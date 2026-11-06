/**
 * upload-aoh-maps: Pre-rendered AOH PNGs → Cloudflare R2
 *
 * Reads AOH GeoTIFFs from the STAR pipeline output directory, reprojects
 * from Mollweide to WGS84, renders as PNG, and uploads to R2 alongside
 * metadata JSON (bounds + AOH stats).
 *
 * This eliminates the need for runtime GDAL on Vercel — the API routes
 * become simple R2 fetches.
 *
 * Prerequisites:
 *   1. STAR pipeline output in /scratch/sw984/star/aohs/current/
 *   2. GDAL tools (gdalwarp, gdal_translate, gdalinfo) on PATH
 *   3. Environment variables: R2_*
 *
 * Usage:
 *   npx tsx scripts/maps/upload-aoh-maps.ts                    # all taxa
 *   npx tsx scripts/maps/upload-aoh-maps.ts mammalia aves      # specific taxa
 *   npx tsx scripts/maps/upload-aoh-maps.ts --ids 10009        # specific sis_taxon_ids
 *   npx tsx scripts/maps/upload-aoh-maps.ts mammalia --force   # re-upload all
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { loadEnvFiles, SyncLogger } from "../lib/utils";
import { execFileSync } from "child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { r2Client } from "../lib/r2";

const R2_PREFIX = "aoh-maps";
const STAR_DATA_DIR = "/scratch/sw984/star";
const MAX_SIZE = 4096; // Max pixel dimension for output PNG

const TAXON_GROUPS = ["MAMMALIA", "AVES", "REPTILIA", "AMPHIBIA"] as const;

const TAXON_GROUP_LOWER: Record<string, string> = {
  mammalia: "MAMMALIA",
  aves: "AVES",
  reptilia: "REPTILIA",
  amphibia: "AMPHIBIA",
};

async function listExistingKeys(r2: S3Client, bucket: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let continuationToken: string | undefined;

  do {
    const response = await r2.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${R2_PREFIX}/`,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of response.Contents ?? []) {
      if (obj.Key) keys.add(obj.Key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

function getWgs84Bounds(tifPath: string): [number, number, number, number] {
  const stdout = execFileSync("gdalinfo", ["-json", tifPath], { encoding: "utf-8" });
  const info = JSON.parse(stdout);
  if (info.wgs84Extent) {
    const coords = info.wgs84Extent.coordinates[0];
    const lons = coords.map((c: number[]) => c[0]);
    const lats = coords.map((c: number[]) => c[1]);
    return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  }
  const cc = info.cornerCoordinates;
  return [cc.lowerRight[1], cc.upperLeft[0], cc.upperLeft[1], cc.lowerRight[0]];
}

interface InsetClip {
  /** Percent of width trimmed off the left and right edges (integer 1-100). */
  x: number;
  /** Percent of height trimmed off the top and bottom edges (integer 1-100). */
  y: number;
}

/**
 * Reproject a Mollweide AOH raster to Web Mercator.
 *
 * For most species this is a single gdalwarp call. For globe-spanning
 * species (e.g. wide-ranging seabirds, sea snakes), the rectangular
 * source raster's corner pixels lie just outside the valid Mollweide
 * projection ellipse, so PROJ refuses with "Point outside of projection
 * domain" / "Cannot find coordinate operations". In that case we
 * pre-clip the source via -srcwin to inset the bbox inside the ellipse,
 * escalating the inset until the warp succeeds. The clipped pixels
 * around the edge are guaranteed to be empty (otherwise they'd already
 * be inside the ellipse), so no habitat is lost — but we still record
 * the inset in the output metadata so the frontend can flag it.
 *
 * Returns the inset percentages used, or null if no clipping was needed.
 */
