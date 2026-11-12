/**
 * usage_owner: one row per CoL usage whose GBIF records count for a species,
 * naming that species. This table is the counting rule: every GBIF number on
 * the dashboard is a sum of occurrences joined to it.
 *
 * Built from: taxa, assessment_link.
 *
 * Columns:
 *   usage_key       a taxa.col_id; the occurrences' usage_key
 *   sis_taxon_id    the assessed species its records count for, else NULL
 *   link_usage_id   the assessment_link row it counts through (that row's
 *                   col_taxon_id), for an assessed species
 *   col_id          the unassessed CoL species its records count for, else NULL
 *
 * Decisions, in order (the first that applies decides):
 *   1. A lumped species owns its own usage and everything under it (three levels
 *      down: the deepest case in the current release is three). Roots can nest:
 *      Zosterops simplex owns both the subspecies Z. japonicus simplex and the
 *      synonym Z. simplex filed under it, so a usage goes to the nearest root
 *      claiming it, and of two lumped species reaching it, the one whose own
 *      name it is.
 *   2. Otherwise a usage counts for its species (taxa.species_id): its own name,
 *      its synonyms, its subspecies, their BINs. If an assessed species' counted
 *      "own" link row is that species, for the assessed species.
 *   3. Otherwise, if no link row names that species at all (a candidate row,
 *      what an unconfirmed or waiting species might be, doesn't count), for the
 *      species itself, unassessed. A species linked only by rows that don't count
 *      (counts nothing) counts for no one.
 *
 * Checks: each usage has at most one owner. A violation means a number
 * somewhere is inflated, so the sync stops.
 */

-- 1. What each lumped species owns.
WITH RECURSIVE down(sis, root, usage_key, depth) AS (
  SELECT sis_taxon_id, col_taxon_id, col_taxon_id, 0 FROM {{ source('link', 'assessment_link') }} WHERE counts = 'only records under its own name'
  UNION ALL
  SELECT d.sis, d.root, t.col_id, d.depth + 1 FROM down d JOIN {{ source('sources', 'taxa') }} t ON t.parent_id = d.usage_key WHERE d.depth < 3
),
lumped AS (
  SELECT sis, root, usage_key FROM down
  QUALIFY row_number() OVER (PARTITION BY usage_key ORDER BY depth, sis, root) = 1
),
link AS (SELECT * FROM {{ source('link', 'assessment_link') }}),
taxa AS (SELECT col_id, parent_id, species_id FROM {{ source('sources', 'taxa') }})

-- Every claim on a usage; the tests check there is one per usage.
SELECT usage_key, sis AS sis_taxon_id, root AS link_usage_id, NULL::VARCHAR AS col_id FROM lumped
UNION ALL
-- 2. A species' usages, for the assessed species whose own row it is.
SELECT t.col_id, l.sis_taxon_id, l.col_taxon_id, NULL
FROM taxa t JOIN link l ON l.col_taxon_id = t.species_id AND l.counts = 'the whole CoL species'
WHERE t.col_id NOT IN (SELECT usage_key FROM lumped)
UNION ALL
-- 3. A species no link row names: its own.
SELECT t.col_id, NULL, NULL, t.species_id
FROM taxa t
WHERE t.species_id IS NOT NULL
  AND t.col_id NOT IN (SELECT usage_key FROM lumped)
  AND t.species_id NOT IN (SELECT col_species_id FROM link WHERE col_species_id IS NOT NULL AND method <> 'undecided_candidate')
