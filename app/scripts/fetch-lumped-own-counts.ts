/**
 * fetch-lumped-own-counts: occurrence counts for species Catalogue of Life lumps
 *
 * Some assessed species are, in CoL's view, synonyms of a different species. The
 * dashboard deliberately does not show them the other species' counts — that is
 * how a Critically Endangered Algerian willowherb came to display 295,698 records
 * of a common European one.
 *
 * But refusing the other species' records is not the same as having none. GBIF
 * holds the records identified under the species' own name against its own usage,
 * and those are legitimately its own:
 *
 *   Malus sieversii (VU)      146,340 shown -> 8,135 its own
 *   Epilobium numidicum (CR)  295,698 shown ->     0 its own
 *   Thymallus aeliani (EN)     73,641 shown ->    11 its own
 *
 * So blanking them outright trades a wrong number for no number when the right
 * number exists. This phase fetches it.
 *
 * The same problem has a second shape. Where CoL ranks a species below species —
 * Fringilla polatzeki (EN) is a subspecies of F. teydea in CoL — the key is the
 * species' outright, no lump involved, and the enumeration still cannot produce
 * it. Those were written off as "no GBIF data", which reads as "GBIF holds
 * nothing" when the truth is "a facet cannot express this key". 358 species lost
 * counts they had before this migration that way, 96 of them threatened.
 *
 * So the phase is really "count the keys the enumeration cannot emit", and it
 * takes both verdicts that mean the key belongs to the species: lumped and own.
 * (Its name predates the second case; the rename is tracked in the file-layout
 * restructure, since it moves the output file too.)
 *
 * These keys cannot come from the facet enumeration in fetch-gbif-species, which
 * only ever emits accepted, species-rank usages — a synonym's own key, or a
 * subspecies key, is absent from it by construction. So each is counted
 * directly, into a standalone
 * data/lumped-own-counts.csv rewritten whole on every run. It is deliberately NOT
 * appended into the per-taxon GBIF CSVs: that made the phase depend on its own
 * run history, so tightening the rule deciding which species qualify had no
 * effect on species a looser rule had already written.
 *
 * Usage:
 *   npx tsx scripts/fetch-lumped-own-counts.ts
 */

import * as path from "path";
import {
  loadEnvFiles,
  SyncLogger,
  DATA_DIR,
  writeCsv,
  delay,
} from "./utils";
import { readMappingCsv, loadAllGbifKeys } from "./match-redlist-species-to-gbif";
import { readRedlistCsv } from "./fetch-redlist-species";
import { getTaxa } from "./taxa";
import {
  GBIF_CHECKLIST_KEY,
  includedBasisOfRecord,
  kingdomCountsPreservedSpecimens,
} from "../src/lib/gbif";

// Counts are read from a faceted query over many keys at once rather than one
// request per species. Individually there are 6,000+ species and two counts each,
// which GBIF rate-limits long before it finishes — the first attempt at this got
// 2,750 species in and then 429'd for the rest of the run.
const BATCH_SIZE = 100;
// A taxonKey facet returns every ancestor of every match as well as the keys
// asked for, so the limit has to leave room for those or requested keys fall off
// the end. Verified per batch below rather than assumed.
const FACET_LIMIT = 2000;
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 2000;
const CURRENT_YEAR = new Date().getFullYear();

const LUMPED_CSV_PATH = path.join(DATA_DIR, "lumped-own-counts.csv");
const LUMPED_CSV_COLUMNS = [
  // sis_taxon_id is what lets build-parquet attribute these counts back to the
  // species. Without it the rows land in the file, get folded into gbif_rows, and
  // then join to nothing — the species still shows 0 (Pararge xiphioides sat on
  // 4,371 of its own records reading "no data"), and its key surfaces separately
  // in unassessed.parquet as a browsable species that does not exist.
  "sis_taxon_id",
  "gbif_species_key",
  // Which group's file these rows belong with, for the per-group enrichment join.
  "taxon_group_table1a",
  "total_count", "count_after_assessment_year",
  "total_count_all", "count_after_assessment_year_all",
];
// Name and lineage are deliberately absent. They were written for years and read
// by nothing: the only consumer that wants them is the browsable-species export,
// and it excludes every key in this file by construction, because each one
// belongs to a species the Red List has already assessed.

