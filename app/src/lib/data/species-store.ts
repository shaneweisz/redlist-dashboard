/**
 * File-backed data layer for species and taxa summary.
 *
 * Reads per-taxon CSV files and taxa-summary.json produced by the sync scripts.
 * Caches in memory for the process lifetime (on Vercel = per cold start).
 */

import * as fs from "fs";
import * as path from "path";
import { syncPath } from "./sync-layout";
import type { GbifGroupTotals, GbifRecordMode } from "../gbif-records";
import { countryToRegion } from "../regions";
import type { ColRevision } from "../col-revision";
import type { NoMatchReason, NoMatchDetail } from "./col-breakdown";
import {
  CANDIDATE_RANKS,
  type CandidateRank, type CandidateResult, type CandidateTier,
  type CreditCandidate, type CreditRole, type TargetLineage,
} from "@/lib/credit-candidates";

// =============================================================================
// PATHS
// =============================================================================

const DATA_DIR = path.join(process.cwd(), "data", "sync");
const TAXA_SUMMARY_PATH = path.join(DATA_DIR, syncPath("taxa-summary.json"));
const TABLE1A_CHILDREN_SUMMARIES_PATH = path.join(DATA_DIR, syncPath("table1a-children-summaries.json"));
const SSC_GROUP_CHILDREN_SUMMARIES_PATH = path.join(DATA_DIR, syncPath("ssc-group-children-summaries.json"));
const COUNTRY_STATS_PATH = path.join(DATA_DIR, syncPath("country-stats.json"));
const COL_REVISIONS_PATH = path.join(DATA_DIR, syncPath("col-revisions.json"));

// =============================================================================
// TYPES
// =============================================================================

/**
 * An assessed species as credit candidates need it: its latest assessment and
 * lineage. Read from assessed.parquet by getCreditSource (species-duckdb.ts).
 */
export interface CreditRow {
  sis_taxon_id: number;
  assessment_id: number;
  scientific_name: string;
  class_name: string | null;
  order_name: string | null;
  family: string | null;
  category: string;
  assessment_date: string | null;
  year_published: string;
  countries: string[];
}

export interface PreviousAssessment {
  id: number;
  year: string;
  category: string;
  date: string | null;
  assessors: string | null;
  reviewers: string | null;
  /**
   * The individuals behind an organisational assessor — every bird assessment
   * credits "BirdLife International", so the assessor line can't identify a
   * person and the facilitator line is the only one that can.
   *
   * Optional because it is optional in the FILES, not just the type: history
   * JSON written before sources/assessments.ts started emitting the field has no
   * such key (same story as `criteria` — see scripts/sync/dbt/models/lists/assessed.sql, which writes these
   * same files and coalesces both).
   */
  facilitators?: string | null;
}

export interface TaxaSummaryRow {
  table1a_taxon_group: string;
  total_assessed: number;
  outdated: number;
  by_category: Record<string, number>;
  /** GBIF totals, georeferenced records only and all records. */
  gbif: Record<GbifRecordMode, GbifGroupTotals>;
  col_described?: number; // CoL extant universe in this group (#271)
  col_ne?: number;        // CoL universe not yet IUCN-assessed
}

// =============================================================================
// CACHE
// =============================================================================

/** sis_taxon_id → its published assessments, newest first (assessments.parquet). */
export type HistoryMap = Record<string, PreviousAssessment[]>;

/** One group's assessed species and their histories: what credit candidates are drawn from. */
export interface CreditSource { rows: CreditRow[]; history: HistoryMap }

let taxaSummaryCache: TaxaSummaryRow[] | null = null;
let nodeChildrenSummariesCache: Record<string, NodeSummary[]> | null = null;
let countryStatsCache: Record<string, { species: number; outdated: number }> | null = null;
let colRevisionsCache: Map<number, ColRevision> | null = null;

