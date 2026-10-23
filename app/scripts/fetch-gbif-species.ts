/**
 * fetch-gbif-species: GBIF API → CSV
 *
 * Fetches per-species observation counts from GBIF and writes per-taxon to data/gbif/{taxonId}.csv.
 * Each species gets two counts: georeferenced records, and every record. Species
 * with records but none georeferenced go to data/gbif-all-only/ instead — see
 * GBIF_ALL_ONLY_DIR for why they are kept apart.
 *
 * Usage:
 *   npx tsx scripts/fetch-gbif-species.ts [taxon]   # Fetch one taxon (e.g. mammalia)
 *   npx tsx scripts/fetch-gbif-species.ts            # Fetch all taxa
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  loadEnvFiles,
  SyncLogger,
  writeCsv,
  readCsv,
  DATA_DIR,
  GBIF_DIR,
  delay,
  toTitleCase,
} from "./utils";
import { getTaxa, type Taxon, type GbifQuery } from "./taxa";

import {
  GBIF_CHECKLIST_KEY,
  includedBasisOfRecord,
  kingdomCountsPreservedSpecimens,
} from "../src/lib/gbif";

// =============================================================================
// GBIF TAXA (legacy lookup — used by fetch-gbif-new-counts)
// =============================================================================

export type { Taxon, GbifQuery };

// =============================================================================
// CONFIGURATION
// =============================================================================

const FACET_LIMIT = 100000;
const REQUEST_DELAY = 200; // ms between GBIF requests
// Patient rather than brisk. Under sustained throttling a five-attempt backoff
// topping out at 32 seconds gives up while GBIF is still saying "slow down", and
// giving up here aborts a run measured in hours.
const MAX_RETRIES = 8;
const BACKOFF_BASE_MS = 2000;

// =============================================================================
// TYPES
// =============================================================================

interface SpeciesCount {
  speciesKey: string;
  count: number;
  taxonGroup: string;
}

interface ValidatedSpecies {
  key: string;
  canonicalName: string;
  vernacularName: string;
  className: string;
  orderName: string;
  familyName: string;
}

export interface GbifSpecies {
  gbif_species_key: string;
  scientific_name: string;
  common_name: string;
  taxon_group_table1a: string;
  total_count: number;
  count_after_assessment_year: number | null;
  /** Every record, georeferenced or not. null in a CSV written before it existed. */
  total_count_all: number | null;
  count_after_assessment_year_all: number | null;
  class_name: string;
  order_name: string;
  family: string;
  countries: string;
}

// =============================================================================
// GBIF API FUNCTIONS
// =============================================================================

export async function fetchFacets(
  taxonKey: string,
  {
    yearRange,
    modifiedRange,
    includePreservedSpecimens = false,
    georeferencedOnly = true,
  }: {
    yearRange?: string;
    modifiedRange?: string;
    /** See kingdomCountsPreservedSpecimens — on for plants, fungi and algae. */
    includePreservedSpecimens?: boolean;
    /** Off for the all-records count, which also takes records with no usable coordinates. */
    georeferencedOnly?: boolean;
  } = {},
): Promise<Array<{ speciesKey: string; count: number }>> {
  const allResults: Array<{ speciesKey: string; count: number }> = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      checklistKey: GBIF_CHECKLIST_KEY,
      facet: "speciesKey",
      facetLimit: FACET_LIMIT.toString(),
      facetOffset: offset.toString(),
      limit: "0",
      taxonKey,
    });
    if (georeferencedOnly) {
      params.set("hasCoordinate", "true");
      params.set("hasGeospatialIssue", "false");
    }

    if (yearRange) params.set("year", yearRange);
    if (modifiedRange) params.set("modified", modifiedRange);
    includedBasisOfRecord(includePreservedSpecimens).forEach((bor) =>
      params.append("basisOfRecord", bor),
    );

    // The body read has to sit inside the retry, not after it. A dropped socket
    // part-way through a response throws from .json(), not from fetch(), and a
    // sync that runs for hours will meet one — killing the whole run at whatever
    // phase it happened to reach.
    let data: { facets?: Array<{ field: string; counts: Array<{ name: string; count: number }> }> } | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`https://api.gbif.org/v1/occurrence/search?${params}`);
        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
          if (attempt < MAX_RETRIES) {
            await delay(Math.min(Math.pow(2, attempt) * BACKOFF_BASE_MS, 120_000));
            continue;
          }
          throw new Error(`GBIF API error: ${response.status} ${response.statusText}`);
        }
        if (!response.ok) throw new Error(`GBIF API error: ${response.status} ${response.statusText}`);
        data = await response.json();
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await delay(Math.min(Math.pow(2, attempt) * BACKOFF_BASE_MS, 120_000));
          continue;
        }
        throw err;
      }
    }
    if (!data) throw new Error("GBIF API error: no response after retries");
    const facet = data.facets?.find((f: { field: string }) => f.field === "SPECIES_KEY");

    if (!facet || facet.counts.length === 0) break;

    for (const c of facet.counts) {
      allResults.push({ speciesKey: c.name, count: c.count });
    }

    hasMore = facet.counts.length >= FACET_LIMIT;
    if (hasMore) {
      offset += FACET_LIMIT;
      await delay(REQUEST_DELAY);
    }
  }

  return allResults;
}