interface LumpedSpecies {
  sisTaxonId: number;
  taxonId: string;
  gbifKey: string;
  assessmentYear: number | null;
  /** Whether this species' counts include preserved specimens (plants, fungi). */
  preservedSpecimens: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Occurrence counts for a batch of keys, from one faceted query.
 *
 * Returns a key → count map covering exactly the keys asked for. A key GBIF has
 * no records for is absent from the facet, which is indistinguishable from the
 * facet having been truncated — so the caller's keys are reconciled against the
 * response and a short facet is retried in smaller pieces rather than silently
 * read as a row of zeroes.
 *
 * One batch is one set of record types, so callers batch plants and fungi
 * separately from animals — see kingdomCountsPreservedSpecimens.
 */
async function countBatch(
  keys: string[],
  yearRange?: string,
  includePreservedSpecimens = false,
  georeferencedOnly = true,
): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    checklistKey: GBIF_CHECKLIST_KEY,
    facet: "taxonKey",
    facetLimit: String(FACET_LIMIT),
    limit: "0",
  });
  if (georeferencedOnly) {
    params.set("hasCoordinate", "true");
    params.set("hasGeospatialIssue", "false");
  }
  for (const k of keys) params.append("taxonKey", k);
  if (yearRange) params.set("year", yearRange);
  includedBasisOfRecord(includePreservedSpecimens).forEach((b) =>
    params.append("basisOfRecord", b),
  );

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.gbif.org/v1/occurrence/search?${params}`);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < MAX_RETRIES) {
          await delay(Math.pow(2, attempt) * BACKOFF_BASE_MS);
          continue;
        }
        throw new Error(`GBIF API error: HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`GBIF API error: HTTP ${res.status}`);

      const data = (await res.json()) as {
        facets?: Array<{ field: string; counts: Array<{ name: string; count: number }> }>;
      };
      const facet = data.facets?.find((f) => f.field === "TAXON_KEY");
      const counts = new Map<string, number>();
      for (const c of facet?.counts ?? []) counts.set(c.name, c.count);

      // If the facet filled up, a requested key could be missing because it was
      // cut off rather than because it has no records. Split and retry.
      if ((facet?.counts?.length ?? 0) >= FACET_LIMIT && keys.length > 1) {
        const halves = chunk(keys, Math.ceil(keys.length / 2));
        const merged = new Map<string, number>();
        for (const half of halves) {
          for (const [k, v] of await countBatch(half, yearRange, includePreservedSpecimens, georeferencedOnly)) {
            merged.set(k, v);
          }
        }
        return merged;
      }

      return new Map(keys.map((k) => [k, counts.get(k) ?? 0]));
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await delay(Math.pow(2, attempt) * BACKOFF_BASE_MS);
        continue;
      }
      throw err;
    }
  }
  throw new Error("GBIF count batch exhausted retries");
}

/**
 * Assessed species whose key the facet enumeration never emitted.
 *
 * Two kinds, both needing a count fetched directly:
 *
 * LUMPED — the resolution to another species was refused, so the key kept is the
 * species' own usage, which is a synonym and therefore absent from a facet over
 * accepted usages. Only taken when the match came from the species' OWN name: a
 * match reached through one of its Red List synonyms landed on a usage that CoL
 * assigns to a different species, and the records under that name are not safely
 * this species'. Catapodium borgesii (VU, Azores endemic) is the case — matched
 * via a synonym onto Catapodium marinum, a widespread European grass, and 19,901
 * records is not a number to hand an island endemic on that basis.
 *
 * NOT_IN_FACETS — the resolution was followed and the key is real, but it is not
 * species rank, so no speciesKey facet contains it. Fringilla polatzeki (EN) is
 * one: CoL ranks it a subspecies of Fringilla teydea, the demotion is correctly
 * followed, and then the key finds nothing to join to.
 */
