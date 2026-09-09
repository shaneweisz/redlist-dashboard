/**
 * upload-narratives-to-r2: the two narrative parquets → narratives/<release>/
 *
 * Deliberately not part of `upload-data-to-r2`. That script publishes a sync:
 * everything under app/data/, to syncs/<timestamp>/, every week. The narratives
 * are not weekly data — they are what the assessors wrote for a Red List
 * release, and they change when a release ships, twice a year. Putting ~170 MB
 * of unchanged text into every Sunday's sync would be paying to store the same
 * two files fifty times a year for no reader that can tell the difference.
 *
 * So they get their own prefix, written once per release and read by every sync
 * until the next one:
 *
 *   <bucket>/narratives/2026-1/narratives.parquet
 *   <bucket>/narratives/2026-1/narrative-index.parquet
 *   <bucket>/narratives/2026-1/narrative-terms.parquet
 *   <bucket>/narratives/2026-1/narrative-lengths.parquet
 *
 * The pointer is a constant, not a file: NARRATIVE_RELEASE in
 * src/lib/redlist/narrative-release.ts. Production reads whatever it names, so
 * uploading is inert until that line changes on main — the same bargain
 * latest-sync.txt makes for a sync.
 *
 * Usage:
 *   npx tsx scripts/build-narratives.ts        # writes both files into data/
 *   npx tsx scripts/upload-narratives-to-r2.ts
 */
import * as fs from "fs";
import * as path from "path";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { loadEnvFiles, DATA_DIR } from "./utils";
import { NARRATIVE_RELEASE, narrativeKey } from "../src/lib/redlist/narrative-release";

/** The files the search reads. Both, or neither — they index each other. */
export const NARRATIVE_FILES = [
  "narratives.parquet",
  "narrative-index.parquet",
  "narrative-terms.parquet",
  "narrative-lengths.parquet",
];

async function main(): Promise<void> {
  loadEnvFiles();
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_DATA_BUCKET_NAME;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_DATA_BUCKET_NAME)"
    );
  }

  const local = NARRATIVE_FILES.map((name) => ({ name, file: path.join(DATA_DIR, name) }));
  const missing = local.filter((f) => !fs.existsSync(f.file));
  if (missing.length > 0) {
    throw new Error(
      `Not built yet: ${missing.map((f) => f.name).join(", ")}. Run scripts/build-narratives.ts first.`
    );
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  // A release's narratives are written once and then read for six months.
  // Overwriting them in place is how a deployed search starts disagreeing with
  // itself mid-request — half its row groups from the old file — so a file that
  // is already published is left alone, and replacing one is a deliberate
  // `--force`. Per file, not per release: adding a fourth file to a release
  // that already has three is a normal thing to want.
  const force = process.argv.includes("--force");
  const todo: typeof local = [];
  for (const entry of local) {
    const key = narrativeKey(entry.name);
    const exists = await client
      .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      .then(() => true)
      .catch(() => false);
    if (exists && !force) console.log(`  already published, skipping: ${key}`);
    else todo.push(entry);
  }
  if (todo.length === 0) {
    console.log(`\nEverything for ${NARRATIVE_RELEASE} is already published.`);
    console.log("Bump NARRATIVE_RELEASE for a new release, or pass --force to replace this one.");
    return;
  }

  for (const { name, file } of todo) {
    const key = narrativeKey(name);
    const body = fs.readFileSync(file);
    process.stdout.write(`  ${(body.length / 1e6).toFixed(1).padStart(6)} MB → ${key} … `);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/octet-stream",
      })
    );
    console.log("done");
  }

  console.log(`\nPublished the ${NARRATIVE_RELEASE} narratives.`);
  console.log("Production reads them once NARRATIVE_RELEASE names this release on main.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
