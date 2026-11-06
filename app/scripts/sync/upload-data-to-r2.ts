/**
 * upload-data-to-r2: app/data/sync → a new syncs/<timestamp>/ in the
 * dashboard-data R2 bucket, then point app/latest-sync.txt at it.
 *
 * Production only switches to the new sync once that pointer change merges, so
 * uploading is safe at any time. `npm run sync:publish` calls this after
 * copying a build into app/data/sync; run alone, it uploads whatever is there.
 *
 * Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (and
 * R2_DATA_BUCKET_NAME, default dashboard-data).
 *
 * Usage:  npm run upload-data-to-r2
 */

import * as fs from "fs";
import * as path from "path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { loadEnvFiles, SyncLogger, DATA_DIR, mapConcurrent } from "../lib/utils";
import { r2Client, dataBucket } from "../lib/r2";

const UPLOAD_CONCURRENCY = 16;
const LATEST_SYNC_FILE = path.join(__dirname, "..", "..", "latest-sync.txt");

function makeTimestamp(): string {
  // 2026-05-20T10-30-00Z — lexicographically sortable, S3/URL-safe.
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".log")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** Upload app/data/sync as a new sync and point latest-sync.txt at it. Returns the sync's name. */
export async function uploadSync(): Promise<string> {
  const logger = new SyncLogger("upload-data-to-r2");

  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Data dir does not exist: ${DATA_DIR}`);
  }

  const client = r2Client();
  const bucket = dataBucket();
  const timestamp = makeTimestamp();
  const syncPrefix = `syncs/${timestamp}/`;

  // app/data/sync is exactly one sync, so all of it goes up.
  const localPaths = walkFiles(DATA_DIR);

  // Anything here is pulled down at build time and bundled into every serverless
  // function, where Vercel caps a function at 250MB uncompressed. A 92MB key
  // cache that had no business being published is what taught us that, by failing
  // a deploy after the build had already succeeded. Large files are legitimate
  // (taxa.parquet is one), so this reports rather than blocks — but it
  // reports, so a new one is noticed here instead of three steps later.
  const LARGE_FILE_MB = 50;
  const large = localPaths
    .map((p) => ({ p, mb: fs.statSync(p).size / 1024 / 1024 }))
    .filter((f) => f.mb >= LARGE_FILE_MB)
    .sort((a, b) => b.mb - a.mb);
  if (large.length > 0) {
    console.log(`Large files in this sync (bundled into every serverless function, 250MB cap):`);
    for (const f of large) {
      console.log(`  ${f.mb.toFixed(1).padStart(7)} MB  ${path.relative(DATA_DIR, f.p)}`);
    }
    console.log(`  total ${large.reduce((n, f) => n + f.mb, 0).toFixed(1)} MB\n`);
  }
  if (localPaths.length === 0) {
    throw new Error(`No files found under ${DATA_DIR}`);
  }

  const totalBytes = localPaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
  console.log(
    `Uploading ${localPaths.length} files (${(totalBytes / 1024 / 1024).toFixed(1)} MB) ` +
      `to s3://${bucket}/${syncPrefix}`
  );
  logger.log("upload_started", { bucket, timestamp, fileCount: localPaths.length, totalBytes });

  let completed = 0;
  await mapConcurrent(localPaths, UPLOAD_CONCURRENCY, async (localPath) => {
    const relPath = path.relative(DATA_DIR, localPath);
    const key = syncPrefix + relPath.split(path.sep).join("/");
    const body = fs.readFileSync(localPath);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentTypeFor(localPath),
      })
    );
    completed++;
    process.stdout.write(`\r  ${completed}/${localPaths.length}`);
    logger.log("uploaded", { key, bytes: body.length });
  });
  console.log("");

  // Update the repo-tracked pointer file so the next PR flips production.
  fs.writeFileSync(LATEST_SYNC_FILE, timestamp + "\n");
  logger.log("pointer_file_updated", { timestamp, path: LATEST_SYNC_FILE });

  console.log(`Uploaded ${localPaths.length} files`);
  console.log(`Updated ${path.relative(process.cwd(), LATEST_SYNC_FILE)} → ${timestamp}`);
  logger.close();
  return timestamp;
}

const isDirectRun = process.argv[1]?.endsWith("sync/upload-data-to-r2.ts");
if (isDirectRun) {
  loadEnvFiles();
  uploadSync()
    .then(() => console.log("\nOpen the data PR with:\n  git add app/latest-sync.txt app/src/config/"))
    .catch((err) => { console.error(err); process.exit(1); });
}
