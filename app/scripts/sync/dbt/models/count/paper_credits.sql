/**
 * paper_credits: which species each literature mention counts for. One row per
 * source, species, paper and work: the rule paper_counts counts and
 * paper_works lists, kept in one place so the two can't disagree.
 *
 * Built from: literature_mentions (sources/literature.ts), taxa, usage_owner.
 *
 * Columns:
 *   source            'openalex' | 'bhl'
 *   sis_taxon_id      the assessed species, else NULL
 *   col_id            the unassessed CoL species, else NULL
 *   paper             the paper the work is (literature_mentions)
 *   work_id
 *   publication_date, publication_year
 *
 * Decisions:
 *   - A mention is credited as a GBIF record is: the name is a CoL species-rank
 *     usage (accepted or a synonym, by its exact spelling), and usage_owner says
 *     which species that usage counts for. A paper naming a synonym counts for
 *     the species that owns it, and a lump or split is handled by the same
 *     ownership as occurrences. Misapplied usages are left out.
 *   - A name CoL holds for more than one species (a homonym across kingdoms, a
 *     name two species' records both claim) can't say which it means, and counts
 *     for neither.
 */

WITH name_owner AS (
  SELECT t.scientific_name AS name, any_value(o.sis_taxon_id) AS sis_taxon_id, any_value(o.col_id) AS col_id
  FROM {{ source('sources', 'taxa') }} t
  JOIN {{ ref('usage_owner') }} o ON o.usage_key = t.col_id
  WHERE t.rank = 'species' AND t.status <> 'misapplied'
  GROUP BY t.scientific_name
  HAVING count(DISTINCT coalesce(CAST(o.sis_taxon_id AS VARCHAR), 'col:' || o.col_id)) = 1
)

SELECT DISTINCT m.source, n.sis_taxon_id, n.col_id, m.paper, m.work_id, m.publication_date, m.publication_year
FROM {{ source('sources', 'literature_mentions') }} m
JOIN name_owner n USING (name)