export async function fetchGbifCounts(
  taxon: Taxon,
  { georeferencedOnly = true }: { georeferencedOnly?: boolean } = {},
): Promise<SpeciesCount[]> {
  const allResults: SpeciesCount[] = [];
  const includePreservedSpecimens = kingdomCountsPreservedSpecimens(taxon.kingdomKey);

  for (let i = 0; i < taxon.gbif.length; i++) {
    const q = taxon.gbif[i];
    process.stdout.write(`\r  Query ${i + 1}/${taxon.gbif.length}`);
    const results = await fetchFacets(q.taxonKey, { includePreservedSpecimens, georeferencedOnly });
    // Reported, not thrown. An empty facet does NOT mean the key is dead: it
    // also happens when a real taxon has no records identified to species rank.
    // Turbellaria (BDSSX) is exactly that — 13,998 occurrence records under this
    // pipeline's own filters and zero speciesKey facets, because CoL XR places
    // essentially none of them at species level. Throwing here aborted every
    // sync at phase 5. Whether the key is still VALID is a different question,
    // and assertRootKeysResolve answers it directly against the pinned release.
    if (results.length === 0 && georeferencedOnly) {
      console.warn(`  note: root key ${q.taxonKey} matched no species-rank taxa (it may legitimately have none)`);
    }
    for (const r of results) {
      allResults.push({ speciesKey: r.speciesKey, count: r.count, taxonGroup: taxon.id });
    }
    if (i < taxon.gbif.length - 1) await delay(REQUEST_DELAY);
  }
  console.log("");

  // Deduplicate: keep highest count per speciesKey
  const seen = new Map<string, SpeciesCount>();
  for (const r of allResults) {
    if (!seen.has(r.speciesKey) || seen.get(r.speciesKey)!.count < r.count) {
      seen.set(r.speciesKey, r);
    }
  }

  return Array.from(seen.values()).sort((a, b) => b.count - a.count);
}

/**
 * Resolve the species keys GBIF's facets returned to names and lineage.
 *
 * A local join against the Catalogue of Life release GBIF's occurrence index
 * runs. This used to be one GBIF request per key — some 680,000 per sync, which
 * rate-limited hard enough to kill three full runs — on the reasoning that GBIF's
 * index held usages the published CoL export did not.
 *
 * That reasoning was wrong. The export was simply the wrong release: the sync
 * downloaded the newest, GBIF promotes each release to production about three
 * weeks later, and CoL renumbers ids for names whose authorship changes. Pinned
 * to the indexed release (see fetch-col-xr), every one of those keys resolves
 * locally — 504 assessed and 9,092 unassessed unresolvable before, zero after —
 * and the local answer matches GBIF's own matcher on rank and status.
 *
 * What still genuinely needs GBIF is the other direction: fuzzy name-to-key
 * matching, where GBIF's matcher handles spelling and authorship variants no
 * lookup can. That remains in match-redlist-species-to-gbif.
 *
 * assertPinnedRelease below is what keeps this honest — it is only safe while the
 * local release and the indexed one agree, so that is checked rather than assumed.
 */
