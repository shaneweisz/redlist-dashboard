/**
 * fetch-duckdb-ext: vendor DuckDB's httpfs extension for Vercel into
 * app/duckdb-ext/ at build time.
 *
 * On Vercel the routes query the sync's parquets in R2 over httpfs. Installing
 * it at runtime would download it from extensions.duckdb.org on every cold
 * start, so the build downloads the matching build once and the routes LOAD it
 * by path (next.config.ts traces the folder into the functions). Always
 * linux_amd64, Vercel's runtime; locally the routes read app/data/sync and never
 * load it. The engine version is read from DuckDB itself, so a @duckdb/node-api
 * bump fetches the matching file; an unchanged version skips the download.
 *
 * Usage:  npm run fetch-duckdb-ext
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { DuckDBInstance } from "@duckdb/node-api";

export const EXT_DIR = path.join(__dirname, "..", "..", "duckdb-ext");
const EXT_NAME = "httpfs";
const PLATFORM = "linux_amd64"; // Vercel's runtime, the only place the routes read R2

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
