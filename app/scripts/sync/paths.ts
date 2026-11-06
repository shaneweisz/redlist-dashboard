/**
 * Where the pipeline keeps things.
 *
 *   CACHE_ROOT  downloaded inputs and baselines, reused across runs (cachedDir)
 *   BUILD_DIR   what a run produces; copied into app/data only to publish, so
 *               app/data keeps matching the sync production serves meanwhile
 *     core/     the source-of-truth tables (taxa, assessments, links, counts)
 *     data/     what the app reads, built from core/ (same layout as app/data)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const CACHE_ROOT = path.join(os.homedir(), ".cache", "redlist-dashboard");
export const BUILD_DIR = process.env.PIPELINE_BUILD_DIR ?? path.join(CACHE_ROOT, "build");
/** Where the sync's DuckDB instances spill to disk (left to itself, DuckDB uses ./.tmp in the repo). */
export const DUCKDB_TMP = path.join(CACHE_ROOT, "duckdb-tmp");
export const CORE_DIR = path.join(BUILD_DIR, "core");
export const OUT_DIR = path.join(BUILD_DIR, "data");

/**
 * A cached download or build: `fill` runs into an empty `dir` unless an earlier
 * run finished it. Finished means its .complete marker exists, so an interrupted
 * run is redone, never half-used.
 */
export async function cachedDir(dir: string, fill: (dir: string) => unknown): Promise<string> {
  const marker = path.join(dir, ".complete");
  if (fs.existsSync(marker)) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await fill(dir);
  fs.writeFileSync(marker, new Date().toISOString() + "\n");
  return dir;
}

/** Stop if a step's input is missing: a sync always builds them, so a gap is a bug, not a reason to write zeros. */
export function requireFiles(step: string, ...files: string[]): void {
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`${step}: ${f} is missing`);
}
