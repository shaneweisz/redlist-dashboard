/**
 * Which GBIF records a count counts.
 *
 *   georeferenced  records with coordinates and none of GBIF's geospatial
 *                  issues (hasCoordinate=true&hasGeospatialIssue=false), of
 *                  any type.
 *   all            every record GBIF holds for the species, of any type, with
 *                  or without coordinates: the number gbif.org shows. The default.
 *
 * Both count every record type (the maps apply their own record-type
 * defaults), and the species' own name, synonyms and subspecies the same way
 * (scripts/sync/count/). Every GBIF number on the dashboard reads its
 * mode through here, so the toggle changes them together.
 */

export type GbifRecordMode = "georeferenced" | "all";

export const GBIF_RECORD_MODES: readonly GbifRecordMode[] = ["all", "georeferenced"];
export const DEFAULT_GBIF_RECORD_MODE: GbifRecordMode = "all";

/** The URL parameter holding the mode; absent means the default. */
export const GBIF_RECORDS_PARAM = "records";

export function parseGbifRecordMode(v: string | null | undefined): GbifRecordMode {
  return v === "georeferenced" ? "georeferenced" : DEFAULT_GBIF_RECORD_MODE;
}

export const GBIF_RECORD_MODE_LABEL: Record<GbifRecordMode, string> = {
  georeferenced: "Georeferenced",
  all: "All records",
};

/** A taxonomic group's GBIF totals under one mode (taxa-summary.json). */
export interface GbifGroupTotals {
  /** Species (assessed or not) with at least one record. */
  species_count: number;
  /** Of those, species no assessment is linked to. */
  ne_species_count: number;
  records: number;
  median: number | null;
}

/** A species' GBIF counts as the lists carry them. */
export interface GbifRecordCounts {
  gbif_georeferenced_records_count?: number | null;
  gbif_all_records_count?: number | null;
  gbif_georeferenced_records_since_assessment?: number | null;
  gbif_all_records_since_assessment?: number | null;
}

/** A species' record count in this mode. */
export function gbifRecordCount(s: GbifRecordCounts, mode: GbifRecordMode): number | null {
  const v = mode === "all" ? s.gbif_all_records_count : s.gbif_georeferenced_records_count;
  return v ?? null;
}

/** Records dated after the species' assessment, in this mode; null when there is no window. */
export function gbifRecordsSinceAssessment(s: GbifRecordCounts, mode: GbifRecordMode): number | null {
  const v = mode === "all" ? s.gbif_all_records_since_assessment : s.gbif_georeferenced_records_since_assessment;
  return v ?? null;
}

/**
 * The GBIF occurrence-search filter for a mode, set on `params`. Georeferenced
 * asks for coordinates and no geospatial issue; all records asks for nothing.
 * Neither filters record types: the maps apply their own.
 */
export function applyGbifRecordMode(params: URLSearchParams, mode: GbifRecordMode): URLSearchParams {
  if (mode === "all") return params;
  params.set("hasCoordinate", "true");
  params.set("hasGeospatialIssue", "false");
  return params;
}

/**
 * The first day a since-assessment count includes, as GBIF's eventDate range
 * start: the day after the assessment. Null for an undated assessment.
 */
