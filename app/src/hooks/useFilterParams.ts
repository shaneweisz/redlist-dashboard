"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { canonicalizeTaxonId } from "@/lib/data/taxonomy-constants";
import { resolveRegions } from "@/lib/regions";
import { expandTaxaToken, collapseTaxaToTokens, getViewRootForNode, type FilterRank } from "@/lib/taxonomy-utils";
import { ALL_HABITAT_SEASONS, ALL_HABITAT_IMPORTANCE, ALL_HABITAT_SUITABILITY } from "@/lib/habitat-filter";
import { parseSpeciesParam } from "@/lib/species-row-key";
import { prettifyQs } from "@/lib/query-string";

// Both habitat checkbox-dropdowns (Importance, Season) default to "everything
// checked" (nothing excluded) rather than "nothing checked" — see
// habitat-filter.ts's isRestrictiveSelection for why an empty selection and a
// full one are treated the same. A set-equality helper lets buildQs omit the
// param entirely at the default, instead of writing out every value.
const setEqualsArray = (a: Set<string>, b: string[]): boolean => a.size === b.length && b.every(v => a.has(v));

// --- URL parsing helpers ---

export type ViewMode = "reassessments" | "new-assessments";

// Flat-table layout ("Table 1a mode" / "SSC groups mode") plus the country-view
// landing page ("country") — URL-synced so it survives reload/share and so the
// browser back button can return to it after drilling into a group (see
// navigateToTaxonSubgroup below) or a country (see enterCountryDrilldown).
export type LayoutMode = "table1a" | "ssc" | "country" | null;

/**
 * Values the species detail panel's `?tab=` can take.
 *
 * "assessors" and "reviewers" are legacy aliases: the two Suggested tabs merged
 * into one ("candidates") with a credit-line toggle, and links predating that
 * still name them. They stay accepted here and are mapped — with the role they
 * asked for preselected — by RedListView's visibleTab/roleFromLegacyTab.
 */
export type DetailTabParam = "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "candidates" | "assessors" | "reviewers" | "col" | "eol";

// WorldMap's own Map/List toggle and the list view's column sort — URL-synced
// (distinct from sortField/sortDirection above, which sort the species table)
// so a list-view sort like "most outdated plants" is a shareable link.
export type MapViewMode = "map" | "list";
export type MapSortKey = "name" | "species" | "outdated" | "percentOutdated";

// Exact, URL-only base filters (no on-screen control — the charts use coarse
// buckets). They let an agent/MCP dashboard link reproduce the exact /browse
// query; each feeds the same predicate the dashboard already runs.
export interface ExactFilters {
  outdated: "yes" | "no" | null;
  minObs: number | null;
  maxObs: number | null;
  minAssessmentYear: number | null;
  maxAssessmentYear: number | null;
  minDescribedYear: number | null;
  maxDescribedYear: number | null;
}

export const EMPTY_EXACT_FILTERS: ExactFilters = {
  outdated: null, minObs: null, maxObs: null,
  minAssessmentYear: null, maxAssessmentYear: null,
  minDescribedYear: null, maxDescribedYear: null,
};

