/**
 * review/links: every assessment_link row, written for a person to read: the
 * Red List's side, CoL's side and the matcher's, each with the release it comes
 * from beside it, the decision with its reasons, the records it counts, and the
 * evidence for checking it. assessment_link holds ids for the stages that read
 * it; this is the same rows with the names. Rebuilt every sync; not published.
 *
 * Built from: assessments, assessment_link, matches, taxa, usage_owner,
 * occurrences, rank_aliases; the releases from the sync.
 *
 * Columns, in groups, the ones a review reads first at the front:
 *   at a glance    redlist_name, redlist_authority, col_taxon_name,
 *                  col_taxon_authorship, col_taxon_rank, col_species_name,
 *                  verdict, counted, records, name_reason, reason, signals, stratum
 *   the Red List   sis_taxon_id, redlist_release, category, taxon_group, class,
 *                  order, family, assessment_date
 *   CoL            role (primary | covered), col_xr, col_taxon_id, col_taxon_name,
 *                  col_taxon_authorship, col_taxon_rank, col_taxon_status
 *                  (the taxon it is), col_species_id, col_species_name,
 *                  col_species_authorship (the species that taxon is in),
 *                  col_described_year
 *   the decision   verdict, method, basis, decided_by, name_reason (why this
 *                  name), reason (what it makes the species), counted, records,
 *                  georeferenced_records (what this row counts)
 *   the matcher    matcher_version, matcher_name, matcher_authorship,
 *                  matcher_status, match_type, confidence, matcher_score (its
 *                  answer for the name, primary rows; JSON points)
 *   the evidence   primary rows only. stratum: how the link was made, the unit an
 *                  error rate is measured per ('exact', 'synonym', 'decision',
 *                  'unmatched'). genus_differs, epithet_differs (the Red List
 *                  name against the CoL species', as written, so spelling variants
 *                  count), class_differs, order_differs (through rank_aliases: a
 *                  known renaming is no difference), family_differs,
 *                  author_year_differs (both give a year and they differ),
 *                  iucn_lists_col_name (IUCN's own synonyms include CoL's name:
 *                  it knows the name and treats it as this species),
 *                  described_after_assessment (CoL's species is newer than the
 *                  assessment: a likely lag), lumped_with (how many other assessed
 *                  species link to the same CoL species), signals (how many of
 *                  those hold), sample_rank (a fixed random order within the
 *                  stratum: reviewing ranks 1..n is a random sample of n)
 *
 * Decisions:
 *   - Evidence, not verdicts: a difference is a reason to look. The comparisons
 *     are raw, looser than the CoL-differences card's: for finding links to
 *     check, a false alarm costs a look, a missed one a wrong link.
 *   - Sorted by stratum and sample_rank, so the first rows of each stratum are its
 *     random sample.
 */
import { lit, openDuckDB } from "../sql";
import { output, parquet, type Tables } from "../paths";

export interface Releases { redlist: string; colXr: string }

