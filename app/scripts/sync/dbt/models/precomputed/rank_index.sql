/**
 * search/rank-index: one row per class, order, family or genus name, and per
 * common name of one, sorted by name: the search bar's "Browse Felidae →"
 * suggestions, read by prefix like name-index.
 *
 * Built from: lists/assessed, lists/ne, the tree's labels (vernacular_names).
 *
 * Columns:
 *   name             the name searched, lowercased: a rank's scientific name, or
 *                    one of its common names
 *   rp               its rank: 0 class, 1 order, 2 family, 3 genus (SUGGEST_RANKS
 *                    in species-duckdb.ts; keep in step)
 *   taxon_group, class_name, order_name, family
 *                    where to browse it
 *   taxon            the rank's scientific name
 *   common           its common name, if it has one ("baobab" offers "Browse
 *                    Adansonia (Baobabs)")
 *
 * Decisions:
 *   - One row per name, aggregated here, so a suggestion is a pruned range read.
 *   - A name in several groups (the genus "×" is in mosses and flowering plants)
 *     goes to the coarsest rank, then the alphabetically first group: min() of a
 *     struct compares field by field, so the choice is total and stable. A plain
 *     arg_min's tie-break varied between runs on identical data.
 *   - A common name that is itself some rank's scientific name is left out (the
 *     scientific row wins); one shared by several ranks follows the same rule.
 */
{%- set ranks = [("class_name", "class_name"), ("order_name", "order_name"), ("family", "family"), ("lower(split_part(scientific_name, ' ', 1))", "scientific_name")] %}
WITH rank_rows AS (
  {%- for rel in [ref('assessed'), ref('ne')] %}
  {%- set outer = loop %}
  {%- for match, present in ranks %}
  SELECT {{ match }} AS name, {{ loop.index0 }} AS rp, taxon_group, class_name, order_name, family
  FROM {{ rel }} WHERE {{ present }} IS NOT NULL
  {% if not (outer.last and loop.last) %}UNION ALL{% endif %}
  {%- endfor %}
  {%- endfor %}
),
rank_sci AS (
  SELECT name, (min(s)).rp AS rp, (min(s)).tg AS taxon_group,
         (min(s)).cls AS class_name, (min(s)).ord AS order_name, (min(s)).fam AS family
  FROM (SELECT name, {'rp': rp, 'tg': taxon_group, 'cls': class_name, 'ord': order_name, 'fam': family} AS s FROM rank_rows)
  WHERE name <> ''
  GROUP BY name
),
rank_vern AS (SELECT key AS sci, name AS common FROM {{ ref('vernacular_names') }})
SELECT r.name, r.rp, r.taxon_group, r.class_name, r.order_name, r.family, r.name AS taxon, v.common
FROM rank_sci r LEFT JOIN rank_vern v ON v.sci = r.name
UNION ALL
SELECT name, (min(s)).rp, (min(s)).tg, (min(s)).cls, (min(s)).ord, (min(s)).fam, (min(s)).taxon, (min(s)).common
FROM (
  SELECT lower(v.common) AS name,
         {'rp': r.rp, 'tg': r.taxon_group, 'taxon': r.name, 'cls': r.class_name, 'ord': r.order_name, 'fam': r.family, 'common': v.common} AS s
  FROM rank_vern v JOIN rank_sci r ON r.name = v.sci
  WHERE lower(v.common) NOT IN (SELECT name FROM rank_sci)
)
GROUP BY name