function warpMollweideToMercator(srcPath: string, dstPath: string): InsetClip | null {
  const baseArgs = [
    "-t_srs", "EPSG:3857",
    "-r", "near",
    "-srcnodata", "0",
    "-dstnodata", "0",
    "-co", "COMPRESS=LZW",
    "-overwrite",
  ];

  try {
    execFileSync("gdalwarp", [...baseArgs, srcPath, dstPath], { stdio: "pipe" });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/coordinate operations|projection domain/i.test(msg)) throw err;
  }

  const info = JSON.parse(execFileSync("gdalinfo", ["-json", srcPath], { encoding: "utf-8" }));
  const [w, h] = info.size as [number, number];
  const clippedPath = dstPath + ".clipped.tif";

  // Escalating inset levels: most failures only need a 1% horizontal
  // inset, but a few wide+tall rasters need ~5% on both axes.
  const insets: InsetClip[] = [
    { x: 1, y: 0 },
    { x: 5, y: 5 },
    { x: 10, y: 10 },
  ];

  for (const inset of insets) {
    const ix = Math.max(1, Math.ceil((w * inset.x) / 100));
    const iy = Math.max(0, Math.ceil((h * inset.y) / 100));
    const newW = w - 2 * ix;
    const newH = h - 2 * iy;
    if (newW <= 0 || newH <= 0) continue;
    try {
      execFileSync("gdal_translate", [
        "-srcwin", String(ix), String(iy), String(newW), String(newH),
        srcPath, clippedPath,
      ], { stdio: "pipe" });
      execFileSync("gdalwarp", [...baseArgs, clippedPath, dstPath], { stdio: "pipe" });
      return inset;
    } catch {
      // Try the next inset level
    } finally {
      if (existsSync(clippedPath)) rmSync(clippedPath);
    }
  }

  throw new Error(
    `gdalwarp failed for ${srcPath} even after escalating insets — ` +
    `source CRS may not be standard Mollweide`
  );
}

function renderAohPng(
  tifPath: string,
  tmpDir: string,
): { pngBuffer: Buffer; bounds: [number, number, number, number]; insetClip: InsetClip | null } {
  const warpedPath = join(tmpDir, "warped.tif");
  const pngPath = join(tmpDir, "aoh.png");

  // Step 1: Reproject Mollweide → Web Mercator. We target EPSG:3857 (not
  // 4326) so the PNG pixel grid matches MapLibre's image-source quad,
  // which is sampled in Mercator screen space. An equirectangular PNG
  // drifts visibly from vector overlays at higher latitudes.
  // -srcnodata/-dstnodata 0 flags absence pixels as nodata so we can
  // turn them into transparent alpha when rendering the PNG below.
  const insetClip = warpMollweideToMercator(tifPath, warpedPath);

  // Step 2: Get WGS84 bounds (gdalinfo reports wgs84Extent in lon/lat
  // regardless of source SRS), used by the frontend image-source coords.
  const bounds = getWgs84Bounds(warpedPath);

  // Step 3: Render to PNG, downsampling if the warped raster exceeds
  // MAX_SIZE on its longest edge.
  const warpedInfo = JSON.parse(
    execFileSync("gdalinfo", ["-json", warpedPath], { encoding: "utf-8" })
  );
  const [warpedWidth, warpedHeight] = warpedInfo.size;
  const longest = Math.max(warpedWidth, warpedHeight);

  // -scale 0 1 1 255 maps fractional habitat values [0,1] → byte [1,255],
  // reserving 0 exclusively for nodata. This gives a *consistent* mapping
  // across species, instead of GDAL's default per-image autoscale which
  // makes a species with max=0.05 look identical in intensity to one with
  // max=1.0.
  // -b 1 -b mask emits a 2-band grayscale+alpha PNG: band 1 is the value,
  // the second band is the nodata mask flipped to alpha (0 = transparent
  // for absence, 255 = opaque for presence). Without this the PNG renders
  // as an opaque rectangle covering the species' bounding box.
  const translateArgs = [
    "-of", "PNG",
    "-ot", "Byte",
    "-scale", "0", "1", "1", "255",
    "-b", "1",
    "-b", "mask",
    "-colorinterp", "green,alpha",
  ];
  if (longest > MAX_SIZE) {
    const scale = MAX_SIZE / longest;
    translateArgs.push(
      "-outsize",
      String(Math.round(warpedWidth * scale)),
      String(Math.round(warpedHeight * scale))
    );
  }
  translateArgs.push(warpedPath, pngPath);
  execFileSync("gdal_translate", translateArgs);

  return { pngBuffer: readFileSync(pngPath), bounds, insetClip };
}