export function sinceAssessmentStart(assessmentDate: string | null | undefined): string | null {
  if (!assessmentDate || !/^\d{4}-\d{2}-\d{2}/.test(assessmentDate)) return null;
  const d = new Date(`${assessmentDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── The GBIF Records chart and its filters ───────────────────────────────────
//
// The chart shows one metric in one mode at a time (two toggles), and each of
// the six keeps its own bucket selection, so they combine the way assessors and
// reviewers do: "Total (all) 10K+" and "Total (georeferenced) 1K-10K" at once.
// This is independent of the table's toggle, which only sets what is displayed.

export type GbifMetric = "total" | "new" | "pctNew";
export type GbifRangeKey = `${GbifMetric}.${GbifRecordMode}`;

export const GBIF_RANGE_KEYS: readonly GbifRangeKey[] = [
  "total.all", "total.georeferenced", "new.all", "new.georeferenced", "pctNew.all", "pctNew.georeferenced",
];
export const DEFAULT_GBIF_CHART_KEY: GbifRangeKey = "total.all";

/** Each selection's URL parameter. */
export const GBIF_RANGE_PARAM: Record<GbifRangeKey, string> = {
  "total.all": "gbifTotal",
  "total.georeferenced": "gbifTotalGeo",
  "new.all": "gbifNew",
  "new.georeferenced": "gbifNewGeo",
  "pctNew.all": "gbifPctNew",
  "pctNew.georeferenced": "gbifPctNewGeo",
};
export const GBIF_CHART_PARAM = "gbifChart";

export type GbifRanges = Record<GbifRangeKey, Set<string>>;
export const emptyGbifRanges = (): GbifRanges =>
  Object.fromEntries(GBIF_RANGE_KEYS.map((k) => [k, new Set<string>()])) as GbifRanges;
export const hasGbifRanges = (r: GbifRanges): boolean => GBIF_RANGE_KEYS.some((k) => r[k].size > 0);

export function parseGbifChartKey(v: string | null | undefined): GbifRangeKey {
  return (GBIF_RANGE_KEYS as readonly string[]).includes(v ?? "") ? (v as GbifRangeKey) : DEFAULT_GBIF_CHART_KEY;
}
export const gbifKeyParts = (key: GbifRangeKey) => {
  const [metric, mode] = key.split(".") as [GbifMetric, GbifRecordMode];
  return { metric, mode };
};

export const GBIF_METRIC_LABEL: Record<GbifMetric, string> = { total: "Total", new: "New", pctNew: "% New" };
export const gbifRangeKeyLabel = (key: GbifRangeKey): string => {
  const { metric, mode } = gbifKeyParts(key);
  return `${GBIF_METRIC_LABEL[metric]} · ${GBIF_RECORD_MODE_LABEL[mode]}`;
};

export const GBIF_COUNT_BUCKETS = ["0", "1-10", "11-100", "101-1K", "1K-10K", "10K+"] as const;
export const GBIF_PCT_BUCKETS = ["0%", "<10%", "10-25%", "25-50%", "50%+"] as const;
export const gbifBucketsFor = (metric: GbifMetric): readonly string[] => (metric === "pctNew" ? GBIF_PCT_BUCKETS : GBIF_COUNT_BUCKETS);

/** A species' value for a chart key; null where it has none (no assessment window, or % of no records). */
export function gbifMetricValue(s: GbifRecordCounts, key: GbifRangeKey): number | null {
  const { metric, mode } = gbifKeyParts(key);
  const total = gbifRecordCount(s, mode) ?? 0;
  if (metric === "total") return total;
  const since = gbifRecordsSinceAssessment(s, mode);
  if (metric === "new") return since;
  return since == null || total === 0 ? null : (100 * since) / total;
}

/** The bucket a value falls in, or null for no value. */
export function gbifBucket(value: number | null, metric: GbifMetric): string | null {
  if (value == null) return null;
  if (metric === "pctNew") {
    if (value === 0) return "0%";
    if (value < 10) return "<10%";
    if (value < 25) return "10-25%";
    if (value < 50) return "25-50%";
    return "50%+";
  }
  if (value === 0) return "0";
  if (value <= 10) return "1-10";
  if (value <= 100) return "11-100";
  if (value <= 1000) return "101-1K";
  if (value <= 10000) return "1K-10K";
  return "10K+";
}

/** Does a species pass every GBIF range selection (except `skip`, the chart's own)? */
export function matchesGbifRanges(s: GbifRecordCounts, ranges: GbifRanges, skip?: GbifRangeKey): boolean {
  for (const key of GBIF_RANGE_KEYS) {
    const sel = ranges[key];
    if (key === skip || sel.size === 0) continue;
    const b = gbifBucket(gbifMetricValue(s, key), gbifKeyParts(key).metric);
    if (b == null || !sel.has(b)) return false;
  }
  return true;
}
