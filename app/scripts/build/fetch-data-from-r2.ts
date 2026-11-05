/**
 * fetch-data-from-r2: Cloudflare R2 dashboard-data bucket → app/data/
 *
 * Reads the active sync timestamp from app/latest-sync.txt (the
 * repo-tracked pointer), lists every object under syncs/<timestamp>/
 * in R2, and downloads them into app/data/ preserving relative paths.
 *
 * Runs as `prebuild` so Vercel and local builds populate app/data/
 * from R2 based on whatever timestamp is committed to the branch.
 *
 * Prerequisites:
 *   - Environment variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *     R2_SECRET_ACCESS_KEY, R2_DATA_BUCKET_NAME
 *   - app/latest-sync.txt exists and references a sync that's been
 *     uploaded via scripts/sync/upload-data-to-r2.ts
 *
 * Usage:
 *   npx tsx scripts/build/fetch-data-from-r2.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import { loadEnvFiles, SyncLogger, DATA_DIR, mapConcurrent } from "../lib/utils";

const DOWNLOAD_CONCURRENCY = 16;
const LATEST_SYNC_FILE = path.join(__dirname, "..", "..", "latest-sync.txt");

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

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  loadEnvFiles();
  const logger = new SyncLogger("fetch-data-from-r2");

  const client = getR2Client();
  const bucket = getDataBucket();

  // 1. Resolve the active sync via the repo-tracked pointer file.
  if (!fs.existsSync(LATEST_SYNC_FILE)) {
    throw new Error(`Pointer file not found: ${LATEST_SYNC_FILE}`);
  }
  const timestamp = fs.readFileSync(LATEST_SYNC_FILE, "utf-8").trim();
  if (!timestamp) {
    throw new Error(`Empty pointer file: ${LATEST_SYNC_FILE}`);
  }
  const syncPrefix = `syncs/${timestamp}/`;
  console.log(`Fetching sync ${timestamp} from s3://${bucket}/${syncPrefix}`);
  logger.log("fetch_started", { bucket, timestamp });

  // 2. List every object under that sync prefix.
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: syncPrefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  if (keys.length === 0) {
    throw new Error(`No objects under s3://${bucket}/${syncPrefix}`);
  }

  console.log(`Downloading ${keys.length} files into ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 3. Download in parallel.
  let completed = 0;
  await mapConcurrent(keys, DOWNLOAD_CONCURRENCY, async (key) => {
    const resp = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    const body = await streamToBuffer(resp.Body as Readable);
    const relPath = key.substring(syncPrefix.length);
    const localPath = path.join(DATA_DIR, ...relPath.split("/"));
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, body);
    completed++;
    process.stdout.write(`\r  ${completed}/${keys.length}`);
    logger.log("downloaded", { key, bytes: body.length });
  });
  console.log("");
  console.log(`Done. Sync: ${timestamp}`);
  logger.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
