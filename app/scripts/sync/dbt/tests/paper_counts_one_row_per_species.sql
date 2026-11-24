-- paper_counts has one row per source and species, and each row names exactly
-- one species (assessed or not): a second row would double a species' count in
-- the lists. Returns the rows that break it.
SELECT source, sis_taxon_id, col_id, count(*) AS n
FROM {{ ref('paper_counts') }}
GROUP BY ALL
HAVING count(*) > 1 OR (sis_taxon_id IS NULL) = (col_id IS NULL)
