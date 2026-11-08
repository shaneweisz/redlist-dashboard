/**
 * tree_membership: one row per species and static taxonomy-tree node it is in,
 * assessed (IUCN's names) or not (CoL's). Every count a tree node shows is a
 * count of its rows here.
 *
 * Built from: tree_nodes and tree_aliases (the tree's rules, sources/tree.ts),
 * assessed, species/.
 *
 * Columns:
 *   sis_taxon_id    the assessed species, else NULL
 *   col_id          the CoL species (species/), else NULL
 *   node_id         a tree node it is in (never the root, "all")
 *
 * Decisions:
 *   - A species is in a node when it is in one of the node's groups and its
 *     filter holds: each include list names its class, order, family, genus or
 *     name, and no exclude list does. Names are compared lowercased, a missing
 *     one as ''.
 *   - Class and order names match through tree_aliases both ways IUCN and CoL
 *     disagree: a node naming Pinales holds CoL's Cupressales too.
 *   - A species with no order matches an order rule by its class (GBIF's
 *     taxonomy files a few so).
 *   - extra_names are held whatever the rules say; override_names (CoL's names
 *     for the bison) are held by their node only, and left out of every other.
 *   - A catch-all ("Other Mammals") holds what its filter matches less what a
 *     sibling naming classes or orders holds, so siblings never share a species.
 *     The same for assessed and CoL species, and the same override for both:
 *     before this table, CoL counts skipped the first and assessed counts the
 *     second.
 */

WITH aliases AS (SELECT * FROM {{ source('core', 'tree_aliases') }}),
excluded AS (SELECT coalesce(list(name), []) AS names FROM aliases WHERE rank = 'excluded'),
-- A list of class or order names, with the names they also match.
nodes AS (
  SELECT n.*,
    {%- for col, rank in [("class_in", "class"), ("class_out", "class"), ("order_in", "order"), ("order_out", "order")] %}
    list_concat(n.{{ col }}, coalesce((SELECT list(a.alias) FROM aliases a WHERE a.rank = '{{ rank }}' AND list_contains(n.{{ col }}, a.name)), [])) AS {{ col }}_x,
    {%- endfor %}
  FROM {{ source('core', 'tree_nodes') }} n
  WHERE n.parent_id IS NOT NULL
),
species_rows AS (
  {%- for rel, id in [(ref('assessed'), "id::BIGINT AS sis_taxon_id, NULL::VARCHAR AS col_id"), (ref('species'), "NULL::BIGINT, col_id")] %}
  SELECT {{ id }}, taxon_group,
         coalesce(lower(class_name), '') AS cls, coalesce(lower(order_name), '') AS ord, coalesce(lower(family), '') AS fam,
         coalesce(lower(split_part(scientific_name, ' ', 1)), '') AS gen, coalesce(lower(scientific_name), '') AS name
  FROM {{ rel }}
  {% if not loop.last %}UNION ALL{% endif %}
  {%- endfor %}
),
matched AS (
  SELECT r.sis_taxon_id, r.col_id, n.node_id, n.parent_id, n.catch_all, n.claims,
         (   (len(n.class_in) = 0 OR list_contains(n.class_in_x, r.cls))
         AND (len(n.class_out) = 0 OR NOT list_contains(n.class_out_x, r.cls))
         AND (len(n.order_in) = 0 OR list_contains(n.order_in_x, r.ord) OR (r.ord = '' AND list_contains(n.order_in, r.cls)))
         AND (len(n.order_out) = 0 OR NOT (list_contains(n.order_out_x, r.ord) OR (r.ord = '' AND list_contains(n.order_out, r.cls))))
         AND (len(n.family_in) = 0 OR list_contains(n.family_in, r.fam))
         AND (len(n.family_out) = 0 OR NOT list_contains(n.family_out, r.fam))
         AND (len(n.genus_in) = 0 OR list_contains(n.genus_in, r.gen))
         AND (len(n.genus_out) = 0 OR NOT list_contains(n.genus_out, r.gen))
         AND (len(n.name_in) = 0 OR list_contains(n.name_in, r.name))
         AND (len(n.name_out) = 0 OR NOT list_contains(n.name_out, r.name))
         AND NOT list_contains(x.names, r.name)
         ) OR (list_contains(n.extra_names, r.name) AND NOT list_contains(x.names, r.name)) AS by_filter,
         list_contains(n.override_names, r.name) AS by_override
  FROM species_rows r
  JOIN nodes n ON list_contains(n.taxon_groups, r.taxon_group)
  CROSS JOIN excluded x
),
held AS (
  SELECT *,
         -- How many siblings that claim (name classes or orders) hold it, not counting itself.
         count(*) FILTER (claims AND by_filter) OVER (PARTITION BY sis_taxon_id, col_id, parent_id)
           - (claims AND by_filter)::INT AS claimed_by_siblings
  FROM matched WHERE by_filter OR by_override
)
SELECT sis_taxon_id, col_id, node_id
FROM held
WHERE by_override OR (by_filter AND NOT (catch_all AND claimed_by_siblings > 0))
