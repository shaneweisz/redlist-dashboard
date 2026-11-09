/**
 * lists/ne: one row per Not Evaluated species GBIF has records for, keyed by
 * col_id, which is also its GBIF key. Looked up by that key (the map's
 * tooltips, nearby species, search), which species/'s partitions can't prune.
 *
 * Built from: species/, assessment_link, record_counts, occurrence_countries
 * with usage_owner, common_names.
 *
 * Columns:
 *   id, col_id, gbif_species_key   the CoL id, three times: the app reads each
 *                                  name in a different place
 *   scientific_name, common_name, taxon_group, class_name, order_name, family
 *   iucn_category                  'NE'
 *   countries                      GBIF countries of its georeferenced records
 *   gbif_all_records_countries     … of all its records
 *   gbif_georeferenced_records_count, gbif_all_records_count
 *   gbif_live_key                  the id GBIF's live index uses for it, where
 *                                  that differs (live_keys). NULL most months
 *
 * Decisions:
 *   - Not Evaluated: described (species/), linked by no assessment_link row of
 *     any kind (primary, covered, even refused), and with GBIF records.
 *   - Common name: iNaturalist's, else CoL's.
 */

-- A record's country is its countrycode, which GBIF fills from coordinates or
-- from what the publisher wrote, so an all-records country list is longer.
WITH ne_countries AS (
  SELECT o.col_id,
         string_agg(DISTINCT c.countrycode, ';' ORDER BY c.countrycode) FILTER (c.georef) AS countries,
         string_agg(DISTINCT c.countrycode, ';' ORDER BY c.countrycode) AS all_records_countries
  FROM {{ source('core', 'occurrence_countries') }} c JOIN {{ ref('usage_owner') }} o ON o.usage_key = c.usage_key
  WHERE o.col_id IS NOT NULL GROUP BY 1
)
SELECT s.col_id AS id, s.col_id, s.scientific_name,
       coalesce(inat.name, col.name) AS common_name,
       s.taxon_group, s.class_name, s.order_name, s.family, 'NE' AS iucn_category,
       c.countries, c.all_records_countries AS gbif_all_records_countries,
       s.col_id AS gbif_species_key,
       rc.georef AS gbif_georeferenced_records_count, rc.all_records AS gbif_all_records_count,
       live.live_key AS gbif_live_key
FROM {{ ref('species') }} s
LEFT JOIN {{ source('core', 'live_keys') }} live ON live.kind = 'species' AND live.id = s.col_id
JOIN {{ ref('record_counts') }} rc ON rc.col_id = s.col_id
LEFT JOIN ne_countries c ON c.col_id = s.col_id
LEFT JOIN {{ source('core', 'common_names') }} col ON col.source = 'col' AND col.kind = 'display' AND col.col_id = s.col_id
LEFT JOIN {{ source('core', 'common_names') }} inat ON inat.source = 'inat' AND inat.kind = 'display'
  AND inat.scientific_name = s.scientific_name AND inat.kingdom = {{ inat_kingdom("s.taxon_group") }}
WHERE s.described
  AND s.col_id NOT IN (SELECT col_id FROM {{ source('core', 'assessment_link') }} WHERE col_id IS NOT NULL)
