/**
 * Habitat filter predicate — extracted from RedListView.tsx so the
 * breadth/importance/season logic (and its edge cases) can be unit tested
 * directly instead of only through the component.
 *
 * habitat_codes tuples are "code:season:suitability:importance", written by
 * sources/assessments.ts.ts — see that file's SEASON_CODES/SUITABILITY_CODES/
 * MAJOR_IMPORTANCE_CODES for the single-letter encoding this decodes.
 */

export interface HabitatEntry {
  code: string;
  season: string;
  suitability: string;
  /** "Major" | "Not major" | "Unknown" (importance not recorded in the IUCN DB) */
  importance: string;
}

const HABITAT_SEASON_LABELS: Record<string, string> = {
  R: "Resident", B: "Breeding Season", N: "Non-Breeding Season", P: "Passage", U: "Seasonal Occurrence Unknown", "-": "Unknown",
};
const HABITAT_SUITABILITY_LABELS: Record<string, string> = {
  S: "Suitable", M: "Marginal", U: "Unknown", "-": "Unknown",
};
const HABITAT_IMPORTANCE_LABELS: Record<string, string> = {
  "1": "Major", "0": "Not major", "-": "Unknown",
};

/** Every value parseHabitatEntries can produce for `season`/`importance` —
 *  the full "nothing excluded" set for each checkbox dropdown's default. */
export const ALL_HABITAT_SEASONS = ["Resident", "Breeding Season", "Non-Breeding Season", "Passage", "Seasonal Occurrence Unknown"];
export const ALL_HABITAT_IMPORTANCE = ["Major", "Not major", "Unknown"];
export const ALL_HABITAT_SUITABILITY = ["Suitable", "Marginal", "Unknown"];

/** The IUCN "Unknown" top-level habitat category — has no subtypes, so a
 *  species recorded only here has no *known* habitat and can't be a
 *  specialist in anything. */
const UNKNOWN_HABITAT_CATEGORY = "18";

export function parseHabitatEntries(habitatCodes: string[] | null | undefined): HabitatEntry[] {
  if (!habitatCodes) return [];
  return habitatCodes.map(tuple => {
    const [code, season, suitability, importance] = tuple.split(":");
    return {
      code: code ?? tuple,
      season: HABITAT_SEASON_LABELS[season] ?? "Unknown",
      suitability: HABITAT_SUITABILITY_LABELS[suitability] ?? "Unknown",
      importance: HABITAT_IMPORTANCE_LABELS[importance] ?? "Unknown",
    };
  });
}

/** Distinct top-level habitat categories a set of codes belongs to, with the
 *  IUCN "Unknown" category (18, no subtypes) excluded — a species recorded
 *  only there has no *known* habitat, so it shouldn't count toward either
 *  "specialist" (1 known category) or "generalist" (2+ known categories). */
export function coarseKnownCategories(codes: string[]): Set<string> {
  return new Set(codes.map(code => code.split(".")[0]).filter(top => top !== UNKNOWN_HABITAT_CATEGORY));
}

/** A checkbox-dropdown selection only restricts anything once it's a proper
 *  subset of "all" values — fully checked (the default) or fully unchecked
 *  both mean "no restriction" here, so an accidental clear-all doesn't trap
 *  the user in a permanent zero-results state. */
export function isRestrictiveSelection(selected: Set<string>, all: string[]): boolean {
  return selected.size > 0 && selected.size < all.length;
}

/** null = no breadth filter; "specialist" = exactly one known coarse
 *  category; "generalist" = two or more. */
export type HabitatBreadth = "specialist" | "generalist" | null;

export interface HabitatFilterCriteria {
  selectedHabitat: Set<string>;
  breadth: HabitatBreadth;
  /** Which importance values to include — defaults to ALL_HABITAT_IMPORTANCE
   *  (nothing excluded); unchecking a value excludes matches whose relevant
   *  entries are ONLY that value. */
  importance: Set<string>;
  /** Which season values to include — defaults to ALL_HABITAT_SEASONS. */
  seasons: Set<string>;
  /** Which suitability values to include — defaults to ALL_HABITAT_SUITABILITY. */
  suitability: Set<string>;
}

export function matchesHabitatFilter(
  habitatCodes: string[] | null | undefined,
  criteria: HabitatFilterCriteria
): boolean {
  const { selectedHabitat, breadth, importance, seasons, suitability } = criteria;
  const importanceActive = isRestrictiveSelection(importance, ALL_HABITAT_IMPORTANCE);
  const seasonsActive = isRestrictiveSelection(seasons, ALL_HABITAT_SEASONS);
  const suitabilityActive = isRestrictiveSelection(suitability, ALL_HABITAT_SUITABILITY);
  if (selectedHabitat.size === 0 && !breadth && !importanceActive && !seasonsActive && !suitabilityActive) return true;

  const entries = parseHabitatEntries(habitatCodes);
  const codes = Array.from(new Set(entries.map(e => e.code)));

  if (selectedHabitat.size > 0 && !codes.some(code => Array.from(selectedHabitat).some(sel => code === sel || code.startsWith(sel + ".")))) {
    return false;
  }

  if (breadth) {
    // Breadth is about the coarse (top-level) category, not the exact code —
    // a species recorded in two Forest subtypes (1.1 and 1.5) is still a
    // 1-category (specialist) species, not a 2-habitat generalist.
    const known = coarseKnownCategories(codes);
    if (breadth === "specialist" && known.size !== 1) return false;
    if (breadth === "generalist" && known.size < 2) return false;
  }

  // Importance and season scope to the entries matching the current habitat
  // selection (so they refine "this specific habitat match"), falling back
  // to all entries when no habitat is selected.
  const relevant = selectedHabitat.size > 0
    ? entries.filter(e => Array.from(selectedHabitat).some(sel => e.code === sel || e.code.startsWith(sel + ".")))
    : entries;

  if (importanceActive && !relevant.some(e => importance.has(e.importance))) return false;
  if (seasonsActive && !relevant.some(e => seasons.has(e.season))) return false;
  if (suitabilityActive && !relevant.some(e => suitability.has(e.suitability))) return false;

  return true;
}
