/**
 * taxonomy/col-to-assessed: one row per CoL species an assessed species is
 * linked to, naming that species. The "infraspecific" no-match reason uses it to
 * name the assessed species a demoted subspecies now sits under (Arctocephalus
 * townsendi → A. philippii).
 *
 * Built from: assessment_link, lists/assessed.
 *
 * Columns:
 *   col_id
 *   assessed_id, assessed_name   the assessed species linked to it
 *
 * Decisions: primary links only; where two share a col_id, an accepted-name
 * match before others, then the lowest SIS id.
 */
WITH links AS (
  SELECT l.col_id, l.sis_taxon_id AS assessed_id, a.scientific_name AS assessed_name,
         row_number() OVER (PARTITION BY l.col_id ORDER BY (CASE WHEN l.method = 'accepted' THEN 0 ELSE 1 END), l.sis_taxon_id) AS rn
  FROM {{ source('core', 'assessment_link') }} l
  JOIN {{ ref('assessed') }} a ON a.id = l.sis_taxon_id
  WHERE l.col_id IS NOT NULL AND l.role = 'primary'
)
SELECT col_id, assessed_id, assessed_name FROM links WHERE rn = 1
