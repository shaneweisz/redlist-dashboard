/**
 * link_audit (a dbt analysis: compiled against a build on demand, never built by
 * the sync): one row per assessed species, with how its CoL link was made and
 * the evidence for checking it: where IUCN and CoL agree, where they differ, and
 * whether a difference looks like our link going wrong or a real taxonomic one
 * (a lag, or a disagreement between authorities). It decides nothing; it is what
 * a reviewer, a person or an agent, works from.
 *
 * Built from: assessments (the latest, with IUCN's authority and synonyms),
 * assessment_link (the primary row), taxa, rank_aliases.
 *
 * Run it from app/scripts/sync/dbt, against a build (the versions it holds for
 * are the build's sync.json):
 *   uv run dbt show --profiles-dir . --select link_audit --limit 20
 *
 * Columns:
 *   sis_taxon_id, iucn_name, iucn_authority, taxon_group, assessment_date
 *   stratum          how the link was made, the unit the accuracy is measured
 *                    per: 'exact' (the Red List name is an accepted CoL species),
 *                    'synonym' (a CoL synonym, linked to the species it points
 *                    to), 'decision' (decisions.tsv), or
 *                    'unmatched'
 *   decided_by       who decided it, for a decision ('heuristic' when carried
 *                    over from the old name-matching passes, unreviewed)
 *   col_id           the CoL species it is linked to
 *   col_name, col_authorship        that species, as CoL accepts it
 *   matched_name, matched_authorship  the CoL record the Red List name matched,
 *                    when that is a synonym of col_name
 *   col_described_year  the year CoL gives for the species' description
 *   lumped_with      how many other assessed species share the CoL species
 *   genus_differs, epithet_differs     between the Red List name and col_name
 *                    (as written, lowercased: spelling variants count too)
 *   class_differs, order_differs, family_differs
 *                    between IUCN's and CoL's placement, order and class through
 *                    rank_aliases (a known renaming is not a difference)
 *   author_year_differs  both authorities give a year, and the years differ
 *   iucn_lists_col_name  IUCN's own synonym list for the species includes the
 *                    name CoL accepts: IUCN knows CoL's name and treats it as the
 *                    same species, which backs the link and points to a choice of
 *                    authority rather than an error
 *   described_after_assessment  CoL's species was described after the
 *                    assessment: the taxonomy moved on since (a likely lag)
 *   signals          how many of the differences above hold
 *   sample_rank      the species' place in a fixed random order within its
 *                    stratum: reviewing ranks 1..n is a random sample of n, the
 *                    same every sync, so an error rate can be measured per stratum
 *
 * Decisions:
 *   - Evidence, not verdicts: a difference is a reason to look, and the same
 *     columns serve the review queue and, later, the CoL-differences card.
 *   - Raw comparisons, deliberately looser than the card's (which folds
 *     orthographic variants): for finding links to check, a false alarm costs a
 *     look, a missed one costs a wrong link.
 */

