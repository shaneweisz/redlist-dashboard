/**
 * check-fixtures: hold a sync to the named matching cases.
 *
 * Each case in fixtures/matching.ts is a species that once showed the wrong
 * number, or a rule written for one. This checks what a sync actually
 * published for it: which CoL species an assessed species is linked to, which
 * GBIF key the app uses, whether it has records, and whether given CoL species
 * appear in the Not Evaluated list, and which link rules its rows show. It
 * reads the same facts as the comparison (compare/facts.ts). The sync stops if
 * any case fails, or if a build gives some species a rule no case shows: every
 * rule has a real species to read it by.
 *
 * Expectations are by name, not CoL id, because CoL renumbers about 2% of
 * ids each release.
 *
 * Usage:
 *   npx tsx scripts/sync/checks/check-fixtures.ts [DIR] [--observe]
 *     DIR        data directory (default app/data/sync)
 *     --observe  print what the sync shows for every case, check nothing
 */

import * as fs from "fs";
import * as path from "path";
import { type DuckDBConnection } from "@duckdb/node-api";
import { DATA_DIR } from "../../lib/utils";
import { loadFacts, inSync } from "./compare/facts";
import { MATCHING_CASES, type MatchCase, type Versions } from "./fixtures/matching";
import { lit, openDuckDB } from "../sql";
import { compareAuthors } from "../../../src/lib/authors";

export interface Observed {
  assessed: boolean;
  category: string | null;
  linkedTo: string | null;
  /** The CoL authorship of the species it links to. */
  linkedAuthorship: string | null;
  /** The Red List's authority for it; undefined when the build's working tables aren't to hand. */
  authority?: string | null;
  gbifKey: string | null;
  gbifKeyName: string | null;
  records: number | null;
  neListed: Record<string, boolean>;
  /** The rule labels its link rows carry (ruleLabel). */
  rules: string[];
}

/** A link row's rule: how it was made (match_reason), and for a species still waiting, why. */
export const ruleLabel = (matchReason: string | null, toReview: string | null): string | null =>
  matchReason === "waiting" ? `waiting: ${toReview ?? "?"}` : matchReason;

/** The rule labels the build in `dir` gives at least one species. */
export async function rulesInBuild(conn: DuckDBConnection, dir: string): Promise<string[]> {
  const rows = (await conn.runAndReadAll(`SELECT DISTINCT match_reason, to_review FROM read_parquet(${lit(inSync(dir, "assessment_link.parquet"))})
    WHERE match_reason IS NOT NULL`)).getRowObjects();
  return [...new Set(rows.map((r) => ruleLabel(r.match_reason as string | null, r.to_review as string | null)).filter((x): x is string => !!x))].sort();
}

/** Rules the build shows that no case names: each needs a real species, read by name, before it ships. */
export function uncoveredRules(cases: MatchCase[], inBuild: string[]): string[] {
  const named = new Set(cases.flatMap((c) => c.expect.rules ?? []));
  return inBuild.filter((r) => !named.has(r));
}


/**
 * What the build in `dir` (a published sync) shows for each case. `assessments`,
 * the build's working Red List table, adds the Red List's authority, which the
 * published files don't carry.
 */