/** @internal Reset all module-level caches (for tests only). */
export function _resetCaches(): void {
  taxaSummaryCache = null;
  nodeChildrenSummariesCache = null;
  countryStatsCache = null;
  colRevisionsCache = null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get taxa summary rows from the pre-computed JSON file.
 */
export function getTaxaSummary(): TaxaSummaryRow[] {
  if (taxaSummaryCache) return taxaSummaryCache;
  const content = fs.readFileSync(TAXA_SUMMARY_PATH, "utf-8");
  taxaSummaryCache = JSON.parse(content) as TaxaSummaryRow[];
  return taxaSummaryCache;
}

/**
 * Get precomputed children summaries for a parent node.
 * Reads from data/table1a-children-summaries.json + data/ssc-group-children-
 * summaries.json (cached in memory, merged — callers don't care which of the
 * two static-tree sources a given parent id belongs to).
 */
export function getPrecomputedChildrenSummaries(parentNodeId: string): NodeSummary[] {
  if (!nodeChildrenSummariesCache) {
    const table1a = JSON.parse(fs.readFileSync(TABLE1A_CHILDREN_SUMMARIES_PATH, "utf-8")) as Record<string, NodeSummary[]>;
    const ssc = JSON.parse(fs.readFileSync(SSC_GROUP_CHILDREN_SUMMARIES_PATH, "utf-8")) as Record<string, NodeSummary[]>;
    nodeChildrenSummariesCache = { ...table1a, ...ssc };
  }
  return nodeChildrenSummariesCache[parentNodeId] ?? [];
}

/**
 * Get per-country totals across ALL species (unfiltered by taxon) — feeds the
 * country-view landing page's world map. A single precomputed aggregate
 * (~200 countries, one static file), not a live query: this data never varies
 * by taxon/subgroup selection, unlike the per-country taxa-summary/node-summary
 * endpoints (see scoped-taxa-summary-duckdb.ts), so there's nothing for a
 * live query to compose with here.
 */
export function getCountryStats(): Record<string, { species: number; outdated: number }> {
  if (!countryStatsCache) {
    const content = fs.readFileSync(COUNTRY_STATS_PATH, "utf-8");
    countryStatsCache = JSON.parse(content) as Record<string, { species: number; outdated: number }>;
  }
  return countryStatsCache;
}


/**
 * sis_taxon_id → the taxonomic-difference flag, for the ~6% of
 * assessed species carrying one (data/col-revisions.json, built by
 * scripts/sync/precomputed/col-revisions.ts). Two independent signals share the entry: no
 * clean 1:1 Catalogue of Life match, and species CoL has likely split out of
 * this one — see lib/col-revision.
 *
 * Stamped onto every assessed species row (species-duckdb.ts) so the dashboard
 * can flag inline and filter by reason without a second round trip.
 *
 * Returns an empty map when the file is absent — a sync predating the script
 * still serves species, just with every row unflagged, rather than 500ing.
 */
export function getColRevisions(): Map<number, ColRevision> {
  if (colRevisionsCache) return colRevisionsCache;
  const out = new Map<number, ColRevision>();
  if (fs.existsSync(COL_REVISIONS_PATH)) {
    // Short-keyed on disk (r/d/i/dc/k/c/n/s/lw/ln, absent fields omitted) — one entry per
    // flagged species, so the shipped file stays small. See precomputed/col-revisions.ts.
    const file = JSON.parse(fs.readFileSync(COL_REVISIONS_PATH, "utf-8")) as {
      species: Record<string, { r?: string; d?: string; i?: number; dc?: string; c?: string; n?: string; k?: string;
        s?: [string, string, string, string][]; lw?: [string, string, string][]; ln?: string;
        an?: string; ac?: string; gd?: 1 }>;
    };
    for (const [id, e] of Object.entries(file.species ?? {})) {
      out.set(Number(id), {
        ...(e.r != null ? { reason: e.r } : {}),
        ...(e.d != null ? { detail: e.d } : {}),
        ...(e.i != null ? { detailId: e.i } : {}),
        ...(e.dc != null ? { detailColId: e.dc } : {}),
        ...(e.k != null ? { rank: e.k } : {}),
        ...(e.c != null ? { colId: e.c } : {}),
        ...(e.n != null ? { colName: e.n } : {}),
        // [name, col_id, previous name, previous col_id] on disk; an empty
        // string means CoL has nothing we can link to, so the UI renders that
        // part as plain text (or omits it).
        ...(e.lw?.length ? {
          lumpedWith: e.lw.map(([name, colId, category]) => ({
            name,
            ...(colId ? { colId } : {}),
            ...(category ? { category } : {}),
          })),
        } : {}),
        ...(e.ln != null ? { lumpedUnder: e.ln } : {}),
        ...(e.an != null ? { acceptedName: e.an } : {}),
        ...(e.ac != null ? { acceptedColId: e.ac } : {}),
        ...(e.gd ? { genusDiffers: true } : {}),
        ...(e.s?.length ? {
          splitInto: e.s.map(([name, colId, prevName, prevColId]) => ({
            name,
            ...(colId ? { colId } : {}),
            ...(prevName ? { previousName: prevName } : {}),
            ...(prevColId ? { previousColId: prevColId } : {}),
          })),
        } : {}),
      });
    }
  }
  colRevisionsCache = out;
  return out;
}

// =============================================================================
// SUGGESTED ASSESSOR / REVIEWER CANDIDATES
// =============================================================================

// Vocabulary and result shapes live in lib/credit-candidates.ts, which the client
// imports as values too (this module reaches for `fs` and can't be bundled there).
// Re-exported so callers that want both the query and its types have one import.
export type {
  CreditRole, CandidateRank, TargetLineage, CandidateTier, CreditCandidate, CandidateResult,
} from "@/lib/credit-candidates";

/** Below this many candidates a rank is too thin to open on (but still offered). */
const MIN_CANDIDATES_FOR_DEFAULT = 3;

/**
 * Strip trailing parenthetical affiliations from an assessor/reviewer name.
 * The same person appears with a "(... Red List Authority)" / "(... Assessment
 * Team)" role label in some assessments but not others, so we drop it to (a)
 * aggregate that person's species under one candidate and (b) keep the name a
 * stable identity that round-trips with the assessors/reviewers dashboard filter
 * (which matches against the latest assessment, where the label is often absent).
 * e.g. "Amori, G. (Small Nonvolant Mammal Red List Authority)" -> "Amori, G."
 */
function stripAffiliation(name: string): string {
  return name.replace(/\s*\([^)]*\)/g, "").trim();
}

