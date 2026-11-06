/**
 * Which GBIF records a count counts.
 *
 *   georeferenced  the records a map can use: coordinates and none of GBIF's
 *                  geospatial issues (hasCoordinate=true&hasGeospatialIssue=false),
 *                  of a type that places the species where it lives wild
 *                  (GEOREFERENCED_BASIS_OF_RECORD). The default.
 *   all            every record GBIF holds for the species, of any type, with
 *                  or without coordinates: the number gbif.org shows.
 *
 * Both count the species' own name, synonyms and subspecies the same way
 * (scripts/sync/core/counts.ts). Every GBIF number on the dashboard reads its
 * mode through here, so the toggle changes them together.
 */

export type GbifRecordMode = "georeferenced" | "all";

export const GBIF_RECORD_MODES: readonly GbifRecordMode[] = ["georeferenced", "all"];
export const DEFAULT_GBIF_RECORD_MODE: GbifRecordMode = "georeferenced";

/**
 * Record types a georeferenced count keeps, for every kingdom: observations,
 * machine records (camera traps, sound), material samples (eDNA), the generic
 * types, and preserved specimens (museum and herbarium material, often the
 * main record of a rare species). Left out: living specimens (zoos, botanic
 * gardens: not where the species lives wild), fossils, and material citations
 * (literature records, often copies of a specimen GBIF already holds).
 */
export const GEOREFERENCED_BASIS_OF_RECORD = [
  "HUMAN_OBSERVATION",
  "MACHINE_OBSERVATION",
  "MATERIAL_SAMPLE",
  "OCCURRENCE",
  "OBSERVATION",
  "PRESERVED_SPECIMEN",
] as const;

/** The URL parameter holding the mode; absent means the default. */
export const GBIF_RECORDS_PARAM = "records";

export function parseGbifRecordMode(v: string | null | undefined): GbifRecordMode {
  return v === "all" ? "all" : DEFAULT_GBIF_RECORD_MODE;
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
 * The GBIF occurrence-search filter for a mode, appended to `params`.
 * Georeferenced asks for coordinates, no geospatial issue and its record
 * types; all records asks for nothing.
 */
export function applyGbifRecordMode(params: URLSearchParams, mode: GbifRecordMode): URLSearchParams {
  if (mode === "all") return params;
  params.set("hasCoordinate", "true");
  params.set("hasGeospatialIssue", "false");
  for (const b of GEOREFERENCED_BASIS_OF_RECORD) params.append("basisOfRecord", b);
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
