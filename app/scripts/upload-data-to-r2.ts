/**
 * upload-data-to-r2: app/data/ → Cloudflare R2 dashboard-data bucket
 *
 * Uploads every file under app/data/ to syncs/<timestamp>/ in the
 * dashboard-data R2 bucket, then updates the repo-tracked
 * app/latest-sync.txt to point at the new timestamp. The pointer
 * change is committed via PR — production only switches to the new
 * sync once that PR merges.
 *
 * Layout in R2:
 *   <bucket>/
 *     syncs/
 *       2026-05-20T10-30-00Z/
 *         gbif/amphibia.csv
 *         redlist/...
 *         backbone.parquet
 *         ...
 *
 * Active sync pointer lives in app/latest-sync.txt (version-controlled).
 *
 * Prerequisites:
 *   - Environment variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *     R2_SECRET_ACCESS_KEY, R2_DATA_BUCKET_NAME
 *   - app/data/ populated locally (e.g. by running the sync pipeline)
 *
 * Usage:
 *   npx tsx scripts/upload-data-to-r2.ts
 */

import * as fs from "fs";
import * as path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { loadEnvFiles, SyncLogger, DATA_DIR, mapConcurrent } from "./utils";

const UPLOAD_CONCURRENCY = 16;
const LATEST_SYNC_FILE = path.join(__dirname, "..", "latest-sync.txt");

// Files to leave out of new syncs, relative-to-DATA_DIR and forward-slashed.
//
// search-index.json (~95MB) is a legacy artifact: it backed the old in-memory
// search, live search now queries Parquet over R2 (searchSpecies in
// species-duckdb.ts), and nothing reads the JSON. Excluding it stops it
// propagating (fetch → data/ → re-upload) into future syncs.
//
// col-revisions.json is excluded for the opposite reason — it is current, and
// the REPO owns it. Every other tracked data/ file is dual git-tracked and
// R2-published, where R2 wins at build time because fetch-data-from-r2
// overwrites the committed copy. That is right for the others: they are numbers,
// and stale numbers are merely stale.
//
// This one carries the card's REASON CODES, which have to match the vocabulary
// in src/lib/col-revision.ts that reads them. Publish it and the two can ship
// apart: renaming genus_moved -> genus_differs in code would leave R2 serving
// data that still says genus_moved, and the bar would silently empty until the
// next sync. Coupled vocabulary has to travel with the code that reads it.
//
// It does not go stale: the weekly workflow runs Phase 13a and commits the
// regenerated file alongside latest-sync.txt, so a sync still refreshes it —
// through git, where the diff is reviewable, rather than around it.
const EXCLUDE_FROM_SYNC = new Set(["search-index.json", "col-revisions.json"]);

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)"
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getDataBucket(): string {
  const bucket = process.env.R2_DATA_BUCKET_NAME;
  if (!bucket) {
    throw new Error("Missing R2_DATA_BUCKET_NAME env var");
  }
  return bucket;
}

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
  if (filePath.endsWith(".csv")) return "text/csv";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

async function main(): Promise<void> {
  loadEnvFiles();
  const logger = new SyncLogger("upload-data-to-r2");

  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Data dir does not exist: ${DATA_DIR}`);
  }

  const client = getR2Client();
  const bucket = getDataBucket();
  const timestamp = makeTimestamp();
  const syncPrefix = `syncs/${timestamp}/`;

  const localPaths = walkFiles(DATA_DIR).filter(
    (p) => !EXCLUDE_FROM_SYNC.has(path.relative(DATA_DIR, p).split(path.sep).join("/"))
  );

  // Anything here is pulled down at build time and bundled into every serverless
  // function, where Vercel caps a function at 250MB uncompressed. A 92MB key
  // cache that had no business being published is what taught us that, by failing
  // a deploy after the build had already succeeded. Large files are legitimate
  // (backbone.parquet is one), so this reports rather than blocks — but it
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
  console.log("");
  console.log("Next steps:");
  console.log("  git add app/latest-sync.txt app/data/taxa-summary.json app/data/table1a-children-summaries.json app/data/ssc-group-children-summaries.json app/data/col-split-candidates.parquet app/data/col-synonym-assessed.parquet app/data/col-to-assessed.parquet");
  console.log(`  git commit -m "Bump data sync to ${timestamp}"`);
  console.log("  git push  # open PR; merging flips production to the new sync");
  logger.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
