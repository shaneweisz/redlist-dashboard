/**
 * taxonomy/vernacular-names.json: one common name per class, order, family and
 * genus name, for the taxonomy tree's labels ("Browse Adansonia (Baobabs)").
 *
 * Built from: common_names (CoL's display names above species rank).
 *
 * Shape: { "<lowercased scientific name>": "<common name>" }
 *
 * One name per scientific name, chosen in sources/common-names.ts. dbt keeps
 * the pairs as a table; the export step writes them as one JSON object.
 */

SELECT lower(scientific_name) AS key, name FROM {{ source('sources', 'common_names') }}
WHERE source = 'col' AND kind = 'display' AND rank IN ('class', 'order', 'family', 'genus')