const lc = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();
const genusOf = (scientificName: string | null | undefined): string =>
  lc(scientificName).split(/\s+/)[0] ?? "";

function emptyTier(): CandidateTier {
  return { total: 0, inRegion: 0, regionCounts: {}, countryCounts: {}, latestDate: "" };
}

/** Fold `from` into `into` — used to roll narrow tiers up into broader ones. */
function mergeTier(into: CandidateTier, from: CandidateTier): void {
  into.total += from.total;
  into.inRegion += from.inRegion;
  for (const [k, v] of Object.entries(from.regionCounts)) into.regionCounts[k] = (into.regionCounts[k] ?? 0) + v;
  for (const [k, v] of Object.entries(from.countryCounts)) into.countryCounts[k] = (into.countryCounts[k] ?? 0) + v;
  if (from.latestDate > into.latestDate) into.latestDate = from.latestDate;
}

/**
 * Rank the people who have already assessed (or reviewed) species near a target
 * species, at every granularity from its whole taxon group down to its genus.
 *
 * One pass: each assessed row is credited at the DEEPEST rank it shares with the
 * target (a same-genus species counts as genus, a same-family one as family, …),
 * and the tiers are then rolled up so each rank includes everything below it —
 * the same "a genus match also counts as family/order/class" rule the original
 * per-rank query used, but it survives a null order_name or family on the way up
 * (a genus match with no family recorded still counts toward family and above).
 */