export async function validateSpeciesKeys(
  speciesKeys: string[],
  opts: { onProgress?: (done: number, total: number, cached: number) => void } = {},
): Promise<Map<string, ValidatedSpecies>> {
  const valid = new Map<string, ValidatedSpecies>();
  if (speciesKeys.length === 0) return valid;

  const backbone = path.join(DATA_DIR, "backbone.parquet");
  const speciesGlob = path.join(DATA_DIR, "species", "**", "*.parquet");
  const vernaculars = path.join(DATA_DIR, "species-vernaculars.parquet");
  if (!fs.existsSync(backbone)) {
    throw new Error(
      `validateSpeciesKeys: ${backbone} not found. It is written by build-backbone, ` +
      `which must run before the GBIF phases.`
    );
  }
  const hasVernaculars = fs.existsSync(vernaculars);

  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  try {
    await conn.run(`CREATE TEMP TABLE wanted (col_id VARCHAR);`);
    const appender = await conn.createAppender("wanted");
    for (const k of speciesKeys) {
      appender.appendVarchar(k);
      appender.endRow();
    }
    appender.closeSync();

    // Lineage comes from species/, which build-backbone writes with the
    // classification already denormalised; the backbone join covers keys that are
    // real but not species rank, which species/ deliberately excludes.
    const reader = await conn.runAndReadAll(`
      SELECT w.col_id,
             coalesce(sp.scientific_name, b.scientific_name) AS scientific_name,
             coalesce(sp.class_name, '')  AS class_name,
             coalesce(sp.order_name, '')  AS order_name,
             coalesce(sp.family, '')      AS family,
             ${hasVernaculars ? "coalesce(v.vernacular_name, '')" : "''"} AS vernacular_name
      FROM wanted w
      JOIN '${backbone}' b ON b.col_id = w.col_id
      LEFT JOIN '${speciesGlob}' sp ON sp.col_id = w.col_id
      ${hasVernaculars ? `LEFT JOIN '${vernaculars}' v ON v.col_id = w.col_id` : ""}
      WHERE b.rank = 'species' AND b.status IN ('accepted', 'provisionally accepted')
    `);

    for (const r of reader.getRowObjects()) {
      const key = String(r.col_id);
      valid.set(key, {
        key,
        canonicalName: String(r.scientific_name ?? ""),
        vernacularName: String(r.vernacular_name ?? ""),
        className: String(r.class_name ?? ""),
        orderName: String(r.order_name ?? ""),
        familyName: String(r.family ?? ""),
      });
    }
  } finally {
    conn.closeSync();
    inst.closeSync();
  }

  opts.onProgress?.(speciesKeys.length, speciesKeys.length, speciesKeys.length);
  return valid;
}

/**
 * Confirm the local Catalogue of Life release is the one GBIF's index runs.
 *
 * Everything resolved locally depends on this, and the failure is silent: a
 * mismatched release does not error, it just fails to find keys, which reads
 * exactly like species that have no records. So a sample of the keys GBIF has
 * just returned is checked against the local copy before any of it is trusted.
 *
 * Cheap — no extra requests, since the keys are already in hand.
 */
