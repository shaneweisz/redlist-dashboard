/**
 * upload-overlays-to-r2: app/data/overlays/ → the maps R2 bucket
 *
 * The two context layers on the occurrence map are large, static and openly
 * licensed: RESOLVE Ecoregions 2017 and El-Gabbas's GBIF sampling-effort
 * raster. Neither belongs in git — together they are ~3 MB of binary that would
 * sit in the object history forever — and neither should be fetched from its
 * origin at runtime, which would put a dependency (and load) on somebody else's
 * service for a file that never changes.
 *
 * So they are built once by build-ecoregions-layer.ts and
 * build-sampling-effort-layer.ts, uploaded here, and served through
 * /api/overlays/<name>.
 *
 * Unlike the data sync, this writes to a fixed prefix rather than a timestamped
 * one. These are releases of external datasets, not a snapshot of ours: the
 * ecoregions have not changed since 2017 and the sampling-effort raster is a
 * published product. A new version means a new filename, which is a code
 * change and reviewable as one.
 *
 * Prerequisites:
 *   - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_MAPS_BUCKET_NAME
 *   - app/data/overlays/ populated by the two build scripts
 *
 * Usage:
 *   npx tsx scripts/maps/build-ecoregions-layer.ts
 *   npx tsx scripts/maps/build-sampling-effort-layer.ts --out data/overlays/sampling-effort-n_obs-10km.png
 *   npx tsx scripts/maps/upload-overlays-to-r2.ts
 */

import * as fs from "fs";
import * as path from "path";
import { PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { loadEnvFiles } from "../lib/utils";
import { r2Client } from "../lib/r2";

export const OVERLAY_PREFIX = "overlays";

const OVERLAYS_DIR = path.join(__dirname, "..", "..", "data", "overlays");

/** Content types by extension — R2 serves what we tell it to. */
const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".gz": "application/json",
  ".png": "image/png",
};

async function main() {
  loadEnvFiles();
  const bucket = process.env.R2_MAPS_BUCKET_NAME;
  if (!bucket) throw new Error("Missing R2_MAPS_BUCKET_NAME");
  if (!fs.existsSync(OVERLAYS_DIR)) {
    throw new Error(`No ${OVERLAYS_DIR} — run the build scripts first (see the header of this file)`);
  }

  const client = r2Client();
  // The uncompressed .json is kept locally for inspection; only the gzip goes
  // up, since that is what the route serves.
  const files = fs
    .readdirSync(OVERLAYS_DIR)
    .filter((name) => !name.endsWith(".json") || name.endsWith(".json.gz"));
  if (files.length === 0) throw new Error(`Nothing to upload in ${OVERLAYS_DIR}`);

  let uploaded = 0;
  for (const name of files) {
    const filePath = path.join(OVERLAYS_DIR, name);
    const key = `${OVERLAY_PREFIX}/${name}`;

    // The bucket refuses overwrites, and that is the behaviour we want: the
    // route caches these files forever, so quietly swapping one's contents
    // would serve a stale copy indefinitely. A name already present is
    // therefore a no-op rather than an error — re-running this after adding one
    // new layer shouldn't fail on the layers that haven't changed. Changing a
    // file means giving it a new name, which is a code change in
    // lib/mapping/map-overlays.ts and reviewable as one.
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`  already published, left alone → ${key}`);
      continue;
    } catch {
      // Not there yet; upload it below.
    }

    const body = fs.readFileSync(filePath);
    const extension = path.extname(name);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        // Set on the object so the header survives however it's fetched. These
        // are immutable by construction: a new version gets a new filename.
        CacheControl: "public, max-age=31536000, immutable",
        ...(name.endsWith(".gz") ? { ContentEncoding: "gzip" } : {}),
      })
    );
    uploaded++;
    console.log(`  ${(body.length / 1024 / 1024).toFixed(2)} MB → ${bucket}/${key}`);
  }
  console.log(`Uploaded ${uploaded} of ${files.length} overlay file${files.length === 1 ? "" : "s"}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
