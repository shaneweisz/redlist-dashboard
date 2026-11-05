/**
 * fetch-duckdb-ext (#260 Phase 2): vendor the DuckDB `httpfs` extension for the
 * deployment target into app/duckdb-ext/ at build time.
 *
 * Why: the v2 read layer queries Parquet in R2 over httpfs. Doing
 * `INSTALL httpfs` at runtime hits extensions.duckdb.org on every cold start
 * (a network round-trip on the request path). Instead we download the matching
 * extension once at build time and `LOAD` it by path — no runtime network, no
 * cold-start INSTALL. next.config traces this dir into the v2 function.
 *
 * Target is always linux_amd64 (Vercel's runtime). Locally the file is unused
 * (dev reads local parquets, USE_R2=false) but harmless to have. The engine
 * version is read from DuckDB itself so this survives a @duckdb/node-api bump.
 *
 * Runs as part of `prebuild`. Idempotent: skips the download when the vendored
 * file already matches the current engine version (via a .version sidecar).
 *
 * Usage:
 *   npx tsx scripts/build/fetch-duckdb-ext.ts
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { DuckDBInstance } from "@duckdb/node-api";

export const EXT_DIR = path.join(__dirname, "..", "..", "duckdb-ext");
const EXT_NAME = "httpfs";
const PLATFORM = "linux_amd64"; // Vercel runtime; the only place USE_R2 is true.

async function engineVersion(): Promise<string> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const rows = (await (await conn.run("SELECT version() AS v")).getRowObjects()) as { v: string }[];
  return rows[0].v; // e.g. "v1.5.3"
}

export async function run(): Promise<void> {
  const version = await engineVersion();
  const extPath = path.join(EXT_DIR, `${EXT_NAME}.duckdb_extension`);
  const versionPath = path.join(EXT_DIR, `${EXT_NAME}.version`);

  const have = fs.existsSync(extPath) && fs.existsSync(versionPath)
    ? fs.readFileSync(versionPath, "utf-8").trim()
    : null;
  if (have === version) {
    console.log(`duckdb-ext: ${EXT_NAME} ${version} already vendored — skipping.`);
    return;
  }

  const url = `http://extensions.duckdb.org/${version}/${PLATFORM}/${EXT_NAME}.duckdb_extension.gz`;
  console.log(`duckdb-ext: downloading ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const gz = Buffer.from(await resp.arrayBuffer());
  const bin = zlib.gunzipSync(gz);

  fs.mkdirSync(EXT_DIR, { recursive: true });
  fs.writeFileSync(extPath, bin);
  fs.writeFileSync(versionPath, version + "\n");
  console.log(`duckdb-ext: wrote ${extPath} (${(bin.length / 1e6).toFixed(1)} MB) for engine ${version}`);
}

const isDirectRun = process.argv[1]?.endsWith("build/fetch-duckdb-ext.ts") || process.argv[1]?.endsWith("build/fetch-duckdb-ext.js");
if (isDirectRun) {
  run().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
}
