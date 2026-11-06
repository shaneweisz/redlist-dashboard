/**
 * upload-range-maps: IUCN DB → Cloudflare R2
 *
 * Generates range map GeoJSON (polygons + point localities) from the IUCN
 * PostgreSQL database and uploads to R2.
 *
 * Geometry simplification strategy:
 *   - Raw geometries are fetched at full resolution from the DB
 *   - If the resulting GeoJSON exceeds MAX_SIZE_BYTES, the script iteratively
 *     applies ST_SimplifyPreserveTopology at increasing tolerances until the
 *     output fits. The tolerance used is recorded in the filename and as a
 *     top-level `simplification` property in the GeoJSON so the frontend can
 *     inform the user.
 *   - Filename convention:
 *       {id}.json              — full resolution (no simplification)
 *       {id}_s0.001.json       — simplified at 0.001° (~100m)
 *
 * Which assessments have a map comes from the database (assessments.has_map),
 * for each species' latest global assessment, opened read-only
 * (lib/redlist-db.ts).
 *
 * Prerequisites:
 *   1. The Red List database with geometry (the SSH tunnel; the local restore has none)
 *   2. Environment variables: DB_*, R2_*
 *
 * Usage:
 *   npx tsx scripts/maps/upload-range-maps.ts                    # all taxa
 *   npx tsx scripts/maps/upload-range-maps.ts mammalia aves      # specific taxa
 *   npx tsx scripts/maps/upload-range-maps.ts --ids 280792135    # specific assessment IDs
 */

import { Client } from "pg";
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { loadEnvFiles, SyncLogger } from "../lib/utils";
import { getTaxa, type Taxon } from "../lib/taxa";
import { connectRedListDb } from "../lib/redlist-db";
import { CURRENT_TAXON, GLOBAL_ASSESSMENT } from "../sync/core/build-assessments";
import { r2Client } from "../lib/r2";

const R2_PREFIX = "iucn-range-maps";

// Max GeoJSON size before simplification kicks in (10 MB)
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

// Simplification tolerances to try, in order (degrees).
// 0.001° ≈ 100m, 0.005° ≈ 500m, 0.01° ≈ 1km, 0.05° ≈ 5km, 0.1° ≈ 10km
const SIMPLIFY_TOLERANCES = [0.001, 0.005, 0.01, 0.05, 0.1];

const PRESENCE_LABELS: Record<number, string> = {
  1: "Extant",
  2: "Probably Extant",
  3: "Possibly Extant",
  4: "Possibly Extinct",
  5: "Extinct",
  6: "Presence Uncertain",
};