export async function observe(conn: DuckDBConnection, dir: string, cases: MatchCase[], assessments?: string): Promise<Map<string, Observed>> {
  await loadFacts(conn, "f", dir);
  const tax = `read_parquet(${lit(inSync(dir, "taxa.parquet"))})`;
  // species_name: the accepted species a usage belongs to (a synonym's accepted
  // name, an infraspecific's species), so a link reads the same whether it
  // points at the usage or at the species.
  await conn.run(`CREATE TEMP TABLE names AS
    WITH t AS (SELECT col_id, parent_id, status, rank, scientific_name, authorship FROM ${tax}),
    s1 AS (SELECT t.col_id, t.scientific_name,
             CASE WHEN t.status ILIKE '%synonym%' OR t.status ILIKE 'misapplied' THEN p.col_id ELSE t.col_id END AS acc
           FROM t LEFT JOIN t p ON p.col_id = t.parent_id)
    SELECT s1.col_id, s1.scientific_name,
           CASE WHEN a.rank <> 'species' AND sp.rank = 'species' THEN sp.scientific_name ELSE a.scientific_name END AS species_name,
           CASE WHEN a.rank <> 'species' AND sp.rank = 'species' THEN sp.authorship ELSE a.authorship END AS species_authorship
    FROM s1 LEFT JOIN t a ON a.col_id = s1.acc LEFT JOIN t sp ON sp.col_id = a.parent_id`);

  const out = new Map<string, Observed>();
  for (const c of cases) {
    const [row] = (await conn.runAndReadAll(`
      SELECT a.key AS sis, a.iucn_category AS category, l.species_name AS linked, l.species_authorship AS linked_auth, a.gbif_species_key AS gkey,
             g.scientific_name AS gname, a.gbif_georeferenced_records_count AS n
      FROM f.assessed a
      LEFT JOIN names l ON l.col_id = a.link_col_id
      LEFT JOIN names g ON g.col_id = a.gbif_species_key
      WHERE a.scientific_name = ${lit(c.name)}`)).getRowObjects();
    const neListed: Record<string, boolean> = {};
    for (const n of Object.keys(c.expect.neListed ?? {})) {
      const [r] = (await conn.runAndReadAll(`
        SELECT count(*) AS c FROM f.ne WHERE scientific_name = ${lit(n)}`)).getRowObjects();
      neListed[n] = Number(r.c) > 0;
    }
    const rules = row ? (await conn.runAndReadAll(`SELECT DISTINCT match_reason, to_review FROM read_parquet(${lit(inSync(dir, "assessment_link.parquet"))})
      WHERE sis_taxon_id::VARCHAR = ${lit(String(row.sis))}`)).getRowObjects()
      .map((r) => ruleLabel(r.match_reason as string | null, r.to_review as string | null)).filter((x): x is string => !!x).sort() : [];
    out.set(c.name, {
      assessed: row !== undefined,
      category: row ? (row.category as string | null) : null,
      linkedTo: row ? (row.linked as string | null) : null,
      linkedAuthorship: row ? (row.linked_auth as string | null) : null,
      ...(assessments ? { authority: await authorityOf(conn, assessments, c.name) } : {}),
      gbifKey: row ? (row.gkey as string | null) : null,
      gbifKeyName: row ? (row.gname as string | null) : null,
      records: row && row.n !== null ? Number(row.n) : null,
      neListed,
      rules,
    });
  }
  return out;
}

/** The releases a build was made from, as `confirmed` names them, from its sync.json. */
export function buildVersions(syncJson: { redlist?: { database?: string }; col?: { xr?: { alias?: string } }; gbif?: { snapshot?: string } }): Versions {
  return {
    redlist: (syncJson.redlist?.database ?? "?").replace(/^redlist_/, "").replace(/_/g, "-"),
    col: syncJson.col?.xr?.alias ?? "?",
    snapshot: syncJson.gbif?.snapshot ?? "?",
  };
}

/**
 * What a failing case's releases say about the failure: the same releases it last
 * passed on make it a regression in the code; newer ones may be the data moving.
 * The snapshot counts only for a case about records.
 */
export function failureKind(c: MatchCase, build: Versions): string {
  const e = c.expect;
  const aboutRecords = e.hasRecords !== undefined || e.minRecords !== undefined || e.maxRecords !== undefined;
  const moved = (["redlist", "col", "snapshot"] as const)
    .filter((k) => (k !== "snapshot" || aboutRecords) && c.confirmed[k] !== build[k])
    .map((k) => `${k} ${c.confirmed[k]} → ${build[k]}`);
  return moved.length === 0
    ? "a regression: it passed on these same releases"
    : `confirmed on older releases (${moved.join(", ")}): check it against these, then update its \`confirmed\``;
}

async function authorityOf(conn: DuckDBConnection, assessments: string, name: string): Promise<string | null> {
  const [r] = (await conn.runAndReadAll(`SELECT any_value(authority) AS a FROM read_parquet(${lit(assessments)})
    WHERE is_latest AND scientific_name = ${lit(name)}`)).getRowObjects();
  return (r?.a as string | null) ?? null;
}

