/**
 * build-matches: GBIF's matcher's answer for every assessed species' name.
 *
 * Each species is sent as GBIF would see it on a record: its Red List name,
 * its authority, and IUCN's kingdom, phylum, class, order and family as hints.
 * The answer is the CoL usage the name is, how it matched (exact, variant,
 * fuzzy, higher rank), a confidence score, and the alternatives the matcher
 * weighed. Nothing here decides anything: build-link does.
 *
 * Answers are cached by query, matcher version and XR key under
 * ~/.cache/redlist-dashboard/matching/<key>-<version>/answers.jsonl, so a month
 * in which neither the Red List nor the XR moves sends nothing.
 *
 * Writes core/matches.parquet:
 *   sis_taxon_id, usage_id, usage_name, usage_authorship, usage_rank,
 *   usage_status (ACCEPTED, SYNONYM, AMBIGUOUS_SYNONYM, PROVISIONALLY_ACCEPTED,
 *   MISAPPLIED, ...), match_type, confidence,
 *   alternatives (list of {usage_id, name, authorship, rank, status, confidence, match_type})
 *
 * Usage:  npx tsx scripts/sync/core/build-matches.ts
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles } from "../../lib/utils";
import { CACHE_ROOT, CORE_DIR } from "../paths";
import { ensureColInputs } from "../inputs/col";
import { ensureMatcher, type Matcher } from "../inputs/matcher";

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const THREADS = 16;

export interface Usage { usage_id: string; name: string; authorship: string | null; rank: string | null; status: string | null }
export interface Answer {
  usage: Usage | null;
  match_type: string | null;
  confidence: number | null;
  alternatives: (Usage & { confidence: number | null; match_type: string | null })[];
}

interface Query { scientificName: string; authorship?: string; kingdom?: string; phylum?: string; class?: string; order?: string; family?: string }

const cap = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : undefined);

function slim(u: Record<string, unknown> | undefined): Usage | null {
  if (!u?.key) return null;
  return { usage_id: String(u.key), name: String(u.canonicalName ?? u.name), authorship: (u.authorship as string) || null,
    rank: (u.rank as string) ?? null, status: (u.status as string) ?? null };
}

async function ask(m: Matcher, q: Query): Promise<Answer> {
  const params = new URLSearchParams({ verbose: "true" });
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${m.url}/v2/species/match?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { usage?: Record<string, unknown>; diagnostics?: { matchType?: string; confidence?: number;
        alternatives?: { usage?: Record<string, unknown>; diagnostics?: { matchType?: string; confidence?: number } }[] } };
      const dg = d.diagnostics ?? {};
      return {
        usage: slim(d.usage), match_type: dg.matchType ?? null, confidence: dg.confidence ?? null,
        alternatives: (dg.alternatives ?? []).flatMap((a) => {
          const u = slim(a.usage);
          return u ? [{ ...u, confidence: a.diagnostics?.confidence ?? null, match_type: a.diagnostics?.matchType ?? null }] : [];
        }),
      };
    } catch (e) {
      if (attempt >= 5) throw new Error(`matcher: ${q.scientificName}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export async function buildMatches(conn: DuckDBConnection, coreDir: string, matcher: Matcher): Promise<{ out: string; asked: number; cached: number }> {
  const out = path.join(coreDir, "matches.parquet");
  const species = (await conn.runAndReadAll(`
    SELECT sis_taxon_id::INTEGER AS sis, scientific_name, authority, kingdom_name, phylum_name, class_name, order_name, family
    FROM read_parquet(${lit(path.join(coreDir, "assessments.parquet"))}) WHERE is_latest ORDER BY sis`)).getRowObjects() as unknown as {
      sis: number; scientific_name: string; authority: string | null; kingdom_name: string | null; phylum_name: string | null;
      class_name: string | null; order_name: string | null; family: string | null }[];

  const cacheDir = path.join(CACHE_ROOT, "matching", `${matcher.datasetKey}-${matcher.version}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, "answers.jsonl");
  const cache = new Map<string, Answer>();
  if (fs.existsSync(cacheFile)) {
    for (const line of fs.readFileSync(cacheFile, "utf-8").split("\n")) {
      if (!line) continue;
      try { const { q, a } = JSON.parse(line); cache.set(q, a); } catch { /* a torn last line from an interrupted run */ }
    }
  }

  const jobs = species.map((s) => {
    const q: Query = { scientificName: s.scientific_name, authorship: s.authority ?? undefined, kingdom: cap(s.kingdom_name),
      phylum: cap(s.phylum_name), class: cap(s.class_name), order: cap(s.order_name), family: cap(s.family) };
    return { sis: s.sis, q, hash: createHash("sha1").update(JSON.stringify(q)).digest("hex") };
  });
  const missing = [...new Map(jobs.filter((j) => !cache.has(j.hash)).map((j) => [j.hash, j])).values()];
  if (missing.length > 0) {
    const fd = fs.openSync(cacheFile, "a");
    let next = 0, done = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: THREADS }, async () => {
      while (next < missing.length) {
        const j = missing[next++];
        const a = await ask(matcher, j.q);
        cache.set(j.hash, a);
        fs.writeSync(fd, JSON.stringify({ q: j.hash, a }) + "\n");
        if (++done % 20000 === 0) console.log(`   matched ${done.toLocaleString()} of ${missing.length.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
    }));
    fs.closeSync(fd);
  }

  await conn.run(`CREATE OR REPLACE TEMP TABLE match_rows (sis_taxon_id INTEGER, answer JSON)`);
  const ap = await conn.createAppender("match_rows");
  for (const j of jobs) { ap.appendInteger(j.sis); ap.appendVarchar(JSON.stringify(cache.get(j.hash))); ap.endRow(); }
  ap.closeSync();
  const ALT = `STRUCT(usage_id VARCHAR, name VARCHAR, authorship VARCHAR, rank VARCHAR, status VARCHAR, confidence INTEGER, match_type VARCHAR)`;
  fs.mkdirSync(coreDir, { recursive: true });
  await conn.run(`COPY (
    SELECT sis_taxon_id,
           answer->>'$.usage.usage_id' AS usage_id, answer->>'$.usage.name' AS usage_name,
           answer->>'$.usage.authorship' AS usage_authorship, answer->>'$.usage.rank' AS usage_rank,
           answer->>'$.usage.status' AS usage_status, answer->>'$.match_type' AS match_type,
           (answer->>'$.confidence')::INTEGER AS confidence,
           CAST(answer->'$.alternatives' AS ${ALT}[]) AS alternatives
    FROM match_rows ORDER BY sis_taxon_id
  ) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);
  fs.writeFileSync(path.join(coreDir, "matches.json"), JSON.stringify({ matcher: matcher.version, xr: matcher.datasetKey,
    names: jobs.length, asked: missing.length }, null, 2) + "\n");
  return { out, asked: missing.length, cached: jobs.length - missing.length };
}

export async function run(): Promise<void> {
  const col = await ensureColInputs();
  const matcher = await ensureMatcher(col.xr, col.nameUsage);
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const r = await buildMatches(conn, CORE_DIR, matcher);
  console.log(`Wrote ${r.out}: ${r.asked.toLocaleString()} asked, ${r.cached.toLocaleString()} from cache`);
}

const isDirectRun = process.argv[1]?.endsWith("core/build-matches.ts");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((e) => { console.error(e); process.exit(1); });
}
