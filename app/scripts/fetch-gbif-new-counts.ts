/**
 * fetch-gbif-new-counts: GBIF occurrence counts since last Red List assessment
 *
 * For each linked species, fetches GBIF occurrence counts from the year
 * after their last assessment to the current year, then updates per-taxon data/gbif/{taxonId}.csv
 * and data/gbif-all-only/{taxonId}.csv. Both counts, georeferenced and every record.
 *
 * Prerequisites:
 *   1. Per-taxon redlist CSVs exist in data/redlist/ (from fetch-redlist, with GBIF keys from match)
 *   2. Per-taxon GBIF CSVs exist in data/gbif/ (from fetch-gbif)
 *
 * Usage:
 *   npx tsx scripts/fetch-gbif-new-counts.ts [taxon]   # One taxon (e.g. mammalia)
 *   npx tsx scripts/fetch-gbif-new-counts.ts            # All taxa
 */

import * as path from "path";
import {
  loadEnvFiles,
  SyncLogger,
  GBIF_DIR,
  mapConcurrent,
} from "./utils";
import { getTaxa, type Taxon } from "./taxa";
import {
  GbifSpecies,
  GBIF_ALL_ONLY_DIR,
  fetchFacets,
  writeGbifCsv,
  readGbifCsv,
} from "./fetch-gbif-species";
import { readRedlistCsv } from "./fetch-redlist-species";
import { readMappingCsv } from "./match-redlist-species-to-gbif";
import { kingdomCountsPreservedSpecimens } from "../src/lib/gbif";

// =============================================================================
// CONFIGURATION
// =============================================================================

const CURRENT_YEAR = new Date().getFullYear();
// Thirty is what this used to run at. Since the migration a full run has died on
// a 429 an hour in, three separate times, throwing away everything before it.
//
// Not request volume — that fell. This group's queries used to fan out over ~47
// backbone order keys for fishes alone; five derived CoL keys cover it now. So
// GBIF is throttling fewer requests than it used to accept, which points at cost
// per request rather than rate: naming a non-default checklistKey asks it to
// resolve against a checklist its occurrence index is not denormalised for.
//
// That mechanism is inferred, not measured — the checklist arrived in the same
// change as taxonKey replacing classKey, and GBIF may simply have tightened
// limits when it relaunched. Worth an A/B if this phase's runtime ever matters;
// it is not latency-bound in any way a user notices, so until then it runs
// politely rather than at the edge of what gets refused.
const YEAR_BUCKET_CONCURRENCY = 8;

// =============================================================================
// HELPERS
// =============================================================================

function loadAssessmentYears(taxonId: string, taxonGbifKeys: Set<string>): Map<string, number> {
  const mapping = readMappingCsv();
  const speciesAssessmentYear = new Map<string, number>();
  const redlistSpecies = readRedlistCsv(taxonId);
  for (const s of redlistSpecies) {
    const links = mapping.get(s.sis_taxon_id) ?? [];
    if (!s.assessment_date) continue;
    const year = parseInt(s.assessment_date.slice(0, 4), 10);
    if (isNaN(year)) continue;
    // A single sis_taxon_id may map to multiple GBIF keys (canonical + synonyms).
    // Tag every linked key with the same assessment year.
    for (const link of links) {
      const gbifKey = link.gbif_species_key;
      if (gbifKey && taxonGbifKeys.has(gbifKey)) {
        speciesAssessmentYear.set(gbifKey, year);
      }
    }
  }
  return speciesAssessmentYear;
}

// =============================================================================
// MAIN LOGIC
// =============================================================================

