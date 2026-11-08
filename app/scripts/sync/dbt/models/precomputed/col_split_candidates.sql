/**
 * taxonomy/col-split-candidates: one row per Not Evaluated species CoL likely
 * split from an assessed one: an infraspecific name, now a synonym, that
 * resolves to it. The CoL-differences card reads it ("likely split from …").
 *
 * Built from: taxonomy/taxa, lists/assessed, assessment_link.
 *
 * Columns:
 *   ne_col_id        the Not Evaluated CoL species
 *   parent_id, parent_name, parent_category
 *                    the assessed species the old name belonged to
 *   rn               1 for the likeliest parent (the lowest SIS id) when several
 *
 * Decisions:
 *   - A heuristic: CoL keeps an old infraspecific name as a synonym when it
 *     promotes one to a species, so the card words it as likely, never as fact.
 *   - It catches only the "was a named subspecies, got promoted" pattern, the
 *     common one in recent Bovidae and Giraffidae splits.
 *   - One hop further where CoL points the old name at the new species' own
 *     nominate subspecies rather than the species (Giraffa camelopardalis
 *     tippelskirchi → Giraffa tippelskirchi tippelskirchi): an accepted
 *     infraspecific parent resolves to its species.
 *
 * Worked example: Vallonia costata (IUCN LC, CoL 7FDLW). CoL holds six old
 * infraspecific names under it, each a synonym. Three now point at other
 * accepted species IUCN hasn't assessed (V. patens, V. parvula, V. gracilicosta),
 * so those three are flagged; two resolve back to V. costata itself (assessed,
 * so not Not Evaluated) and one to an extinct species (outside the universe).
 * CoL shows the evidence only from the new species' page: V. gracilicosta lists
 * "Vallonia costata var. montana Sterki, 1893" among its synonyms.
 */
WITH taxa AS (SELECT * FROM {{ ref('app_taxa') }}),
assessed_cids AS (SELECT DISTINCT col_id FROM {{ source('core', 'assessment_link') }} WHERE col_id IS NOT NULL),
synonym_rows AS (
  SELECT b.parent_id AS direct_parent_id,
         split_part(b.scientific_name, ' ', 1) || ' ' || split_part(b.scientific_name, ' ', 2) AS parent_binomial
  FROM taxa b
  WHERE b.status = 'synonym' AND b.rank IN ('subspecies', 'infraspecific name', 'variety')
),
resolved AS (
  SELECT CASE
           WHEN p.rank = 'species' THEN p.col_id
           WHEN p.rank IN ('subspecies', 'infraspecific name', 'variety')
                AND p.status IN ('accepted', 'provisionally accepted') THEN p.parent_id
         END AS ne_col_id,
         sr.parent_binomial
  FROM synonym_rows sr JOIN taxa p ON p.col_id = sr.direct_parent_id
),
candidate_synonyms AS (
  SELECT ne_col_id, parent_binomial FROM resolved
  WHERE ne_col_id IS NOT NULL AND ne_col_id NOT IN (SELECT col_id FROM assessed_cids)
),
matched AS (
  SELECT DISTINCT cs.ne_col_id, a.id AS parent_id, a.scientific_name AS parent_name, a.iucn_category AS parent_category
  FROM candidate_synonyms cs
  JOIN {{ ref('assessed') }} a ON lower(a.scientific_name) = lower(cs.parent_binomial)
)
SELECT ne_col_id, parent_id, parent_name, parent_category,
       row_number() OVER (PARTITION BY ne_col_id ORDER BY parent_id) AS rn
FROM matched
