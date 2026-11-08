/**
 * record_counts: one row per species with GBIF records, assessed or not, with
 * its counts in both record modes.
 *
 * Built from: usage_owner, occurrences, assessment_link (each row's verdict),
 * assessments (the latest assessment's date).
 *
 * Columns:
 *   sis_taxon_id      the assessed species, else NULL
 *   col_id            the unassessed CoL species, else NULL
 *   gbif_species_key  the usage the species' GBIF page is (assessed species)
 *   georef            records with coordinates and no geospatial issue
 *   all_records       every record
 *   georef_since, all_since
 *                     the same, since the latest assessment (assessed species;
 *                     NULL when there is no window)
 *
 * Decisions:
 *   - Every count is occurrences summed over the usages usage_owner gives the
 *     species.
 *   - The GBIF key is the counted usage with the most records, an own row's
 *     before a lumped one's, so Hylatomus pileatus links to Dryocopus pileatus'
 *     5M records rather than its own 156: CoL holds that bird twice, and both
 *     halves count.
 *   - Since the assessment means from the day after its date to the sync date.
 *     Later years count whatever their precision. In the assessment's own year a
 *     record counts if it is dated to a later day, or only to a later month; one
 *     dated only to that year, or only to the assessment's month, can't be placed
 *     either side and is left out.
 *   - No window for an undated assessment, or one dated on or after the sync
 *     date: nothing can postdate it yet.
 */

{%- set today = "DATE '" ~ var('sync_date') ~ "'" %}


WITH owner AS (SELECT * FROM {{ ref('usage_owner') }}),
occ AS (SELECT * FROM {{ source('core', 'occurrences') }}),

-- Per assessed species and link row: its usages' records, in total and since the assessment.
link_rows AS (
  SELECT o.sis_taxon_id AS sis, o.link_usage_id AS usage_id, any_value(l.verdict) AS verdict,
         CAST(any_value(a.assessment_date) AS DATE) AS assessed_on
  FROM owner o
  JOIN {{ source('core', 'assessment_link') }} l ON l.sis_taxon_id = o.sis_taxon_id AND l.usage_id = o.link_usage_id AND l.counted
  JOIN {{ source('core', 'assessments') }} a ON a.sis_taxon_id = o.sis_taxon_id AND a.is_latest
  WHERE o.sis_taxon_id IS NOT NULL GROUP BY 1, 2
),
row_counts AS (
  SELECT r.sis, r.usage_id, any_value(r.verdict) AS verdict, any_value(r.assessed_on) AS assessed_on,
         coalesce(sum(c.n) FILTER (c.georef), 0)::BIGINT AS georef,
         coalesce(sum(c.n), 0)::BIGINT AS all_records,
         coalesce(sum(c.n) FILTER (c.georef AND ({{ since_assessment("c", "r.assessed_on", today) }})), 0)::BIGINT AS georef_since,
         coalesce(sum(c.n) FILTER ({{ since_assessment("c", "r.assessed_on", today) }}), 0)::BIGINT AS all_since
  FROM link_rows r
  JOIN owner o ON o.sis_taxon_id = r.sis AND o.link_usage_id = r.usage_id
  JOIN occ c ON c.usage_key = o.usage_key
  GROUP BY r.sis, r.usage_id
)

SELECT sis AS sis_taxon_id, NULL::VARCHAR AS col_id,
       -- usage_id last: two usages with the same counts would otherwise swap between runs.
       arg_min(usage_id, (CASE verdict WHEN 'own' THEN 0 ELSE 1 END, -georef, -all_records, usage_id)) AS gbif_species_key,
       sum(georef)::BIGINT AS georef, sum(all_records)::BIGINT AS all_records,
       CASE WHEN any_value(assessed_on) IS NULL OR any_value(assessed_on) >= {{ today }} THEN NULL ELSE sum(georef_since)::BIGINT END AS georef_since,
       CASE WHEN any_value(assessed_on) IS NULL OR any_value(assessed_on) >= {{ today }} THEN NULL ELSE sum(all_since)::BIGINT END AS all_since
FROM row_counts GROUP BY sis HAVING sum(all_records) > 0
UNION ALL
SELECT NULL, o.col_id, NULL, coalesce(sum(c.n) FILTER (c.georef), 0)::BIGINT, sum(c.n)::BIGINT, NULL, NULL
FROM owner o JOIN occ c ON c.usage_key = o.usage_key
WHERE o.col_id IS NOT NULL GROUP BY o.col_id HAVING sum(c.n) > 0