/** Every way the observation misses the case's expectations (empty = pass). */
export function mismatches(c: MatchCase, o: Observed): string[] {
  const e = c.expect;
  const miss: string[] = [];
  const want = (what: string, exp: unknown, got: unknown) => {
    if (exp !== undefined && exp !== got) miss.push(`${what}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(got)}`);
  };
  want("assessed", e.assessed, o.assessed);
  want("linked to", e.linkedTo, o.linkedTo);
  // A homonym's name is the same for both; the citation says which one it is. Compared
  // as authors, not as strings: a release reformatting the citation isn't another species.
  if (e.linkedAuthorship !== undefined && (o.linkedAuthorship == null || compareAuthors(e.linkedAuthorship, o.linkedAuthorship) === "other")) {
    miss.push(`linked to: expected ${e.linkedTo ?? ""} ${e.linkedAuthorship}, got ${o.linkedTo ?? "nothing"} ${o.linkedAuthorship ?? ""}`.replace(/\s+/g, " "));
  }
  // The case is about the name as the Red List cites it; clearly other authors make it another name.
  if (c.authority && o.authority !== undefined && compareAuthors(c.authority, o.authority) === "other") {
    miss.push(`Red List authority: the case is about ${c.name} ${c.authority}, the Red List now cites ${o.authority}`);
  }
  want("GBIF key name", e.gbifKeyName, o.gbifKeyName);
  if (e.hasRecords !== undefined) want("has records", e.hasRecords, (o.records ?? 0) > 0);
  if (e.minRecords !== undefined && (o.records ?? 0) < e.minRecords) {
    miss.push(`records: expected at least ${e.minRecords}, got ${o.records ?? 0}`);
  }
  if (e.maxRecords !== undefined && (o.records ?? 0) > e.maxRecords) {
    miss.push(`records: expected at most ${e.maxRecords}, got ${o.records}`);
  }
  for (const [n, listed] of Object.entries(e.neListed ?? {})) {
    want(`${n} in NE list`, listed, o.neListed[n]);
  }
  for (const r of e.rules ?? []) {
    if (!o.rules.includes(r)) miss.push(`rule: expected "${r}", its rows show ${JSON.stringify(o.rules)}`);
  }
  return miss;
}

const isDirectRun = process.argv[1]?.endsWith("checks/check-fixtures.ts") || process.argv[1]?.endsWith("checks/check-fixtures.js");
if (isDirectRun) {
  (async () => {
    const dir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? DATA_DIR);
    if (!fs.existsSync(dir)) throw new Error(`No data directory at ${dir}`);
    const conn = await openDuckDB();
    // A build's working Red List table, beside its publish/, gives the Red List authority.
    const working = path.join(dir, "..", "working", "sources", "assessments.parquet");
    const obs = await observe(conn, dir, MATCHING_CASES, fs.existsSync(working) ? working : undefined);

    if (process.argv.includes("--observe")) {
      for (const c of MATCHING_CASES) console.log(c.name.padEnd(28), JSON.stringify(obs.get(c.name)));
      return;
    }
    const syncJson = path.join(dir, "sync.json");
    const build = buildVersions(fs.existsSync(syncJson) ? JSON.parse(fs.readFileSync(syncJson, "utf-8")) : {});
    let failed = 0;
    for (const c of MATCHING_CASES) {
      const miss = mismatches(c, obs.get(c.name)!);
      if (miss.length === 0) continue;
      failed++;
      console.log(`FAIL    ${c.name}: ${miss.join("; ")} (${failureKind(c, build)})`);
    }
    console.log(`\n${MATCHING_CASES.length} cases: ${failed} failed.`);
    const uncovered = uncoveredRules(MATCHING_CASES, await rulesInBuild(conn, dir));
    for (const r of uncovered) console.log(`NO CASE ${r}`);
    if (failed > 0 || uncovered.length > 0) process.exitCode = 1;
  })().catch((e) => { console.error(e); process.exit(1); });
}
