/**
 * build-assessments: the assessments core table, straight from the IUCN Red
 * List Postgres database, one row per global assessment of a current species.
 *
 * Replaces fetch-redlist-species' per-group CSVs and history JSON. One pass
 * over every species instead of one query per group, list columns as real
 * lists, and the Table 1a group as a column rather than a file layout.
 *
 * The database is somebody else's (see the repo's memory notes): the session
 * is opened with default_transaction_read_only=on, and the build refuses to
 * run unless Postgres confirms it.
 *
 * Columns, per assessment:
 *   sis_taxon_id, assessment_id, is_latest, year_published, assessment_date,
 *   category, criteria, possibly_extinct, possibly_extinct_in_the_wild,
 *   population_trend, countries[], systems[], growth_forms[], movement_pattern,
 *   threat_codes[], habitat_codes[], assessors, reviewers, facilitators,
 *   contributors, institutions
 * and the species' (latest taxon record), repeated on each of its rows:
 *   scientific_name, authority, common_name, kingdom_name … family (IUCN's, as
 *   lowercase), taxon_group, synonyms[{name, status}]
 *
 * Usage:  npx tsx scripts/sync/core/build-assessments.ts [--out DIR]
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles } from "../../lib/utils";
import { TAXA_DEFINITIONS } from "../../lib/taxa";
import { CORE_DIR } from "../paths";

/**
 * Mayaheros ericymba's only global assessment is an amendment, which the
 * database flags latest=false. IUCN's website and Table 1a count it.
 * https://www.iucnredlist.org/species/4840/288151174#amendment
 */
const FORCED_LATEST = [288151174];

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** A query run inside Postgres; DuckDB only sees its result. */
const pg = (sql: string) => `postgres_query('pg', ${lit(sql)})`;

const CURRENT_TAXON = `t.latest AND t.infra_name IS NULL AND t.subpopulation_name IS NULL`;
const GLOBAL_ASSESSMENT = `a.suppress = false AND EXISTS (
  SELECT 1 FROM assessment_scopes s WHERE s.assessment_id = a.id AND s.scope_lookup_id = 15)`;
const IN_SCOPE = `SELECT a.id FROM assessments a JOIN taxons t ON t.id = a.taxon_id WHERE ${CURRENT_TAXON} AND ${GLOBAL_ASSESSMENT}`;

/**
 * IUCN's group definitions (scripts/lib/taxa.ts) as SQL over the uppercased
 * columns k, p, c, o, plus a count of how many match (must be 1).
 */
const RANK_COL = { kingdom_name: "k", phylum_name: "p", class_name: "c", order_name: "o" } as const;
function groupSql(): { caseSql: string; matchCount: string } {
  const conds = TAXA_DEFINITIONS.map((t) => ({
    id: t.id,
    cond: t.redlist.map((q) => `${RANK_COL[q.filterColumn]} IN (${q.filterValues.map(lit).join(", ")})`).join(" OR "),
  }));
  return {
    caseSql: `CASE ${conds.map((c) => `WHEN ${c.cond} THEN ${lit(c.id)}`).join(" ")} END`,
    matchCount: conds.map((c) => `(CASE WHEN ${c.cond} THEN 1 ELSE 0 END)`).join(" + "),
  };
}

export async function attachRedList(conn: DuckDBConnection): Promise<void> {
  const env = (k: string, d?: string) => process.env[k] ?? d;
  const parts = [
    `host=${env("DB_HOST", "localhost")}`, `port=${env("DB_PORT", "5432")}`,
    `dbname=${env("DB_NAME", "redlist_2026_1")}`, `user=${env("DB_USER", process.env.USER)}`,
    ...(env("DB_PASSWORD") ? [`password=${env("DB_PASSWORD")}`] : []),
    `options='-c default_transaction_read_only=on -c statement_timeout=600000'`,
  ];
  await conn.run(`INSTALL postgres; LOAD postgres;`);
  await conn.run(`ATTACH ${lit(parts.join(" "))} AS pg (TYPE postgres, READ_ONLY)`);
  const [ro] = (await conn.runAndReadAll(
    `SELECT * FROM ${pg("SELECT current_setting('default_transaction_read_only') AS ro")}`)).getRowObjects();
  if (ro.ro !== "on") throw new Error("build-assessments: the Red List session is not read-only; refusing to continue.");
}

