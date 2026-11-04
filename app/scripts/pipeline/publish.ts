/**
 * publish: put a built sync into app/data and upload it to R2.
 *
 * Copies ~/.cache/redlist-dashboard/build/data/ over app/data/, removing
 * files the new layout no longer has (the per-group CSVs, unassessed.parquet,
 * mapping.csv, …) but keeping what isn't sync data: narratives, which have
 * their own release prefix, and map overlays. Then runs upload-data-to-r2,
 * which uploads to a fresh syncs/<timestamp>/ prefix and bumps
 * latest-sync.txt. Production switches only when that change is merged.
 *
 * Usage:  npm run sync:publish [-- --no-upload]
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { DATA_DIR, loadEnvFiles } from "../utils";
import { OUT_DIR } from "./paths";

const KEEP = ["narratives.parquet", "narrative-index.parquet", "narrative-terms.parquet", "narrative-lengths.parquet", "overlays/"];

export function publish(opts: { upload?: boolean } = {}): void {
  if (!fs.existsSync(path.join(OUT_DIR, "sync.json"))) {
    throw new Error(`publish: no finished build at ${OUT_DIR} (run npm run sync first)`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "sync.json"), "utf-8"));
  if (manifest.fixtures?.failed?.length) throw new Error(`publish: the build's fixtures failed: ${manifest.fixtures.failed.join(", ")}`);

  const appData = path.join(__dirname, "..", "..", "data");
  if (path.resolve(DATA_DIR) !== path.resolve(appData)) throw new Error("publish: unset PIPELINE_DATA_DIR; publish writes app/data");
  execFileSync("rsync", ["-a", "--delete", ...KEEP.flatMap((k) => ["--exclude", k]), `${OUT_DIR}/`, `${appData}/`], { stdio: "inherit" });
  console.log(`Copied ${OUT_DIR} → ${appData}`);
  if (opts.upload !== false) {
    execFileSync("npx", ["tsx", "scripts/upload-data-to-r2.ts"], { cwd: path.join(__dirname, "..", ".."), stdio: "inherit" });
  }
}

const isDirectRun = process.argv[1]?.endsWith("pipeline/publish.ts") || process.argv[1]?.endsWith("pipeline/publish.js");
if (isDirectRun) {
  loadEnvFiles();
  try { publish({ upload: !process.argv.includes("--no-upload") }); } catch (e) { console.error(e); process.exit(1); }
}
