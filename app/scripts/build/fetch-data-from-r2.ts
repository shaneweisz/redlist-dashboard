/**
 * fetch-data-from-r2: the sync app/latest-sync.txt names → app/data/sync/.
 *
 * The first step of every build (`prebuild`), on Vercel and locally: the
 * branch's pointer decides which sync it builds with. app/data/sync is replaced
 * whole, so it holds exactly that sync and no file an older one left.
 *
 * Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (and
 * R2_DATA_BUCKET_NAME, default dashboard-data).
 *
 * Usage:  npm run fetch-data-from-r2
 */

import * as fs from "fs";
import * as path from "path";
import { loadEnvFiles, DATA_DIR } from "../lib/utils";
import { downloadSync } from "../lib/r2";

const LATEST_SYNC_FILE = path.join(__dirname, "..", "..", "latest-sync.txt");

async function main(): Promise<void> {
  loadEnvFiles();
  const sync = fs.readFileSync(LATEST_SYNC_FILE, "utf-8").trim();
  if (!sync) throw new Error(`Empty pointer file: ${LATEST_SYNC_FILE}`);
  console.log(`Fetching sync ${sync} into ${DATA_DIR}`);
  // Downloaded beside it, then swapped in, so a failed fetch leaves the old copy whole.
  const incoming = `${DATA_DIR}.incoming`;
  fs.rmSync(incoming, { recursive: true, force: true });
  const n = await downloadSync(sync, incoming);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.renameSync(incoming, DATA_DIR);
  console.log(`Done: ${n} files, sync ${sync}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