export async function buildReviewLinks(T: Tables, releases: Releases): Promise<number> {
  const conn = await openDuckDB();
  await conn.run(`CREATE OR REPLACE TEMP TABLE aliases AS SELECT * FROM ${parquet(T.rankAliases)}`);
  const sameRank = (rank: string, a: string, b: string) => `(${a} = ${b} OR EXISTS (SELECT 1 FROM aliases x WHERE x.rank = '${rank}'
     AND ((x.name = ${a} AND x.alias = ${b}) OR (x.name = ${b} AND x.alias = ${a}))))`;
  const year = (s: string) => `regexp_extract(${s}, '(1[7-9]\\d\\d|20\\d\\d)')`;
  await conn.run(`COPY (
    WITH latest AS (
      SELECT * FROM ${parquet(T.assessments)} WHERE is_latest
    ),
    taxa AS (SELECT col_id, scientific_name, authorship, rank, status, described_year, class_name, order_name, family FROM ${parquet(T.taxa)}),
    counts AS (
      SELECT w.sis_taxon_id, w.link_usage_id, sum(o.n)::BIGINT AS records, (sum(o.n) FILTER (o.georef))::BIGINT AS georeferenced_records
      FROM ${parquet(T.usageOwner)} w JOIN ${parquet(T.occurrences)} o ON o.usage_key = w.usage_key
      WHERE w.sis_taxon_id IS NOT NULL GROUP BY ALL
    ),
    lumps AS (
      SELECT col_species_id, count(DISTINCT sis_taxon_id) AS n FROM ${parquet(T.link)}
      WHERE role = 'primary' AND col_species_id IS NOT NULL GROUP BY 1
    ),
    rows AS (
      SELECT a.sis_taxon_id, ${lit(releases.redlist)} AS redlist_release, a.scientific_name AS redlist_name, a.authority AS redlist_authority,
             a.category, a.taxon_group, a.class_name AS class, a.order_name AS "order", a.family, a.assessment_date,
             l.role, ${lit(releases.colXr)} AS col_xr,
             l.col_taxon_id, tx.scientific_name AS col_taxon_name, tx.authorship AS col_taxon_authorship, tx.rank AS col_taxon_rank, tx.status AS col_taxon_status,
             l.col_species_id, sp.scientific_name AS col_species_name, sp.authorship AS col_species_authorship, sp.described_year AS col_described_year,
             l.verdict, l.method, l.basis, l.decided_by, l.name_reason, l.reason, l.counted,
             CASE WHEN l.counted THEN c.records END AS records, CASE WHEN l.counted THEN c.georeferenced_records END AS georeferenced_records,
             CASE WHEN l.role = 'primary' THEN m.matcher_version END AS matcher_version,
             CASE WHEN l.role = 'primary' THEN m.matcher_name END AS matcher_name,
             CASE WHEN l.role = 'primary' THEN m.matcher_authorship END AS matcher_authorship,
             CASE WHEN l.role = 'primary' THEN m.matcher_status END AS matcher_status,
             CASE WHEN l.role = 'primary' THEN m.match_type END AS match_type,
             CASE WHEN l.role = 'primary' THEN m.confidence END AS confidence,
             CASE WHEN l.role = 'primary' THEN m.matcher_score END AS matcher_score,
             -- for the evidence
             lower(a.scientific_name) AS iname, lower(sp.scientific_name) AS cname,
             lower(a.class_name) AS ic, lower(sp.class_name) AS cc, lower(a.order_name) AS io, lower(sp.order_name) AS co,
             lower(a.family) AS ifam, lower(sp.family) AS cfam, a.synonyms,
             coalesce(k.n, 1) - 1 AS lumps_with
      FROM ${parquet(T.link)} l
      JOIN latest a ON a.sis_taxon_id = l.sis_taxon_id
      LEFT JOIN taxa tx ON tx.col_id = l.col_taxon_id
      LEFT JOIN taxa sp ON sp.col_id = l.col_species_id
      LEFT JOIN ${parquet(T.matches)} m ON m.sis_taxon_id = l.sis_taxon_id
      LEFT JOIN counts c ON c.sis_taxon_id = l.sis_taxon_id AND c.link_usage_id = l.col_taxon_id
      LEFT JOIN lumps k ON k.col_species_id = l.col_species_id
    ),
    evidence AS (
      SELECT *,
        CASE WHEN role = 'primary' THEN
          CASE WHEN col_species_id IS NULL THEN 'unmatched' WHEN basis = 'decision' THEN 'decision'
               WHEN method = 'accepted' THEN 'exact' ELSE method END END AS stratum,
        role = 'primary' AND col_species_id IS NOT NULL AS judged,
        coalesce(CASE WHEN col_taxon_id <> col_species_id THEN col_taxon_authorship END, col_species_authorship) AS col_authorship
      FROM rows
    ),
    signals AS (
      SELECT *,
        CASE WHEN judged THEN split_part(iname, ' ', 1) <> split_part(cname, ' ', 1) END AS genus_differs,
        CASE WHEN judged THEN split_part(iname, ' ', 2) <> split_part(cname, ' ', 2) END AS epithet_differs,
        CASE WHEN judged THEN ic IS NOT NULL AND cc IS NOT NULL AND NOT ${sameRank("class", "ic", "cc")} END AS class_differs,
        CASE WHEN judged THEN io IS NOT NULL AND co IS NOT NULL AND NOT ${sameRank("order", "io", "co")} END AS order_differs,
        CASE WHEN judged THEN ifam IS NOT NULL AND cfam IS NOT NULL AND ifam <> cfam END AS family_differs,
        CASE WHEN judged THEN ${year("redlist_authority")} <> '' AND ${year("col_authorship")} <> ''
          AND ${year("redlist_authority")} <> ${year("col_authorship")} END AS author_year_differs,
        CASE WHEN judged THEN list_contains(list_transform(coalesce(synonyms, []), lambda x: lower(x.name)), cname) END AS iucn_lists_col_name,
        CASE WHEN judged THEN col_described_year IS NOT NULL AND assessment_date IS NOT NULL
          AND col_described_year > year(assessment_date) END AS described_after_assessment,
        CASE WHEN judged THEN lumps_with END AS lumped_with
      FROM evidence
    )
    SELECT
           -- 1. at a glance: what each side calls it, what was decided, and why
           redlist_name, redlist_authority, col_taxon_name, col_taxon_authorship, col_taxon_rank, col_species_name,
           verdict, counted, records, name_reason, reason,
           CASE WHEN judged THEN genus_differs::INT + epithet_differs::INT + class_differs::INT + order_differs::INT + family_differs::INT
             + author_year_differs::INT + (lumped_with > 0)::INT END AS signals,
           stratum,
           -- 2. the Red List
           sis_taxon_id, redlist_release, category, taxon_group, class, "order", family, assessment_date,
           -- 3. CoL
           role, col_xr, col_taxon_id, col_taxon_status, col_species_id, col_species_authorship, col_described_year,
           -- 4. the decision
           method, basis, decided_by, georeferenced_records,
           -- 5. the matcher
           matcher_version, matcher_name, matcher_authorship, matcher_status, match_type, confidence, matcher_score,
           -- 6. the evidence
           genus_differs, epithet_differs, class_differs, order_differs, family_differs, author_year_differs,
           iucn_lists_col_name, described_after_assessment, lumped_with,
           CASE WHEN role = 'primary' THEN row_number() OVER (PARTITION BY stratum, role = 'primary' ORDER BY hash(sis_taxon_id, 'link-audit-v1')) END AS sample_rank
    FROM signals
    ORDER BY role DESC, stratum, sample_rank, sis_taxon_id, col_species_id
  ) TO ${lit(output(T.reviewLinks))} (FORMAT parquet, COMPRESSION zstd)`);
  const [r] = (await conn.runAndReadAll(`SELECT count(*) AS n FROM ${parquet(T.reviewLinks)}`)).getRowObjects();
  return Number(r.n);
}
