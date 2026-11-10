/**
 * specialist_group_species: one row per species and SSC Specialist Group whose
 * remit holds it, assessed (IUCN's names) or not (CoL's). Every count the "By
 * SSC Specialist Group" layout shows is a count of a group's rows here.
 *
 * Built from: specialist_group_remits and rank_aliases (sources/specialist-groups.ts),
 * assessments (the latest), taxa (species/'s rows). lists/assessed and species/
 * carry each species' group as specialist_group.
 *
 * Columns:
 *   sis_taxon_id    the assessed species, else NULL
 *   col_id          the CoL species (species/), else NULL
 *   group_id        the Specialist Group
 *
 * Decisions:
 *   - A species is in a group when it is in one of the group's IUCN groups and
 *     its remit holds: each include list names its class, order, family, genus
 *     or name, and no exclude list does. Names are compared lowercased, a
 *     missing one as ''.
 *   - Class and order names match through rank_aliases, since IUCN and CoL file
 *     some species differently: a remit naming Pinales holds CoL's Cupressales too.
 *   - A species with no order matches an order rule by its class (GBIF's
 *     taxonomy files a few so).
 *   - extra_names are held whatever the rules say. override_names (CoL's names
 *     for the bison) are held by their group only, and left out of every other.
 *   - A species is in at most one group (the tests check it), so the lists
 *     carry it as one column.
 *   - A section's catch-all ("Other Mammals") holds what its remit matches less
 *     what a sibling naming classes or orders holds, so groups never share a
 *     species. The same for assessed and CoL species, and the same override for
 *     both: before this table, CoL counts skipped the first and assessed counts
 *     the second.
 */

WITH aliases AS (SELECT * FROM {{ source('sources', 'rank_aliases') }}),
-- Names only their own group holds.
excluded AS (SELECT coalesce(flatten(list(override_names)), []) AS names FROM {{ source('sources', 'specialist_group_remits') }}),
-- Each remit, its class and order lists with the names they also match.
remits AS (
  SELECT n.*,
    {%- for col, rank in [("class_in", "class"), ("class_out", "class"), ("order_in", "order"), ("order_out", "order")] %}
    list_concat(n.{{ col }}, coalesce((SELECT list(a.alias) FROM aliases a WHERE a.rank = '{{ rank }}' AND list_contains(n.{{ col }}, a.name)), [])) AS {{ col }}_x,
    {%- endfor %}
  FROM {{ source('sources', 'specialist_group_remits') }} n
),
species_rows AS (
  -- The assessed species (lists/assessed's rows) and the CoL species (species/'s),
  -- from the sources, since both lists carry this table's answer.
  {%- for rel, id, where in [(source('sources', 'assessments'), "sis_taxon_id::BIGINT AS sis_taxon_id, NULL::VARCHAR AS col_id", "is_latest"),
                             (source('sources', 'taxa'), "NULL::BIGINT, col_id", col_species())] %}
  SELECT {{ id }}, taxon_group,
         coalesce(lower(class_name), '') AS cls, coalesce(lower(order_name), '') AS ord, coalesce(lower(family), '') AS fam,
         coalesce(lower(split_part(scientific_name, ' ', 1)), '') AS gen, coalesce(lower(scientific_name), '') AS name
  FROM {{ rel }} WHERE {{ where }}
  {% if not loop.last %}UNION ALL{% endif %}
  {%- endfor %}
),
matched AS (
  SELECT r.sis_taxon_id, r.col_id, n.group_id, n.section_id, n.catch_all, n.claims,
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
  JOIN remits n ON list_contains(n.taxon_groups, r.taxon_group)
  CROSS JOIN excluded x
),
held AS (
  SELECT *,
         -- How many groups in its section that claim (name classes or orders) hold it, not counting this one.
         count(*) FILTER (claims AND by_filter) OVER (PARTITION BY sis_taxon_id, col_id, section_id)
           - (claims AND by_filter)::INT AS claimed_by_siblings
  FROM matched WHERE by_filter OR by_override
)
SELECT sis_taxon_id, col_id, group_id
FROM held
WHERE by_override OR (by_filter AND NOT (catch_all AND claimed_by_siblings > 0))