export function loadLumpedSpecies(taxaIds?: string[]): LumpedSpecies[] {
  const mapping = readMappingCsv();
  // Global, not per-group: a species' key can arrive in a different group's file
  // than the one IUCN files the species under, and asking the wrong file would
  // count a species that already has its number.
  const fetched = loadAllGbifKeys();
  const out: LumpedSpecies[] = [];

  for (const taxon of getTaxa(taxaIds)) {
    for (const s of readRedlistCsv(taxon.id)) {
      const links = mapping.get(s.sis_taxon_id) ?? [];

      // Only species that came away with nothing. A species that already linked
      // to a key the facets emitted has its count; fetching its synonym usage as
      // well would add a second row under a second key, and since no assessed
      // species links to that key it would surface in unassessed.parquet as a
      // browsable species — a phantom duplicate of the accepted one. Skipping
      // these takes the phase from 56,395 species to the ~14,800 it is for.
      //
      // A non-null gbif_species_key already means the key passed the same global
      // check, because matching refuses to record one that did not.
      if (links.some((l) => l.gbif_species_key)) continue;

      // The verdict, asked rather than re-derived. This used to reconstruct the
      // decision from match_type and name_source, which is how the pipeline came
      // to answer "is this key this species' key?" three times in three ways —
      // and every disagreement was a species showing the wrong number.
      //
      // Both verdicts that mean "this key is this species'":
      //
      //   lumped — CoL folds the species into another and we kept its own usage,
      //     which is a synonym, so no facet over accepted usages emits it.
      //   own — the key is the species' outright, but the enumeration still did
      //     not produce it, because facets emit only species-rank usages and CoL
      //     ranks this taxon below species. Fringilla polatzeki (EN) is one: CoL
      //     makes it a subspecies of F. teydea.
      //
      // The second case used to be discarded as NO_GBIF_DATA, which read as "GBIF
      // has nothing" when the truth was "the enumeration cannot express this key".
      // 358 species lost counts they had before the migration that way, 96 of
      // them threatened.
      const lumped = links.find(
        (l) =>
          (l.verdict === "lumped" || l.verdict === "own") &&
          l.unfetched_key &&
          !fetched.has(l.unfetched_key)
      );
      if (!lumped?.unfetched_key) continue;

      const year = s.assessment_date ? parseInt(s.assessment_date.slice(0, 4), 10) : NaN;
      out.push({
        sisTaxonId: s.sis_taxon_id,
        taxonId: taxon.id,
        gbifKey: lumped.unfetched_key,
        assessmentYear: Number.isNaN(year) ? null : year,
        preservedSpecimens: kingdomCountsPreservedSpecimens(taxon.kingdomKey),
      });
    }
  }
  return out;
}