/** Build R2 key suffix encoding the inset clip, if any: e.g. `_c1x0`, `_c5x5`. */
function insetSuffix(inset: InsetClip | null): string {
  return inset ? `_c${inset.x}x${inset.y}` : "";
}

/** Match either `{id}.png` or `{id}_c{x}x{y}.png` (and same for .json). */
function hasExistingAohUpload(existingKeys: Set<string>, id: string): boolean {
  if (existingKeys.has(`${R2_PREFIX}/${id}.png`)) return true;
  for (const key of existingKeys) {
    if (key.startsWith(`${R2_PREFIX}/${id}_c`) && key.endsWith(".png")) return true;
  }
  return false;
}

/** List all sisTaxonIds that have AOH TIFs for a given taxon group folder */
function listAohSpecies(folder: string): string[] {
  const dir = join(STAR_DATA_DIR, "aohs", "current", folder);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir);
  const ids: string[] = [];
  for (const f of files) {
    const match = f.match(/^(\d+)_all\.tif$/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

async function uploadBatch(
  r2: S3Client,
  bucket: string,
  folder: string,
  ids: string[],
  existingKeys: Set<string>,
  logger: SyncLogger,
): Promise<{ uploaded: number; skipped: number; existing: number; failed: number }> {
  let uploaded = 0;
  let skipped = 0;
  let existing = 0;
  let failed = 0;

  const tmpDir = mkdtempSync(join(tmpdir(), "aoh-upload-"));

  for (const id of ids) {
    try {
      if (hasExistingAohUpload(existingKeys, id)) {
        existing++;
        logger.log("aoh_existing", { sisTaxonId: id });
        console.log(`    ${id} — already in R2, skipping`);
        continue;
      }

      const total = uploaded + existing + skipped + failed + 1;
      process.stdout.write(`    [${total}/${ids.length}] ${id}...`);
      const t0 = Date.now();

      const tifPath = join(STAR_DATA_DIR, "aohs", "current", folder, `${id}_all.tif`);
      const jsonPath = join(STAR_DATA_DIR, "aohs", "current", folder, `${id}_all.json`);

      if (!existsSync(tifPath)) {
        skipped++;
        logger.log("aoh_no_tif", { sisTaxonId: id });
        console.log(` no TIF (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        continue;
      }

      // Render PNG + extract bounds
      const { pngBuffer, bounds, insetClip } = renderAohPng(tifPath, tmpDir);

      // Encode inset clip in the R2 filename so the PNG/metadata variant
      // is visible from a plain R2 listing — same convention as the
      // simplified range-map files (`_s{tolerance}.json`).
      const suffix = insetSuffix(insetClip);
      const pngKey = `${R2_PREFIX}/${id}${suffix}.png`;
      const metaKey = `${R2_PREFIX}/${id}${suffix}.json`;

      // Read metadata JSON if it exists
      let metadata: Record<string, unknown> = {};
      if (existsSync(jsonPath)) {
        metadata = JSON.parse(readFileSync(jsonPath, "utf-8"));
      }

      // Combine metadata with bounds + (optional) inset_clip note. The
      // frontend reads inset_clip to display a "edges trimmed" tooltip.
      const metaJson = JSON.stringify({
        ...metadata,
        bounds,
        ...(insetClip && { inset_clip: insetClip }),
      });

      // Upload PNG
      await r2.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: pngKey,
          Body: pngBuffer,
          ContentType: "image/png",
        })
      );

      // Upload metadata
      await r2.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: metaKey,
          Body: metaJson,
          ContentType: "application/json",
        })
      );

      uploaded++;
      const sizeMB = (pngBuffer.length / 1024 / 1024).toFixed(2);
      logger.log("aoh_uploaded", {
        sisTaxonId: id,
        sizeMB,
        ...(insetClip && { insetClip }),
      });
      const clipNote = insetClip ? ` [clipped ${insetClip.x}%×${insetClip.y}%]` : "";
      console.log(` ${sizeMB} MB${clipNote} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      failed++;
      logger.log("aoh_failed", { sisTaxonId: id, error: err instanceof Error ? err.message : String(err) });
      console.log(` FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Clean up temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  return { uploaded, skipped, existing, failed };
}

export async function run(opts: {
  taxa?: string[];
  logger?: SyncLogger;
  force?: boolean;
} = {}): Promise<void> {
  const logger = opts.logger ?? new SyncLogger("upload-aoh-maps");
  const r2 = r2Client();
  const bucket = process.env.R2_MAPS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("Missing R2_MAPS_BUCKET_NAME");
  }

  let existingKeys: Set<string>;
  if (opts.force) {
    existingKeys = new Set();
    console.log("  Force mode: re-uploading all species");
  } else {
    console.log("  Listing existing R2 keys...");
    existingKeys = await listExistingKeys(r2, bucket);
    console.log(`  Found ${existingKeys.size} existing AOH maps in R2`);
  }

  // Determine which taxon group folders to process
  const folders = opts.taxa
    ? opts.taxa.map((t) => TAXON_GROUP_LOWER[t.toLowerCase()]).filter(Boolean)
    : [...TAXON_GROUPS];

  let totalUploaded = 0;
  let totalExisting = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const folder of folders) {
    const ids = listAohSpecies(folder);

    if (ids.length === 0) {
      console.log(`  ${folder}: no AOH maps found`);
      continue;
    }

    const alreadyUploaded = ids.filter((id) => hasExistingAohUpload(existingKeys, id));
    const toUpload = ids.filter((id) => !hasExistingAohUpload(existingKeys, id));

    console.log(`  ${folder}: ${ids.length} species with AOH (${alreadyUploaded.length} already in R2, ${toUpload.length} to upload)`);
    logger.log("aoh_taxon_start", { taxon: folder, total: ids.length, toUpload: toUpload.length });

    totalExisting += alreadyUploaded.length;
    const result = await uploadBatch(r2, bucket, folder, toUpload, existingKeys, logger);
    totalUploaded += result.uploaded;
    totalExisting += result.existing;
    totalSkipped += result.skipped;
    totalFailed += result.failed;

    console.log(`    ${folder} done: ${result.uploaded} uploaded, ${result.existing} existing, ${result.skipped} skipped, ${result.failed} failed`);
    logger.log("aoh_taxon_complete", { taxon: folder, ...result });
  }

  console.log(`\n  Total: ${totalUploaded} uploaded, ${totalExisting} already in R2, ${totalSkipped} skipped, ${totalFailed} failed`);
  logger.log("aoh_complete", { uploaded: totalUploaded, existing: totalExisting, skipped: totalSkipped, failed: totalFailed });
  if (!opts.logger) logger.close();
}

async function main() {
  loadEnvFiles();

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const filteredArgs = args.filter((a) => a !== "--force");

  // Direct ID mode: --ids 10009 10032
  if (filteredArgs[0] === "--ids") {
    const ids = filteredArgs.slice(1).filter((a) => /^\d+$/.test(a));
    if (ids.length === 0) {
      console.error("No valid sis_taxon_ids provided");
      process.exit(1);
    }

    const r2 = r2Client();
    const bucket = process.env.R2_MAPS_BUCKET_NAME!;
    const logger = new SyncLogger("upload-aoh-maps");

    console.log("Listing existing R2 keys...");
    const existingKeys = force ? new Set<string>() : await listExistingKeys(r2, bucket);
    console.log(`Processing ${ids.length} species...`);

    // Find which folder each ID is in
    for (const id of ids) {
      let found = false;
      for (const folder of TAXON_GROUPS) {
        const tifPath = join(STAR_DATA_DIR, "aohs", "current", folder, `${id}_all.tif`);
        if (existsSync(tifPath)) {
          const result = await uploadBatch(r2, bucket, folder, [id], existingKeys, logger);
          console.log(`  ${id} (${folder}): ${result.uploaded ? "uploaded" : result.existing ? "existing" : "skipped"}`);
          found = true;
          break;
        }
      }
      if (!found) console.log(`  ${id}: TIF not found in any taxon group`);
    }

    logger.close();
    return;
  }

  // Taxon group mode (default)
  const taxa = filteredArgs.length > 0 ? filteredArgs.map((a) => a.toLowerCase()) : undefined;
  await run({ taxa, force });
}

const isDirectRun = process.argv[1]?.endsWith("maps/upload-aoh-maps.ts") || process.argv[1]?.endsWith("maps/upload-aoh-maps.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
