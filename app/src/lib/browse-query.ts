/**
 * Shared query logic for the dashboard's agent/data surface — used by BOTH the
 * /browse HTTP route and the /api/mcp tools, so they return identical results
 * (single source of truth, can't drift).
 *
 * Takes raw string params (from URL query or MCP tool args), resolves the
 * plain-English vocabulary, runs the DuckDB read layer (querySpecies for taxon
 * browse, searchSpecies for species lookup), applies the shared base predicate +
 * the SPA-local filters, and returns a structured result (total + by-category
 * breakdown + outdated stats + a capped, labelled species list).
 */
import { querySpecies, searchSpecies, type SearchResult } from "@/lib/data/species-duckdb";
import { isOutdated } from "@/lib/data/species-store";
import { getDataSyncDate } from "@/lib/data-sync-date";
import { findNode, speciesMatchesNode } from "@/lib/taxonomy-utils";
import { matchesSpeciesFilter, type SpeciesFilterCriteria, type FilterableSpecies } from "@/lib/species-filter";
import { applySharedFilters, type SharedFilterInput } from "@/lib/shared-filters";
import type { RedListSpecies } from "@/hooks/useRedListSpeciesQuery";
import { parseAssessors, parseInstitutions } from "@/lib/parseAssessors";
import { resolveRegions } from "@/lib/regions";
import { CATEGORY_ORDER } from "@/config/taxa";
import {
  resolveTaxa, resolveCountries,
  taxonLabel, categoryLabel, countryLabel, threatDisplay,
} from "@/lib/filter-vocab";

export const RESULT_CAP = 200;

// The categorical filters (categories, threats, systems, trends, movement,
// growthForms, endemic) come from the shared-filter registry via
// SharedFilterInput; the fields below are the bespoke ones (taxa/search,
// country+region, assessor/reviewer substring, and the exact numeric params).
export interface BrowseInput extends SharedFilterInput {
  taxa?: string[];
  search?: string;
  countries?: string[];
  region?: string[];
  outdated?: "yes" | "no" | null;
  assessors?: string[];
  reviewers?: string[];
  facilitators?: string[];
  contributors?: string[];
  institutions?: string[];
  minObs?: number;
  maxObs?: number;
  minAssessmentYear?: number;
  maxAssessmentYear?: number;
  minDescribedYear?: number;
  maxDescribedYear?: number;
}

export interface BrowseSpecies {
  scientific_name: string;
  common_name: string | null;
  matched_synonym: string | null;
  category: string;
  category_label: string;
  threats: { code: string; label: string }[];
  countries: string[];
  systems: string[] | null;
  population_trend: string | null;
  assessment_date: string | null;
  outdated: boolean;
  gbif_occurrence_count: number | null;
}

export interface BrowseResult {
  interpreted: string[];
  unresolved: string[];
  /** A requested group is too large to enumerate (drill into a sub-group). */
  tooLarge: boolean;
  /** True when neither a taxon nor a search term resolved (caller decides how to surface). */
  noSelector: boolean;
  total: number;
  shown: number;
  capped: boolean;
  breakdown: Record<string, number>;
  stats: { assessed: number; outdated: number; outdated_pct: number | null };
  species: BrowseSpecies[];
}

type Row = FilterableSpecies & {
  taxon_group?: string;
  class_name?: string | null;
  order_name?: string | null;
  family?: string | null;
  latest_assessors?: string | null;
  latest_reviewers?: string | null;
  latest_facilitators?: string | null;
  latest_contributors?: string | null;
  latest_institutions?: string | null;
  described_year?: number | null;
  matched_synonym?: string | null;
};

// resolveRegions now lives in @/lib/regions (shared with the dashboard-URL
// translator); re-exported here for existing importers.
export { resolveRegions } from "@/lib/regions";

function searchHitToRow(h: SearchResult): Row {
  return {
    category: h.category, countries: h.countries ?? [], systems: null,
    population_trend: null, movement_pattern: null, threat_codes: null,
    growth_forms: null, scientific_name: h.scientific_name, common_name: h.common_name,
    gbif_occurrence_count: null, assessment_date: h.assessment_date, taxon_group: h.taxon_group,
    latest_assessors: null, latest_reviewers: null, latest_facilitators: null,
    latest_contributors: null, latest_institutions: null, described_year: null,
    matched_synonym: h.matched_synonym ?? null,
  };
}

