/**
 * paper_counts: one row per species and literature source with at least one
 * paper mentioning it, assessed or not: how many papers, and for an assessed
 * species how many were published since its latest assessment.
 *
 * Built from: paper_credits (which species each mention counts for),
 * assessments (the latest assessment's date).
 *
 * Columns:
 *   source                  'openalex' | 'bhl'
 *   sis_taxon_id            the assessed species, else NULL
 *   col_id                  the unassessed CoL species, else NULL
 *   works                   papers mentioning it
 *   works_since_assessment  … published after its latest assessment, up to the
 *                           sync date (assessed species; NULL when there is no
 *                           window)
 *
 * Decisions:
 *   - A paper counts once per species, however many of its records (and
 *     whichever of the species' names) led there. Its date is its earliest
 *     record's.
 *   - Since the assessment: by the paper's date where it has one, else by its
 *     year. A paper dated only to the assessment's year can't be placed and
 *     isn't counted as new.
 *   - No window for an undated assessment, or one dated on or after the sync
 *     date, as for record_counts.
 */

{%- set today = "DATE '" ~ var('sync_date') ~ "'" %}


WITH papers AS (
  SELECT source, sis_taxon_id, col_id, paper,
         min(publication_date) AS published, min(publication_year) AS published_year
  FROM {{ ref('paper_credits') }}
  GROUP BY ALL
),
assessed_on AS (
  SELECT sis_taxon_id, CAST(assessment_date AS DATE) AS d
  FROM {{ source('sources', 'assessments') }} WHERE is_latest
),
placed AS (
  SELECT p.*, a.d,
         CASE WHEN p.published IS NOT NULL THEN p.published > a.d AND p.published <= {{ today }}
              ELSE p.published_year > year(a.d) AND p.published_year <= year({{ today }}) END AS since_assessment
  FROM papers p LEFT JOIN assessed_on a ON a.sis_taxon_id = p.sis_taxon_id
)

SELECT source, sis_taxon_id, col_id, count(*)::BIGINT AS works,
       CASE WHEN any_value(d) IS NULL OR any_value(d) >= {{ today }} THEN NULL
            ELSE (count(*) FILTER (since_assessment))::BIGINT END AS works_since_assessment
FROM placed
GROUP BY source, sis_taxon_id, col_id