WITH latest AS (
  SELECT sis_taxon_id, scientific_name, authority, taxon_group, assessment_date, class_name, order_name, family, synonyms
  FROM {{ source('sources', 'assessments') }} WHERE is_latest
),
link AS (
  SELECT sis_taxon_id, any_value(col_id) AS col_id, any_value(usage_id) AS usage_id, any_value(method) AS method,
         any_value(basis) AS basis, any_value(decided_by) AS decided_by
  FROM {{ source('link', 'assessment_link') }} WHERE role = 'primary' GROUP BY sis_taxon_id
),
taxa AS (SELECT * FROM {{ source('sources', 'taxa') }}),
aliases AS (SELECT * FROM {{ source('sources', 'rank_aliases') }}),
lumps AS (
  SELECT col_id, count(DISTINCT sis_taxon_id) AS n FROM {{ source('link', 'assessment_link') }}
  WHERE role = 'primary' AND col_id IS NOT NULL GROUP BY col_id
),
joined AS (
  SELECT a.sis_taxon_id, a.scientific_name AS iucn_name, a.authority AS iucn_authority, a.taxon_group, a.assessment_date,
         CASE WHEN l.col_id IS NULL THEN 'unmatched'
              WHEN l.basis = 'decision' THEN 'decision'
              WHEN l.method = 'accepted' THEN 'exact'
              ELSE l.method END AS stratum,
         CASE WHEN l.basis = 'decision' THEN l.decided_by END AS decided_by,
         l.col_id, s.scientific_name AS col_name, s.authorship AS col_authorship,
         CASE WHEN m.col_id <> s.col_id THEN m.scientific_name END AS matched_name,
         CASE WHEN m.col_id <> s.col_id THEN m.authorship END AS matched_authorship,
         s.described_year AS col_described_year,
         coalesce(k.n, 1) - 1 AS lumped_with,
         lower(a.scientific_name) AS iname, lower(s.scientific_name) AS cname,
         lower(a.class_name) AS ic, lower(s.class_name) AS cc, lower(a.order_name) AS io, lower(s.order_name) AS co,
         lower(a.family) AS ifam, lower(s.family) AS cfam,
         a.synonyms
  FROM latest a
  LEFT JOIN link l USING (sis_taxon_id)
  LEFT JOIN taxa s ON s.col_id = l.col_id
  LEFT JOIN taxa m ON m.col_id = l.usage_id
  LEFT JOIN lumps k ON k.col_id = l.col_id
),
-- Two names for one rank agree when they are equal or one is the other's known alias.
{%- macro same_rank(rank, a, b) -%}
  ({{ a }} = {{ b }} OR EXISTS (SELECT 1 FROM aliases x WHERE x.rank = '{{ rank }}'
     AND ((x.name = {{ a }} AND x.alias = {{ b }}) OR (x.name = {{ b }} AND x.alias = {{ a }}))))
{%- endmacro %}
signals AS (
  SELECT *,
    col_id IS NOT NULL AND split_part(iname, ' ', 1) <> split_part(cname, ' ', 1) AS genus_differs,
    col_id IS NOT NULL AND split_part(iname, ' ', 2) <> split_part(cname, ' ', 2) AS epithet_differs,
    col_id IS NOT NULL AND ic IS NOT NULL AND cc IS NOT NULL AND NOT {{ same_rank('class', 'ic', 'cc') }} AS class_differs,
    col_id IS NOT NULL AND io IS NOT NULL AND co IS NOT NULL AND NOT {{ same_rank('order', 'io', 'co') }} AS order_differs,
    col_id IS NOT NULL AND ifam IS NOT NULL AND cfam IS NOT NULL AND ifam <> cfam AS family_differs,
    col_id IS NOT NULL AND regexp_extract(iucn_authority, '(1[7-9]\d\d|20\d\d)') <> ''
      AND regexp_extract(coalesce(matched_authorship, col_authorship), '(1[7-9]\d\d|20\d\d)') <> ''
      AND regexp_extract(iucn_authority, '(1[7-9]\d\d|20\d\d)') <> regexp_extract(coalesce(matched_authorship, col_authorship), '(1[7-9]\d\d|20\d\d)')
      AS author_year_differs,
    col_id IS NOT NULL AND list_contains(list_transform(coalesce(synonyms, []), lambda x: lower(x.name)), cname) AS iucn_lists_col_name,
    col_id IS NOT NULL AND col_described_year IS NOT NULL AND assessment_date IS NOT NULL
      AND col_described_year > year(assessment_date) AS described_after_assessment
  FROM joined
)
SELECT sis_taxon_id, iucn_name, iucn_authority, taxon_group, assessment_date, stratum, decided_by,
       col_id, col_name, col_authorship, matched_name, matched_authorship, col_described_year, lumped_with,
       genus_differs, epithet_differs, class_differs, order_differs, family_differs, author_year_differs,
       iucn_lists_col_name, described_after_assessment,
       genus_differs::INT + epithet_differs::INT + class_differs::INT + order_differs::INT + family_differs::INT
         + author_year_differs::INT + (lumped_with > 0)::INT AS signals,
       row_number() OVER (PARTITION BY stratum ORDER BY hash(sis_taxon_id, 'link-audit-v1')) AS sample_rank
FROM signals
