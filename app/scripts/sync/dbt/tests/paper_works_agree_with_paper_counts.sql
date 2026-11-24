-- paper_works lists the works behind every OpenAlex count, and nothing else:
-- each species' papers there are its count. Returns the species that disagree.
WITH listed AS (
  SELECT c.sis_taxon_id, c.col_id, count(DISTINCT c.paper) AS papers
  FROM {{ ref('paper_credits') }} c
  JOIN {{ ref('paper_works') }} w
    ON w.work = CAST(regexp_extract(c.work_id, 'W(\d+)$', 1) AS BIGINT)
   AND w.sis_taxon_id IS NOT DISTINCT FROM c.sis_taxon_id AND w.col_id IS NOT DISTINCT FROM c.col_id
  WHERE c.source = 'openalex'
  GROUP BY ALL
)
SELECT coalesce(l.sis_taxon_id, p.sis_taxon_id) AS sis_taxon_id, coalesce(l.col_id, p.col_id) AS col_id,
       l.papers, p.works
FROM listed l
FULL JOIN (SELECT * FROM {{ ref('paper_counts') }} WHERE source = 'openalex') p
  ON p.sis_taxon_id IS NOT DISTINCT FROM l.sis_taxon_id AND p.col_id IS NOT DISTINCT FROM l.col_id
WHERE l.papers IS DISTINCT FROM p.works
