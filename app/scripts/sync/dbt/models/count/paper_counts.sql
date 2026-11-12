/**
 * paper_counts: one row per species and literature source with at least one
 * work mentioning it, assessed or not: how many works, and for an assessed
 * species how many were published since its latest assessment.
 *
 * Built from: literature_mentions (work × binomial, sources/literature.ts),
 * taxa, usage_owner, assessments (the latest assessment's date).
 *
 * Columns:
 *   source                  'openalex' | 'bhl'
 *   sis_taxon_id            the assessed species, else NULL
 *   col_id                  the unassessed CoL species, else NULL
 *   works                   works mentioning it
 *   works_since_assessment  … published after its latest assessment, up to the
 *                           sync date (assessed species; NULL when there is no
 *                           window)
 *
 * Decisions:
 *   - A mention is credited as a GBIF record is: the name is a CoL species-rank
 *     usage (accepted or a synonym, by its exact spelling), and usage_owner says
 *     which species that usage counts for. A paper naming a synonym counts for
 *     the species that owns it, and a lump or split is handled by the same
 *     ownership as occurrences.
 *   - A name CoL holds for more than one species (a homonym across kingdoms, a
 *     name two species' records both claim) can't say which it means, and counts
 *     for neither.
 *   - A work counts once per species, whichever of its names led there.
 *   - Since the assessment: by the work's date where it has one, else by its
 *     year. A work dated only to the assessment's year can't be placed and isn't
 *     counted as new.
 *   - No window for an undated assessment, or one dated on or after the sync
 *     date, as for record_counts.
 */

{%- set today = "DATE '" ~ var('sync_date') ~ "'" %}


WITH name_owner AS (
  SELECT t.scientific_name AS name, any_value(o.sis_taxon_id) AS sis_taxon_id, any_value(o.col_id) AS col_id
  FROM {{ source('sources', 'taxa') }} t
  JOIN {{ ref('usage_owner') }} o ON o.usage_key = t.col_id
  WHERE t.rank = 'species' AND t.status <> 'misapplied'
  GROUP BY t.scientific_name
  HAVING count(DISTINCT coalesce(CAST(o.sis_taxon_id AS VARCHAR), 'col:' || o.col_id)) = 1
),
assessed_on AS (
  SELECT sis_taxon_id, CAST(assessment_date AS DATE) AS d
  FROM {{ source('sources', 'assessments') }} WHERE is_latest
),
credited AS (
  SELECT m.source, n.sis_taxon_id, n.col_id, m.work_id,
         any_value(m.publication_date) AS published, any_value(m.publication_year) AS published_year
  FROM {{ source('sources', 'literature_mentions') }} m JOIN name_owner n USING (name)
  GROUP BY ALL
),
placed AS (
  SELECT c.*, a.d,
         CASE WHEN c.published IS NOT NULL THEN c.published > a.d AND c.published <= {{ today }}
              ELSE c.published_year > year(a.d) AND c.published_year <= year({{ today }}) END AS since_assessment
  FROM credited c LEFT JOIN assessed_on a ON a.sis_taxon_id = c.sis_taxon_id
)

SELECT source, sis_taxon_id, col_id, count(*)::BIGINT AS works,
       CASE WHEN any_value(d) IS NULL OR any_value(d) >= {{ today }} THEN NULL
            ELSE (count(*) FILTER (since_assessment))::BIGINT END AS works_since_assessment
FROM placed
GROUP BY source, sis_taxon_id, col_id
