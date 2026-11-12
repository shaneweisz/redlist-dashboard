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
 *   may_be_assessed                the assessed species it may be, ';'-joined: ones
 *                                  whose link is flagged or waiting and whose
 *                                  name leads here (a candidate row); else NULL
 *
 * Decisions:
 *   - Not Evaluated: described (species/), linked by no assessment_link row of
 *     any kind (primary, covered, even refused) except a candidate, and with
 *     GBIF records. A candidate's species is listed, flagged with may_be_assessed:
 *     hiding it would be a guess that it is the assessed one.
 *   - Common name: iNaturalist's, else CoL's.
 */

-- A record's country is its countrycode, which GBIF fills from coordinates or
-- from what the publisher wrote, so an all-records country list is longer.
WITH ne_countries AS (
  SELECT o.col_id,
         string_agg(DISTINCT c.countrycode, ';' ORDER BY c.countrycode) FILTER (c.georef) AS countries,
         string_agg(DISTINCT c.countrycode, ';' ORDER BY c.countrycode) AS all_records_countries
  FROM {{ source('sources', 'occurrence_countries') }} c JOIN {{ ref('usage_owner') }} o ON o.usage_key = c.usage_key
  WHERE o.col_id IS NOT NULL GROUP BY 1
),
candidates AS (
  SELECT l.col_species_id AS col_id, string_agg(DISTINCT a.scientific_name, ';' ORDER BY a.scientific_name) AS may_be_assessed
  FROM {{ source('link', 'assessment_link') }} l
  JOIN {{ source('sources', 'assessments') }} a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
  WHERE l.method = 'undecided_candidate' GROUP BY 1
)
SELECT s.col_id AS id, s.col_id, s.scientific_name,
       coalesce(inat.name, col.name) AS common_name,
       s.taxon_group, s.class_name, s.order_name, s.family, 'NE' AS iucn_category,
       c.countries, c.all_records_countries AS gbif_all_records_countries,
       s.col_id AS gbif_species_key,
       rc.georef AS gbif_georeferenced_records_count, rc.all_records AS gbif_all_records_count,
       cand.may_be_assessed
FROM {{ ref('species') }} s
JOIN {{ ref('record_counts') }} rc ON rc.col_id = s.col_id
LEFT JOIN ne_countries c ON c.col_id = s.col_id
LEFT JOIN candidates cand ON cand.col_id = s.col_id
LEFT JOIN {{ source('sources', 'common_names') }} col ON col.source = 'col' AND col.kind = 'display' AND col.col_id = s.col_id
LEFT JOIN {{ source('sources', 'common_names') }} inat ON inat.source = 'inat' AND inat.kind = 'display'
  AND inat.scientific_name = s.scientific_name AND inat.kingdom = {{ inat_kingdom("s.taxon_group") }}
WHERE s.described
  AND s.col_id NOT IN (SELECT col_species_id FROM {{ source('link', 'assessment_link') }} WHERE col_species_id IS NOT NULL AND method <> 'undecided_candidate')