const arr = (a?: string[]) => (a ?? []).map((s) => s.trim()).filter(Boolean);
const setOrUndef = (a: string[]) => (a.length ? new Set(a) : undefined);

export async function runBrowseQuery(input: BrowseInput): Promise<BrowseResult> {
  const taxa = resolveTaxa(arr(input.taxa));
  const countries = resolveCountries(arr(input.countries));
  const regionRaw = arr(input.region);
  const regions = resolveRegions(regionRaw);
  const assessors = arr(input.assessors);
  const reviewers = arr(input.reviewers);
  const facilitators = arr(input.facilitators);
  const contributors = arr(input.contributors);
  const institutions = arr(input.institutions);
  const search = (input.search ?? "").trim();
  const { outdated = null, minObs, maxObs, minAssessmentYear, maxAssessmentYear, minDescribedYear, maxDescribedYear } = input;

  // Categorical filters resolve into `criteria` via the shared registry; the
  // bespoke ones (country+region, search, obs/year bounds) are added below.
  const criteria: SpeciesFilterCriteria = {};
  const shared = applySharedFilters(input, criteria);
  criteria.countries = setOrUndef([...countries.codes, ...regions.codes]);
  criteria.search = search ? search.toLowerCase() : undefined;
  criteria.minObs = minObs;
  criteria.maxObs = maxObs;
  criteria.minAssessmentYear = minAssessmentYear;
  criteria.maxAssessmentYear = maxAssessmentYear;

  const unresolved = [
    ...taxa.unresolved.map((v) => `taxa=${v}`),
    ...shared.unresolved,
    ...countries.unresolved.map((v) => `countries=${v}`),
    ...regions.unresolved.map((v) => `region=${v}`),
  ];

  if (taxa.ids.length === 0 && !search) {
    return { interpreted: [], unresolved, tooLarge: false, noSelector: true, total: 0, shown: 0, capped: false, breakdown: {}, stats: { assessed: 0, outdated: 0, outdated_pct: null }, species: [] };
  }

  let matched: Row[] = [];
  let tooLarge = false;

  if (taxa.ids.length) {
    const includeNE = criteria.categories?.has("NE") ?? false;
    const results = await Promise.all(taxa.ids.map((id) => querySpecies({ taxon: id, includeNE })));
    const seen = new Set<string>();
    results.forEach((res, i) => {
      if (res.tooLarge) tooLarge = true;
      const id = taxa.ids[i];
      const isNode = !!findNode(id);
      for (const r of res.species as unknown as RedListSpecies[]) {
        if (isNode && !speciesMatchesNode(r, id)) continue;
        if (seen.has(r.species_key)) continue;
        seen.add(r.species_key);
        if (matchesSpeciesFilter(r, criteria)) matched.push(r);
      }
    });
    if (outdated) matched = matched.filter((r) => isOutdated(r.assessment_date ?? null, getDataSyncDate()) === (outdated === "yes"));
    if (assessors.length) {
      const q = assessors.map((a) => a.toLowerCase());
      matched = matched.filter((r) => parseAssessors(r.latest_assessors).some((a) => q.some((x) => a.toLowerCase().includes(x))));
    }
    if (reviewers.length) {
      const q = reviewers.map((a) => a.toLowerCase());
      matched = matched.filter((r) => parseAssessors(r.latest_reviewers).some((a) => q.some((x) => a.toLowerCase().includes(x))));
    }
    if (facilitators.length) {
      const q = facilitators.map((a) => a.toLowerCase());
      matched = matched.filter((r) => parseAssessors(r.latest_facilitators).some((a) => q.some((x) => a.toLowerCase().includes(x))));
    }
    if (contributors.length) {
      const q = contributors.map((a) => a.toLowerCase());
      matched = matched.filter((r) => parseAssessors(r.latest_contributors).some((a) => q.some((x) => a.toLowerCase().includes(x))));
    }
    if (institutions.length) {
      const q = institutions.map((a) => a.toLowerCase());
      matched = matched.filter((r) => parseInstitutions(r.latest_institutions).some((a) => q.some((x) => a.toLowerCase().includes(x))));
    }
    if (minDescribedYear != null || maxDescribedYear != null) {
      matched = matched.filter((r) => r.described_year != null
        && (minDescribedYear == null || r.described_year >= minDescribedYear)
        && (maxDescribedYear == null || r.described_year <= maxDescribedYear));
    }
  } else {
    const hits = await searchSpecies(search, RESULT_CAP);
    matched = hits.map(searchHitToRow);
  }

  matched.sort((a, b) => {
    const ca = CATEGORY_ORDER[a.category] ?? 99;
    const cb = CATEGORY_ORDER[b.category] ?? 99;
    return ca !== cb ? ca - cb : a.scientific_name.localeCompare(b.scientific_name);
  });

  const total = matched.length;
  const shown = matched.slice(0, RESULT_CAP);
  const breakdown: Record<string, number> = {};
  for (const r of matched) breakdown[r.category] = (breakdown[r.category] ?? 0) + 1;
  const assessed = matched.filter((r) => r.category !== "NE");
  const outdatedCount = assessed.filter((r) => isOutdated(r.assessment_date ?? null, getDataSyncDate())).length;
  const outdated_pct = assessed.length ? Math.round((outdatedCount / assessed.length) * 100) : null;

  // Human-readable active-filter summary (drives the HTML/JSON "interpreted").
  // The categorical lines come from the shared registry; the rest are bespoke.
  const interpreted: string[] = [];
  if (taxa.ids.length) interpreted.push(`Taxa: ${taxa.ids.map(taxonLabel).join(", ")}`);
  interpreted.push(...shared.describe);
  if (countries.codes.length) interpreted.push(`Countries: ${countries.codes.map(countryLabel).join(", ")}`);
  if (regions.codes.length) interpreted.push(`Region: ${regionRaw.filter((v) => !regions.unresolved.includes(v)).join(", ")}`);
  if (search) interpreted.push(`Name search: "${search}"`);
  if (assessors.length) interpreted.push(`Assessor: ${assessors.join(", ")}`);
  if (reviewers.length) interpreted.push(`Reviewer: ${reviewers.join(", ")}`);
  if (facilitators.length) interpreted.push(`Facilitator: ${facilitators.join(", ")}`);
  if (contributors.length) interpreted.push(`Contributor: ${contributors.join(", ")}`);
  if (institutions.length) interpreted.push(`Institution: ${institutions.join(", ")}`);
  if (minObs != null) interpreted.push(`GBIF observations ≥ ${minObs.toLocaleString()}`);
  if (maxObs != null) interpreted.push(`GBIF observations ≤ ${maxObs.toLocaleString()}`);
  if (minAssessmentYear != null) interpreted.push(`Assessed in or after ${minAssessmentYear}`);
  if (maxAssessmentYear != null) interpreted.push(`Assessed in or before ${maxAssessmentYear}`);
  if (minDescribedYear != null) interpreted.push(`Described in or after ${minDescribedYear}`);
  if (maxDescribedYear != null) interpreted.push(`Described in or before ${maxDescribedYear}`);
  if (outdated) interpreted.push(outdated === "yes" ? "Assessments needing updating (>10 yrs old)" : "Current assessments (≤10 yrs old)");

  return {
    interpreted, unresolved, tooLarge, noSelector: false,
    total, shown: shown.length, capped: total > RESULT_CAP, breakdown,
    stats: { assessed: assessed.length, outdated: outdatedCount, outdated_pct },
    species: shown.map((s) => ({
      scientific_name: s.scientific_name,
      common_name: s.common_name,
      matched_synonym: s.matched_synonym ?? null,
      category: s.category,
      category_label: categoryLabel(s.category),
      threats: (s.threat_codes ?? []).map((c) => ({ code: c, label: threatDisplay(c) })),
      countries: s.countries,
      systems: s.systems ?? null,
      population_trend: s.population_trend,
      assessment_date: s.assessment_date ?? null,
      outdated: isOutdated(s.assessment_date ?? null, getDataSyncDate()),
      gbif_occurrence_count: s.gbif_occurrence_count ?? null,
    })),
  };
}
