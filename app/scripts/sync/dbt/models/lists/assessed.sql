/**
 * lists/assessed: one row per assessed species: its latest assessment, its GBIF
 * key and counts, its latest credits.
 *
 * Built from: assessments (latest), record_counts, paper_counts, lists/assessments (how many
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
 *                            no records are counted; 'flagged' when the species
 *                            has doubts (match_doubts), or counts only other CoL
 *                            names; else NULL
 *   match_reason             how its CoL name was found (assessment_link's primary
 *                            row): exact, unique | … | decision | no candidate | …
 *   match_doubts             its doubts, ';'-joined (docs/specs/matching.md); NULL when none
 *   match_decided_by, match_reviewed  who made a decision, and whether a person checked it
 *   match_counts             what its link counts: the whole CoL species | only
 *                            records under its own name | nothing
 *   match_note, match_records  for a match that isn't plain: how it was matched or why
 *   match_jury      what the AI jury found, for a species it checked (link/assessment-link.ts)
 *                            it is in doubt, in sentences, and the CoL
 *                            records it is about (JSON: id, name, authorship, status,
 *                            species, role), from assessment_link, plus each counted
 *                            record's share of the all-records count (records), and
 *                            the CoL species holding the rest of the count, if any
 *   redlist_authority, redlist_synonyms
 *                            the Red List's authority and its listed synonyms
 *                            (';'-joined), where there is a match note
 *   match_treatment          what CoL makes of the record it is linked through, when
 *                            not 'accepted': synonym, other name (renamed) | synonym,
 *                            other spelling | lumped, …
 *   match_other_names        how many other CoL names' records count for it too
 *                            (covered rows that count), 0 when none
 *   gbif_georeferenced_records_count, gbif_all_records_count
 *   gbif_georeferenced_records_since_assessment, gbif_all_records_since_assessment
 *   openalex_works, openalex_works_since_assessment, bhl_works, bhl_works_since_assessment
 *                            literature works mentioning it (paper_counts)
 *   latest_assessors, latest_reviewers, latest_facilitators, latest_contributors,
 *   latest_institutions
 *   assessment_count         years with a published assessment
 *   specialist_group         the SSC Specialist Group whose remit holds it, if any
 *                            (specialist_group_species)
 *
 * Decisions:
 *   - Common name: IUCN's, else iNaturalist's.
 *   - A species with no GBIF records counts 0, and still has a since-assessment
 *     window (0) unless its assessment has none. Likewise for works.
 */

{%- set today = "DATE '" ~ var('sync_date') ~ "'" %}


-- Each counted match record's share of the count (all records): the records under it, and
-- under any usage below it (a subspecies, a synonym) that no closer listed record claims.
-- What no listed record claims is listed too, one record per CoL species it falls under,
-- largest first, so every record counted is under a named CoL record.
WITH RECURSIVE note AS (
  SELECT sis_taxon_id AS sis,
         from_json(match_records, '[{"id":"VARCHAR","name":"VARCHAR","authorship":"VARCHAR","status":"VARCHAR","species":"VARCHAR","role":"VARCHAR"}]') AS recs
  FROM {{ source('link', 'assessment_link') }} WHERE role = 'primary' AND match_records IS NOT NULL
),
listed AS (SELECT DISTINCT sis, r.id FROM note, unnest(recs) t(r) WHERE r.role <> 'not'),
-- Each counted usage and its records, then the usages above it, as deep as usage_owner reaches.
counted AS (
  SELECT o.sis_taxon_id AS sis, o.usage_key, sum(c.n)::BIGINT AS n
  FROM {{ ref('usage_owner') }} o JOIN {{ source('sources', 'occurrences') }} c ON c.usage_key = o.usage_key
  WHERE o.sis_taxon_id IN (SELECT sis FROM note) GROUP BY ALL
),
up(sis, usage_key, anc, depth) AS (
  SELECT sis, usage_key, usage_key, 0 FROM counted
  UNION ALL
  SELECT u.sis, u.usage_key, t.parent_id, u.depth + 1
  FROM up u JOIN {{ source('sources', 'taxa') }} t ON t.col_id = u.anc WHERE u.depth < 3 AND t.parent_id IS NOT NULL
),
nearest AS (SELECT u.sis, u.usage_key, arg_min(u.anc, u.depth) AS id FROM up u JOIN listed l ON l.sis = u.sis AND l.id = u.anc GROUP BY ALL),
per_record AS (
  SELECT sis, map(list(id), list(n)) AS n
  FROM (SELECT x.sis, x.id, sum(c.n)::BIGINT AS n FROM nearest x JOIN counted c USING (sis, usage_key) GROUP BY ALL)
  GROUP BY sis
),
-- The rest, by the CoL species each usage falls under.
unlisted AS (
  SELECT g.sis, list({'id': g.id, 'name': t.scientific_name, 'authorship': t.authorship, 'status': t.status,
                      'species': NULL::VARCHAR, 'role': 'also', 'records': g.n} ORDER BY g.n DESC, g.id) AS recs
  FROM (SELECT c.sis, coalesce(t.species_id, c.usage_key) AS id, sum(c.n)::BIGINT AS n
        FROM counted c LEFT JOIN {{ source('sources', 'taxa') }} t ON t.col_id = c.usage_key
        WHERE NOT EXISTS (SELECT 1 FROM nearest x WHERE x.sis = c.sis AND x.usage_key = c.usage_key) GROUP BY ALL) g
  LEFT JOIN {{ source('sources', 'taxa') }} t ON t.col_id = g.id
  GROUP BY g.sis
),
match_records AS (
  SELECT note.sis, to_json(list_concat(
           list_transform(note.recs, lambda r: struct_insert(r, records := CASE WHEN r.role <> 'not' THEN coalesce(p.n[r.id], 0) END)),
           coalesce(u.recs, [])))::VARCHAR AS records
  FROM note LEFT JOIN per_record p USING (sis) LEFT JOIN unlisted u USING (sis)
)

