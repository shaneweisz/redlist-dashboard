/**
 * lists/assessed: one row per assessed species: its latest assessment, its GBIF
 * key and counts, its latest credits.
 *
 * Built from: assessments (latest), record_counts, lists/assessments (how many
 * years it was assessed in), common_names.
 *
 * Columns:
 *   id                       the SIS taxon id
 *   scientific_name, common_name, taxon_group, class_name, order_name, family
 *   iucn_category, assessment_id, assessment_date, year_published, criteria,
 *   population_trend, movement_pattern, possibly_extinct, possibly_extinct_in_the_wild
 *   countries, systems, growth_forms, threat_codes, habitat_codes
 *                            lists, ';'-joined (the app's filter SQL reads them so)
 *   gbif_species_key         see record_counts
 *   gbif_live_key            the id GBIF's live index uses for it, where that
 *                            differs (live_keys); the app's live GBIF queries
 *                            ask it first. NULL most months
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
       nullif(live.live_key, gbif.gbif_species_key) AS gbif_live_key,
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
FROM {{ source('core', 'assessments') }} latest
LEFT JOIN {{ ref('specialist_group_species') }} sg ON sg.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN {{ ref('record_counts') }} gbif ON gbif.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN {{ source('core', 'live_keys') }} live ON live.kind = 'assessed' AND live.id = latest.sis_taxon_id::VARCHAR
LEFT JOIN (SELECT sis_taxon_id, count(*) AS n FROM {{ ref('assessment_history') }} GROUP BY 1) history
  ON history.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN {{ source('core', 'common_names') }} inat ON inat.source = 'inat' AND inat.kind = 'display'
  AND inat.scientific_name = latest.scientific_name AND inat.kingdom = {{ inat_kingdom("latest.taxon_group") }}
WHERE latest.is_latest