export async function run(opts: { taxa?: string[]; logger?: SyncLogger } = {}): Promise<void> {
  const logger = opts.logger ?? SyncLogger.noop();
  const lumped = loadLumpedSpecies(opts.taxa);

  console.log(
    `  ${lumped.length} species whose key the enumeration cannot emit — counting them directly`
  );
  if (lumped.length === 0) return;

  // A batch is one set of record types, so every grouping below is split on it:
  // a plant counted in an animal's batch would silently lose its herbarium
  // records, which for a plant is most of what GBIF holds about it.
  const preservedKeys = new Set(lumped.filter((s) => s.preservedSpecimens).map((s) => s.gbifKey));

  // Totals: batched across all of them, georeferenced and every record.
  const totals = new Map<string, number>();
  const totalsAll = new Map<string, number>();
  const allKeys = [...new Set(lumped.map((s) => s.gbifKey))];
  let totalsDone = 0;
  for (const preserved of [false, true]) {
    const keys = allKeys.filter((k) => preservedKeys.has(k) === preserved);
    for (const batch of chunk(keys, BATCH_SIZE)) {
      for (const [k, v] of await countBatch(batch, undefined, preserved)) totals.set(k, v);
      for (const [k, v] of await countBatch(batch, undefined, preserved, false)) totalsAll.set(k, v);
      totalsDone += batch.length;
      process.stdout.write(`\r  Totals ${totalsDone}/${allKeys.length}`);
    }
  }
  console.log("");

  // Records since assessment: the window differs per species, so batch by the
  // assessment year they share (and by record types, as above).
  const byYear = new Map<string, { year: number; preserved: boolean; keys: string[] }>();
  for (const sp of lumped) {
    if (sp.assessmentYear === null || sp.assessmentYear + 1 > CURRENT_YEAR) continue;
    const bucketKey = `${sp.assessmentYear}:${sp.preservedSpecimens}`;
    const bucket = byYear.get(bucketKey)
      ?? { year: sp.assessmentYear, preserved: sp.preservedSpecimens, keys: [] };
    bucket.keys.push(sp.gbifKey);
    byYear.set(bucketKey, bucket);
  }
  const since = new Map<string, number>();
  const sinceAll = new Map<string, number>();
  let bucketsDone = 0;
  for (const { year, preserved, keys } of byYear.values()) {
    for (const batch of chunk([...new Set(keys)], BATCH_SIZE)) {
      const yearRange = `${year + 1},${CURRENT_YEAR}`;
      for (const [k, v] of await countBatch(batch, yearRange, preserved)) since.set(k, v);
      for (const [k, v] of await countBatch(batch, yearRange, preserved, false)) sinceAll.set(k, v);
    }
    bucketsDone++;
    process.stdout.write(`\r  Since-assessment windows ${bucketsDone}/${byYear.size}`);
  }
  if (byYear.size > 0) console.log("");

  // Written as its own artifact rather than appended into the per-taxon CSVs.
  // Appending made the phase depend on run history: rows added by an earlier run
  // survived a later one, so tightening the rule that decides which species
  // qualify had no effect on species a looser rule had already added. A separate
  // file is rewritten whole every time, which makes the phase idempotent and the
  // pipeline reproducible from any starting point.
  // Only species that actually have records. A key can resolve perfectly and hold
  // nothing, and writing a zero for it is not the same as writing nothing: zero is
  // a value, so those rows would count as "has GBIF data" and the headline would
  // read 175,363 of 175,909 species — 99.7% coverage, produced entirely by
  // recording 60,601 absences as if they were measurements.
  //
  // "Has records" means any record. A species whose records are all
  // ungeoreferenced still gets a row, with its georeferenced counts empty rather
  // than 0, for the same reason: build-parquet reads empty as NULL, "no
  // georeferenced data", where 0 would count it as having some.
  const rows = lumped
    .filter((sp) => (totalsAll.get(sp.gbifKey) ?? 0) > 0)
    .map((sp) => {
      const total = totals.get(sp.gbifKey) ?? 0;
      const georeferenced = total > 0;
      const s = since.get(sp.gbifKey);
      const sAll = sinceAll.get(sp.gbifKey);
      return {
        sis_taxon_id: sp.sisTaxonId,
        gbif_species_key: sp.gbifKey,
        taxon_group_table1a: sp.taxonId,
        total_count: georeferenced ? total : null,
        count_after_assessment_year: georeferenced && s !== undefined ? s : null,
        // Floored at the georeferenced counts they contain; see fetch-gbif-species.
        total_count_all: Math.max(totalsAll.get(sp.gbifKey)!, total),
        count_after_assessment_year_all: sAll !== undefined ? Math.max(sAll, s ?? 0) : null,
      };
    });

  writeCsv(rows, LUMPED_CSV_COLUMNS, LUMPED_CSV_PATH);

  const withRecords = rows.filter((r) => r.total_count !== null).length;
  const totalRecords = rows.reduce((n, r) => n + (r.total_count ?? 0), 0);
  console.log(`  Wrote ${LUMPED_CSV_PATH}: ${rows.length} rows`);
  console.log(
    `  ${withRecords} of ${lumped.length} have georeferenced records of their own ` +
    `(${totalRecords.toLocaleString()} in total); ${rows.length} have any record`
  );
  logger.log("fetch_lumped_own_counts", {
    species: lumped.length,
    with_records: withRecords,
    records: totalRecords,
  });
}

const isDirectRun =
  process.argv[1]?.endsWith("fetch-lumped-own-counts.ts") ||
  process.argv[1]?.endsWith("fetch-lumped-own-counts.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