export function getCreditCandidates(
  role: CreditRole,
  target: TargetLineage,
  countries: string[],
  source: CreditSource,
): CandidateResult {
  const countrySet = new Set(countries.map((c) => c.toUpperCase()));
  const genus = genusOf(target.scientificName);
  const familyLc = lc(target.family);
  const orderLc = lc(target.orderName);
  const classLc = lc(target.className);

  const redlistRows = source.rows;
  const historyMap = source.history;

  // name -> rank -> tier, holding ONLY rows whose deepest match is that rank
  // until the roll-up below.
  const byName = new Map<string, Partial<Record<CandidateRank, CandidateTier>>>();
  // Rows in this species' own class, used to drop a class rank that just restates
  // the group (Mammalia is every mammal, so offering it would be a second "group").
  let rowsInClass = 0;

  for (const row of redlistRows) {
    const rowGenus = genusOf(row.scientific_name);
    const isGenus = genus !== "" && rowGenus === genus;
    const isFamily = familyLc !== "" && lc(row.family) === familyLc;
    const isOrder = orderLc !== "" && lc(row.order_name) === orderLc;
    const isClass = classLc !== "" && lc(row.class_name) === classLc;
    if (isClass) rowsInClass++;

    // Deepest rank this row shares with the target. Every row in the CSV is at
    // least "group", so there is no "no overlap, skip" case.
    const rank: CandidateRank = isGenus ? "genus" : isFamily ? "family" : isOrder ? "order" : isClass ? "class" : "group";

    const overlapping = row.countries.filter((c) => countrySet.has(c.toUpperCase()));
    const hasCountryOverlap = overlapping.length > 0;
    const regions = new Set(overlapping.map((c) => countryToRegion(c)));

    const assessments = historyMap[String(row.sis_taxon_id)] ?? [];
    const allAssessments = assessments.length > 0 ? assessments : [{
      id: row.assessment_id,
      year: row.year_published,
      category: row.category,
      date: row.assessment_date,
      // A species with no published history contributes nobody, whichever role is asked for.
      assessors: null as string | null,
      reviewers: null as string | null,
      facilitators: null as string | null,
    }];

    // Credit each person once per species, dated by the most recent assessment
    // OF THIS SPECIES that person is actually on.
    const dateByName = new Map<string, string>();
    for (const assessment of allAssessments) {
      const credited = role === "assessors" ? assessment.assessors
        : role === "reviewers" ? assessment.reviewers
        : assessment.facilitators ?? null;
      if (!credited) continue;
      const date = assessment.date ?? "";
      for (const name of parseAssessorNames(credited)) {
        const normalizedName = stripAffiliation(name);
        if (!normalizedName || normalizedName.length < 3) continue;
        if (date > (dateByName.get(normalizedName) ?? "")) dateByName.set(normalizedName, date);
      }
    }

    for (const [name, date] of dateByName) {
      let tiers = byName.get(name);
      if (!tiers) { tiers = {}; byName.set(name, tiers); }
      const tier = (tiers[rank] ??= emptyTier());

      tier.total++;
      if (hasCountryOverlap) {
        tier.inRegion++;
        for (const region of regions) tier.regionCounts[region] = (tier.regionCounts[region] ?? 0) + 1;
        for (const c of overlapping) {
          const code = c.toUpperCase();
          tier.countryCounts[code] = (tier.countryCounts[code] ?? 0) + 1;
        }
      }
      if (date > tier.latestDate) tier.latestDate = date;
    }
  }

  // Which granularities to offer. Ranks the species has no value for can't be
  // asked about at all, and a class that spans the whole group is just "group"
  // under another name.
  const ranks: CandidateRank[] = ["group"];
  if (classLc !== "" && rowsInClass < redlistRows.length) ranks.push("class");
  if (orderLc !== "") ranks.push("order");
  if (familyLc !== "") ranks.push("family");
  if (genus !== "") ranks.push("genus");

  // Roll narrow tiers up into broader ones, so each offered rank counts
  // everything at or below it.
  const candidates: CreditCandidate[] = [];
  for (const [name, raw] of byName) {
    const tiers: Partial<Record<CandidateRank, CandidateTier>> = {};
    let carried: CandidateTier | null = null;
    for (const rank of [...CANDIDATE_RANKS].reverse()) {
      const own = raw[rank];
      if (!own && !carried) continue;
      const tier = own ?? emptyTier();
      if (carried) mergeTier(tier, carried);
      // Deeper ranks that aren't offered still roll up; they just aren't listed.
      if (ranks.includes(rank)) tiers[rank] = tier;
      carried = tier;
    }
    // Someone with no country overlap anywhere in the group is not a candidate —
    // the ranking is "who works on species like this, where this species lives".
    if ((tiers.group?.inRegion ?? 0) > 0) candidates.push({ name, tiers });
  }

  // Open on the finest granularity that still has enough people to compare.
  let defaultRank: CandidateRank = "group";
  for (const rank of ranks) {
    const n = candidates.filter((c) => (c.tiers[rank]?.inRegion ?? 0) > 0).length;
    if (n >= MIN_CANDIDATES_FOR_DEFAULT) defaultRank = rank;
  }

  candidates.sort((a, b) => {
    const at = a.tiers[defaultRank], bt = b.tiers[defaultRank];
    const diff = (bt?.inRegion ?? 0) - (at?.inRegion ?? 0);
    if (diff !== 0) return diff;
    const totalDiff = (bt?.total ?? 0) - (at?.total ?? 0);
    if (totalDiff !== 0) return totalDiff;
    return (bt?.latestDate ?? "").localeCompare(at?.latestDate ?? "");
  });

  return { candidates, ranks, defaultRank };
}

