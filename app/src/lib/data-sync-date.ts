/**
 * Deliberately standalone (no import from species-store.ts or anywhere else
 * that touches data/redlist, data/gbif, etc). species-store.ts reads those
 * directories with computed paths that Next.js's file-tracer can't statically
 * resolve, so it conservatively bundles the *entire* data/ directory (~400MB)
 * into any serverless function that imports anything from that module — which
 * blew through Vercel's 250MB uncompressed function size limit for the tiny
 * /api/data-sync-date route. Keeping this in its own file with only a literal
 * path keeps that route's bundle to just this one small text file.
 */
import * as fs from "fs";
import * as path from "path";

const LATEST_SYNC_PATH = path.join(process.cwd(), "latest-sync.txt");

/**
 * The timestamp of the data sync that data/taxa-summary.json etc. were built
 * from (see README § Data Sync Pipeline) — i.e. the "now" the build script used
 * when it computed isOutdated() into that static file. Parses
 * scripts/sync/upload-data-to-r2.ts's makeTimestamp format ("2026-07-16T17-03-30Z",
 * colons swapped for dashes to be S3/URL-safe) back into a Date.
 */
export function getDataSyncDate(): Date {
  const raw = fs.readFileSync(LATEST_SYNC_PATH, "utf-8").trim();
  const iso = raw.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
  return new Date(iso);
}