const numParam = (p: URLSearchParams, key: string): number | null => {
  const v = p.get(key);
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

const FILTER_RANKS: FilterRank[] = ["class", "order", "family", "genus", "species"];

// Compare mode support: every param name this hook owns can be namespaced with a
// suffix (e.g. "_b") so two independent panels can each keep their own filter
// state in one shared URL without colliding (?taxa=birds&taxa_b=reptiles). A
// bare "" suffix (the default / single-dashboard case) is identical to no
// namespacing at all.
const paramKey = (name: string, suffix: string): string => (suffix ? `${name}${suffix}` : name);

// The full set of base (unsuffixed) param names this hook reads/writes — used by
// syncUrl to know which keys in the URL "belong to" a given hook instance (so it
// can merge its own writes into the URL without clobbering another instance's
// differently-suffixed params). Keep in sync with parseParams/buildQs below.
// Exported so tests can assert this list actually tracks every key
// parseParams/buildQs read or write — otherwise a future param added to one
// but not the other would silently leak across compare-mode panels with
// nothing catching it (see filterParams.test.ts's "OWN_PARAM_NAMES stays in
// sync" test).
export const OWN_PARAM_NAMES = [
  "view", "layout", "origin", "countries", "region", "taxa", "subgroups",
  "categories", "years", "assessmentYears", "describedYears", "obsRanges", "assessmentCounts",
  "systems", "trends", "movement", "threats", "threatsScope", "criteria", "habitat", "habitatBreadth",
  "habitatImportance", "habitatSeasons", "habitatSuitability", "bd", "endemics", "growthForms",
  "colMatch", "colReasons",
  "assessors", "reviewers", "facilitators", "contributors", "institutions",
  "search", "outdated", "minObs", "maxObs",
  "minAssessmentYear", "maxAssessmentYear", "minDescribedYear", "maxDescribedYear",
  "species", "tab", "sort", "dir", "sort2", "dir2", "mapview", "mapsort", "mapdir",
];

/**
 * Which species the Threats chart (and a threat selection made from it) covers.
 * IUCN's feedback is that threat coding is only reliable for threatened
 * assessments, so "threatened" (CR/EN/VU) is the default and "all" is the
 * explicit opt-in to the fuller, patchier data.
 */
export type ThreatsScope = "threatened" | "all";

/** Columns the species table can be sorted by. */
export type SortField = "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | "describedYear";

const SORT_FIELDS: SortField[] = ["year", "category", "totalGbif", "newGbif", "pctNewGbif", "describedYear"];

/** Narrow a raw `sort=`/`sort2=` param to a SortField, or null if unrecognised. */
function parseSortField(raw: string | null): SortField | null {
  return SORT_FIELDS.find((f) => f === raw) ?? null;
}

// `bd=ssc-small-mammal:order:rodentia` — narrows a node's species list to one
// breakdown row (see TaxaSummary.tsx's BreakdownList). nodeId:rank:name, colon-joined
// like the rest of the URL scheme. Carries its own nodeId (rather than always
// implicitly meaning "the selected subgroup") so RedListView can gate the filter on
// selectedSubgroups still containing that exact node — a stale bd= surviving into an
// unrelated group's view becomes inert instead of silently hiding all its species.
// An optional `:only:id1,id2` or `:excl:id1,id2` suffix further narrows to/away-from
// an explicit sis_taxon_id list (the "No CoL Match" / "CoL Match" split within one
// breakdown name's Assessed count).
export interface BreakdownParam {
  nodeId: string;
  rank: FilterRank;
  name: string;
  onlyIds?: number[];
  excludeIds?: number[];
}
/**
 * Parsed from the RIGHT, because the nodeId is the one field that can itself contain
 * the delimiter: a live-drilldown node id is `mammals~order:rodentia`, so
 * `bd=mammals~order:rodentia:family:Muridae` split left-to-right yields
 * nodeId="mammals~order", rank="rodentia" — not a rank, so the whole param was
 * rejected and the breakdown narrowing silently vanished, leaving the full node list.
 * (Static ids like `ssc-small-mammal` have no colon and always parsed fine, which is
 * why this survived: every curated breakdown row worked, only live-drilldown ones
 * didn't.)
 *
 * The tail is fixed-arity, so it can be peeled off unambiguously: an optional
 * `only|excl:<ids>` pair, then name, then rank — and whatever remains, colons and
 * all, is the nodeId. Deliberately fixed here rather than by making the writer emit
 * a colon-free node id: RedListView gates this filter on
 * `selectedSubgroups.has(breakdownFilter.nodeId)`, and selectedSubgroups holds
 * INTERNAL ids, so rewriting the nodeId to its URL-token form would make the filter
 * silently inert instead — the same failure with extra steps.
 */
const parseBreakdownParam = (p: URLSearchParams, key: string): BreakdownParam | null => {
  const raw = p.get(key);
  if (!raw) return null;
  const parts = raw.split(":");
  let mode: string | undefined;
  let idsCsv: string | undefined;
  // `:only:1,2` / `:excl:1,2` only exists alongside a nodeId+rank+name, so there are
  // at least 5 fields when present — which also stops a 3-field `nodeId:rank:name`
  // from mistaking its own rank for a mode.
  if (parts.length >= 5 && (parts[parts.length - 2] === "only" || parts[parts.length - 2] === "excl")) {
    idsCsv = parts.pop();
    mode = parts.pop();
  }
  const name = parts.pop();
  const rank = parts.pop();
  const nodeId = parts.join(":");
  if (!nodeId || !name || !FILTER_RANKS.includes(rank as FilterRank)) return null;
  const result: BreakdownParam = { nodeId, rank: rank as FilterRank, name };
  if (mode && idsCsv) {
    const ids = idsCsv.split(",").map(Number).filter((n) => !Number.isNaN(n));
    if (ids.length > 0) {
      if (mode === "only") result.onlyIds = ids;
      else result.excludeIds = ids;
    }
  }
  return result;
};

export function parseParams(search: string, suffix: string = "") {
  const p = new URLSearchParams(search);
  const k = (name: string) => paramKey(name, suffix);
  const sortParam = p.get(k("sort"));
  const viewParam = p.get(k("view"));
  const layoutParam = p.get(k("layout"));
  // A `region` param expands to its country codes (the dashboard has no separate
  // region state — it stores a region AS its countries and re-derives the chip).
  const countryCodes = new Set<string>(
    p.get(k("countries")) ? p.get(k("countries"))!.split(",").filter(Boolean) : []
  );
  if (p.get(k("region"))) {
    resolveRegions(p.get(k("region"))!.split(",").filter(Boolean)).codes.forEach((c) => countryCodes.add(c));
  }
  // Taxa: the URL carries a single flat `taxa` token list; expand each into the
  // internal display-root + (optional) sub-group. Legacy `subgroups=` links still
  // parse (their values are added directly, with the parent root ensured present).
  const taxaSet = new Set<string>();
  const subgroupSet = new Set<string>();
  for (const tok of p.get(k("taxa"))?.split(",").filter(Boolean) ?? []) {
    const { taxa, subgroup } = expandTaxaToken(tok);
    taxaSet.add(taxa);
    if (subgroup) subgroupSet.add(subgroup);
  }
  for (const sg of p.get(k("subgroups"))?.split(",").filter(Boolean) ?? []) {
    const id = canonicalizeTaxonId(sg);
    subgroupSet.add(id);
    const root = getViewRootForNode(id);
    if (root) taxaSet.add(root);
  }
  // A `col-…` species key IS a Not Evaluated species (assessed rows always key on
  // `sis-…` — see lib/species-row-key), so a link carrying one but no `view` can only
  // have meant the Not Evaluated list. Without this a hand-written or truncated
  // `?species=col-…` lands in the assessed list, which never contains that row, and
  // the panel silently never opens. `view` still wins when present, and is still
  // required on its own — it is the list's mode, and most URLs carry no species.
  const speciesKey = parseSpeciesParam(p.get(k("species")));
  const impliedView: ViewMode | null = speciesKey?.startsWith("col-") ? "new-assessments" : null;

  return {
    viewMode: (viewParam === "new-assessments" ? "new-assessments"
      : viewParam ? "reassessments"
      : impliedView ?? "reassessments") as ViewMode,
    layoutMode: (layoutParam === "table1a" || layoutParam === "ssc" || layoutParam === "country" ? layoutParam : null) as LayoutMode,
    // Remembers the layout mode a taxon drill-down exited FROM (see
    // exitCountryModeForTaxon) — survives even while layoutMode itself is
    // null/something-else, so "All Species" and the site logo's Home button
    // can jump back to Country View's landing page rather than the generic
    // default, and so that memory itself survives a reload/shared link
    // (page.tsx's Home handler reads this directly off the URL, outside this
    // hook entirely). Cleared wherever a new layoutMode is deliberately set
    // (setLayoutMode/navigateToTaxonSubgroup/returnToLayoutMode) — a fresh,
    // explicit mode choice overrides whatever "return to X" memory it held.
    originLayout: (p.get(k("origin")) === "table1a" || p.get(k("origin")) === "ssc" || p.get(k("origin")) === "country" ? p.get(k("origin")) : null) as LayoutMode,
    // Expanded from the flat `taxa` token list (+ legacy `subgroups=`) above.
    taxa: taxaSet,
    subgroups: subgroupSet,
    categories: p.get(k("categories"))
      ? new Set(p.get(k("categories"))!.split(",").filter(Boolean))
      : new Set<string>(),
    yearRanges: p.get(k("years"))
      ? new Set(p.get(k("years"))!.split(",").filter(Boolean))
      : new Set<string>(),
    assessmentYears: p.get(k("assessmentYears"))
      ? new Set(p.get(k("assessmentYears"))!.split(",").filter(Boolean))
      : new Set<string>(),
    // CoL description-year range buckets (NE/new-assessments view only).
    describedYears: p.get(k("describedYears"))
      ? new Set(p.get(k("describedYears"))!.split(",").filter(Boolean))
      : new Set<string>(),
    countries: countryCodes,
    obsRanges: p.get(k("obsRanges"))
      ? new Set(p.get(k("obsRanges"))!.split(",").filter(Boolean))
      : new Set<string>(),
    assessmentCounts: p.get(k("assessmentCounts"))
      ? new Set(p.get(k("assessmentCounts"))!.split(",").filter(Boolean))
      : new Set<string>(),
    systems: p.get(k("systems"))
      ? new Set(p.get(k("systems"))!.split(",").filter(Boolean))
      : new Set<string>(),
    populationTrends: p.get(k("trends"))
      ? new Set(p.get(k("trends"))!.split(",").filter(Boolean))
      : new Set<string>(),
    movementPatterns: p.get(k("movement"))
      ? new Set(p.get(k("movement"))!.split(",").filter(Boolean))
      : new Set<string>(),
    threats: p.get(k("threats"))
      ? new Set(p.get(k("threats"))!.split(",").filter(Boolean))
      : new Set<string>(),
    // Which species the threat axis covers. IUCN's own advice is that threat
    // coding is only reliable for threatened (CR/EN/VU) assessments, so
    // "threatened" is the DEFAULT and the param is only written to the URL for
    // the opt-out ("all"). Absent/unrecognised therefore means threatened.
    threatsScope: (p.get(k("threatsScope")) === "all" ? "all" : "threatened") as ThreatsScope,
    criteria: p.get(k("criteria"))
      ? new Set(p.get(k("criteria"))!.split(",").filter(Boolean))
      : new Set<string>(),
    // Catalogue of Life match state — "flagged" = no clean 1:1 CoL match (a
    // possible taxonomic revision since the assessment), "clean" = its mirror
    // image. Any other/missing value means no filter. colReasons narrows
    // "flagged" to specific reasons (see lib/col-revision.ts); it implies
    // flagged on its own, so the two are independent params, like
    // habitat/habitatBreadth.
    colMatch: (
      p.get(k("colMatch")) === "flagged" ? "flagged"
      : p.get(k("colMatch")) === "clean" ? "clean"
      : null
    ) as "flagged" | "clean" | null,
    colReasons: p.get(k("colReasons"))
      ? new Set(p.get(k("colReasons"))!.split(",").filter(Boolean))
      : new Set<string>(),
    habitat: p.get(k("habitat"))
      ? new Set(p.get(k("habitat"))!.split(",").filter(Boolean))
      : new Set<string>(),
    // Habitat breadth: "specialist" = exactly one known coarse habitat category,
    // "generalist" = two or more. Any other/missing value means no filter.
    habitatBreadth: (
      p.get(k("habitatBreadth")) === "specialist" ? "specialist"
      : p.get(k("habitatBreadth")) === "generalist" ? "generalist"
      : null
    ) as "specialist" | "generalist" | null,
    // Habitat importance: which importance values (Major/Not major/Unknown) count
    // as a match, scoped to the selected habitat (or any entry if none selected).
    // Defaults to all three checked (no filter) — the param is only present in the
    // URL once something's been unchecked, so its absence means "everything".
    habitatImportance: p.get(k("habitatImportance")) !== null
      ? new Set(p.get(k("habitatImportance"))!.split(",").filter(Boolean))
      : new Set<string>(ALL_HABITAT_IMPORTANCE),
    // Habitat seasons: same "defaults to all checked" shape as importance above.
    habitatSeasons: p.get(k("habitatSeasons")) !== null
      ? new Set(p.get(k("habitatSeasons"))!.split(",").filter(Boolean))
      : new Set<string>(ALL_HABITAT_SEASONS),
    // Habitat suitability: same "defaults to all checked" shape as importance above.
    habitatSuitability: p.get(k("habitatSuitability")) !== null
      ? new Set(p.get(k("habitatSuitability"))!.split(",").filter(Boolean))
      : new Set<string>(ALL_HABITAT_SUITABILITY),
    breakdown: parseBreakdownParam(p, k("bd")),
    // Endemics-only: restrict to species occurring in exactly one country.
    endemicsOnly: p.get(k("endemics")) === "1",
    growthForms: p.get(k("growthForms"))
      ? new Set(p.get(k("growthForms"))!.split(",").filter(Boolean))
      : new Set<string>(),
    assessors: p.get(k("assessors"))
      ? new Set(p.get(k("assessors"))!.split("|").filter(Boolean))
      : new Set<string>(),
    reviewers: p.get(k("reviewers"))
      ? new Set(p.get(k("reviewers"))!.split("|").filter(Boolean))
      : new Set<string>(),
    facilitators: p.get(k("facilitators"))
      ? new Set(p.get(k("facilitators"))!.split("|").filter(Boolean))
      : new Set<string>(),
    contributors: p.get(k("contributors"))
      ? new Set(p.get(k("contributors"))!.split("|").filter(Boolean))
      : new Set<string>(),
    institutions: p.get(k("institutions"))
      ? new Set(p.get(k("institutions"))!.split("|").filter(Boolean))
      : new Set<string>(),
    search: p.get(k("search")) || "",
    // Exact URL-only base filters (see ExactFilters).
    outdated: (p.get(k("outdated")) === "yes" ? "yes" : p.get(k("outdated")) === "no" ? "no" : null) as "yes" | "no" | null,
    minObs: numParam(p, k("minObs")),
    maxObs: numParam(p, k("maxObs")),
    minAssessmentYear: numParam(p, k("minAssessmentYear")),
    maxAssessmentYear: numParam(p, k("maxAssessmentYear")),
    minDescribedYear: numParam(p, k("minDescribedYear")),
    maxDescribedYear: numParam(p, k("maxDescribedYear")),
    sortField: parseSortField(sortParam),
    sortDirection: (p.get(k("dir")) === "asc" ? "asc" : "desc") as "asc" | "desc",
    // Secondary sort — applied within ties on the primary (shift/cmd-click a
    // second column header). Ignored when it names the same column as the
    // primary, which would be a no-op tiebreaker.
    sortField2: parseSortField(p.get(k("sort2"))),
    sortDirection2: (p.get(k("dir2")) === "asc" ? "asc" : "desc") as "asc" | "desc",
    mapViewMode: (p.get(k("mapview")) === "list" ? "list" : "map") as MapViewMode,
    mapSortKey: (
      p.get(k("mapsort")) === "name" ? "name" :
      p.get(k("mapsort")) === "outdated" ? "outdated" :
      p.get(k("mapsort")) === "percentOutdated" ? "percentOutdated" :
      "species"
    ) as MapSortKey,
    mapSortDirection: (p.get(k("mapdir")) === "asc" ? "asc" : "desc") as "asc" | "desc",
    // The row key, namespaced (`sis-…`/`col-…`). parseSpeciesParam also accepts the
    // pre-namespace bare-number form so existing links keep working — see its doc.
    species: speciesKey,
    tab: (p.get(k("tab")) || null) as DetailTabParam | null,
  };
}

/**
 * The species-scoped fields that a taxa / sub-group navigation drops.
 *
 * `species`/`tab` (the open detail panel) and `search` (the scientific name the
 * header search bar leaves behind when it jumps straight to one species) only
 * ever describe the taxon you were looking at when they were set. Clicking a
 * *different* taxa or sub-group row is a fresh browse, so carrying them over
 * strands the user on a one-row table for a species that isn't even in the
 * group they just clicked, with that species' detail panel still open below.
 * `breakdown` (bd=) is the same story one level further down.
 *
 * Spread into the same state update as the taxa/sub-group change (rather than
 * cleared by a follow-up setter) so the whole navigation stays one atomic
 * transition — one history entry, and no intermediate URL where the new taxon
 * and the old species coexist.
 */
export const SPECIES_SCOPED_RESET: Pick<
  ReturnType<typeof parseParams>,
  "search" | "species" | "tab" | "breakdown"
> = {
  search: "",
  species: null,
  tab: null,
  breakdown: null,
};

export function buildQs(state: {
  viewMode: ViewMode;
  layoutMode?: LayoutMode;
  originLayout?: LayoutMode;
  taxa: Set<string>;
  subgroups: Set<string>;
  categories: Set<string>;
  yearRanges: Set<string>;
  assessmentYears: Set<string>;
  describedYears: Set<string>;
  countries: Set<string>;
  obsRanges: Set<string>;
  assessmentCounts: Set<string>;
  systems: Set<string>;
  populationTrends: Set<string>;
  movementPatterns: Set<string>;
  threats: Set<string>;
  threatsScope?: ThreatsScope;
  criteria: Set<string>;
  colMatch?: "flagged" | "clean" | null;
  colReasons?: Set<string>;
  habitat: Set<string>;
  habitatBreadth: "specialist" | "generalist" | null;
  habitatImportance: Set<string>;
  habitatSeasons: Set<string>;
  habitatSuitability: Set<string>;
  breakdown?: BreakdownParam | null;
  endemicsOnly: boolean;
  growthForms: Set<string>;
  assessors: Set<string>;
  reviewers: Set<string>;
  /** Facilitator names — the individuals behind an organisational assessor. */
  facilitators: Set<string>;
  /** Contributor names — everyone credited without being assessor or reviewer. */
  contributors: Set<string>;
  /** Institution names — the organisation(s) behind the assessment. */
  institutions: Set<string>;
  search: string;
  outdated?: "yes" | "no" | null;
  minObs?: number | null;
  maxObs?: number | null;
  minAssessmentYear?: number | null;
  maxAssessmentYear?: number | null;
  minDescribedYear?: number | null;
  maxDescribedYear?: number | null;
  sortField: SortField | null;
  sortDirection: "asc" | "desc";
  sortField2: SortField | null;
  sortDirection2: "asc" | "desc";
  mapViewMode?: MapViewMode;
  mapSortKey?: MapSortKey;
  mapSortDirection?: "asc" | "desc";
  species: string | null;
  tab: DetailTabParam | null;
}, suffix: string = ""): string {
  const p = new URLSearchParams();
  const k = (name: string) => paramKey(name, suffix);
  if (state.viewMode === "new-assessments") p.set(k("view"), "new-assessments");
  if (state.layoutMode) p.set(k("layout"), state.layoutMode);
  if (state.originLayout) p.set(k("origin"), state.originLayout);
  // taxa + subgroups collapse to a single flat `taxa` token list (e.g.
  // invertebrates + inv-corals → taxa=corals); no separate subgroups param.
  const taxaTokens = collapseTaxaToTokens(state.taxa, state.subgroups);
  if (taxaTokens.length > 0) p.set(k("taxa"), taxaTokens.join(","));
  if (state.categories.size > 0) p.set(k("categories"), [...state.categories].join(","));
  if (state.yearRanges.size > 0) p.set(k("years"), [...state.yearRanges].join(","));
  if (state.assessmentYears.size > 0) p.set(k("assessmentYears"), [...state.assessmentYears].join(","));
  if (state.describedYears.size > 0) p.set(k("describedYears"), [...state.describedYears].join(","));
  if (state.countries.size > 0) p.set(k("countries"), [...state.countries].join(","));
  if (state.obsRanges.size > 0) p.set(k("obsRanges"), [...state.obsRanges].join(","));
  if (state.assessmentCounts.size > 0) p.set(k("assessmentCounts"), [...state.assessmentCounts].join(","));
  if (state.systems.size > 0) p.set(k("systems"), [...state.systems].join(","));
  if (state.populationTrends.size > 0) p.set(k("trends"), [...state.populationTrends].join(","));
  if (state.movementPatterns.size > 0) p.set(k("movement"), [...state.movementPatterns].join(","));
  if (state.threats.size > 0) p.set(k("threats"), [...state.threats].join(","));
  // Only the opt-out is written — "threatened" is the default (see parseParams).
  if (state.threatsScope === "all") p.set(k("threatsScope"), "all");
  if (state.criteria.size > 0) p.set(k("criteria"), [...state.criteria].join(","));
  if (state.colMatch) p.set(k("colMatch"), state.colMatch);
  if (state.colReasons && state.colReasons.size > 0) p.set(k("colReasons"), [...state.colReasons].join(","));
  if (state.habitat.size > 0) p.set(k("habitat"), [...state.habitat].join(","));
  if (state.habitatBreadth) p.set(k("habitatBreadth"), state.habitatBreadth);
  if (!setEqualsArray(state.habitatImportance, ALL_HABITAT_IMPORTANCE)) p.set(k("habitatImportance"), [...state.habitatImportance].join(","));
  if (!setEqualsArray(state.habitatSeasons, ALL_HABITAT_SEASONS)) p.set(k("habitatSeasons"), [...state.habitatSeasons].join(","));
  if (!setEqualsArray(state.habitatSuitability, ALL_HABITAT_SUITABILITY)) p.set(k("habitatSuitability"), [...state.habitatSuitability].join(","));
  if (state.breakdown) {
    let bd = `${state.breakdown.nodeId}:${state.breakdown.rank}:${state.breakdown.name}`;
    if (state.breakdown.onlyIds?.length) bd += `:only:${state.breakdown.onlyIds.join(",")}`;
    else if (state.breakdown.excludeIds?.length) bd += `:excl:${state.breakdown.excludeIds.join(",")}`;
    p.set(k("bd"), bd);
  }
  if (state.endemicsOnly) p.set(k("endemics"), "1");
  if (state.growthForms.size > 0) p.set(k("growthForms"), [...state.growthForms].join(","));
  if (state.assessors.size > 0) p.set(k("assessors"), [...state.assessors].join("|"));
  if (state.reviewers.size > 0) p.set(k("reviewers"), [...state.reviewers].join("|"));
  if (state.facilitators.size > 0) p.set(k("facilitators"), [...state.facilitators].join("|"));
  if (state.contributors.size > 0) p.set(k("contributors"), [...state.contributors].join("|"));
  if (state.institutions.size > 0) p.set(k("institutions"), [...state.institutions].join("|"));
  if (state.search) p.set(k("search"), state.search);
  if (state.outdated) p.set(k("outdated"), state.outdated);
  if (state.minObs != null) p.set(k("minObs"), String(state.minObs));
  if (state.maxObs != null) p.set(k("maxObs"), String(state.maxObs));
  if (state.minAssessmentYear != null) p.set(k("minAssessmentYear"), String(state.minAssessmentYear));
  if (state.maxAssessmentYear != null) p.set(k("maxAssessmentYear"), String(state.maxAssessmentYear));
  if (state.minDescribedYear != null) p.set(k("minDescribedYear"), String(state.minDescribedYear));
  if (state.maxDescribedYear != null) p.set(k("maxDescribedYear"), String(state.maxDescribedYear));
  if (state.species != null) p.set(k("species"), state.species);
  if (state.species != null && state.tab && state.tab !== "gbif") p.set(k("tab"), state.tab);
  // null / "year" desc is the default — only write non-default sort to URL
  const isDefaultSort = state.sortField === null || state.sortField === "year";
  if (!isDefaultSort) {
    p.set(k("sort"), state.sortField!);
    if (state.sortDirection !== "desc") p.set(k("dir"), state.sortDirection);
  } else if (state.sortDirection !== "desc") {
    p.set(k("dir"), state.sortDirection);
  }
  // Secondary sort is only meaningful alongside a primary that differs from it.
  if (state.sortField2 && state.sortField2 !== (state.sortField ?? "year")) {
    p.set(k("sort2"), state.sortField2);
    if (state.sortDirection2 !== "desc") p.set(k("dir2"), state.sortDirection2);
  }
  if (state.mapViewMode === "list") p.set(k("mapview"), "list");
  if (state.mapSortKey && state.mapSortKey !== "species") p.set(k("mapsort"), state.mapSortKey);
  if (state.mapSortDirection === "asc") p.set(k("mapdir"), "asc");
  const qs = prettifyQs(p.toString());
  return qs ? `?${qs}` : "";
}

export { prettifyQs };

// Pure merge: combines this instance's (suffixed) params into whatever's
// already present in `currentSearch`, rather than replacing the whole query
// string — so a second useFilterParams instance with a different paramSuffix
// (compare mode) can co-exist in the same URL, each only ever touching its
// own suffixed keys. Exported (and used by syncUrl below, its only caller)
// so this merge behavior — the actual novel logic here — is directly
// unit-testable rather than only reachable through the hook itself.
export function mergeParamsIntoSearch(
  currentSearch: string,
  newState: Parameters<typeof buildQs>[0],
  suffix: string
): string {
  const current = new URLSearchParams(currentSearch);
  for (const name of OWN_PARAM_NAMES) current.delete(paramKey(name, suffix));
  for (const [ownKey, value] of new URLSearchParams(buildQs(newState, suffix))) {
    current.set(ownKey, value);
  }
  const qs = prettifyQs(current.toString());
  return qs ? `?${qs}` : "";
}

/**
 * Hook that syncs filter state with URL search parameters,
 * enabling shareable/bookmarkable filtered views.
 *
 * Uses local useState for instant UI updates and native
 * history.replaceState/pushState to sync the URL — no Next.js
 * router overhead.
 *
 * Example URL: /?taxa=mammals&categories=CR,EN&years=11-20+years&search=shrew
 *
 * `paramSuffix` namespaces every URL param this hook reads/writes (e.g. "_b" turns
 * `taxa` into `taxa_b`), so a second, independently-filtered instance of this hook
 * can share one URL with the first (compare mode) without either clobbering the
 * other's params. Defaults to "" — identical to the single-dashboard behavior.
 */
export function useFilterParams(paramSuffix: string = "") {
  // Initialize with empty state (SSR-safe), hydrate from URL in effect
  const [state, setState] = useState(() => parseParams("", paramSuffix));

  // Tracks whether the most recent state update came from a popstate (URL navigation).
  // Consumers can check this to avoid clearing URL-driven state.
  const fromPopstateRef = useRef(false);

  // Hydrate from URL on mount + sync on popstate (back/forward button)
  useEffect(() => {
    fromPopstateRef.current = true;
    setState(parseParams(window.location.search, paramSuffix)); // eslint-disable-line react-hooks/set-state-in-effect -- hydrate from URL on mount
    const onPopState = () => {
      fromPopstateRef.current = true;
      setState(parseParams(window.location.search, paramSuffix));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [paramSuffix]);

  // Write URL silently (no Next.js navigation, no re-render loop). Merges this
  // instance's (suffixed) params into whatever's currently in the URL rather than
  // replacing the whole query string, so a second useFilterParams instance with a
  // different paramSuffix (compare mode) can co-exist in the same URL — each
  // instance only ever touches its own suffixed keys.
  const syncUrl = useCallback((newState: typeof state, push: boolean) => {
    const qs = mergeParamsIntoSearch(window.location.search, newState, paramSuffix);
    const url = window.location.pathname + qs;
    if (push) {
      window.history.pushState(null, "", url);
    } else {
      window.history.replaceState(null, "", url);
    }
  }, [paramSuffix]);

  // --- Setters: update local state instantly, sync URL in background ---

  const setSelectedTaxa = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextTaxa = typeof updater === "function" ? updater(prev.taxa) : updater;
        // An actual taxa change here is a fresh selection, so drop everything scoped
        // to the previous one (the open species panel, the header search bar's
        // `search=`, a stale bd=) rather than silently carrying it over — see
        // SPECIES_SCOPED_RESET. None of those are ever set via this setter: they
        // arrive by their own atomic URL push (SpeciesSearchBar, TaxaSummary.tsx's
        // navigateToNodeSpeciesList), read back through parseParams on popstate.
        // Guard on reference inequality (not just "this setter ran"): some callers
        // invoke this as a conditional no-op (e.g. the view-mode-switch effect's
        // `prev.has("all") ? new Set() : prev`), which must NOT clobber state a
        // same-tick popstate just set.
        const next = nextTaxa === prev.taxa ? { ...prev, taxa: nextTaxa } : { ...prev, taxa: nextTaxa, ...SPECIES_SCOPED_RESET };
        queueMicrotask(() => syncUrl(next, true)); // push so back button works
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedCategories = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextCats = typeof updater === "function" ? updater(prev.categories) : updater;
        const next = { ...prev, categories: nextCats };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedYearRanges = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextYears = typeof updater === "function" ? updater(prev.yearRanges) : updater;
        const next = { ...prev, yearRanges: nextYears };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedAssessmentYears = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextYears = typeof updater === "function" ? updater(prev.assessmentYears) : updater;
        const next = { ...prev, assessmentYears: nextYears };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedDescribedYears = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextYears = typeof updater === "function" ? updater(prev.describedYears) : updater;
        const next = { ...prev, describedYears: nextYears };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedCountries = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextCountries = typeof updater === "function" ? updater(prev.countries) : updater;
        const next = { ...prev, countries: nextCountries };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedObsRanges = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextObsRanges = typeof updater === "function" ? updater(prev.obsRanges) : updater;
        const next = { ...prev, obsRanges: nextObsRanges };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedAssessmentCounts = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextAssessmentCounts = typeof updater === "function" ? updater(prev.assessmentCounts) : updater;
        const next = { ...prev, assessmentCounts: nextAssessmentCounts };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedSubgroups = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextSubgroups = typeof updater === "function" ? updater(prev.subgroups) : updater;
        // See setSelectedTaxa above — drop the previous selection's species/search/bd=
        // on an actual subgroup change, but not on a same-reference no-op.
        const next = nextSubgroups === prev.subgroups ? { ...prev, subgroups: nextSubgroups } : { ...prev, subgroups: nextSubgroups, ...SPECIES_SCOPED_RESET };
        queueMicrotask(() => syncUrl(next, true));
        return next;
      });
    },
    [syncUrl]
  );

  const setLayoutMode = useCallback(
    (mode: LayoutMode) => {
      setState(prev => {
        // A deliberate, explicit mode choice overrides any "return to X"
        // memory exitCountryModeForTaxon left behind — see originLayout's doc.
        const next = { ...prev, layoutMode: mode, originLayout: null as LayoutMode };
        queueMicrotask(() => syncUrl(next, true)); // push so back button exits the mode
        return next;
      });
    },
    [syncUrl]
  );

  // Atomic taxon + sub-group navigation (used by Table 1a / SSC groups mode
  // click-through). A single setState + single history push, so one back-press
  // undoes the whole navigation instead of unwinding it one field at a time —
  // and clearing layoutMode in the same update means back lands on the flat
  // table the group was drilled into from, not a half-updated intermediate.
  const navigateToTaxonSubgroup = useCallback(
    (taxonId: string, subgroupId: string) => {
      setState(prev => {
        const next = { ...prev, taxa: new Set([taxonId]), subgroups: new Set([subgroupId]), layoutMode: null, originLayout: null as LayoutMode, ...SPECIES_SCOPED_RESET };
        queueMicrotask(() => syncUrl(next, true));
        return next;
      });
    },
    [syncUrl]
  );

  // Exits Country View to the full charts+species-table view when a taxon's
  // clicked from the country-scoped landing/list (see RedListView's
  // handleToggleTaxon) — atomic (one setState + one history push), same
  // reasoning as navigateToTaxonSubgroup above: without this, layoutMode and
  // taxa/subgroups would each get their own history entry, so a single
  // "back" press would land on some half-updated intermediate (e.g.
  // layoutMode cleared but taxa not yet set) instead of cleanly restoring
  // the Country View landing page. countries is deliberately left untouched
  // — the taxon drill-down stays scoped to whatever was selected. Also
  // records originLayout: "country" — layoutMode itself is about to go
  // null, so without this nothing durable remembers we came from Country
  // View. RedListView's "All Species" row (and the site logo's Home button,
  // reading straight off the URL) use this to jump back to that landing
  // page instead of the generic default view.
  const exitCountryModeForTaxon = useCallback(
    (taxonId: string) => {
      setState(prev => {
        const next = { ...prev, taxa: new Set([taxonId]), subgroups: new Set<string>(), layoutMode: null as LayoutMode, originLayout: "country" as LayoutMode, ...SPECIES_SCOPED_RESET };
        queueMicrotask(() => syncUrl(next, true));
        return next;
      });
    },
    [syncUrl]
  );

  // Reverse of navigateToTaxonSubgroup — clears taxa/subgroups back to the
  // landing page and re-enters a flat-table layout mode, atomically (one
  // history push). Used when clicking the "Mammals" ancestor row after
  // drilling out of SSC groups mode should return to that table instead of
  // falling through to the plain taxon tree view, and (passing "country")
  // by RedListView's "All Species" row to consume an originLayout memory
  // left by exitCountryModeForTaxon and land back on Country View properly.
  const returnToLayoutMode = useCallback(
    (mode: LayoutMode) => {
      setState(prev => {
        const next = { ...prev, taxa: new Set<string>(), subgroups: new Set<string>(), layoutMode: mode, originLayout: null as LayoutMode, ...SPECIES_SCOPED_RESET };
        queueMicrotask(() => syncUrl(next, true));
        return next;
      });
    },
    [syncUrl]
  );

  // Select country/countries from the Country view landing page — a single
  // setState + history push (see navigateToTaxonSubgroup above for why atomic
  // matters here too). Accepts either a plain Set (replace) or an updater
  // function (toggle-in-place), the same shape setSelectedCountries takes, so
  // RedListView's click handler can implement the normal plain-click-replaces/
  // ctrl-click-toggles gesture for a single country, a whole region, or an
  // arbitrary multi-select — this just guarantees the country change stays
  // atomic with clearing taxa/subgroups, whichever shape the update takes.
  // Deliberately leaves layoutMode untouched (stays "country"): the promoted
  // map and the bare taxa summary table (All Species, Mammals, ..., Fungi)
  // show together, scoped to however many countries are now selected, until
  // the user clicks an actual taxon row (handleToggleTaxon, in RedListView) —
  // that's what exits to the full charts+species-table view, still scoped the
  // same way.
  //
  // Sets fromPopstateRef true first: RedListView's own "reset all other filters
  // when taxa selection changes" effect (it watches selectedTaxa transitioning
  // non-empty→non-empty/empty to drop stale category/year/etc. filters from
  // whatever was previously browsed) would otherwise fire right after this
  // non-empty→empty taxa change and immediately clear the `countries` this very
  // call just set — the ref is the same "this is one atomic, fully-specified
  // state transition, don't run the generic per-field reset side effect"
  // escape hatch real popstate restores already rely on.
  const enterCountryDrilldown = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      fromPopstateRef.current = true;
      setState(prev => {
        const nextCountries = typeof updater === "function" ? updater(prev.countries) : updater;
        const next = { ...prev, countries: nextCountries, taxa: new Set<string>(), subgroups: new Set<string>(), ...SPECIES_SCOPED_RESET };
        queueMicrotask(() => syncUrl(next, true));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedSystems = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextSystems = typeof updater === "function" ? updater(prev.systems) : updater;
        const next = { ...prev, systems: nextSystems };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedPopulationTrends = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.populationTrends) : updater;
        const next = { ...prev, populationTrends: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedMovementPatterns = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.movementPatterns) : updater;
        const next = { ...prev, movementPatterns: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedThreats = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.threats) : updater;
        const next = { ...prev, threats: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setThreatsScope = useCallback(
    (value: ThreatsScope) => {
      setState(prev => {
        const next = { ...prev, threatsScope: value };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedCriteria = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.criteria) : updater;
        const next = { ...prev, criteria: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setColMatch = useCallback(
    (value: "flagged" | "clean" | null) => {
      setState(prev => {
        // Leaving the flagged bucket makes a reason narrowing meaningless, so
        // clear it rather than leaving an invisible filter behind a toggle the
        // user just switched off.
        const next = { ...prev, colMatch: value, colReasons: value === "flagged" ? prev.colReasons : new Set<string>() };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setColReasons = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.colReasons) : updater;
        const next = { ...prev, colReasons: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedHabitat = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.habitat) : updater;
        const next = { ...prev, habitat: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setHabitatBreadth = useCallback(
    (value: "specialist" | "generalist" | null) => {
      setState(prev => {
        const next = { ...prev, habitatBreadth: value };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedHabitatImportance = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.habitatImportance) : updater;
        const next = { ...prev, habitatImportance: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedHabitatSeasons = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.habitatSeasons) : updater;
        const next = { ...prev, habitatSeasons: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedHabitatSuitability = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.habitatSuitability) : updater;
        const next = { ...prev, habitatSuitability: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedGrowthForms = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextVal = typeof updater === "function" ? updater(prev.growthForms) : updater;
        const next = { ...prev, growthForms: nextVal };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setBreakdownFilter = useCallback(
    (value: BreakdownParam | null) => {
      setState(prev => {
        const next = { ...prev, breakdown: value };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setEndemicsOnly = useCallback(
    (value: boolean) => {
      setState(prev => {
        const next = { ...prev, endemicsOnly: value };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedAssessors = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextAssessors = typeof updater === "function" ? updater(prev.assessors) : updater;
        const next = { ...prev, assessors: nextAssessors };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedReviewers = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextReviewers = typeof updater === "function" ? updater(prev.reviewers) : updater;
        const next = { ...prev, reviewers: nextReviewers };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedFacilitators = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextFacilitators = typeof updater === "function" ? updater(prev.facilitators) : updater;
        const next = { ...prev, facilitators: nextFacilitators };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedContributors = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextContributors = typeof updater === "function" ? updater(prev.contributors) : updater;
        const next = { ...prev, contributors: nextContributors };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSelectedInstitutions = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextInstitutions = typeof updater === "function" ? updater(prev.institutions) : updater;
        const next = { ...prev, institutions: nextInstitutions };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSearchFilter = useCallback(
    (value: string) => {
      setState(prev => {
        const next = { ...prev, search: value };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  // Stable identity (keyed on the 7 primitive fields) so consumers can use it as a
  // memo/effect dep without recomputing every render.
  const exactFilters = useMemo<ExactFilters>(() => ({
    outdated: state.outdated,
    minObs: state.minObs,
    maxObs: state.maxObs,
    minAssessmentYear: state.minAssessmentYear,
    maxAssessmentYear: state.maxAssessmentYear,
    minDescribedYear: state.minDescribedYear,
    maxDescribedYear: state.maxDescribedYear,
  }), [state.outdated, state.minObs, state.maxObs, state.minAssessmentYear, state.maxAssessmentYear, state.minDescribedYear, state.maxDescribedYear]);

  // Patch one or more exact URL-only filters (outdated / obs / year bounds).
  const setExactFilters = useCallback(
    (patch: Partial<ExactFilters>) => {
      setState(prev => {
        const next = { ...prev, ...patch };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setState(prev => {
        const next = { ...prev, viewMode: mode };
        queueMicrotask(() => syncUrl(next, true));
        return next;
      });
    },
    [syncUrl]
  );

  const setSort = useCallback(
    (field: SortField | null, direction: "asc" | "desc") => {
      setState(prev => {
        const next = { ...prev, sortField: field, sortDirection: direction };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSort2 = useCallback(
    (field: SortField | null, direction: "asc" | "desc") => {
      setState(prev => {
        const next = { ...prev, sortField2: field, sortDirection2: direction };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setMapViewMode = useCallback(
    (mode: MapViewMode) => {
      setState(prev => {
        const next = { ...prev, mapViewMode: mode };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setMapSort = useCallback(
    (key: MapSortKey, direction: "asc" | "desc") => {
      setState(prev => {
        const next = { ...prev, mapSortKey: key, mapSortDirection: direction };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setSpeciesParam = useCallback(
    (species: string | null, tab: DetailTabParam = "gbif") => {
      setState(prev => {
        const next = { ...prev, species, tab: species != null ? tab : null };
        queueMicrotask(() => syncUrl(next, true));
        return next;
      });
    },
    [syncUrl]
  );

  const setTabParam = useCallback(
    (tab: DetailTabParam) => {
      setState(prev => {
        if (prev.species == null) return prev; // no species selected, nothing to update
        const next = { ...prev, tab };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const clearAllFilters = useCallback(() => {
    setState(prev => {
      const next = {
        ...prev,
        subgroups: new Set<string>(),
        categories: new Set<string>(),
        yearRanges: new Set<string>(),
        assessmentYears: new Set<string>(),
        describedYears: new Set<string>(),
        countries: new Set<string>(),
        obsRanges: new Set<string>(),
        assessmentCounts: new Set<string>(),
        systems: new Set<string>(),
        populationTrends: new Set<string>(),
        movementPatterns: new Set<string>(),
        threats: new Set<string>(),
        threatsScope: "threatened" as ThreatsScope,
        criteria: new Set<string>(),
        colMatch: null,
        colReasons: new Set<string>(),
        habitat: new Set<string>(),
        habitatBreadth: null,
        habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
        habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
        habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
        breakdown: null,
        endemicsOnly: false,
        growthForms: new Set<string>(),
        assessors: new Set<string>(),
        reviewers: new Set<string>(),
        facilitators: new Set<string>(),
        contributors: new Set<string>(),
        institutions: new Set<string>(),
        search: "",
        ...EMPTY_EXACT_FILTERS,
        sortField: null,
        sortDirection: "desc" as const,
        sortField2: null,
        sortDirection2: "desc" as const,
        species: null,
        tab: null,
      };
      queueMicrotask(() => syncUrl(next, false));
      return next;
    });
  }, [syncUrl]);

  const clearAllFiltersAndTaxa = useCallback(() => {
    setState(prev => {
      const next = {
        ...prev,
        taxa: new Set<string>(),
        subgroups: new Set<string>(),
        categories: new Set<string>(),
        yearRanges: new Set<string>(),
        assessmentYears: new Set<string>(),
        describedYears: new Set<string>(),
        countries: new Set<string>(),
        obsRanges: new Set<string>(),
        assessmentCounts: new Set<string>(),
        systems: new Set<string>(),
        populationTrends: new Set<string>(),
        movementPatterns: new Set<string>(),
        threats: new Set<string>(),
        threatsScope: "threatened" as ThreatsScope,
        criteria: new Set<string>(),
        colMatch: null,
        colReasons: new Set<string>(),
        habitat: new Set<string>(),
        habitatBreadth: null,
        habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
        habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
        habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
        breakdown: null,
        endemicsOnly: false,
        growthForms: new Set<string>(),
        assessors: new Set<string>(),
        reviewers: new Set<string>(),
        facilitators: new Set<string>(),
        contributors: new Set<string>(),
        institutions: new Set<string>(),
        search: "",
        ...EMPTY_EXACT_FILTERS,
        sortField: null,
        sortDirection: "desc" as const,
        sortField2: null,
        sortDirection2: "desc" as const,
        species: null,
        tab: null,
      };
      queueMicrotask(() => syncUrl(next, true));
      return next;
    });
  }, [syncUrl]);

  return {
    viewMode: state.viewMode,
    layoutMode: state.layoutMode,
    originLayout: state.originLayout,
    selectedTaxa: state.taxa,
    selectedSubgroups: state.subgroups,
    selectedCategories: state.categories,
    selectedYearRanges: state.yearRanges,
    selectedAssessmentYears: state.assessmentYears,
    selectedDescribedYears: state.describedYears,
    selectedCountries: state.countries,
    selectedObsRanges: state.obsRanges,
    selectedAssessmentCounts: state.assessmentCounts,
    selectedSystems: state.systems,
    selectedPopulationTrends: state.populationTrends,
    selectedMovementPatterns: state.movementPatterns,
    selectedThreats: state.threats,
    threatsScope: state.threatsScope,
    selectedCriteria: state.criteria,
    colMatch: state.colMatch,
    selectedColReasons: state.colReasons,
    selectedHabitat: state.habitat,
    habitatBreadth: state.habitatBreadth,
    selectedHabitatImportance: state.habitatImportance,
    selectedHabitatSeasons: state.habitatSeasons,
    selectedHabitatSuitability: state.habitatSuitability,
    breakdownFilter: state.breakdown,
    endemicsOnly: state.endemicsOnly,
    selectedGrowthForms: state.growthForms,
    selectedAssessors: state.assessors,
    selectedReviewers: state.reviewers,
    selectedFacilitators: state.facilitators,
    selectedContributors: state.contributors,
    selectedInstitutions: state.institutions,
    searchFilter: state.search,
    exactFilters,
    setExactFilters,
    sortField: state.sortField,
    sortDirection: state.sortDirection,
    sortField2: state.sortField2,
    sortDirection2: state.sortDirection2,
    mapViewMode: state.mapViewMode,
    mapSortKey: state.mapSortKey,
    mapSortDirection: state.mapSortDirection,

    setColMatch,
    setColReasons,
    setViewMode,
    setLayoutMode,
    navigateToTaxonSubgroup,
    exitCountryModeForTaxon,
    returnToLayoutMode,
    enterCountryDrilldown,
    setSelectedTaxa,
    setSelectedSubgroups,
    setSelectedCategories,
    setSelectedYearRanges,
    setSelectedAssessmentYears,
    setSelectedDescribedYears,
    setSelectedCountries,
    setSelectedObsRanges,
    setSelectedAssessmentCounts,
    setSelectedSystems,
    setSelectedPopulationTrends,
    setSelectedMovementPatterns,
    setSelectedThreats,
    setThreatsScope,
    setSelectedCriteria,
    setSelectedHabitat,
    setHabitatBreadth,
    setSelectedHabitatImportance,
    setSelectedHabitatSeasons,
    setSelectedHabitatSuitability,
    setBreakdownFilter,
    setEndemicsOnly,
    setSelectedGrowthForms,
    setSelectedAssessors,
    setSelectedReviewers,
    setSelectedFacilitators,
    setSelectedContributors,
    setSelectedInstitutions,
    setSearchFilter,
    setSort,
    setSort2,
    setMapViewMode,
    setMapSort,
    fromPopstateRef,
    clearAllFilters,
    clearAllFiltersAndTaxa,
    species: state.species,
    tab: state.tab,
    setSpeciesParam,
    setTabParam,
  };
}
