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
import { PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, type S3Client } from "@aws-sdk/client-s3";
import { loadEnvFiles, DATA_DIR, mapConcurrent } from "../lib/utils";
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

/** Files larger than this go up in parts: one 170 MB request timed out (EPIPE) on a slow link. */
const MULTIPART_BYTES = 64 * 1024 * 1024;
const PART_BYTES = 16 * 1024 * 1024;

/** A multipart upload, each part retried on its own. */
async function putMultipart(client: S3Client, bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
  const parts: { ETag: string; PartNumber: number }[] = [];
  for (let off = 0, n = 1; off < body.length; off += PART_BYTES, n++) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: n, Body: body.subarray(off, off + PART_BYTES) }));
        parts.push({ ETag: r.ETag!, PartNumber: n });
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
      }
    }
  }
  await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } }));
}

/** Upload app/data/sync as a new sync and point latest-sync.txt at it. Returns the sync's name. */
export async function uploadSync(): Promise<string> {

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

  let completed = 0;
  await mapConcurrent(localPaths, UPLOAD_CONCURRENCY, async (localPath) => {
    const relPath = path.relative(DATA_DIR, localPath);
    const key = syncPrefix + relPath.split(path.sep).join("/");
    const body = fs.readFileSync(localPath);
    if (body.length > MULTIPART_BYTES) await putMultipart(client, bucket, key, body, contentTypeFor(localPath));
    else await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentTypeFor(localPath) }));
    completed++;
    process.stdout.write(`\r  ${completed}/${localPaths.length}`);
  });
  console.log("");

  // Update the repo-tracked pointer file so the next PR flips production.
  fs.writeFileSync(LATEST_SYNC_FILE, timestamp + "\n");

  console.log(`Uploaded ${localPaths.length} files`);
  console.log(`Updated ${path.relative(process.cwd(), LATEST_SYNC_FILE)} → ${timestamp}`);
  return timestamp;
}

const isDirectRun = process.argv[1]?.endsWith("sync/upload-data-to-r2.ts");
if (isDirectRun) {
  loadEnvFiles();
  uploadSync()
    .then(() => console.log("\nOpen the data PR with:\n  git add app/latest-sync.txt app/src/config/"))
    .catch((err) => { console.error(err); process.exit(1); });
}
