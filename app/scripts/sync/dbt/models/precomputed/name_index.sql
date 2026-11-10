/**
 * search/name-index: one row per searchable name of a species, sorted by it, so
 * the search bar's prefix query
 *
 *   WHERE name_lo >= 'panth' AND name_lo < 'panth' || chr(1114111)
 *
 * reads a row group or two instead of scanning the species lists (which are
 * sorted for browsing, by class, order and family).
 *
 * Built from: lists/assessed, lists/ne, assessment_link, common_names (every CoL
 * and iNaturalist name).
 *
 * Columns:
 *   name_lo          the name, lowercased: what the prefix query ranges over
 *   matched_name     the name as written
 *   name_kind        which name it is, the search's ranking tiers: 0 scientific
 *                    name, 1 common name, 2 epithet, 3 a later word of the
 *                    common name, 4 another common name, 5 a later word of one
 *                    (searchSpecies in species-duckdb.ts ranks by these; keep in step)
 *   rank_name        the common name the row ranks by: the display one, or the
 *                    other name it was reached through
 *   id, scientific_name, common_name, taxon_group, category, gbif_species_key,
 *   gbif_georeferenced_records_count, assessment_id, assessment_date, countries,
 *   class_name, order_name, family, assessed, col_id
 *                    the search result itself, so a hit needs no join back
 *
 * Decisions:
 *   - One row per name, not per species: "panthera", "lion" and "leo" all reach
 *     Panthera leo by prefix, and "elephant" finds African Elephant.
 *   - Assessed species and the Not Evaluated ones GBIF has records for; the
 *     CoL-only and synonym tiers are searched only when nothing here matches.
 *   - Sorted by name_lo in row groups of 20,000 when written: about a megabyte,
 *     so a prefix query reads about a megabyte, fast even on a cold container.
 */
WITH species AS (
  SELECT a.id, a.scientific_name, a.common_name, a.taxon_group, a.iucn_category AS category,
         a.gbif_species_key, a.gbif_georeferenced_records_count,
         a.assessment_id, CAST(a.assessment_date AS VARCHAR) AS assessment_date,
         a.countries, a.class_name, a.order_name, a.family,
         true AS assessed, CAST(NULL AS VARCHAR) AS col_id, ra.col_id AS name_col_id
  FROM {{ ref('assessed') }} a
  LEFT JOIN (
    -- The primary link only: a covered row names another concept the species is
    -- kept out of the NE list under, not the species itself.
    SELECT sis_taxon_id AS id, any_value(col_id) AS col_id FROM {{ source('link', 'assessment_link') }}
    WHERE col_id IS NOT NULL AND role = 'primary' GROUP BY 1
  ) ra ON ra.id = a.id
  UNION ALL
  -- Not Evaluated species GBIF has records for, keyed by col_id (also their GBIF key).
  -- col_id is NULL on assessed rows on purpose: those are keyed by SIS id.
  SELECT NULL::BIGINT, u.scientific_name, u.common_name, u.taxon_group, u.iucn_category,
         u.gbif_species_key, u.gbif_georeferenced_records_count, NULL, NULL,
         u.countries, u.class_name, u.order_name, u.family, false, u.col_id, u.col_id
  FROM {{ ref('ne') }} u
),
{%- set payload = "id, scientific_name, common_name, taxon_group, category, gbif_species_key, gbif_georeferenced_records_count, assessment_id, assessment_date, countries, class_name, order_name, family, assessed, col_id" %}
-- Every other English common name CoL gives the species, and every one
-- iNaturalist gives it (matched by scientific name within a kingdom), so "baobab"
-- finds Adansonia digitata through "African baobab". One row per species and
-- name, case-insensitively. A species is its SIS id when assessed, its col_id
-- when not (id alone is NULL on every NE row).
alt_sources AS (
  SELECT s.*, v.name AS alt_name FROM species s
  JOIN (SELECT col_id, name FROM {{ source('sources', 'common_names') }} WHERE source = 'col' AND kind = 'name') v ON v.col_id = s.name_col_id
  UNION ALL
  SELECT s.*, n.name FROM species s
  JOIN (SELECT scientific_name, kingdom, name FROM {{ source('sources', 'common_names') }} WHERE source = 'inat' AND kind = 'name') n
    ON n.scientific_name = s.scientific_name AND n.kingdom = {{ inat_kingdom("s.taxon_group") }}
),
alt_names AS (
  SELECT * EXCLUDE (k) FROM (
    SELECT *, row_number() OVER (PARTITION BY assessed, coalesce(CAST(id AS VARCHAR), col_id), lower(alt_name) ORDER BY alt_name) AS k
    FROM alt_sources WHERE lower(alt_name) <> lower(coalesce(common_name, ''))
  ) WHERE k = 1
)
SELECT name_lo, matched_name, name_kind, rank_name, {{ payload }} FROM (
  -- 0: the scientific name.
  SELECT lower(scientific_name) AS name_lo, scientific_name AS matched_name, 0 AS name_kind, common_name AS rank_name, {{ payload }}
  FROM species WHERE scientific_name IS NOT NULL AND scientific_name <> ''
  UNION ALL
  -- 1: the common name ('' rather than NULL when absent).
  SELECT lower(common_name), common_name, 1, common_name, {{ payload }}
  FROM species WHERE nullif(common_name, '') IS NOT NULL
  UNION ALL
  -- 2: the specific epithet, the half of a binomial people remember ("leo").
  SELECT lower(split_part(scientific_name, ' ', 2)), scientific_name, 2, common_name, {{ payload }}
  FROM species WHERE scientific_name LIKE '% %' AND nullif(split_part(scientific_name, ' ', 2), '') IS NOT NULL
  UNION ALL
  -- 3: each later word of a multi-word common name ("elephant", "eagle").
  SELECT lower(w.word), s.common_name, 3, s.common_name, {{ payload }}
  FROM species s, unnest(string_split(s.common_name, ' ')) WITH ORDINALITY AS w(word, pos)
  WHERE nullif(s.common_name, '') IS NOT NULL AND w.pos > 1 AND nullif(w.word, '') IS NOT NULL
  UNION ALL
  -- 4 and 5: each other common name, and each of its later words.
  SELECT lower(alt_name), alt_name, 4, alt_name, {{ payload }} FROM alt_names
  UNION ALL
  SELECT lower(w.word), a.alt_name, 5, a.alt_name, {{ payload }}
  FROM alt_names a, unnest(string_split(a.alt_name, ' ')) WITH ORDINALITY AS w(word, pos)
  WHERE w.pos > 1 AND nullif(w.word, '') IS NOT NULL
)
