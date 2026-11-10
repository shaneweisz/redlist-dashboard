/**
 * publish: put a built sync into app/data/sync and upload it to R2.
 *
 * Makes app/data/sync exactly the build's data/ (removing what the build
 * doesn't have), then uploadSync (upload-data-to-r2.ts) uploads it to a fresh
 * syncs/<timestamp>/ and bumps latest-sync.txt. Production switches only when
 * that change is merged. The narratives and map overlays are siblings of
 * app/data/sync, so they are neither touched nor uploaded.
 *
 * Usage:  npm run sync:publish [-- --no-upload]
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { DATA_DIR, loadEnvFiles } from "../lib/utils";
import { PUBLISHED_DIR } from "./paths";
import { uploadSync } from "./upload-data-to-r2";
import { syncPath } from "../../src/lib/data/sync-layout";

export async function publish(opts: { upload?: boolean } = {}): Promise<void> {
  if (!fs.existsSync(path.join(PUBLISHED_DIR, syncPath("sync.json")))) {
    throw new Error(`publish: no finished build at ${PUBLISHED_DIR} (run npm run sync first)`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLISHED_DIR, syncPath("sync.json")), "utf-8"));
  if (manifest.fixtures?.failed?.length) throw new Error(`publish: the build's fixtures failed: ${manifest.fixtures.failed.join(", ")}`);
  if (manifest.data_tests?.passed !== true) throw new Error("publish: the build's data tests didn't pass (see npm run sync's checks)");

  const appData = path.join(__dirname, "..", "..", "data", "sync");
  if (path.resolve(DATA_DIR) !== path.resolve(appData)) throw new Error("publish: unset PIPELINE_DATA_DIR; publish writes app/data/sync");
  fs.mkdirSync(appData, { recursive: true });
  execFileSync("rsync", ["-a", "--delete", `${PUBLISHED_DIR}/`, `${appData}/`], { stdio: "inherit" });
  console.log(`Copied ${PUBLISHED_DIR} → ${appData}`);
  if (opts.upload !== false) await uploadSync();
  // The sync's data lives in R2 only; git holds the pointer, and the CoL
  // release and taxon-id configs the sync writes into src/config/.
  console.log(`\nStage the data PR with:\n  git add app/latest-sync.txt app/src/config/`);
}

const isDirectRun = process.argv[1]?.endsWith("sync/publish.ts") || process.argv[1]?.endsWith("sync/publish.js");
if (isDirectRun) {
  loadEnvFiles();
  publish({ upload: !process.argv.includes("--no-upload") }).catch((e) => { console.error(e); process.exit(1); });
}