export async function fetchCountsSinceAssessment(
  taxon: Taxon,
  gbifSpeciesMap: Map<string, GbifSpecies>,
): Promise<number> {
  const taxonGbifKeys = new Set(gbifSpeciesMap.keys());

  const speciesAssessmentYear = loadAssessmentYears(taxon.id, taxonGbifKeys);
  console.log(`  ${speciesAssessmentYear.size} linked species with assessment dates`);

  if (speciesAssessmentYear.size === 0) return 0;

  const uniqueYears = Array.from(new Set(Array.from(speciesAssessmentYear.values()))).sort((a, b) => a - b);
  const yearBuckets = uniqueYears.filter((y) => y + 1 <= CURRENT_YEAR);

  const speciesByYear = new Map<number, Set<string>>();
  speciesAssessmentYear.forEach((year, speciesKey) => {
    if (!speciesByYear.has(year)) speciesByYear.set(year, new Set<string>());
    speciesByYear.get(year)!.add(speciesKey);
  });

  const sinceAssessmentCounts = new Map<string, number>();
  const sinceAssessmentCountsAll = new Map<string, number>();
  speciesAssessmentYear.forEach((_year, speciesKey) => {
    sinceAssessmentCounts.set(speciesKey, 0);
    sinceAssessmentCountsAll.set(speciesKey, 0);
  });

  console.log(`  ${yearBuckets.length} year buckets x ${taxon.gbif.length} queries`);

  // Same record types the total was counted over, or "new records since the
  // assessment" would be a subset of a different universe than the total it sits
  // beside — and for a plant, the smaller of the two.
  const includePreservedSpecimens = kingdomCountsPreservedSpecimens(taxon.kingdomKey);

  for (let qi = 0; qi < taxon.gbif.length; qi++) {
    const q = taxon.gbif[qi];
    let completedBuckets = 0;

    await mapConcurrent(yearBuckets, YEAR_BUCKET_CONCURRENCY, async (assessmentYear) => {
      const yearRange = `${assessmentYear + 1},${CURRENT_YEAR}`;
      const bucketSpecies = speciesByYear.get(assessmentYear);

      for (const [georeferencedOnly, counts] of [
        [true, sinceAssessmentCounts],
        [false, sinceAssessmentCountsAll],
      ] as const) {
        const results = await fetchFacets(q.taxonKey, { yearRange, includePreservedSpecimens, georeferencedOnly });
        if (!bucketSpecies) continue;
        for (const r of results) {
          if (bucketSpecies.has(r.speciesKey)) {
            counts.set(r.speciesKey, counts.get(r.speciesKey)! + r.count);
          }
        }
      }

      completedBuckets++;
      process.stdout.write(`\r  Query ${qi + 1}/${taxon.gbif.length}: ${completedBuckets}/${yearBuckets.length} year buckets`);
    });
  }
  if (yearBuckets.length > 0) console.log("");

  sinceAssessmentCounts.forEach((count, key) => {
    const row = gbifSpeciesMap.get(key);
    if (!row) return;
    row.count_after_assessment_year = count;
    // Floored at the georeferenced count for the same reason as total_count_all.
    row.count_after_assessment_year_all = Math.max(sinceAssessmentCountsAll.get(key)!, count);
  });

  return sinceAssessmentCounts.size;
}

// =============================================================================
// MAIN
// =============================================================================

export async function run(opts: {
  taxa?: string[];
  logger?: SyncLogger;
} = {}): Promise<void> {
  const taxaToSync = getTaxa(opts.taxa);
  const logger = opts.logger ?? SyncLogger.noop();

  const startTime = Date.now();

  let totalComputed = 0;

  for (const taxon of taxaToSync) {
    console.log(`\n${taxon.name} (${taxon.id}):`);
    // Counted together, so one set of queries covers both files. A species in
    // the all-only file has no georeferenced records, so its georeferenced count
    // here comes back 0 and build-parquet reads it as NULL.
    const georeferenced = readGbifCsv(taxon.id);
    const allOnly = readGbifCsv(taxon.id, GBIF_ALL_ONLY_DIR);
    const count = await fetchCountsSinceAssessment(taxon, new Map([...georeferenced, ...allOnly]));
    totalComputed += count;

    writeGbifCsv(georeferenced, path.join(GBIF_DIR, `${taxon.id}.csv`));
    if (allOnly.size > 0) writeGbifCsv(allOnly, path.join(GBIF_ALL_ONLY_DIR, `${taxon.id}.csv`));

    logger.log("fetch_new_gbif_counts_taxon", { taxon_id: taxon.id, computed: count });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const minutes = Math.floor(Number(elapsed) / 60);
  const seconds = Number(elapsed) % 60;

  logger.log("fetch_new_gbif_counts_complete", { total_computed: totalComputed, duration_seconds: Number(elapsed) });

  console.log("\n" + "=".repeat(50));
  console.log("fetch-gbif-new-counts complete:");
  console.log(`  Computed: ${totalComputed.toLocaleString()}`);
  console.log(`  Output:   ${GBIF_DIR}/`);
  console.log(`  Duration: ${minutes}m ${seconds}s`);
}

async function main() {
  loadEnvFiles();

  const args = process.argv.slice(2);
  const taxonArg = args[0]?.toLowerCase();

  console.log("fetch-gbif-new-counts: GBIF counts since last assessment");
  console.log("=".repeat(50));

  const logger = new SyncLogger("fetch-gbif-new-counts");
  try {
    await run({ taxa: taxonArg ? [taxonArg] : undefined, logger });
  } finally {
    logger.close();
  }
}

const isDirectRun = process.argv[1]?.endsWith("fetch-gbif-new-counts.ts") || process.argv[1]?.endsWith("fetch-gbif-new-counts.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