/**
 * Parse assessor string into individual names.
 * Handles formats like "Smith, J.A." and "IUCN SSC Amphibian Specialist Group"
 */
function parseAssessorNames(raw: string): string[] {
  if (!raw || !raw.trim()) return [];

  // Split on " & "
  const ampersandParts = raw.split(" & ");
  const names: string[] = [];

  for (const part of ampersandParts) {
    const segments = part.split(", ");
    let current = segments[0];
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const isInitialsOrAffiliation =
        seg.startsWith("(") ||
        /^[A-Z]\./.test(seg) ||
        /^[A-Z]$/.test(seg);

      if (isInitialsOrAffiliation) {
        current += ", " + seg;
      } else {
        names.push(current.trim());
        current = seg;
      }
    }
    if (current.trim()) {
      names.push(current.trim());
    }
  }

  return names.filter(Boolean);
}

// =============================================================================
// NODE SUMMARIES (replaces old getSubgroupSummaries)
// =============================================================================

export interface NodeSummary {
  id: string;
  name: string;
  estimatedDescribed: number;
  totalAssessed: number;
  outdated: number;
  /** NE species under this node with at least one GBIF record, per record mode. */
  gbifNeSpecies: Record<GbifRecordMode, number>;
  byCategory: Record<string, number>;
  // Catalogue of Life backbone (#272): extant accepted universe under this node and
  // the not-evaluated slice (universe − assessed, by col_id). Undefined when the CoL
  // artifacts weren't present at build time.
  colDescribed?: number;
  colNe?: number;
  // Per-name breakdown of colDescribed/colNe, for every name in the node's primary
  // include dimension (e.g. Pinniped SG's families [otariidae, phocidae, odobenidae],
  // or a single-name dimension like Primate SG's [primates]) — each entry's count/
  // neCount use the same filter (including excludes) narrowed to that one name, so
  // they sum to colDescribed/colNe exactly. trueAssessed is IUCN's own assessed count
  // for that one name (matched via assessed.parquet's own class/order/family fields,
  // not CoL's) — comparing it to count-neCount surfaces likely splits/lumps/coverage
  // gaps a CoL-only view would hide (see BreakdownList in TaxaSummary.tsx). Undefined
  // when the CoL artifacts weren't present at build time.
  colBreakdown?: { name: string; count: number; neCount: number; trueAssessed: number; noMatchIds: number[]; noMatchDetails?: NoMatchDetail[]; splitDetails?: SplitDetail[] }[];
}

// See src/lib/data/col-breakdown.ts's classifyNoMatch for what each reason means and
// how it's derived. Modular/additive on top of noMatchIds — safe to ignore or drop
// without touching the count-only CoL Match / No CoL Match mechanism.
// Re-exported from lib/data/col-breakdown, which is where classifyNoMatch
// actually produces these — this file used to declare its own structurally
// identical copy, and adding a reason there (synonym_of) silently failed to
// typecheck here until both were edited. One declaration, no drift.
export type { NoMatchReason, NoMatchDetail };

// Heuristic "split from" flag for Not Evaluated species — see
// the sync's col_split_candidates model (scripts/sync/dbt/models/precomputed/) for the mechanism and its
// caveats. Keyed by col_id (NE species have no sis_taxon_id), additive on top of
// colBreakdown, and independently droppable.
export interface SplitDetail {
  colId: string;
  parentId: number;
  parentName: string;
  parentCategory: string;
}

export { isOutdated, outdatedCutoffDate } from "@/lib/outdated";
