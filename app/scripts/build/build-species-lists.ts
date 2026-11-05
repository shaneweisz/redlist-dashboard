/**
 * build-species-lists: pre-build the dashboard's species lists as static files.
 *
 * Writes, for every taxon_group partition, the exact rows /api/redlist/species would
 * return for it — `<group>.assessed.json.br` and `<group>.ne.json.br` — plus a small
 * `manifest.json`, into public/species-lists/<sync>/. The browser (lib/species-lists)
 * fetches the groups a view needs and filters every deeper drilldown locally, so no
 * species-list request waits on a DuckDB query over R2 (4-23s cold in production).
 *
 * Runs at BUILD time (prebuild, after fetch-data-from-r2 has put the sync's parquets in
 * data/), not in the sync: some row fields come from repo-owned code and data rather than
 * the sync (col_revision from col-revisions.json, taxon_id from taxonomy-constants), so
 * building here keeps the files in step with the deployed code. Rows come from the same
 * querySpecies the live route runs, so the two cannot disagree on what a row contains.
 *
 * Files are column-encoded (lib/species-lists/format.ts) and brotli-compressed at q9:
 * every group compresses in a few seconds total, where q11 on row JSON took minutes per
 * file for a larger result. next.config serves *.json.br with Content-Encoding: br.
 * The sync timestamp in the path makes each URL immutable — a new sync is new URLs.
 *
 * Usage: npx tsx scripts/build/build-species-lists.ts
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { getConn, parquetUri, querySpecies } from "../../src/lib/data/species-duckdb";
import { encodeColumns, speciesListFileName, type SpeciesListKind, type SpeciesListManifest } from "../../src/lib/species-lists/format";

const brotli = promisify(zlib.brotliCompress);
const APP_DIR = path.join(__dirname, "..", "..");
const OUT_ROOT = path.join(APP_DIR, "public", "species-lists");

async function compress(json: string): Promise<Buffer> {
  return brotli(json, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(json),
    },
  });
}

async function main() {
  const t0 = Date.now();
  const sync = fs.readFileSync(path.join(APP_DIR, "latest-sync.txt"), "utf-8").trim();
  if (!fs.existsSync(path.join(APP_DIR, "data", "assessed.parquet"))) {
    throw new Error("data/assessed.parquet missing — run fetch-data-from-r2 first (this builds from local data, never from R2)");
  }
  const outDir = path.join(OUT_ROOT, sync);
  fs.rmSync(OUT_ROOT, { recursive: true, force: true }); // drop any previous sync's files
  fs.mkdirSync(outDir, { recursive: true });

  // Every partition of species/ (the NE universe) plus every group that has an assessed
  // species, so a group with only one kind still gets both files (one empty).
  const conn = await getConn();
  const assessedGroups = (await conn.runAndReadAll(
    `SELECT DISTINCT taxon_group FROM '${parquetUri("assessed.parquet")}' WHERE taxon_group IS NOT NULL`,
  )).getRowObjects().map((r) => String(r.taxon_group));
  const partitionGroups = fs.readdirSync(path.join(APP_DIR, "data", "species"))
    .filter((d) => d.startsWith("taxon_group=")).map((d) => d.slice("taxon_group=".length));
  const groups = [...new Set([...assessedGroups, ...partitionGroups])].sort();

  const manifest: SpeciesListManifest = { v: 1, sync, groups: {} };
  const writes: Promise<void>[] = [];
  let rawBytes = 0;

  for (const group of groups) {
    const names = new Set<string>();
    const entry = { names: [] as string[] } as SpeciesListManifest["groups"][string];
    for (const kind of ["assessed", "ne"] as SpeciesListKind[]) {
      const { species } = await querySpecies({ taxon: group, group, includeNE: kind === "ne" });
      // The live route's category=NE response is the NE rows only (see the route);
      // the assessed file is the assessed rows only.
      const rows = species.filter((s) => (kind === "ne") === (s.category === "NE"));
      for (const r of rows) {
        if (r.class_name) names.add(String(r.class_name).toLowerCase());
        if (r.order_name) names.add(String(r.order_name).toLowerCase());
      }
      const json = JSON.stringify(encodeColumns(rows as unknown as Record<string, unknown>[]));
      rawBytes += json.length;
      const file = path.join(outDir, speciesListFileName(group, kind));
      const slot = { rows: rows.length, bytes: 0 };
      entry[kind] = slot;
      // Compress off the main thread (libuv pool) while the next query runs.
      writes.push(compress(json).then((buf) => { slot.bytes = buf.length; fs.writeFileSync(file, buf); }));
    }
    entry.names = [...names].sort();
    manifest.groups[group] = entry;
  }
  await Promise.all(writes);
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));

  const total = Object.values(manifest.groups).reduce((s, g) => s + g.assessed.bytes + g.ne.bytes, 0);
  const rows = Object.values(manifest.groups).reduce((s, g) => s + g.assessed.rows + g.ne.rows, 0);
  console.log(`species-lists: ${groups.length} groups, ${rows.toLocaleString()} rows, ` +
    `${(rawBytes / 1e6).toFixed(0)}MB → ${(total / 1e6).toFixed(1)}MB brotli in ${((Date.now() - t0) / 1000).toFixed(1)}s → public/species-lists/${sync}/`);
  process.exit(0); // DuckDB keeps the event loop alive
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
