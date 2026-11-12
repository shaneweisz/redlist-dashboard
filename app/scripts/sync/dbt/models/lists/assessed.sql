/**
 * lists/assessed: one row per assessed species: its latest assessment, its GBIF
 * key and counts, its latest credits.
 *
 * Built from: assessments (latest), record_counts, lists/assessments (how many
 * years it was assessed in), common_names, assessment_link.
 *
 * Columns:
 *   id                       the SIS taxon id
 *   scientific_name, common_name, taxon_group, class_name, order_name, family
 *   iucn_category, assessment_id, assessment_date, year_published, criteria,
 *   population_trend, movement_pattern, possibly_extinct, possibly_extinct_in_the_wild
 *   countries, systems, growth_forms, threat_codes, habitat_codes
 *                            lists, ';'-joined (the app's filter SQL reads them so)
 *   gbif_species_key         see record_counts
 *   count_note               'unlinked' when it is linked to no CoL species, so
 *                            no records are counted; 'flagged' when the
 *                            count rests on the matcher's answer the link's rule
 *                            doubts (match_reason 'flagged: …'), or only on
 *                            other CoL names while its own link waits; else NULL
 *   match_reason             how its CoL name was found (assessment_link's primary
 *                            row): exact, unique | … | flagged: <doubt> |
 *                            override | waiting | …
 *   match_decided_by         who decided an override (a GitHub handle, agent:<model>)
 *   match_counts             what its link counts: the whole CoL species | only
 *                            records under its own name | nothing
 *   match_note, match_records  for a match that isn't plain: how it was matched or why
 *                            it is in doubt, in sentences, and the CoL
 *                            records it is about (JSON: id, name, authorship, status,
 *                            species, role), from assessment_link
 *   redlist_authority        the Red List's authority, where there is a match note
 *   match_treatment          what CoL makes of the record it is linked through, when
 *                            not 'accepted': synonym, other name (renamed) | synonym,
 *                            other spelling | lumped, …
 *   match_other_names        how many other CoL names' records count for it too
 *                            (covered rows that count), 0 when none
 *   gbif_georeferenced_records_count, gbif_all_records_count
 *   gbif_georeferenced_records_since_assessment, gbif_all_records_since_assessment
 *   latest_assessors, latest_reviewers, latest_facilitators, latest_contributors,
 *   latest_institutions
 *   assessment_count         years with a published assessment
 *   specialist_group         the SSC Specialist Group whose remit holds it, if any
 *                            (specialist_group_species)
 *
 * Decisions:
 *   - Common name: IUCN's, else iNaturalist's.
 *   - A species with no GBIF records counts 0, and still has a since-assessment
 *     window (0) unless its assessment has none.
 */

{%- set today = "DATE '" ~ var('sync_date') ~ "'" %}


SELECT latest.sis_taxon_id AS id, latest.scientific_name,
       coalesce(nullif(latest.common_name, ''), inat.name, latest.common_name) AS common_name,
       latest.taxon_group, latest.class_name, latest.order_name, latest.family,
       latest.category AS iucn_category, latest.assessment_id,
       CAST(latest.assessment_date AS VARCHAR) AS assessment_date, latest.year_published,
       {{ semicolon_list("latest.countries") }} AS countries,
       gbif.gbif_species_key,
       -- A species with no link of its own can still count other CoL names' records (a Red List synonym CoL holds as a species): that count is shown, flagged.
       CASE WHEN link.col_species_id IS NULL AND other.n IS NULL THEN 'unlinked'
            WHEN link.col_species_id IS NULL OR link.match_reason LIKE 'flagged: %' THEN 'flagged' END AS count_note,
       link.match_reason, link.decided_by AS match_decided_by, link.counts AS match_counts,
       link.match_note, link.match_records,
       -- Shown beside a match note (the panel's Red List line); not needed otherwise.
       CASE WHEN link.match_note IS NOT NULL THEN latest.authority END AS redlist_authority,
       CASE WHEN link.col_treatment <> 'accepted' THEN link.col_treatment END AS match_treatment,
       coalesce(other.n, 0)::INTEGER AS match_other_names,
       coalesce(gbif.georef, 0) AS gbif_georeferenced_records_count,
       coalesce(gbif.all_records, 0) AS gbif_all_records_count,
       CASE WHEN gbif.sis_taxon_id IS NOT NULL THEN gbif.georef_since
            WHEN latest.assessment_date IS NOT NULL AND CAST(latest.assessment_date AS DATE) < {{ today }} THEN 0 END
         AS gbif_georeferenced_records_since_assessment,
       CASE WHEN gbif.sis_taxon_id IS NOT NULL THEN gbif.all_since
            WHEN latest.assessment_date IS NOT NULL AND CAST(latest.assessment_date AS DATE) < {{ today }} THEN 0 END
         AS gbif_all_records_since_assessment,
       latest.population_trend, {{ semicolon_list("latest.systems") }} AS systems, {{ semicolon_list("latest.growth_forms") }} AS growth_forms,
       latest.movement_pattern, latest.possibly_extinct, latest.possibly_extinct_in_the_wild, latest.criteria,
       {{ semicolon_list("latest.threat_codes") }} AS threat_codes, {{ semicolon_list("latest.habitat_codes") }} AS habitat_codes,
       latest.assessors AS latest_assessors, latest.reviewers AS latest_reviewers, latest.facilitators AS latest_facilitators,
       latest.contributors AS latest_contributors, latest.institutions AS latest_institutions,
       coalesce(history.n, 1)::BIGINT AS assessment_count,
       sg.group_id AS specialist_group
FROM {{ source('sources', 'assessments') }} latest
LEFT JOIN {{ ref('specialist_group_species') }} sg ON sg.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN {{ ref('record_counts') }} gbif ON gbif.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN {{ source('link', 'assessment_link') }} link ON link.sis_taxon_id = latest.sis_taxon_id AND link.role = 'primary'
LEFT JOIN (SELECT sis_taxon_id, count(*) AS n FROM {{ source('link', 'assessment_link') }} WHERE role = 'covered' AND counted GROUP BY 1) other
  ON other.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN (SELECT sis_taxon_id, count(*) AS n FROM {{ ref('assessment_history') }} GROUP BY 1) history
  ON history.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN {{ source('sources', 'common_names') }} inat ON inat.source = 'inat' AND inat.kind = 'display'
  AND inat.scientific_name = latest.scientific_name AND inat.kingdom = {{ inat_kingdom("latest.taxon_group") }}
WHERE latest.is_latest
