/**
 * check-fixtures: hold a sync to the named matching cases.
 *
 * Each case in fixtures/matching.ts is a species that once showed the wrong
 * number, or a rule written for one. This checks what a sync actually
 * published for it: which CoL species an assessed species is linked to, which
 * GBIF key the app uses, whether it has records, and whether given CoL species
 * appear in the Not Evaluated list. It reads the same facts as the comparison
 * harness, so the old and new pipelines are held to the same cases.
 *
 * Expectations are by name, not CoL id, because CoL renumbers about 2% of
 * ids each release.
 *
 * A case marked knownBug states the intended outcome. Today's pipeline is
 * allowed to miss it (reported, not failed); the rewrite is not.
 *
 * Usage:
 *   npx tsx scripts/sync/checks/check-fixtures.ts [DIR] [--observe] [--strict]
 *     DIR        data directory (default app/data)
 *     --observe  print what the sync shows for every case, check nothing
 *     --strict   fail on knownBug cases too
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { DATA_DIR } from "../../lib/utils";
import { loadFacts, inSync, type Layout } from "./compare/facts";
import { MATCHING_CASES, type MatchCase } from "./fixtures/matching";

export interface Observed {
  assessed: boolean;
  category: string | null;
  linkedTo: string | null;
  gbifKey: string | null;
  gbifKeyName: string | null;
  records: number | null;
  neListed: Record<string, boolean>;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** CoL names for ids, from whichever taxonomy file the layout has. */
function taxonomySql(dir: string, layout: Layout): string {
  return `read_parquet(${lit(layout === "v1" ? path.join(dir, "backbone.parquet") : inSync(dir, "taxa.parquet"))})`;
}

export async function observe(conn: DuckDBConnection, dir: string, cases: MatchCase[]): Promise<Map<string, Observed>> {
  const layout = await loadFacts(conn, "f", dir);
  const tax = taxonomySql(dir, layout);
  // species_name: the accepted species a usage belongs to (a synonym's accepted
  // name, an infraspecific's species), so a link reads the same whether a
  // layout points it at the usage or at the species.
  await conn.run(`CREATE TEMP TABLE names AS
    WITH t AS (SELECT col_id, parent_id, status, rank, scientific_name FROM ${tax}),
    s1 AS (SELECT t.col_id, t.scientific_name,
             CASE WHEN t.status ILIKE '%synonym%' OR t.status ILIKE 'misapplied' THEN p.col_id ELSE t.col_id END AS acc
           FROM t LEFT JOIN t p ON p.col_id = t.parent_id)
    SELECT s1.col_id, s1.scientific_name,
           CASE WHEN a.rank <> 'species' AND sp.rank = 'species' THEN sp.scientific_name ELSE a.scientific_name END AS species_name
    FROM s1 LEFT JOIN t a ON a.col_id = s1.acc LEFT JOIN t sp ON sp.col_id = a.parent_id`);

  const out = new Map<string, Observed>();
  for (const c of cases) {
    const [row] = (await conn.runAndReadAll(`
      SELECT a.iucn_category AS category, l.species_name AS linked, a.gbif_species_key AS gkey,
             g.scientific_name AS gname, a.gbif_georeferenced_records_count AS n
      FROM f.assessed a
      LEFT JOIN names l ON l.col_id = a.link_col_id
      LEFT JOIN names g ON g.col_id = a.gbif_species_key
      WHERE a.scientific_name = ${lit(c.name)}`)).getRowObjects();
    const neListed: Record<string, boolean> = {};
    const hasNe = (await conn.runAndReadAll(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'f' AND table_name = 'ne'`)).getRowObjects().length > 0;
    for (const n of Object.keys(c.expect.neListed ?? {})) {
      if (!hasNe) continue;
      const [r] = (await conn.runAndReadAll(`
        SELECT count(*) AS c FROM f.ne WHERE scientific_name = ${lit(n)}`)).getRowObjects();
      neListed[n] = Number(r.c) > 0;
    }
    out.set(c.name, {
      assessed: row !== undefined,
      category: row ? (row.category as string | null) : null,
      linkedTo: row ? (row.linked as string | null) : null,
      gbifKey: row ? (row.gkey as string | null) : null,
      gbifKeyName: row ? (row.gname as string | null) : null,
      records: row && row.n !== null ? Number(row.n) : null,
      neListed,
    });
  }
  return out;
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
  want("GBIF key name", e.gbifKeyName, o.gbifKeyName);
  if (e.hasRecords !== undefined) want("has records", e.hasRecords, (o.records ?? 0) > 0);
  if (e.minRecords !== undefined && (o.records ?? 0) < e.minRecords) {
    miss.push(`records: expected at least ${e.minRecords}, got ${o.records ?? 0}`);
  }
  if (e.maxRecords !== undefined && (o.records ?? 0) > e.maxRecords) {
    miss.push(`records: expected at most ${e.maxRecords}, got ${o.records}`);
  }
  for (const [n, listed] of Object.entries(e.neListed ?? {})) {
    if (n in o.neListed) want(`${n} in NE list`, listed, o.neListed[n]);
  }
  return miss;
}

const isDirectRun = process.argv[1]?.endsWith("checks/check-fixtures.ts") || process.argv[1]?.endsWith("checks/check-fixtures.js");
if (isDirectRun) {
  (async () => {
    const dir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? DATA_DIR);
    if (!fs.existsSync(dir)) throw new Error(`No data directory at ${dir}`);
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    const obs = await observe(conn, dir, MATCHING_CASES);

    if (process.argv.includes("--observe")) {
      for (const c of MATCHING_CASES) console.log(c.name.padEnd(28), JSON.stringify(obs.get(c.name)));
      return;
    }
    const strict = process.argv.includes("--strict");
    let failed = 0;
    let bugs = 0;
    for (const c of MATCHING_CASES) {
      const miss = mismatches(c, obs.get(c.name)!);
      if (miss.length === 0) {
        if (c.knownBug) console.log(`fixed   ${c.name} (was: ${c.knownBug})`);
        continue;
      }
      const label = c.knownBug && !strict ? "bug" : "FAIL";
      if (label === "bug") bugs++; else failed++;
      console.log(`${label.padEnd(7)} ${c.name}: ${miss.join("; ")}${c.knownBug ? `  [known: ${c.knownBug}]` : ""}`);
    }
    console.log(`\n${MATCHING_CASES.length} cases: ${failed} failed, ${bugs} known bugs still present.`);
    if (failed > 0) process.exitCode = 1;
  })().catch((e) => { console.error(e); process.exit(1); });
}