export async function assertPinnedRelease(sampleKeys: string[]): Promise<void> {
  if (sampleKeys.length === 0) return;
  const backbone = path.join(DATA_DIR, "backbone.parquet");
  if (!fs.existsSync(backbone)) return;

  const sample = sampleKeys.slice(0, 500);
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  try {
    await conn.run(`CREATE TEMP TABLE probe (col_id VARCHAR);`);
    const appender = await conn.createAppender("probe");
    for (const k of sample) {
      appender.appendVarchar(k);
      appender.endRow();
    }
    appender.closeSync();
    const row = (await conn.runAndReadAll(`
      SELECT count(*) AS found FROM probe p JOIN '${backbone}' b ON b.col_id = p.col_id
    `)).getRowObjects()[0];
    const rate = Number(row.found) / sample.length;
    if (rate < MIN_PINNED_RELEASE_AGREEMENT) {
      throw new Error(
        `fetch-gbif-species: only ${(rate * 100).toFixed(1)}% of GBIF's own species keys resolve ` +
        `against the local Catalogue of Life release (floor ${MIN_PINNED_RELEASE_AGREEMENT * 100}%). ` +
        `GBIF has almost certainly moved to a newer release — rerun the CoL phases so the local ` +
        `copy matches what its index is keyed by.`
      );
    }
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
}

const MIN_PINNED_RELEASE_AGREEMENT = 0.99;

/**
 * Refuse to write a taxon whose keys mostly failed to resolve.
 *
 * Not every facet key becomes a species — synonyms, higher taxa and unplaced
 * names are all expected to drop out, so some loss is normal. What is not normal
 * is most of a group vanishing, and that is exactly what a key-space mismatch
 * looks like: in the first attempt at this migration Mantodea went from 1,110
 * species to 97 and nothing was printed, because the drop had no floor under it.
 *
 * The threshold is deliberately loose. It is here to catch a group collapsing,
 * not to police normal attrition.
 */
const MIN_RESOLUTION_RATE = 0.5;
const RESOLUTION_RATE_FLOOR_SAMPLE = 50;

export function assertResolutionRate(taxonId: string, requested: number, resolved: number): void {
  // Zero requested is the loudest signal there is, not the quietest: it means the
  // facet query returned nothing at all, which is what a dead group root key
  // looks like. The early return for small groups used to swallow it, because
  // zero is smaller than any threshold.
  if (requested === 0) {
    throw new Error(
      `fetch-gbif-species: the facet query for "${taxonId}" returned no species at all. ` +
      `That is not an empty group — it is what a group key that no longer resolves looks like. ` +
      `Rerun scripts/derive-gbif-taxon-keys.ts; Catalogue of Life renumbers keys between releases.`
    );
  }
  // Tiny groups are noisy — a group of four species is not evidence of anything.
  if (requested < RESOLUTION_RATE_FLOOR_SAMPLE) return;
  const rate = resolved / requested;
  if (rate >= MIN_RESOLUTION_RATE) return;
  throw new Error(
    `fetch-gbif-species: only ${resolved} of ${requested} keys resolved for "${taxonId}" ` +
    `(${(rate * 100).toFixed(1)}%, floor ${MIN_RESOLUTION_RATE * 100}%). ` +
    `That is the signature of a key-space mismatch rather than normal attrition — ` +
    `writing this file would silently shrink the group.`
  );
}

// =============================================================================
// CSV OUTPUT
// =============================================================================

const GBIF_CSV_COLUMNS = [
  "gbif_species_key", "scientific_name", "common_name",
  "class_name", "order_name", "family", "taxon_group_table1a",
  "total_count", "count_after_assessment_year",
  "total_count_all", "count_after_assessment_year_all", "countries",
];

/**
 * Species GBIF holds records for, none of them georeferenced.
 *
 * Kept out of data/gbif/ because everything that reads those files treats a row
 * as "this species has georeferenced GBIF data": the per-group species and record
 * totals in taxa-summary, the country phase, the NE counts. A moss known only from
 * herbarium sheets labelled "Tasmania" belongs in none of those, so it lives here
 * and only the places that want every record — matching, the all-records counts,
 * build-parquet — read this directory too.
 */
export const GBIF_ALL_ONLY_DIR = path.join(DATA_DIR, "gbif-all-only");

export function writeGbifCsv(speciesMap: Map<string, GbifSpecies>, outputPath: string): void {
  const rows = Array.from(speciesMap.values())
    .map((s) => ({
      gbif_species_key: s.gbif_species_key,
      scientific_name: s.scientific_name,
      common_name: s.common_name || null,
      taxon_group_table1a: s.taxon_group_table1a,
      total_count: s.total_count,
      count_after_assessment_year: s.count_after_assessment_year,
      total_count_all: s.total_count_all,
      count_after_assessment_year_all: s.count_after_assessment_year_all,
      class_name: s.class_name || null,
      order_name: s.order_name || null,
      family: s.family || null,
      countries: s.countries || null,
    }));

  writeCsv(rows, GBIF_CSV_COLUMNS, outputPath);
}

export function readGbifCsv(taxonId: string, dir = GBIF_DIR): Map<string, GbifSpecies> {
  const csvPath = path.join(dir, `${taxonId}.csv`);
  // A group with no all-only species, or a data/ from before they existed.
  if (dir !== GBIF_DIR && !fs.existsSync(csvPath)) return new Map();
  const rows = readCsv<GbifSpecies>(csvPath, (r) => ({
    gbif_species_key: r.gbif_species_key,
    scientific_name: r.scientific_name,
    common_name: r.common_name,
    taxon_group_table1a: r.taxon_group_table1a,
    total_count: parseInt(r.total_count, 10) || 0,
    count_after_assessment_year: r.count_after_assessment_year ? parseInt(r.count_after_assessment_year, 10) : null,
    total_count_all: r.total_count_all ? parseInt(r.total_count_all, 10) : null,
    count_after_assessment_year_all: r.count_after_assessment_year_all ? parseInt(r.count_after_assessment_year_all, 10) : null,
    class_name: r.class_name || "",
    order_name: r.order_name || "",
    family: r.family || "",
    countries: r.countries || "",
  }));
  const map = new Map<string, GbifSpecies>();
  for (const row of rows) map.set(row.gbif_species_key, row);
  return map;
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Confirm every group's root keys still exist in the pinned Catalogue of Life
 * release.
 *
 * These are CoL ids like any other usage, and CoL renumbers them: between
 * COL26.6 and COL26.7, Rhodophyta went L2MHG -> CHDNQ and Blattodea's key
 * disappeared outright. Rhodophyta is red_algae's ONLY root key, so a stale one
 * silently empties an entire group.
 *
 * A local join, so it costs nothing and runs before any request is made. It
 * deliberately tests EXISTENCE rather than "did this key return species" — a
 * live taxon can legitimately have no species-rank records, which is a different
 * thing from a key that no longer exists.
 */
export async function assertRootKeysResolve(
  taxa: Taxon[],
  /** Overridable so the guard itself can be tested against a known taxonomy. */
  backbonePath = path.join(DATA_DIR, "backbone.parquet")
): Promise<void> {
  const backbone = backbonePath;
  if (!fs.existsSync(backbone)) return;
  const wanted = taxa.flatMap((t) => t.gbif.map((q) => ({ taxon: t.id, key: q.taxonKey })));
  if (wanted.length === 0) return;

  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  try {
    const list = wanted.map((w) => `'${w.key}'`).join(",");
    const found = new Set(
      (await conn.runAndReadAll(
        `SELECT col_id FROM '${backbone}' WHERE col_id IN (${list})`
      )).getRowObjects().map((r) => String(r.col_id))
    );
    const dead = wanted.filter((w) => !found.has(w.key));
    if (dead.length > 0) {
      throw new Error(
        `fetch-gbif-species: ${dead.length} group root key(s) no longer exist in the pinned ` +
        `Catalogue of Life release:\n` +
        dead.map((d) => `  ${d.taxon}: ${d.key}`).join("\n") +
        `\nCoL renumbers these between releases. Rerun derive-gbif-taxon-keys (sync phase 4b) ` +
        `to re-derive them against what GBIF currently indexes.`
      );
    }
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
}

export async function run(opts: {
  taxa?: string[];
  logger?: SyncLogger;
} = {}): Promise<void> {
  const taxaToSync = getTaxa(opts.taxa);
  const logger = opts.logger ?? SyncLogger.noop();

  await assertRootKeysResolve(taxaToSync);

  const startTime = Date.now();

  logger.log("fetch_gbif_species_start", {
    taxa: taxaToSync.map((t) => t.id),
    taxa_count: taxaToSync.length,
  });

  let totalSpecies = 0;

  for (const taxon of taxaToSync) {
    const taxonStart = Date.now();
    console.log(`\n${taxon.name} (${taxon.id}):`);

    console.log("  Fetching species observation counts from GBIF...");
    const rawResults = await fetchGbifCounts(taxon);
    console.log(`  Raw species: ${rawResults.length}`);
    console.log("  Fetching all-records counts (georeferenced or not)...");
    const allCounts = new Map(
      (await fetchGbifCounts(taxon, { georeferencedOnly: false })).map((r) => [r.speciesKey, r.count]),
    );
    const georeferenced = new Set(rawResults.map((r) => r.speciesKey));
    const allOnlyKeys = [...allCounts.keys()].filter((k) => !georeferenced.has(k));
    console.log(`  Raw species with no georeferenced records: ${allOnlyKeys.length}`);

    console.log("  Resolving species keys...");
    const speciesKeys = rawResults.map((r) => r.speciesKey);
    // Before trusting any local resolution, confirm the local CoL release is the
    // one these keys came from. GBIF moving to a newer release is silent
    // otherwise: keys simply stop being found, which looks like absent species.
    await assertPinnedRelease(speciesKeys);
    const validSpecies = await validateSpeciesKeys([...speciesKeys, ...allOnlyKeys], {
      onProgress: (doneCount, total, cached) =>
        process.stdout.write(`\r  Resolved ${doneCount}/${total} (${cached} from cache)`),
    });
    if (speciesKeys.length > 0) console.log("");
    console.log(`  Valid species: ${validSpecies.size}`);

    assertResolutionRate(taxon.id, speciesKeys.length, speciesKeys.filter((k) => validSpecies.has(k)).length);

    const toRow = (key: string, count: number, countAll: number, info: ValidatedSpecies): GbifSpecies => ({
      gbif_species_key: key,
      scientific_name: info.canonicalName,
      common_name: info.vernacularName ? toTitleCase(info.vernacularName) : "",
      taxon_group_table1a: taxon.id,
      total_count: count,
      count_after_assessment_year: null,
      // Never below the georeferenced count, which it contains. Large facets are
      // approximate, and the two queries are separate requests, so without the
      // floor a species can read as having fewer records than its georeferenced ones.
      total_count_all: Math.max(countAll, count),
      count_after_assessment_year_all: null,
      class_name: info.className.toLowerCase(),
      order_name: info.orderName.toLowerCase(),
      family: info.familyName.toLowerCase(),
      countries: "",
    });

    const taxonMap = new Map<string, GbifSpecies>();
    for (const r of rawResults) {
      const info = validSpecies.get(r.speciesKey);
      if (!info) continue;
      taxonMap.set(r.speciesKey, toRow(r.speciesKey, r.count, allCounts.get(r.speciesKey) ?? 0, info));
    }
    const allOnlyMap = new Map<string, GbifSpecies>();
    for (const key of allOnlyKeys) {
      const info = validSpecies.get(key);
      if (!info) continue;
      allOnlyMap.set(key, toRow(key, 0, allCounts.get(key)!, info));
    }

    const outputPath = path.join(GBIF_DIR, `${taxon.id}.csv`);
    writeGbifCsv(taxonMap, outputPath);
    console.log(`  Wrote ${taxonMap.size} species → ${outputPath}`);
    const allOnlyPath = path.join(GBIF_ALL_ONLY_DIR, `${taxon.id}.csv`);
    writeGbifCsv(allOnlyMap, allOnlyPath);
    console.log(`  Wrote ${allOnlyMap.size} species with no georeferenced records → ${allOnlyPath}`);

    totalSpecies += taxonMap.size;
    const taxonDuration = ((Date.now() - taxonStart) / 1000).toFixed(1);
    logger.log("fetch_gbif_species_taxon", { taxon_id: taxon.id, raw: rawResults.length, valid: validSpecies.size, duration_seconds: Number(taxonDuration) });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const minutes = Math.floor(Number(elapsed) / 60);
  const seconds = Number(elapsed) % 60;

  logger.log("fetch_gbif_species_complete", { total_species: totalSpecies, duration_seconds: Number(elapsed) });

  console.log("\n" + "=".repeat(50));
  console.log("fetch-gbif-species complete:");
  console.log(`  Species: ${totalSpecies.toLocaleString()}`);
  console.log(`  Output:  ${GBIF_DIR}/`);
  console.log(`  Duration: ${minutes}m ${seconds}s`);
}

async function main() {
  loadEnvFiles();

  const args = process.argv.slice(2);
  const taxonArg = args[0]?.toLowerCase();

  console.log("fetch-gbif-species: GBIF API → CSV");
  console.log("=".repeat(50));

  const logger = new SyncLogger("fetch-gbif-species");
  try {
    await run({ taxa: taxonArg ? [taxonArg] : undefined, logger });
  } finally {
    logger.close();
  }
}

const isDirectRun = process.argv[1]?.endsWith("fetch-gbif-species.ts") || process.argv[1]?.endsWith("fetch-gbif-species.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