const ORIGIN_LABELS: Record<number, string> = {
  1: "Native",
  2: "Reintroduced",
  3: "Introduced",
  4: "Vagrant",
  5: "Origin Uncertain",
  6: "Assisted Colonisation",
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

/** Check if any R2 key starts with the given prefix (handles both simplified and unsimplified filenames) */
function hasExistingUpload(existingKeys: Set<string>, assessmentId: number): boolean {
  const prefix = `${R2_PREFIX}/${assessmentId}`;
  for (const key of existingKeys) {
    // Match {id}.json or {id}_s{tolerance}.json
    if (key === `${prefix}.json` || key.startsWith(`${prefix}_s`)) return true;
  }
  return false;
}

interface RangeGeoJSON {
  type: "FeatureCollection";
  features: object[];
  simplification?: { tolerance: number; unit: string };
}

async function queryRangeGeoJSON(
  db: Client,
  assessmentId: number,
  tolerance: number | null,
): Promise<RangeGeoJSON | null> {
  const rangeGeomExpr = tolerance != null
    ? `ST_AsGeoJSON(ST_SimplifyPreserveTopology(assessment_ranges.geom::geometry, ${tolerance}))`
    : `ST_AsGeoJSON(assessment_ranges.geom::geometry)`;

  const [rangeResult, pointResult] = await Promise.all([
    db.query(
      `
      SELECT
        assessment_ranges.presence,
        assessment_ranges.origin,
        ${rangeGeomExpr} AS geojson,
        'range' AS source
      FROM
        assessments
        LEFT JOIN assessment_ranges ON assessment_ranges.assessment_id = assessments.id
      WHERE
        assessments.id = $1
        AND assessment_ranges.geom IS NOT NULL
      `,
      [assessmentId]
    ),
    db.query(
      `
      SELECT
        presence,
        origin,
        ST_AsGeoJSON(geom::geometry) AS geojson,
        'point' AS source
      FROM assessment_points
      WHERE assessment_id = $1
        AND geom IS NOT NULL
      `,
      [assessmentId]
    ),
  ]);

  const allRows = [...rangeResult.rows, ...pointResult.rows];
  if (allRows.length === 0) return null;

  const features = allRows
    .filter((row) => row.geojson != null)
    .map((row) => ({
      type: "Feature" as const,
      properties: {
        presence: row.presence,
        presence_label: PRESENCE_LABELS[row.presence] ?? `Unknown (${row.presence})`,
        origin: row.origin,
        origin_label: ORIGIN_LABELS[row.origin] ?? `Unknown (${row.origin})`,
        source: row.source,
      },
      geometry: JSON.parse(row.geojson),
    }));

  if (features.length === 0) return null;

  const geojson: RangeGeoJSON = { type: "FeatureCollection", features };
  if (tolerance != null) {
    geojson.simplification = { tolerance, unit: "degrees" };
  }
  return geojson;
}

/**
 * Check the total vertex count for a species' range polygons (fast query).
 * Used to decide whether to skip full-resolution and go straight to simplification.
 */
async function getVertexCount(db: Client, assessmentId: number): Promise<number> {
  const result = await db.query(
    `SELECT COALESCE(sum(ST_NPoints(geom::geometry)), 0) AS vertices
     FROM assessment_ranges WHERE assessment_id = $1 AND geom IS NOT NULL`,
    [assessmentId]
  );
  return Number(result.rows[0]?.vertices ?? 0);
}

// Rough bytes per vertex in GeoJSON (~25 bytes for coordinate pair + JSON overhead)
const BYTES_PER_VERTEX = 25;

/**
 * Pick the first simplification tolerance likely to bring the output under MAX_SIZE_BYTES,
 * based on the vertex count. Returns null if full resolution should fit.
 */
function pickStartingTolerance(vertices: number): number | null {
  const estimatedBytes = vertices * BYTES_PER_VERTEX;
  if (estimatedBytes <= MAX_SIZE_BYTES) return null;

  // Each tolerance level roughly reduces size by a factor.
  // Pick the first tolerance whose expected output is under the limit.
  // Conservative: we'll still iterate from this point if it's not enough.
  for (const tol of SIMPLIFY_TOLERANCES) {
    // Rough reduction factors based on empirical data
    const reductionFactor = tol < 0.005 ? 0.5 : tol < 0.01 ? 0.15 : tol < 0.05 ? 0.05 : 0.02;
    if (estimatedBytes * reductionFactor <= MAX_SIZE_BYTES) return tol;
  }
  return SIMPLIFY_TOLERANCES[SIMPLIFY_TOLERANCES.length - 1];
}

/**
 * Generate range GeoJSON, adaptively simplifying if the output exceeds MAX_SIZE_BYTES.
 * Checks vertex count first to skip expensive full-resolution queries for large geometries.
 * Returns the GeoJSON string, the R2 key to use, and the tolerance applied (if any).
 */
async function generateRangeGeoJSON(
  db: Client,
  assessmentId: number,
): Promise<{ body: string; r2Key: string; tolerance: number | null } | null> {
  // Check vertex count first (fast) to decide where to start
  const vertices = await getVertexCount(db, assessmentId);
  const startTolerance = pickStartingTolerance(vertices);

  if (startTolerance === null) {
    // Small enough — try full resolution
    const raw = await queryRangeGeoJSON(db, assessmentId, null);
    if (!raw) return null;

    const body = JSON.stringify(raw);
    if (Buffer.byteLength(body) <= MAX_SIZE_BYTES) {
      return { body, r2Key: `${R2_PREFIX}/${assessmentId}.json`, tolerance: null };
    }

    // Estimate was wrong — fall through to simplification
  }

  // Start from the estimated tolerance (or the first one if estimate was wrong)
  const startIdx = startTolerance
    ? SIMPLIFY_TOLERANCES.indexOf(startTolerance)
    : 0;

  for (let i = Math.max(0, startIdx); i < SIMPLIFY_TOLERANCES.length; i++) {
    const tolerance = SIMPLIFY_TOLERANCES[i];
    const simplified = await queryRangeGeoJSON(db, assessmentId, tolerance);
    if (!simplified) return null;

    const body = JSON.stringify(simplified);
    if (Buffer.byteLength(body) <= MAX_SIZE_BYTES) {
      return {
        body,
        r2Key: `${R2_PREFIX}/${assessmentId}_s${tolerance}.json`,
        tolerance,
      };
    }
  }

  // Even the most aggressive simplification didn't fit — upload it anyway
  const lastTolerance = SIMPLIFY_TOLERANCES[SIMPLIFY_TOLERANCES.length - 1];
  const last = await queryRangeGeoJSON(db, assessmentId, lastTolerance);
  if (!last) return null;
  const body = JSON.stringify(last);
  return {
    body,
    r2Key: `${R2_PREFIX}/${assessmentId}_s${lastTolerance}.json`,
    tolerance: lastTolerance,
  };
}

/** The latest global assessments with a range map, for one Table 1a group. */
async function mappedAssessments(db: Client, taxon: Taxon): Promise<{ assessmentId: number; scientificName: string }[]> {
  const col = { kingdom_name: "kingdom_name", phylum_name: "phylum_name", class_name: "class_name", order_name: "order_name" } as const;
  const params: string[][] = [];
  const inGroup = taxon.redlist.map((q) => { params.push(q.filterValues); return `upper(t.${col[q.filterColumn]}) = ANY($${params.length})`; }).join(" OR ");
  const { rows } = await db.query(
    `SELECT a.id AS assessment_id, t.scientific_name
     FROM assessments a JOIN taxons t ON t.id = a.taxon_id
     WHERE a.latest AND a.has_map AND ${CURRENT_TAXON} AND ${GLOBAL_ASSESSMENT} AND (${inGroup})
     ORDER BY a.id`,
    params,
  );
  return rows.map((r: { assessment_id: string; scientific_name: string }) => ({ assessmentId: Number(r.assessment_id), scientificName: r.scientific_name }));
}

async function uploadBatch(
  db: Client,
  r2: S3Client,
  bucket: string,
  assessmentIds: number[],
  existingKeys: Set<string>,
  logger: SyncLogger,
  nameMap: Map<number, string> = new Map(),
): Promise<{ uploaded: number; skipped: number; existing: number; failed: number }> {
  let uploaded = 0;
  let skipped = 0;
  let existing = 0;
  let failed = 0;

  for (const id of assessmentIds) {
    const speciesName = nameMap.get(id);
    const label = speciesName ? `${speciesName} (${id})` : `${id}`;

    try {
      // Skip if already in R2 (any variant)
      if (hasExistingUpload(existingKeys, id)) {
        existing++;
        logger.log("range_map_existing", { assessmentId: id, ...(speciesName && { scientificName: speciesName }) });
        console.log(`    ${label} — already in R2, skipping`);
        continue;
      }

      const total = uploaded + existing + skipped + failed + 1;
      process.stdout.write(`    [${total}/${assessmentIds.length}] ${label}...`);
      const t0 = Date.now();
      const result = await generateRangeGeoJSON(db, id);
      if (!result) {
        skipped++;
        logger.log("range_map_no_data", { assessmentId: id, ...(speciesName && { scientificName: speciesName }) });
        console.log(` no data (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        continue;
      }

      await r2.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: result.r2Key,
          Body: result.body,
          ContentType: "application/json",
        })
      );

      uploaded++;
      const sizeMB = (Buffer.byteLength(result.body) / 1024 / 1024).toFixed(2);
      const simpLabel = result.tolerance != null ? ` [simplified ${result.tolerance}°]` : "";
      logger.log("range_map_uploaded", {
        assessmentId: id,
        sizeMB,
        ...(speciesName && { scientificName: speciesName }),
        ...(result.tolerance != null && { simplifyTolerance: result.tolerance }),
      });
      console.log(` ${sizeMB} MB${simpLabel} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      failed++;
      logger.log("range_map_failed", { assessmentId: id, ...(speciesName && { scientificName: speciesName }), error: err instanceof Error ? err.message : String(err) });
      console.log(` FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { uploaded, skipped, existing, failed };
}

export async function run(opts: {
  taxa?: string[];
  logger?: SyncLogger;
  force?: boolean;
} = {}): Promise<void> {
  const logger = opts.logger ?? new SyncLogger("upload-range-maps");
  const r2 = r2Client();
  const bucket = process.env.R2_MAPS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("Missing R2_MAPS_BUCKET_NAME");
  }

  const db = await connectRedListDb();
  console.log("  Connected to database");

  let existingKeys: Set<string>;
  if (opts.force) {
    existingKeys = new Set();
    console.log("  Force mode: re-uploading all species");
  } else {
    console.log("  Listing existing R2 keys...");
    existingKeys = await listExistingKeys(r2, bucket);
    console.log(`  Found ${existingKeys.size} existing range maps in R2`);
  }

  const taxa = getTaxa(opts.taxa);
  let totalUploaded = 0;
  let totalExisting = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const taxon of taxa) {
    const species = await mappedAssessments(db, taxon);
    const assessmentIds = species.map((s) => s.assessmentId);
    const nameMap = new Map(species.map((s) => [s.assessmentId, s.scientificName]));

    if (assessmentIds.length === 0) {
      console.log(`  ${taxon.name}: no species with maps`);
      continue;
    }

    const alreadyUploaded = assessmentIds.filter((id) => hasExistingUpload(existingKeys, id));
    const toUpload = assessmentIds.filter((id) => !hasExistingUpload(existingKeys, id));

    console.log(`  ${taxon.name}: ${assessmentIds.length} species with maps (${alreadyUploaded.length} already in R2, ${toUpload.length} to upload)`);
    logger.log("range_map_taxon_start", { taxon: taxon.id, total: assessmentIds.length, toUpload: toUpload.length });

    totalExisting += alreadyUploaded.length;
    const result = await uploadBatch(db, r2, bucket, toUpload, existingKeys, logger, nameMap);
    totalUploaded += result.uploaded;
    totalExisting += result.existing;
    totalSkipped += result.skipped;
    totalFailed += result.failed;

    console.log(`    ${taxon.name} done: ${result.uploaded} uploaded, ${result.existing} existing, ${result.skipped} skipped, ${result.failed} failed`);
    logger.log("range_map_taxon_complete", { taxon: taxon.id, ...result });
  }

  await db.end();
  console.log(`\n  Total: ${totalUploaded} uploaded, ${totalExisting} already in R2, ${totalSkipped} skipped (no data), ${totalFailed} failed`);
  logger.log("range_map_complete", { uploaded: totalUploaded, existing: totalExisting, skipped: totalSkipped, failed: totalFailed });
  if (!opts.logger) logger.close();
}

async function main() {
  loadEnvFiles();

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const filteredArgs = args.filter((a) => a !== "--force");

  // Direct assessment ID mode: --ids 123 456
  if (filteredArgs[0] === "--ids") {
    const ids = filteredArgs.slice(1).map((a) => parseInt(a, 10)).filter((n) => !isNaN(n));
    if (ids.length === 0) {
      console.error("No valid assessment IDs provided");
      process.exit(1);
    }

    const r2 = r2Client();
    const bucket = process.env.R2_MAPS_BUCKET_NAME!;
    const logger = new SyncLogger("upload-range-maps");

    const db = await connectRedListDb();
    console.log("Connected to database");

    // Look up species names for the given assessment IDs
    const nameResult = await db.query(
      `SELECT a.id AS assessment_id, t.scientific_name
       FROM assessments a
       JOIN taxons t ON t.id = a.taxon_id
       WHERE a.id = ANY($1)`,
      [ids]
    );
    const nameMap = new Map<number, string>(
      nameResult.rows.map((r: { assessment_id: string; scientific_name: string }) => [parseInt(r.assessment_id, 10), r.scientific_name])
    );

    console.log("Listing existing R2 keys...");
    const existingKeys = await listExistingKeys(r2, bucket);
    console.log(`Found ${existingKeys.size} existing range maps in R2`);
    console.log(`Processing ${ids.length} assessment(s)...`);

    const result = await uploadBatch(db, r2, bucket, ids, existingKeys, logger, nameMap);
    await db.end();
    console.log(`\nDone: ${result.uploaded} uploaded, ${result.existing} existing, ${result.skipped} skipped, ${result.failed} failed`);
    return;
  }

  // Taxon group mode (default)
  const taxa = filteredArgs.length > 0 ? filteredArgs.map((a) => a.toLowerCase()) : undefined;
  await run({ taxa, force });
}

const isDirectRun = process.argv[1]?.endsWith("maps/upload-range-maps.ts") || process.argv[1]?.endsWith("maps/upload-range-maps.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
