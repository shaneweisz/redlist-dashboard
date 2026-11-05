/**
 * R2 access for the pipeline: list and download one sync from the
 * dashboard-data bucket.
 */

import * as fs from "fs";
import * as path from "path";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import { mapConcurrent } from "./utils";

export function r2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function dataBucket(): string {
  return process.env.R2_DATA_BUCKET_NAME ?? "dashboard-data";
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Download every object under syncs/<sync>/ into dest, keeping relative paths. */
export async function downloadSync(sync: string, dest: string, concurrency = 16): Promise<number> {
  const client = r2Client();
  const bucket = dataBucket();
  const prefix = `syncs/${sync}/`;
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const resp = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of resp.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = resp.NextContinuationToken;
  } while (token);
  if (keys.length === 0) throw new Error(`No objects under s3://${bucket}/${prefix}`);

  let done = 0;
  await mapConcurrent(keys, concurrency, async (key) => {
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(resp.Body as Readable);
    const local = path.join(dest, ...key.substring(prefix.length).split("/"));
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, body);
    done++;
    if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${keys.length}`);
  });
  if (process.stdout.isTTY) process.stdout.write("\n");
  return keys.length;
}
