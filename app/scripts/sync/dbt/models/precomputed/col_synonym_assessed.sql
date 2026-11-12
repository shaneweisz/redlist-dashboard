/**
 * taxonomy/col-synonym-assessed: one row per Not Evaluated species that an
 * assessed species names as its synonym. The other half of "why is this species
 * Not Evaluated": CoL files an IUCN-assessed name among this species' synonyms,
 * so IUCN has assessed the taxon, under a name CoL doesn't accept.
 *
 * Built from: taxonomy/taxa, lists/assessed, assessment_link.
 *
 * Columns:
 *   ne_col_id        the Not Evaluated CoL species
 *   assessed_id, assessed_name, assessed_category
 *                    the assessed species filed among its synonyms
 *
 * Decisions:
 *   - col_split_candidates catches a promoted subspecies; this is the same shape
 *     one rank up: a species-rank synonym IUCN has assessed (CoL files Epidendrum
 *     paniculatum, assessed DD, as a synonym of the unassessed E. diffusum).
 *   - status = 'synonym' exactly: 'ambiguous synonym' is CoL saying the name's
 *     application is uncertain, the opposite of evidence they are one taxon.
 *   - One assessed species per Not Evaluated one, or no claim: CoL can file two
 *     names IUCN assesses separately under one species, and picking one would
 *     present a coin toss as a finding.
 */
WITH assessed_cids AS (SELECT DISTINCT col_species_id AS col_id FROM {{ source('link', 'assessment_link') }} WHERE col_species_id IS NOT NULL AND method <> 'undecided_candidate'),
species_synonyms AS (
  SELECT b.parent_id AS ne_col_id, lower(b.scientific_name) AS lname
  FROM {{ ref('app_taxa') }} b
  WHERE b.status = 'synonym' AND b.rank = 'species' AND b.parent_id IS NOT NULL
),
-- Only names IUCN has assessed, and only under accepted records counted as NE
-- (an assessed parent would make this a match, not an explanation for a gap).
matched AS (
  SELECT ss.ne_col_id, a.id AS assessed_id, a.scientific_name AS assessed_name, a.iucn_category AS assessed_category
  FROM species_synonyms ss
  JOIN {{ ref('assessed') }} a ON lower(a.scientific_name) = ss.lname
  WHERE ss.ne_col_id NOT IN (SELECT col_id FROM assessed_cids)
)
SELECT ne_col_id, any_value(assessed_id) AS assessed_id, any_value(assessed_name) AS assessed_name,
       any_value(assessed_category) AS assessed_category
FROM matched
GROUP BY ne_col_id
HAVING count(DISTINCT assessed_id) = 1
