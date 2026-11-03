/**
 * check-search-shards: prove the static search shards answer like the live route.
 *
 * Runs the browser's own search (lib/search-shards/client.searchFromShards, with fetch
 * reading the built files from public/) and the route's tier-0 prefix search + taxon
 * suggestions (species-duckdb) over thousands of queries — every prefix length of a
 * deterministic sample of indexed names and taxon names, plus a hand-picked list — and
 * compares them result for result.
 *
 * The SQL orders by four keys and leaves ties beyond them unordered (the shards break
 * them deterministically), so species lists that differ only in the order of rows tying
 * on all four keys — or, at the LIMIT edge, in which tied row made the cut — are counted
 * separately as tie-order differences, not failures.
 *
 * Usage: npx tsx scripts/check-search-shards.ts   (after build-search-shards)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { getConn, parquetUri, prefixSearchSpecies, suggestTaxa, type SearchResult } from "../src/lib/data/species-duckdb";

const APP_DIR = path.join(__dirname, "..");
const sync = fs.readFileSync(path.join(APP_DIR, "latest-sync.txt"), "utf-8").trim();
process.env.NEXT_PUBLIC_SPECIES_LISTS_SYNC = sync;

// The client's fetch, served from the built files (brotli-decoded as a browser would).
globalThis.fetch = (async (input: string) => {
  const file = path.join(APP_DIR, "public", decodeURI(String(input)).replace(/^\//, ""));
  if (!fs.existsSync(file)) return new Response("", { status: 404 });
  const buf = fs.readFileSync(file);
  return new Response(file.endsWith(".br") ? zlib.brotliDecompressSync(buf) : buf);
}) as typeof fetch;

const sortKey = (r: SearchResult, q: string) => {
  // The common name the row ranks by: the one it matched through, else the display one.
  const cn = r.matched_common_name ?? r.common_name;
  const cl = cn?.toLowerCase() ?? null, sl = r.scientific_name.toLowerCase();
  return JSON.stringify([cl == null ? 0 : cl === q ? 2 : 1, cl == null ? 0 : cl.startsWith(q) ? 2 : 1, sl.startsWith(q) ? 2 : 1, sl]);
};

async function main() {
  const { searchFromShards } = await import("../src/lib/search-shards/client");
  const conn = await getConn();
  const sample = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjects().map((r) => String(r.v));
  const names = [
    ...await sample(`SELECT name_lo AS v FROM '${parquetUri("name-index.parquet")}' USING SAMPLE 400 ROWS (reservoir, 7)`),
    ...await sample(`SELECT name AS v FROM '${parquetUri("rank-index.parquet")}' USING SAMPLE 150 ROWS (reservoir, 7)`),
  ];
  const queries = new Set<string>([
    "pa", "ca", "co", "ma", "an", "par", "tri", "lion", "oak", "red fox", "panthera", "panthera leo", "quercus rob",
    "bombus", "sorbus", "acacia", "elephant", "chi", "urs", "fel", "felidae", "Lion", "QUERCUS", "zz", "zzqx", "ab",
  ]);
  for (const n of names) {
    const cps = [...n];
    for (let len = 2; len <= Math.min(cps.length, 12); len++) queries.add(cps.slice(0, len).join(""));
    queries.add(n);
  }

  let ok = 0, tieOnly = 0, fallback = 0;
  const failures: string[] = [];
  for (const query of queries) {
    if (/[%_]/.test(query)) continue; // SQL LIKE treats these as wildcards; the shards match literally
    const q = query.toLowerCase();
    const [server, taxa, shards] = await Promise.all([prefixSearchSpecies(query, 10), suggestTaxa(query), searchFromShards(query, 10)]);
    if (!shards) {
      // The shards defer to the route exactly when tier 0 has nothing.
      if (server.length === 0) { fallback++; continue; }
      failures.push(`"${query}": shards deferred to the route, but tier 0 has ${server.length} hits`);
      continue;
    }
    const tA = JSON.stringify(taxa), tB = JSON.stringify(shards.taxa);
    if (tA !== tB) { failures.push(`"${query}" taxa:\n    route  ${tA}\n    shards ${tB}`); continue; }
    const a = server.map((r) => r.species_key ?? r.scientific_name), b = shards.results.map((r) => r.species_key ?? r.scientific_name);
    if (JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(server) === JSON.stringify(shards.results)) { ok++; continue; }
    const ka = server.map((r) => sortKey(r, q)), kb = shards.results.map((r) => sortKey(r, q));
    if (JSON.stringify(ka) === JSON.stringify(kb)) {
      const last = ka[ka.length - 1];
      const fixedA = a.filter((_, i) => ka[i] !== last).sort(), fixedB = b.filter((_, i) => kb[i] !== last).sort();
      if (JSON.stringify(fixedA) === JSON.stringify(fixedB)) { tieOnly++; continue; }
    }
    failures.push(`"${query}" species:\n    route  ${a.join(", ")}\n    shards ${b.join(", ")}`);
  }
  for (const f of failures.slice(0, 15)) console.log(`✗ ${f}`);
  const total = ok + tieOnly + fallback + failures.length;
  console.log(`${total} queries: ${ok} identical, ${tieOnly} differ only in the order of fully tied rows, ${fallback} correctly deferred to the route, ${failures.length} FAILED`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
