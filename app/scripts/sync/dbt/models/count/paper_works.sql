/**
 * paper_works: the OpenAlex works behind each species' count, which the app
 * links to (/api/literature-link opens OpenAlex filtered to them), so a link
 * shows the works counted rather than a search that finds others.
 *
 * Built from: paper_credits.
 *
 * Columns:
 *   sis_taxon_id      the assessed species, else NULL
 *   col_id            the unassessed CoL species, else NULL
 *   work              OpenAlex's work id, as its number (W123 → 123)
 *   publication_date  the paper's date (its earliest record's), else NULL
 *   publication_year  its year
 *
 * Decisions:
 *   - Every record of a counted paper is listed, so a link still finds the
 *     paper if OpenAlex has since merged away the record it was read from.
 *   - OpenAlex only: BHL can't be searched by a list of ids.
 */

WITH papers AS (
  SELECT sis_taxon_id, col_id, paper, min(publication_date) AS publication_date, min(publication_year) AS publication_year
  FROM {{ ref('paper_credits') }} WHERE source = 'openalex'
  GROUP BY ALL
)

SELECT c.sis_taxon_id, c.col_id,
       CAST(regexp_extract(c.work_id, 'W(\d+)$', 1) AS BIGINT) AS work,
       p.publication_date, p.publication_year
FROM {{ ref('paper_credits') }} c
JOIN papers p ON p.paper = c.paper AND p.sis_taxon_id IS NOT DISTINCT FROM c.sis_taxon_id AND p.col_id IS NOT DISTINCT FROM c.col_id
WHERE c.source = 'openalex'
