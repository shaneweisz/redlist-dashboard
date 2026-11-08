-- Every species in an IUCN group the Specialist Groups cover is in one of them:
-- each section ends with a catch-all ("Other Mammals"), so a species that falls
-- through every remit is a remit that went wrong (a family CoL renamed, an order
-- CoL split), not a species with no group. Assessed species, and the described
-- CoL species the counts are made of (fossil names CoL keeps aren't counted).
-- Returns the species that break the rule.
WITH covered AS (
  SELECT DISTINCT unnest(taxon_groups) AS taxon_group FROM {{ source('core', 'specialist_group_remits') }}
)
SELECT 'assessed' AS kind, CAST(id AS VARCHAR) AS id, scientific_name, taxon_group, class_name, order_name, family
FROM {{ ref('assessed') }}
WHERE specialist_group IS NULL AND taxon_group IN (SELECT taxon_group FROM covered)
UNION ALL
SELECT 'CoL', col_id, scientific_name, taxon_group, class_name, order_name, family
FROM {{ ref('species') }}
WHERE described AND specialist_group IS NULL AND taxon_group IN (SELECT taxon_group FROM covered)
