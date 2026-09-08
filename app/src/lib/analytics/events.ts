import posthog from "posthog-js";

/**
 * Product analytics for #524: which searches people run, and which filters they
 * actually reach for.
 *
 * These events are ANONYMOUS for everyone and need no consent. PostHog runs in
 * `persistence: "memory"` by default (see components/PostHogProvider.tsx) — no
 * identifier is stored on the device, so nothing here is tied to a person. That
 * is deliberate rather than incidental: gating these behind the session-replay
 * consent would have limited the answer to "which filters are popular?" to the
 * small consenting slice of signed-in users, when the useful answer covers
 * everyone. A user who has opted in to replay is identified, so their events
 * attach to them — that is the consent they gave.
 *
 * Values are captured only where a value is low-cardinality and about a
 * *species*, never about a person — see FILTER_VALUE_SAFE.
 */

/** No-op rather than a crash when PostHog isn't configured (local dev, CI). */
const enabled = () =>
  typeof window !== "undefined" && !!process.env.NEXT_PUBLIC_POSTHOG_KEY;

/**
 * URL params that are filters worth counting, mapped to the event-facing name.
 *
 * Deliberately a subset of useFilterParams' OWN_PARAM_NAMES: that list also
 * carries pure view state (`layout`, `tab`, `sort`, `mapview`, the open
 * `species`), which says nothing about which *filters* are popular and would
 * bury the signal in navigation noise.
 */
export const FILTER_PARAMS: Record<string, string> = {
  countries: "country",
  region: "region",
  taxa: "taxon",
  subgroups: "subgroup",
  categories: "risk_category",
  years: "assessment_age",
  assessmentYears: "assessment_year",
  describedYears: "described_year",
  obsRanges: "gbif_observations",
  assessmentCounts: "assessment_count",
  systems: "system",
  trends: "population_trend",
  movement: "movement_pattern",
  threats: "threat",
  criteria: "criteria",
  habitat: "habitat",
  habitatBreadth: "habitat_breadth",
  endemics: "endemics_only",
  growthForms: "growth_form",
  colMatch: "col_match",
  colReasons: "col_match_reason",
  assessors: "assessor",
  reviewers: "reviewer",
  facilitators: "facilitator",
  contributors: "contributor",
  institutions: "institution",
  outdated: "outdated",
};

/**
 * Filters whose VALUE may be captured alongside the name.
 *
 * The line is drawn at personal data about third parties: `assessors`,
 * `reviewers`, `facilitators`, `contributors` and `institutions` hold the names
 * of real people (and their employers) who assessed a species. "Which
 * assessors are being looked up" is a record of interest in named individuals,
 * so only the fact that the assessor filter was used is recorded, never who.
 *
 * `subgroups` and `colReasons` are omitted for a duller reason: their values are
 * opaque generated node ids, so they would be cardinality without meaning.
 */
const FILTER_VALUE_SAFE = new Set([
  "countries", "region", "taxa", "categories", "years", "assessmentYears",
  "describedYears", "obsRanges", "assessmentCounts", "systems", "trends",
  "movement", "threats", "criteria", "habitat", "habitatBreadth", "endemics",
  "growthForms", "colMatch", "outdated",
]);

/** A value long enough to be a pasted list is truncated rather than stored whole. */
const MAX_VALUE_LENGTH = 100;

/**
 * Which filter params are set in a query string, and (where safe) to what.
 *
 * Reads the URL rather than the hook's state object so it stays decoupled from
 * that ~50-field shape: a new filter param becomes countable by adding one line
 * to FILTER_PARAMS, with no risk of reading a field that no longer exists.
 */
export function activeFilters(
  search: string,
  suffix: string = ""
): Record<string, string | null> {
  const params = new URLSearchParams(search);
  const active: Record<string, string | null> = {};

  for (const [param, name] of Object.entries(FILTER_PARAMS)) {
    const raw = params.get(suffix ? `${param}${suffix}` : param);
    if (raw === null || raw === "") continue;
    // `endemics` is a flag: present-but-"0" is off, not a filter in use.
    if (param === "endemics" && raw !== "1") continue;
    active[name] = FILTER_VALUE_SAFE.has(param)
      ? raw.slice(0, MAX_VALUE_LENGTH)
      : null;
  }

  return active;
}

/**
 * Filters present in `next` but not in `previous` — i.e. just switched on.
 *
 * Only transitions are reported. Counting every URL write instead would rank
 * filters by how much the user fiddled with the rest of the page while one
 * happened to be set, which is not popularity.
 */
export function newlyApplied(
  previous: Record<string, string | null>,
  next: Record<string, string | null>
): Array<{ filter: string; value: string | null }> {
  return Object.entries(next)
    .filter(([name, value]) => !(name in previous) || previous[name] !== value)
    .map(([filter, value]) => ({ filter, value }));
}

/** Per-suffix baseline, so compare-mode panels are tracked independently. */
const lastSeen = new Map<string, Record<string, string | null>>();

/**
 * Establishes the baseline without emitting anything.
 *
 * Called on mount: filters that arrived in a shared link were chosen by whoever
 * built the link, not by the person opening it, so counting them would let one
 * widely-shared URL look like a popular filter.
 */
export function primeFilterBaseline(search: string, suffix: string = ""): void {
  lastSeen.set(suffix, activeFilters(search, suffix));
}

/** Diffs against the baseline and captures one event per newly-applied filter. */
export function reportFilterUsage(search: string, suffix: string = ""): void {
  const next = activeFilters(search, suffix);
  const previous = lastSeen.get(suffix) ?? {};
  lastSeen.set(suffix, next);

  if (!enabled()) return;

  for (const { filter, value } of newlyApplied(previous, next)) {
    posthog.capture("filter_applied", {
      filter,
      ...(value === null ? {} : { value }),
      // Which panel, when compare mode has two side by side.
      ...(suffix ? { panel: suffix } : {}),
    });
  }
}

/** Test seam: drop the remembered baselines. */
export function resetFilterBaselines(): void {
  lastSeen.clear();
}

// --- Search --------------------------------------------------------------

/**
 * A search the user actually acted on — the highest-signal thing the search box
 * produces, because the chosen result says what the query MEANT.
 *
 * Note what is not captured: the box refetches on a 250ms debounce, so logging
 * every request would record "P", "Pa", "Pan", "Pant"… and rank prefixes rather
 * than searches. Only settled queries are recorded, here and in
 * captureSearchNoResults.
 */
export function captureSearchResultSelected(params: {
  query: string;
  resultName: string;
  /** "species" picks one species; "taxon" browses a whole group. */
  resultType: "species" | "taxon";
  resultCategory: string | null;
  rank: number;
}): void {
  if (!enabled()) return;
  posthog.capture("search_result_selected", {
    query: params.query.slice(0, MAX_VALUE_LENGTH),
    result_name: params.resultName,
    result_type: params.resultType,
    result_category: params.resultCategory,
    // 0-based position in the dropdown: a high rank means the right answer was
    // buried, which is a ranking bug rather than a user error.
    rank: params.rank,
  });
}

/**
 * A settled query that found nothing — the most directly actionable search
 * signal there is, since each one is a name the dashboard could not resolve.
 */
export function captureSearchNoResults(query: string): void {
  if (!enabled()) return;
  posthog.capture("search_no_results", { query: query.slice(0, MAX_VALUE_LENGTH) });
}
