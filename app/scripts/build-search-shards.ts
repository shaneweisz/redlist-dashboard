/**
 * build-search-shards: pre-build the search dropdown as static, prefix-sharded files.
 *
 * Writes public/search-shards/<sync>/ (see lib/search-shards/format.ts for the layout):
 * every name-index.parquet row as a finished SearchResult (toSearchResult — the exact
 * function the live route uses) plus its sort keys, and every rank-index.parquet row as a
 * finished taxon suggestion (resolveTaxonSuggestionNode, ditto). The browser fetches the
 * shard for what's being typed and ranks it with lib/search-shards/rank.ts, which
 * reproduces the route's SQL ordering (scripts/check-search-shards.ts proves it).
 *
 * Runs at build time after fetch-data-from-r2, like build-species-lists, so the baked-in
 * node ids always match the deployed taxonomy code.
 *
 * Usage: npx tsx scripts/build-search-shards.ts
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { getConn, parquetUri, resolveTaxonSuggestionNode, SUGGEST_RANKS, toSearchResult } from "../src/lib/data/species-duckdb";
import { encodeColumns } from "../src/lib/species-lists/format";
import { COMPLETE_MAX, hexKey, prefixKey, type SearchShard, type SearchShardManifest } from "../src/lib/search-shards/format";
import { rankSpeciesRows, rankTaxonRows, SPECIES_TOP_K, TAXA_TOP_K, type ShardSpeciesRow, type ShardTaxonRow } from "../src/lib/search-shards/rank";

const brotli = promisify(zlib.brotliCompress);
const APP_DIR = path.join(__dirname, "..");
const OUT_ROOT = path.join(APP_DIR, "public", "search-shards");
const str = (v: unknown) => (v == null ? null : String(v));

async function main() {
  const t0 = Date.now();
  const sync = fs.readFileSync(path.join(APP_DIR, "latest-sync.txt"), "utf-8").trim();
  if (!fs.existsSync(path.join(APP_DIR, "data", "name-index.parquet"))) {
    throw new Error("data/name-index.parquet missing — run fetch-data-from-r2 first");
  }
  const outDir = path.join(OUT_ROOT, sync);
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "p2"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "p3"), { recursive: true });
  const conn = await getConn();
  // Syncs built before every CoL common name was indexed lack these columns (see
  // build-search-index); fall back to what they mean there, so code and data can ship
  // in either order.
  const cols = async (f: string) => new Set((await conn.runAndReadAll(`DESCRIBE SELECT * FROM '${parquetUri(f)}'`))
    .getRowObjects().map((r) => String(r.column_name)));
  const nameCols = await cols("name-index.parquet");
  const rankCols = await cols("rank-index.parquet");
  const rankNameSql = nameCols.has("rank_name") ? "rank_name" : "common_name";
  const taxonSql = rankCols.has("taxon") ? "taxon, common" : "name AS taxon, NULL AS common";

  // Taxon suggestions: small (116k rows), so load all and bucket by two-letter key.
  const taxaByP2 = new Map<string, ShardTaxonRow[]>();
  const rankRows = (await conn.runAndReadAll(
    `SELECT name, rp, taxon_group, class_name, order_name, family, ${taxonSql} FROM '${parquetUri("rank-index.parquet")}'`,
  )).getRowObjects();
  for (const r of rankRows) {
    const name = String(r.name);
    const k = prefixKey(name, 2);
    if (!k) continue; // a one-character name can't match a query (min length 2)
    const rank = SUGGEST_RANKS[Number(r.rp)];
    const taxon = String(r.taxon ?? name);
    const nodeId = await resolveTaxonSuggestionNode(conn, rank, taxon, String(r.taxon_group),
      { class_name: str(r.class_name), order_name: str(r.order_name), family: str(r.family) });
    if (!taxaByP2.has(k)) taxaByP2.set(k, []);
    taxaByP2.get(k)!.push({ name, rp: Number(r.rp), rank, nodeId, taxon, common: str(r.common) });
  }

  // Species names: bucket keys + counts first, then read one two-letter range at a time
  // (the index is sorted by name_lo, so each range read prunes to its row groups).
  const p2Counts = new Map((await conn.runAndReadAll(
    `SELECT substr(name_lo, 1, 2) AS k, count(*) AS n FROM '${parquetUri("name-index.parquet")}' GROUP BY 1`,
  )).getRowObjects().filter((r) => prefixKey(String(r.k), 2)).map((r) => [String(r.k), Number(r.n)]));
  const keys = [...new Set([...p2Counts.keys(), ...taxaByP2.keys()])].sort();

  const manifest: SearchShardManifest = { v: 1, sync, p2: {} };
  const writes: Promise<void>[] = [];
  let files = 0;
  let bytes = 0;
  let maxBytes = { key: "", bytes: 0 };
  const write = (rel: string, shard: SearchShard, key: string) => {
    files++;
    writes.push(brotli(JSON.stringify(shard), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 22 },
    }).then((buf) => {
      bytes += buf.length;
      if (buf.length > maxBytes.bytes) maxBytes = { key, bytes: buf.length };
      fs.writeFileSync(path.join(outDir, rel), buf);
    }));
  };
  const enc = (rows: object[]) => encodeColumns(rows as Record<string, unknown>[]);

  for (const k of keys) {
    const species: ShardSpeciesRow[] = (p2Counts.get(k) ?? 0) === 0 ? [] : (await conn.runAndReadAll(
      `SELECT *, lower(${rankNameSql}) AS cl, lower(scientific_name) AS sl
       FROM '${parquetUri("name-index.parquet")}'
       WHERE name_lo >= $k AND name_lo < $k || chr(1114111)`, { k },
    )).getRowObjects().map((r) => ({
      ...toSearchResult(r, str(r.col_id)),
      n: String(r.name_lo),
      cl: str(r.cl),
      sl: String(r.sl ?? ""),
    }));
    const taxa = taxaByP2.get(k) ?? [];
    const complete = species.length <= COMPLETE_MAX;
    manifest.p2[k] = complete;
    if (complete) {
      write(`p2/${hexKey(k)}.json.br`, { v: 1, complete, species: enc(species), taxa: enc(taxa) }, k);
      continue;
    }
    // Too many names for one file: pre-rank the two-letter query's own answer, and split
    // every row by three-letter key for the longer queries.
    const byP3 = new Map<string, { species: ShardSpeciesRow[]; taxa: ShardTaxonRow[] }>();
    const bucket = (k3: string) => byP3.get(k3) ?? byP3.set(k3, { species: [], taxa: [] }).get(k3)!;
    for (const r of species) { const k3 = prefixKey(r.n, 3); if (k3) bucket(k3).species.push(r); }
    for (const r of taxa) { const k3 = prefixKey(r.name, 3); if (k3) bucket(k3).taxa.push(r); }
    write(`p2/${hexKey(k)}.json.br`, {
      v: 1, complete, p3: [...byP3.keys()].sort(),
      species: enc(rankSpeciesRows(species, k, SPECIES_TOP_K)),
      taxa: enc(rankTaxonRows(taxa, k, TAXA_TOP_K)),
    }, k);
    for (const [k3, rows] of byP3) {
      write(`p3/${hexKey(k3)}.json.br`, { v: 1, complete: true, species: enc(rows.species), taxa: enc(rows.taxa) }, k3);
    }
  }
  await Promise.all(writes);
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));

  console.log(`search-shards: ${files} files, ${(bytes / 1e6).toFixed(1)}MB brotli (largest "${maxBytes.key}" ${(maxBytes.bytes / 1e3).toFixed(0)}KB), ` +
    `${keys.length} two-letter keys (${Object.values(manifest.p2).filter((c) => !c).length} split) in ${((Date.now() - t0) / 1000).toFixed(1)}s → public/search-shards/${sync}/`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