export async function buildAssessments(conn: DuckDBConnection, coreDir: string): Promise<string> {
  fs.mkdirSync(coreDir, { recursive: true });
  const out = path.join(coreDir, "assessments.parquet");
  const { caseSql, matchCount } = groupSql();

  await conn.run(`CREATE OR REPLACE TEMP TABLE a AS SELECT * FROM ${pg(`
    SELECT t.sis_id AS sis_taxon_id, a.id AS assessment_id,
           (a.latest OR a.id IN (${FORCED_LATEST.join(", ")})) AS latest_candidate,
           a.year_published, a.assessment_date::date AS assessment_date, rlc.code AS category, a.criteria,
           coalesce(a.possibly_extinct, false) AS possibly_extinct,
           coalesce(a.possibly_extinct_in_the_wild, false) AS possibly_extinct_in_the_wild,
           pt.code AS trend_code,
           (SELECT c.supplementary_fields->>'full' FROM assessment_credits c WHERE c.assessment_id = a.id AND c.credit_type_id = 1 ORDER BY c.id LIMIT 1) AS assessors,
           (SELECT c.supplementary_fields->>'full' FROM assessment_credits c WHERE c.assessment_id = a.id AND c.credit_type_id = 2 ORDER BY c.id LIMIT 1) AS reviewers,
           (SELECT c.supplementary_fields->>'full' FROM assessment_credits c WHERE c.assessment_id = a.id AND c.credit_type_id = 4 ORDER BY c.id LIMIT 1) AS facilitators,
           (SELECT c.supplementary_fields->>'full' FROM assessment_credits c WHERE c.assessment_id = a.id AND c.credit_type_id = 3 ORDER BY c.id LIMIT 1) AS contributors,
           (SELECT c.supplementary_fields->>'full' FROM assessment_credits c WHERE c.assessment_id = a.id AND c.credit_type_id = 5 ORDER BY c.id LIMIT 1) AS institutions
    FROM taxons t
    JOIN assessments a ON a.taxon_id = t.id
    JOIN red_list_category_lookup rlc ON rlc.id = a.red_list_category_id
    LEFT JOIN population_trend_lookup pt ON pt.id = a.population_trend_id
    WHERE ${CURRENT_TAXON} AND ${GLOBAL_ASSESSMENT}`)}`);

  await conn.run(`CREATE OR REPLACE TEMP TABLE sp AS SELECT * FROM ${pg(`
    SELECT t.sis_id AS sis_taxon_id, t.scientific_name, t.authority,
           lower(t.kingdom_name) AS kingdom_name, lower(t.phylum_name) AS phylum_name,
           lower(t.class_name) AS class_name, lower(t.order_name) AS order_name, lower(t.family_name) AS family,
           upper(t.kingdom_name) AS k, upper(t.phylum_name) AS p, upper(t.class_name) AS c, upper(t.order_name) AS o,
           (SELECT n.name FROM taxon_common_names n WHERE n.taxon_id = t.id AND n.language_id = 609 AND n.main
            ORDER BY n.id LIMIT 1) AS common_name
    FROM taxons t WHERE ${CURRENT_TAXON}
      -- A few species have a second, identical "latest" taxon record with no
      -- assessments (Rhantus fennicus, Amolops daorum); keep the one assessed.
      AND EXISTS (SELECT 1 FROM assessments a WHERE a.taxon_id = t.id AND ${GLOBAL_ASSESSMENT})`)}`);
  const [dup] = (await conn.runAndReadAll(
    `SELECT count(*) AS n FROM (SELECT sis_taxon_id FROM sp GROUP BY 1 HAVING count(*) > 1)`)).getRowObjects();
  if (Number(dup.n) > 0) throw new Error(`build-assessments: ${dup.n} species have more than one current assessed taxon record`);

  // Native, extant, country-level (two-letter) locations only.
  await conn.run(`CREATE OR REPLACE TEMP TABLE lists AS
    WITH c AS (SELECT * FROM ${pg(`
      SELECT al.assessment_id, array_agg(DISTINCT ll.code ORDER BY ll.code) AS countries
      FROM assessment_locations al JOIN location_lookup ll ON ll.id = al.location_id
      JOIN legend_lookup leg ON leg.id = al.legend_id
      WHERE al.assessment_id IN (${IN_SCOPE}) AND leg.origin = 'Native' AND leg.presence = 'Extant' AND length(ll.code) = 2
      GROUP BY 1`)}),
    s AS (SELECT * FROM ${pg(`
      SELECT x.assessment_id, array_agg(DISTINCT regexp_replace(l.description->>'en', ' \\(=.*\\)', '')) AS systems
      FROM assessment_systems x JOIN system_lookup l ON l.id = x.system_lookup_id
      WHERE x.assessment_id IN (${IN_SCOPE}) GROUP BY 1`)}),
    g AS (SELECT * FROM ${pg(`
      SELECT x.assessment_id, array_agg(DISTINCT l.description->>'en') AS growth_forms
      FROM assessment_growth_forms x JOIN growth_form_lookup l ON l.id = x.growth_form_id
      WHERE x.assessment_id IN (${IN_SCOPE}) GROUP BY 1`)}),
    m AS (SELECT * FROM ${pg(`
      SELECT assessment_id, max(supplementary_fields->>'MovementPatterns.pattern') AS movement_pattern
      FROM assessment_supplementary_infos
      WHERE assessment_id IN (${IN_SCOPE}) AND supplementary_fields->>'MovementPatterns.pattern' IS NOT NULL GROUP BY 1`)}),
    th AS (SELECT * FROM ${pg(`
      SELECT x.assessment_id, array_agg(DISTINCT l.code) AS threat_codes
      FROM assessment_threats x JOIN threat_lookup l ON l.id = x.threat_id
      WHERE x.assessment_id IN (${IN_SCOPE}) GROUP BY 1`)}),
    -- One code:season:suitability:major tuple per row, deduped on the whole
    -- tuple: a habitat can appear twice under different seasons.
    h AS (SELECT * FROM ${pg(`
      SELECT x.assessment_id, array_agg(DISTINCT l.code || ':' ||
               CASE x.supplementary_fields->>'season' WHEN 'Resident' THEN 'R' WHEN 'Breeding Season' THEN 'B'
                 WHEN 'Non-Breeding Season' THEN 'N' WHEN 'Passage' THEN 'P' WHEN 'Seasonal Occurrence Unknown' THEN 'U' ELSE '-' END || ':' ||
               CASE x.supplementary_fields->>'suitability' WHEN 'Suitable' THEN 'S' WHEN 'Marginal' THEN 'M' WHEN 'Unknown' THEN 'U' ELSE '-' END || ':' ||
               CASE x.supplementary_fields->>'majorImportance' WHEN 'Yes' THEN '1' WHEN 'No' THEN '0' ELSE '-' END) AS habitat_codes
      FROM assessment_habitats x JOIN habitat_lookup l ON l.id = x.habitat_id
      WHERE x.assessment_id IN (${IN_SCOPE}) GROUP BY 1`)})
    SELECT a.assessment_id, c.countries, s.systems, g.growth_forms, m.movement_pattern, th.threat_codes, h.habitat_codes
    FROM a LEFT JOIN c USING (assessment_id) LEFT JOIN s USING (assessment_id) LEFT JOIN g USING (assessment_id)
    LEFT JOIN m USING (assessment_id) LEFT JOIN th USING (assessment_id) LEFT JOIN h USING (assessment_id)`);

  // IUCN synonyms. A binomial claimed by more than one current species (as a
  // synonym of one and the name of another, or a synonym of both halves of a
  // split) is dropped: it can't say which species it means. The same name filed
  // twice under different statuses (Bufo arunco, A and ADD) is kept once; the
  // status is never read for meaning.
  await conn.run(`CREATE OR REPLACE TEMP TABLE syn AS
    WITH raw AS (SELECT * FROM ${pg(`
      SELECT t.sis_id, ts.genus_name AS g, ts.species_name AS s, ts.status
      FROM taxon_synonyms ts JOIN taxons t ON t.id = ts.taxon_id
      WHERE ${CURRENT_TAXON} AND ts.genus_name IS NOT NULL AND ts.species_name IS NOT NULL
        AND ts.infra_name IS NULL AND ts.status NOT IN ('DELETE', 'D')`)}),
    -- Every current taxon's name can claim, assessed or not. A claim is the
    -- (genus, species) pair as IUCN stores it, stray whitespace included.
    canon AS (SELECT * FROM ${pg(`
      SELECT sis_id, split_part(scientific_name, ' ', 1) AS g, split_part(scientific_name, ' ', 2) AS s
      FROM taxons t WHERE ${CURRENT_TAXON} AND scientific_name !~ ' [x×] ' AND position('(' in scientific_name) = 0`)}),
    claims AS (SELECT g, s, count(DISTINCT sis_id) AS n FROM (
                 SELECT sis_id, g, s FROM raw UNION ALL SELECT sis_id, g, s FROM canon) GROUP BY g, s),
    one AS (SELECT r.sis_id, r.g || ' ' || r.s AS name, min(r.status) AS status
            FROM raw r JOIN claims c ON c.g = r.g AND c.s = r.s WHERE c.n = 1 GROUP BY 1, 2)
    SELECT o.sis_id AS sis_taxon_id, list({'name': o.name, 'status': o.status} ORDER BY o.name) AS synonyms
    FROM one o JOIN sp ON sp.sis_taxon_id = o.sis_id WHERE o.name <> sp.scientific_name GROUP BY 1`);

  await conn.run(`ALTER TABLE sp ADD COLUMN taxon_group VARCHAR; UPDATE sp SET taxon_group = ${caseSql}`);

  // Every current species must fall in exactly one Table 1a group.
  const coverage = (await conn.runAndReadAll(`
    SELECT k, p, c, o, ${matchCount} AS hits, count(*) AS n
    FROM sp WHERE sis_taxon_id IN (SELECT sis_taxon_id FROM a WHERE latest_candidate)
    GROUP BY ALL HAVING hits <> 1 ORDER BY n DESC`)).getRowObjects();
  if (coverage.length > 0) {
    const lines = coverage.map((r) => `  ${r.k}/${r.p}/${r.c}/${r.o}: ${r.n} species in ${r.hits} groups`);
    throw new Error(`build-assessments: species outside exactly one Table 1a group:\n${lines.join("\n")}`);
  }

  // Dotted codes sort numerically ("1.2" before "1.10"); a habitat tuple's
  // suffix breaks ties.
  const sortCodes = (col: string) => `CASE WHEN ${col} IS NULL THEN NULL ELSE (
      SELECT list(x ORDER BY list_transform(string_split(split_part(x, ':', 1), '.'), lambda p: TRY_CAST(p AS INTEGER)), x)
      FROM (SELECT unnest(${col}) AS x)) END`;

  await conn.run(`COPY (
    WITH latest AS (
      SELECT assessment_id FROM (
        SELECT assessment_id, row_number() OVER (PARTITION BY sis_taxon_id ORDER BY assessment_date DESC, assessment_id DESC) AS rn
        FROM a WHERE latest_candidate) WHERE rn = 1)
    SELECT a.sis_taxon_id, a.assessment_id, a.assessment_id IN (SELECT assessment_id FROM latest) AS is_latest,
           a.year_published, a.assessment_date, a.category, nullif(a.criteria, '') AS criteria,
           a.possibly_extinct, a.possibly_extinct_in_the_wild,
           CASE a.trend_code WHEN '0' THEN 'Increasing' WHEN '1' THEN 'Decreasing' WHEN '2' THEN 'Stable' WHEN '3' THEN 'Unknown' END AS population_trend,
           l.countries, list_sort(l.systems) AS systems, list_sort(l.growth_forms) AS growth_forms, l.movement_pattern,
           ${sortCodes("l.threat_codes")} AS threat_codes, ${sortCodes("l.habitat_codes")} AS habitat_codes,
           nullif(a.assessors, '') AS assessors, nullif(a.reviewers, '') AS reviewers, nullif(a.facilitators, '') AS facilitators,
           nullif(a.contributors, '') AS contributors, nullif(a.institutions, '') AS institutions,
           sp.scientific_name,
           -- IUCN stores authorities with HTML entities ("Temminck &amp; Schlegel").
           replace(replace(replace(replace(replace(replace(sp.authority,
             '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&apos;', '''') AS authority,
           sp.common_name, sp.kingdom_name, sp.phylum_name, sp.class_name, sp.order_name, sp.family,
           sp.taxon_group,
           coalesce(syn.synonyms, []) AS synonyms
    FROM a
    JOIN sp USING (sis_taxon_id)
    LEFT JOIN lists l USING (assessment_id)
    LEFT JOIN syn USING (sis_taxon_id)
    ORDER BY a.sis_taxon_id, a.year_published DESC, a.assessment_id DESC
  ) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);
  return out;
}

export async function run(opts: { out?: string } = {}): Promise<string> {
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "8" })).connect();
  await attachRedList(conn);
  const out = await buildAssessments(conn, opts.out ?? CORE_DIR);
  const [s] = (await conn.runAndReadAll(`SELECT count(*) AS n, count(*) FILTER (is_latest) AS latest,
      count(DISTINCT sis_taxon_id) AS species, max(year_published) AS newest FROM read_parquet(${lit(out)})`)).getRowObjects();
  console.log(`Wrote ${out}: ${Number(s.n).toLocaleString()} assessments, ${Number(s.latest).toLocaleString()} latest, ` +
    `${Number(s.species).toLocaleString()} species, newest published ${s.newest}`);
  return out;
}

const isDirectRun = process.argv[1]?.endsWith("core/build-assessments.ts") || process.argv[1]?.endsWith("core/build-assessments.js");
if (isDirectRun) {
  loadEnvFiles();
  const i = process.argv.indexOf("--out");
  run({ out: i >= 0 ? process.argv[i + 1] : undefined }).catch((e) => { console.error(e); process.exit(1); });
}
