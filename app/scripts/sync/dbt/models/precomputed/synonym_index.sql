/**
 * search/synonym-index: one row per CoL synonym of a described species, so a
 * search for an old name finds the current species.
 *
 * Built from: taxonomy/taxa, species/, assessment_link, lists/assessed.
 *
 * Columns:
 *   synonym_name, synonym_name_lower
 *   accepted_name, accepted_col_id, taxon_group
 *                    the described species it is a synonym of
 *   sis_id           the assessed species linked to it, else NULL (Not Evaluated)
 *   category         its category, 'NE' when not assessed
 *
 * Decisions:
 *   - Only synonyms of described species, so a hit routes like a direct one: to
 *     the assessed species, or to the Not Evaluated list.
 *   - The species whose own link it is, not one merely covering it; the lowest
 *     SIS id when two share it, so a rebuild picks the same one.
 *   - Sorted by synonym_name_lower when written, so a prefix search reads about
 *     one row group.
 */
WITH assessed_link AS (
  SELECT col_species_id AS col_id, arg_min(sis_taxon_id, [CASE WHEN role = 'covered' THEN 1 ELSE 0 END, sis_taxon_id]) AS sis_id
  FROM {{ source('link', 'assessment_link') }} WHERE col_species_id IS NOT NULL GROUP BY col_species_id
)
SELECT syn.scientific_name AS synonym_name,
       lower(syn.scientific_name) AS synonym_name_lower,
       acc.scientific_name AS accepted_name,
       acc.col_id AS accepted_col_id,
       acc.taxon_group AS taxon_group,
       al.sis_id AS sis_id,
       coalesce(a.iucn_category, 'NE') AS category
FROM {{ ref('app_taxa') }} syn
JOIN {{ ref('species') }} acc ON acc.col_id = syn.parent_id
LEFT JOIN assessed_link al ON al.col_id = acc.col_id
LEFT JOIN {{ ref('assessed') }} a ON a.id = al.sis_id
WHERE syn.status = 'synonym'
  AND acc.described
  AND lower(syn.scientific_name) <> lower(acc.scientific_name)