SELECT latest.sis_taxon_id AS id, latest.scientific_name,
       coalesce(nullif(latest.common_name, ''), inat.name, latest.common_name) AS common_name,
       latest.taxon_group, latest.class_name, latest.order_name, latest.family,
       latest.category AS iucn_category, latest.assessment_id,
       CAST(latest.assessment_date AS VARCHAR) AS assessment_date, latest.year_published,
       {{ semicolon_list("latest.countries") }} AS countries,
       gbif.gbif_species_key,
       -- A species with no link of its own can still count other CoL names' records (a Red List synonym CoL holds as a species): that count is shown, flagged.
       CASE WHEN link.col_species_id IS NULL AND other.n IS NULL THEN 'unlinked'
            WHEN link.col_species_id IS NULL OR link.doubts IS NOT NULL THEN 'flagged' END AS count_note,
       link.match_reason, link.decided_by AS match_decided_by, link.counts AS match_counts,
       link.doubts AS match_doubts, link.reviewed AS match_reviewed,
       link.match_note, mr.records AS match_records, link.match_jury,
       -- Shown beside a match note (the panel's Red List line); not needed otherwise.
       CASE WHEN link.match_note IS NOT NULL THEN latest.authority END AS redlist_authority,
       CASE WHEN link.match_note IS NOT NULL THEN array_to_string([regexp_replace(trim(x.name), '\s+', ' ', 'g') FOR x IN latest.synonyms], ';') END AS redlist_synonyms,
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
       {%- for src in ['openalex', 'bhl'] %}
       coalesce({{ src }}.works, 0)::BIGINT AS {{ src }}_works,
       CASE WHEN {{ src }}.sis_taxon_id IS NOT NULL THEN {{ src }}.works_since_assessment
            WHEN latest.assessment_date IS NOT NULL AND CAST(latest.assessment_date AS DATE) < {{ today }} THEN 0 END
         AS {{ src }}_works_since_assessment,
       {%- endfor %}
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
{%- for src in ['openalex', 'bhl'] %}
LEFT JOIN {{ ref('paper_counts') }} {{ src }} ON {{ src }}.source = '{{ src }}' AND {{ src }}.sis_taxon_id = latest.sis_taxon_id
{%- endfor %}
LEFT JOIN {{ source('link', 'assessment_link') }} link ON link.sis_taxon_id = latest.sis_taxon_id AND link.role = 'primary'
LEFT JOIN match_records mr ON mr.sis = latest.sis_taxon_id
LEFT JOIN (SELECT sis_taxon_id, count(*) AS n FROM {{ source('link', 'assessment_link') }} WHERE role = 'covered' AND counted GROUP BY 1) other
  ON other.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN (SELECT sis_taxon_id, count(*) AS n FROM {{ ref('assessment_history') }} GROUP BY 1) history
  ON history.sis_taxon_id = latest.sis_taxon_id
LEFT JOIN {{ source('sources', 'common_names') }} inat ON inat.source = 'inat' AND inat.kind = 'display'
  AND inat.scientific_name = latest.scientific_name AND inat.kingdom = {{ inat_kingdom("latest.taxon_group") }}
WHERE latest.is_latest
