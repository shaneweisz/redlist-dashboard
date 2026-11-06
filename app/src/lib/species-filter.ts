/**
 * Shared species filter predicate.
 *
 * Extracted from RedListView.tsx so the same base-filter logic runs both
 * client-side (the dashboard) and server-side (the /browse LLM endpoint).
 *
 * The *categorical* clauses (categories, threats, systems, population trend,
 * movement, growth form, endemic) are declared once in the shared-filter
 * registry (@/lib/shared-filters) and matched here via matchSharedFilters, so the
 * predicate can't drift from the MCP schema or the dashboard URL. The clauses
 * that don't share that shape stay inline below: countries (entangled with the
 * region expansion), name search, and the GBIF-obs / assessment-year bounds.
 *
 * Semantics (must match the dashboard exactly):
 *  - Within one filter, multiple selected values are OR (species matches ANY).
 *  - Across different filters it is AND (species must satisfy EVERY active filter).
 *  - Threats match by prefix: "11" matches "11", "11.1", "11.4", ...
 *  - Categories match exactly.
 *
 * Note: time-relative filters (years/obs/assessment-year), assessor/reviewer,
 * and the "starred" filter are intentionally NOT included here — they depend on
 * the current date, GBIF counts, or local UI state and stay inline in RedListView.
 */
import { DEFAULT_GBIF_RECORD_MODE, gbifRecordCount, type GbifRecordMode } from "@/lib/gbif-records";
import { matchSharedFilters } from "@/lib/shared-filters";

/** Minimal structural shape this predicate needs. Both `SpeciesRow`
 *  (server data store) and `RedListSpecies` (client hook) satisfy it. */
export interface FilterableSpecies {
  category: string;
  countries: string[];
  systems?: string[] | null;
  population_trend: string | null;
  movement_pattern: string | null;
  threat_codes?: string[] | null;
  growth_forms?: string[] | null;
  scientific_name: string;
  common_name: string | null;
  gbif_georeferenced_records_count?: number | null;
  gbif_all_records_count?: number | null;
  assessment_date?: string | null;
}

export interface SpeciesFilterCriteria {
  categories?: Set<string>;
  threats?: Set<string>;
  countries?: Set<string>;
  systems?: Set<string>;
  populationTrends?: Set<string>;
  movementPatterns?: Set<string>;
  growthForms?: Set<string>;
  /** Only species endemic to a single country (occurring in exactly one). */
  endemicsOnly?: boolean;
  /** Already lowercased by the caller. */
  search?: string;
  /** GBIF record-count bounds (null counts as 0), in the `records` mode. */
  minObs?: number;
  maxObs?: number;
  /** Which GBIF records the bounds count; georeferenced by default. */
  records?: GbifRecordMode;
  /** Assessment year bounds (inclusive). */
  minAssessmentYear?: number;
  maxAssessmentYear?: number;
}

const empty = (s?: Set<string>) => !s || s.size === 0;

export function matchesSpeciesFilter(s: FilterableSpecies, f: SpeciesFilterCriteria): boolean {
  // Categorical clauses (categories, threats, systems, trend, movement, growth
  // form, endemic) — declared once in the shared-filter registry.
  if (!matchSharedFilters(s, f)) return false;

  const matchesCountry = empty(f.countries) || s.countries.some((c) => f.countries!.has(c));

  const q = f.search;
  const matchesSearch =
    !q ||
    s.scientific_name.toLowerCase().includes(q) ||
    (s.common_name?.toLowerCase().includes(q) ?? false);

  const obs = gbifRecordCount(s, f.records ?? DEFAULT_GBIF_RECORD_MODE) ?? 0;
  const matchesMinObs = f.minObs == null || obs >= f.minObs;
  const matchesMaxObs = f.maxObs == null || obs <= f.maxObs;

  let matchesYear = true;
  if (f.minAssessmentYear != null || f.maxAssessmentYear != null) {
    const year = s.assessment_date ? parseInt(s.assessment_date.slice(0, 4), 10) : NaN;
    if (Number.isNaN(year)) matchesYear = false;
    else {
      if (f.minAssessmentYear != null && year < f.minAssessmentYear) matchesYear = false;
      if (f.maxAssessmentYear != null && year > f.maxAssessmentYear) matchesYear = false;
    }
  }

  return matchesCountry && matchesSearch && matchesMinObs && matchesMaxObs && matchesYear;
}

