"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { canonicalizeTaxonId } from "@/lib/data/taxonomy-constants";
import { resolveRegions } from "@/lib/regions";
import { expandTaxaToken, collapseTaxaToTokens, getViewRootForNode, type FilterRank } from "@/lib/taxonomy-utils";
import { ALL_HABITAT_SEASONS, ALL_HABITAT_IMPORTANCE, ALL_HABITAT_SUITABILITY } from "@/lib/habitat-filter";
import { parseSpeciesParam } from "@/lib/species-row-key";
import { prettifyQs } from "@/lib/query-string";
import { primeFilterBaseline, reportFilterUsage } from "@/lib/analytics/events";
import { DEFAULT_GBIF_RECORD_MODE, GBIF_RECORDS_PARAM, parseGbifRecordMode, type GbifRecordMode, GBIF_RANGE_KEYS, GBIF_RANGE_PARAM, GBIF_CHART_PARAM, DEFAULT_GBIF_CHART_KEY, emptyGbifRanges, parseGbifChartKey, type GbifRangeKey, type GbifRanges } from "@/lib/gbif-records";

// Both habitat checkbox-dropdowns (Importance, Season) default to "everything
// checked" (nothing excluded) rather than "nothing checked" — see
// habitat-filter.ts's isRestrictiveSelection for why an empty selection and a
// full one are treated the same. A set-equality helper lets buildQs omit the
// param entirely at the default, instead of writing out every value.
const setEqualsArray = (a: Set<string>, b: string[]): boolean => a.size === b.length && b.every(v => a.has(v));

// --- URL parsing helpers ---

export type ViewMode = "reassessments" | "new-assessments";

// Flat-table layout ("Table 1a mode" / "SSC groups mode") plus the landing-page
// view that scopes the taxa tree to a slice of species rather than re-arranging
// it: "country" — URL-synced so they survive reload/share and so the browser
// back button can return to them after drilling into a group (see
// navigateToTaxonSubgroup below) or a country (see enterCountryDrilldown).
export type LayoutMode = "table1a" | "ssc" | "country" | null;

// Every layout mode that isn't the default taxonomic table. Kept as one list so
// adding a mode doesn't mean remembering to widen two separate parse sites
// (layout= and origin=) that would otherwise silently drop the new value.
const LAYOUT_MODES = ["table1a", "ssc", "country"] as const;

function parseLayoutMode(value: string | null): LayoutMode {
  return value && (LAYOUT_MODES as readonly string[]).includes(value) ? (value as LayoutMode) : null;
}

// The layout mode that scopes the taxa tree to a subset of species (as opposed
// to re-arranging the whole tree, like Table 1a/SSC): it lands on a chooser
// first and drills into the taxa table once a selection is made, with
// TaxaSummary's scoped-fetch/hidden-column handling.
export function isScopeLayout(mode: LayoutMode): mode is "country" {
  return mode === "country";
}

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

// The Outdated toggle (`outdated=yes`), kept apart from the bucketed year
// filters because it's a single cutoff rather than a set of buckets. `no` (only
// species assessed within 10 years) has no control but a link can carry it.
export interface ExactFilters {
  outdated: "yes" | "no" | null;
}

export const EMPTY_EXACT_FILTERS: ExactFilters = {
  outdated: null,
};

const FILTER_RANKS: FilterRank[] = ["class", "order", "family", "genus", "species"];

// The full set of param names this hook reads/writes — used by syncUrl to know
// which keys in the URL belong to it, so it can merge its own writes into the
// URL without clobbering params it doesn't own (utm_* and the like). Keep in
// sync with parseParams/buildQs below. Exported so tests can assert this list
// actually tracks every key parseParams/buildQs read or write — otherwise a
// future param added to one but not the other would linger in the URL after
// being cleared, with nothing catching it (see filterParams.test.ts's
// "OWN_PARAM_NAMES stays in sync" test).
export const OWN_PARAM_NAMES = [
  "view", "layout", "origin", "countries", "region", "taxa", "subgroups",
  "categories", "years", "assessmentYears", "describedYears", "assessmentCounts",
  "systems", "trends", "movement", "threats", "threatsScope", "criteria", "habitat", "habitatBreadth",
  "habitatImportance", "habitatSeasons", "habitatSuitability", "bd", "endemics", "growthForms",
  "colMatch", "colReasons",
  "assessors", "reviewers", "facilitators", "contributors", "institutions",
  "search", "outdated",
  "species", "tab", "sort", "dir", "sort2", "dir2", "mapview", "mapsort", "mapdir",
  GBIF_RECORDS_PARAM, GBIF_CHART_PARAM,
  ...Object.values(GBIF_RANGE_PARAM),
  "triage", "triageY",
];

/**
 * The Reassessment Triage scatter's box selection, in its plot units:
 * [x0, x1] along its x axis, [y0, y1] up its y (log10(count + 1), or %), for
 * the y metric in `triageY`. A filter like any other (`triage=`); the species
 * it holds are re-derived from the data, so a link selects the same dots.
 */
export type TriageBox = [x0: number, x1: number, y0: number, y1: number];

function parseTriageBox(v: string | null): TriageBox | null {
  const n = v?.split(",").map(Number);
  return n && n.length === 4 && n.every(Number.isFinite) && n[0] < n[1] && n[2] < n[3] ? (n as TriageBox) : null;
}

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

export function parseParams(search: string) {
  const p = new URLSearchParams(search);
  const sortParam = p.get("sort");
  const viewParam = p.get("view");
  const layoutParam = p.get("layout");
  // A `region` param expands to its country codes (the dashboard has no separate
  // region state — it stores a region AS its countries and re-derives the chip).
  const countryCodes = new Set<string>(
    p.get("countries") ? p.get("countries")!.split(",").filter(Boolean) : []
  );
  if (p.get("region")) {
    resolveRegions(p.get("region")!.split(",").filter(Boolean)).codes.forEach((c) => countryCodes.add(c));
  }
  // Taxa: the URL carries a single flat `taxa` token list; expand each into the
  // internal display-root + (optional) sub-group. Legacy `subgroups=` links still
  // parse (their values are added directly, with the parent root ensured present).
  const taxaSet = new Set<string>();
  const subgroupSet = new Set<string>();
  for (const tok of p.get("taxa")?.split(",").filter(Boolean) ?? []) {
    const { taxa, subgroup } = expandTaxaToken(tok);
    taxaSet.add(taxa);
    if (subgroup) subgroupSet.add(subgroup);
  }
  for (const sg of p.get("subgroups")?.split(",").filter(Boolean) ?? []) {
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
  const speciesKey = parseSpeciesParam(p.get("species"));
  const impliedView: ViewMode | null = speciesKey?.startsWith("col-") ? "new-assessments" : null;

  return {
    viewMode: (viewParam === "new-assessments" ? "new-assessments"
      : viewParam ? "reassessments"
      : impliedView ?? "reassessments") as ViewMode,
    layoutMode: parseLayoutMode(layoutParam),
    // Remembers the layout mode a taxon drill-down exited FROM (see
    // exitLayoutModeForTaxon) — survives even while layoutMode itself is
    // null/something-else, so "All Species" and the site logo's Home button
    // can jump back to Country View's landing page rather than the generic
    // default, and so that memory itself survives a reload/shared link
    // (page.tsx's Home handler reads this directly off the URL, outside this
    // hook entirely). Cleared wherever a new layoutMode is deliberately set
    // (setLayoutMode/navigateToTaxonSubgroup/returnToLayoutMode) — a fresh,
    // explicit mode choice overrides whatever "return to X" memory it held.
    originLayout: parseLayoutMode(p.get("origin")),
    // Expanded from the flat `taxa` token list (+ legacy `subgroups=`) above.
    taxa: taxaSet,
    subgroups: subgroupSet,
    categories: p.get("categories")
      ? new Set(p.get("categories")!.split(",").filter(Boolean))
      : new Set<string>(),
    yearRanges: p.get("years")
      ? new Set(p.get("years")!.split(",").filter(Boolean))
      : new Set<string>(),
    assessmentYears: p.get("assessmentYears")
      ? new Set(p.get("assessmentYears")!.split(",").filter(Boolean))
      : new Set<string>(),
    // CoL description-year range buckets (NE/new-assessments view only).
    describedYears: p.get("describedYears")
      ? new Set(p.get("describedYears")!.split(",").filter(Boolean))
      : new Set<string>(),
    countries: countryCodes,
    // The GBIF Records chart's six selections (Total / New / % New, each all
    // records or georeferenced), one URL parameter each; see gbif-records.ts.
    gbifRanges: Object.fromEntries(GBIF_RANGE_KEYS.map((key) => {
      const v = p.get(GBIF_RANGE_PARAM[key]);
      return [key, v ? new Set(v.split(",").filter(Boolean)) : new Set<string>()];
    })) as GbifRanges,
    assessmentCounts: p.get("assessmentCounts")
      ? new Set(p.get("assessmentCounts")!.split(",").filter(Boolean))
      : new Set<string>(),
    systems: p.get("systems")
      ? new Set(p.get("systems")!.split(",").filter(Boolean))
      : new Set<string>(),
    populationTrends: p.get("trends")
      ? new Set(p.get("trends")!.split(",").filter(Boolean))
      : new Set<string>(),
    movementPatterns: p.get("movement")
      ? new Set(p.get("movement")!.split(",").filter(Boolean))
      : new Set<string>(),
    threats: p.get("threats")
      ? new Set(p.get("threats")!.split(",").filter(Boolean))
      : new Set<string>(),
    // Which species the threat axis covers. IUCN's own advice is that threat
    // coding is only reliable for threatened (CR/EN/VU) assessments, so
    // "threatened" is the DEFAULT and the param is only written to the URL for
    // the opt-out ("all"). Absent/unrecognised therefore means threatened.
    threatsScope: (p.get("threatsScope") === "all" ? "all" : "threatened") as ThreatsScope,
    criteria: p.get("criteria")
      ? new Set(p.get("criteria")!.split(",").filter(Boolean))
      : new Set<string>(),
    // Catalogue of Life match state — "flagged" = no clean 1:1 CoL match (a
    // possible taxonomic revision since the assessment), "clean" = its mirror
    // image. Any other/missing value means no filter. colReasons narrows
    // "flagged" to specific reasons (see lib/col-revision.ts); it implies
    // flagged on its own, so the two are independent params, like
    // habitat/habitatBreadth.
    colMatch: (
      p.get("colMatch") === "flagged" ? "flagged"
      : p.get("colMatch") === "clean" ? "clean"
      : null
    ) as "flagged" | "clean" | null,
    colReasons: p.get("colReasons")
      ? new Set(p.get("colReasons")!.split(",").filter(Boolean))
      : new Set<string>(),
    habitat: p.get("habitat")
      ? new Set(p.get("habitat")!.split(",").filter(Boolean))
      : new Set<string>(),
    // Habitat breadth: "specialist" = exactly one known coarse habitat category,
    // "generalist" = two or more. Any other/missing value means no filter.
    habitatBreadth: (
      p.get("habitatBreadth") === "specialist" ? "specialist"
      : p.get("habitatBreadth") === "generalist" ? "generalist"
      : null
    ) as "specialist" | "generalist" | null,
    // Habitat importance: which importance values (Major/Not major/Unknown) count
    // as a match, scoped to the selected habitat (or any entry if none selected).
    // Defaults to all three checked (no filter) — the param is only present in the
    // URL once something's been unchecked, so its absence means "everything".
    habitatImportance: p.get("habitatImportance") !== null
      ? new Set(p.get("habitatImportance")!.split(",").filter(Boolean))
      : new Set<string>(ALL_HABITAT_IMPORTANCE),
    // Habitat seasons: same "defaults to all checked" shape as importance above.
    habitatSeasons: p.get("habitatSeasons") !== null
      ? new Set(p.get("habitatSeasons")!.split(",").filter(Boolean))
      : new Set<string>(ALL_HABITAT_SEASONS),
    // Habitat suitability: same "defaults to all checked" shape as importance above.
    habitatSuitability: p.get("habitatSuitability") !== null
      ? new Set(p.get("habitatSuitability")!.split(",").filter(Boolean))
      : new Set<string>(ALL_HABITAT_SUITABILITY),
    breakdown: parseBreakdownParam(p, "bd"),
    // Endemics-only: restrict to species occurring in exactly one country.
    endemicsOnly: p.get("endemics") === "1",
    growthForms: p.get("growthForms")
      ? new Set(p.get("growthForms")!.split(",").filter(Boolean))
      : new Set<string>(),
    assessors: p.get("assessors")
      ? new Set(p.get("assessors")!.split("|").filter(Boolean))
      : new Set<string>(),
    reviewers: p.get("reviewers")
      ? new Set(p.get("reviewers")!.split("|").filter(Boolean))
      : new Set<string>(),
    facilitators: p.get("facilitators")
      ? new Set(p.get("facilitators")!.split("|").filter(Boolean))
      : new Set<string>(),
    contributors: p.get("contributors")
      ? new Set(p.get("contributors")!.split("|").filter(Boolean))
      : new Set<string>(),
    institutions: p.get("institutions")
      ? new Set(p.get("institutions")!.split("|").filter(Boolean))
      : new Set<string>(),
    search: p.get("search") || "",
    // The Outdated toggle (see ExactFilters).
    outdated: (p.get("outdated") === "yes" ? "yes" : p.get("outdated") === "no" ? "no" : null) as "yes" | "no" | null,
    sortField: parseSortField(sortParam),
    sortDirection: (p.get("dir") === "asc" ? "asc" : "desc") as "asc" | "desc",
    // Secondary sort — applied within ties on the primary (shift/cmd-click a
    // second column header). Ignored when it names the same column as the
    // primary, which would be a no-op tiebreaker.
    sortField2: parseSortField(p.get("sort2")),
    sortDirection2: (p.get("dir2") === "asc" ? "asc" : "desc") as "asc" | "desc",
    mapViewMode: (p.get("mapview") === "list" ? "list" : "map") as MapViewMode,
    // Which GBIF records every count counts (georeferenced, the default, or all).
    // A measure rather than a filter, so clearing filters leaves it alone.
    gbifRecordMode: parseGbifRecordMode(p.get(GBIF_RECORDS_PARAM)),
    // Which of the six the GBIF Records chart shows (a display choice, like mapview).
    gbifChartKey: parseGbifChartKey(p.get(GBIF_CHART_PARAM)),
    triageBox: parseTriageBox(p.get("triage")),
    // The triage scatter's y metric (a display choice, like gbifChart); null = its default, New.
    triageY: (GBIF_RANGE_KEYS as readonly string[]).includes(p.get("triageY") ?? "") ? (p.get("triageY") as GbifRangeKey) : null,
    mapSortKey: (
      p.get("mapsort") === "name" ? "name" :
      p.get("mapsort") === "outdated" ? "outdated" :
      p.get("mapsort") === "percentOutdated" ? "percentOutdated" :
      "species"
    ) as MapSortKey,
    mapSortDirection: (p.get("mapdir") === "asc" ? "asc" : "desc") as "asc" | "desc",
    // The row key, namespaced (`sis-…`/`col-…`). parseSpeciesParam also accepts the
    // pre-namespace bare-number form so existing links keep working — see its doc.
    species: speciesKey,
    tab: (p.get("tab") || null) as DetailTabParam | null,
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
  gbifRanges: GbifRanges;
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
  sortField: SortField | null;
  sortDirection: "asc" | "desc";
  sortField2: SortField | null;
  sortDirection2: "asc" | "desc";
  mapViewMode?: MapViewMode;
  gbifRecordMode?: GbifRecordMode;
  gbifChartKey?: GbifRangeKey;
  triageBox?: TriageBox | null;
  triageY?: GbifRangeKey | null;
  mapSortKey?: MapSortKey;
  mapSortDirection?: "asc" | "desc";
  species: string | null;
  tab: DetailTabParam | null;
}): string {
  const p = new URLSearchParams();
  if (state.viewMode === "new-assessments") p.set("view", "new-assessments");
  if (state.layoutMode) p.set("layout", state.layoutMode);
  if (state.originLayout) p.set("origin", state.originLayout);
  // taxa + subgroups collapse to a single flat `taxa` token list (e.g.
  // invertebrates + inv-corals → taxa=corals); no separate subgroups param.
  const taxaTokens = collapseTaxaToTokens(state.taxa, state.subgroups);
  if (taxaTokens.length > 0) p.set("taxa", taxaTokens.join(","));
  if (state.categories.size > 0) p.set("categories", [...state.categories].join(","));
  if (state.yearRanges.size > 0) p.set("years", [...state.yearRanges].join(","));
  if (state.assessmentYears.size > 0) p.set("assessmentYears", [...state.assessmentYears].join(","));
  if (state.describedYears.size > 0) p.set("describedYears", [...state.describedYears].join(","));
  if (state.countries.size > 0) p.set("countries", [...state.countries].join(","));
  for (const key of GBIF_RANGE_KEYS) {
    if (state.gbifRanges[key].size > 0) p.set(GBIF_RANGE_PARAM[key], [...state.gbifRanges[key]].join(","));
  }
  if (state.assessmentCounts.size > 0) p.set("assessmentCounts", [...state.assessmentCounts].join(","));
  if (state.systems.size > 0) p.set("systems", [...state.systems].join(","));
  if (state.populationTrends.size > 0) p.set("trends", [...state.populationTrends].join(","));
  if (state.movementPatterns.size > 0) p.set("movement", [...state.movementPatterns].join(","));
  if (state.threats.size > 0) p.set("threats", [...state.threats].join(","));
  // Only the opt-out is written — "threatened" is the default (see parseParams).
  if (state.threatsScope === "all") p.set("threatsScope", "all");
  if (state.criteria.size > 0) p.set("criteria", [...state.criteria].join(","));
  if (state.colMatch) p.set("colMatch", state.colMatch);
  if (state.colReasons && state.colReasons.size > 0) p.set("colReasons", [...state.colReasons].join(","));
  if (state.habitat.size > 0) p.set("habitat", [...state.habitat].join(","));
  if (state.habitatBreadth) p.set("habitatBreadth", state.habitatBreadth);
  if (!setEqualsArray(state.habitatImportance, ALL_HABITAT_IMPORTANCE)) p.set("habitatImportance", [...state.habitatImportance].join(","));
  if (!setEqualsArray(state.habitatSeasons, ALL_HABITAT_SEASONS)) p.set("habitatSeasons", [...state.habitatSeasons].join(","));
  if (!setEqualsArray(state.habitatSuitability, ALL_HABITAT_SUITABILITY)) p.set("habitatSuitability", [...state.habitatSuitability].join(","));
  if (state.breakdown) {
    let bd = `${state.breakdown.nodeId}:${state.breakdown.rank}:${state.breakdown.name}`;
    if (state.breakdown.onlyIds?.length) bd += `:only:${state.breakdown.onlyIds.join(",")}`;
    else if (state.breakdown.excludeIds?.length) bd += `:excl:${state.breakdown.excludeIds.join(",")}`;
    p.set("bd", bd);
  }
  if (state.endemicsOnly) p.set("endemics", "1");
  if (state.growthForms.size > 0) p.set("growthForms", [...state.growthForms].join(","));
  if (state.assessors.size > 0) p.set("assessors", [...state.assessors].join("|"));
  if (state.reviewers.size > 0) p.set("reviewers", [...state.reviewers].join("|"));
  if (state.facilitators.size > 0) p.set("facilitators", [...state.facilitators].join("|"));
  if (state.contributors.size > 0) p.set("contributors", [...state.contributors].join("|"));
  if (state.institutions.size > 0) p.set("institutions", [...state.institutions].join("|"));
  if (state.search) p.set("search", state.search);
  if (state.outdated) p.set("outdated", state.outdated);
  if (state.species != null) p.set("species", state.species);
  if (state.species != null && state.tab && state.tab !== "gbif") p.set("tab", state.tab);
  // null / "year" desc is the default — only write non-default sort to URL
  const isDefaultSort = state.sortField === null || state.sortField === "year";
  if (!isDefaultSort) {
    p.set("sort", state.sortField!);
    if (state.sortDirection !== "desc") p.set("dir", state.sortDirection);
  } else if (state.sortDirection !== "desc") {
    p.set("dir", state.sortDirection);
  }
  // Secondary sort is only meaningful alongside a primary that differs from it.
  if (state.sortField2 && state.sortField2 !== (state.sortField ?? "year")) {
    p.set("sort2", state.sortField2);
    if (state.sortDirection2 !== "desc") p.set("dir2", state.sortDirection2);
  }
  if (state.mapViewMode === "list") p.set("mapview", "list");
  if (state.gbifRecordMode && state.gbifRecordMode !== DEFAULT_GBIF_RECORD_MODE) p.set(GBIF_RECORDS_PARAM, state.gbifRecordMode);
  if (state.gbifChartKey && state.gbifChartKey !== DEFAULT_GBIF_CHART_KEY) p.set(GBIF_CHART_PARAM, state.gbifChartKey);
  if (state.triageBox) p.set("triage", state.triageBox.join(","));
  if (state.triageY) p.set("triageY", state.triageY);
  if (state.mapSortKey && state.mapSortKey !== "species") p.set("mapsort", state.mapSortKey);
  if (state.mapSortDirection === "asc") p.set("mapdir", "asc");
  const qs = prettifyQs(p.toString());
  return qs ? `?${qs}` : "";
}

export { prettifyQs };

// Pure merge: combines this hook's params into whatever's already present in
// `currentSearch`, rather than replacing the whole query string, so params it
// doesn't own survive its writes. Exported (and used by syncUrl below, its only caller)
// so this merge behavior — the actual novel logic here — is directly
// unit-testable rather than only reachable through the hook itself.
export function mergeParamsIntoSearch(
  currentSearch: string,
  newState: Parameters<typeof buildQs>[0]
): string {
  const current = new URLSearchParams(currentSearch);
  for (const name of OWN_PARAM_NAMES) current.delete(name);
  for (const [ownKey, value] of new URLSearchParams(buildQs(newState))) {
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
 */
export function useFilterParams() {
  // Initialize with empty state (SSR-safe), hydrate from URL in effect
  const [state, setState] = useState(() => parseParams(""));

  // Tracks whether the most recent state update came from a popstate (URL navigation).
  // Consumers can check this to avoid clearing URL-driven state.
  const fromPopstateRef = useRef(false);

  // Hydrate from URL on mount + sync on popstate (back/forward button)
  useEffect(() => {
    fromPopstateRef.current = true;
    setState(parseParams(window.location.search)); // eslint-disable-line react-hooks/set-state-in-effect -- hydrate from URL on mount
    // Whatever filters arrived in the URL are the baseline, not a choice this
    // user made — see primeFilterBaseline. Without this, opening a shared
    // filtered link would count every filter in it as freshly applied.
    primeFilterBaseline(window.location.search);
    const onPopState = () => {
      fromPopstateRef.current = true;
      setState(parseParams(window.location.search));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Write URL silently (no Next.js navigation, no re-render loop). Merges this
  // hook's params into whatever's currently in the URL rather than replacing the
  // whole query string (see mergeParamsIntoSearch).
  const syncUrl = useCallback((newState: typeof state, push: boolean) => {
    const qs = mergeParamsIntoSearch(window.location.search, newState);
    const url = window.location.pathname + qs;
    if (push) {
      window.history.pushState(null, "", url);
    } else {
      window.history.replaceState(null, "", url);
    }
    // Every filter change routes through here regardless of which setter caused
    // it, which makes this the one place that sees them all. It only emits on
    // transitions, so the replace-mode writes (normalisation, view switches)
    // that change no filter are silent (#524).
    reportFilterUsage(qs);
  }, []);

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

  const setGbifRanges = useCallback(
    (key: GbifRangeKey, updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setState(prev => {
        const nextSel = typeof updater === "function" ? updater(prev.gbifRanges[key]) : updater;
        const next = { ...prev, gbifRanges: { ...prev.gbifRanges, [key]: nextSel } };
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
        // memory exitLayoutModeForTaxon left behind — see originLayout's doc.
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

  // Exits a scope view (Country) to the full charts+species-table view
  // when a taxon's clicked from its scoped landing table (see RedListView's
  // handleToggleTaxon) — atomic (one setState + one history push), same
  // reasoning as navigateToTaxonSubgroup above: without this, layoutMode and
  // taxa/subgroups would each get their own history entry, so a single
  // "back" press would land on some half-updated intermediate (e.g.
  // layoutMode cleared but taxa not yet set) instead of cleanly restoring
  // the landing page. The scope itself (countries) is deliberately
  // left untouched — the taxon drill-down stays scoped to whatever was
  // selected. Also records originLayout as the mode being left — layoutMode
  // itself is about to go null, so without this nothing durable remembers
  // which view we came from. RedListView's "All Species" row (and the site
  // logo's Home button, reading straight off the URL) use this to jump back
  // to that landing page instead of the generic default view.
  const exitLayoutModeForTaxon = useCallback(
    (taxonId: string, mode: LayoutMode) => {
      setState(prev => {
        const next = { ...prev, taxa: new Set([taxonId]), subgroups: new Set<string>(), layoutMode: null as LayoutMode, originLayout: mode, ...SPECIES_SCOPED_RESET };
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
  // left by exitLayoutModeForTaxon and land back on that view properly.
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
  }), [state.outdated]);

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
        // RedListView mirrors the page's viewMode in here after every switch,
        // and the page has already pushed the URL by then: an unchanged mode
        // would only push a duplicate history entry.
        if (prev.viewMode === mode) return prev;
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

  // The triage box is a filter; its y metric a display choice. Changing the metric clears the box, drawn in the old units.
  const setTriageBox = useCallback(
    (box: TriageBox | null) => {
      setState(prev => {
        const next = { ...prev, triageBox: box };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );
  const setTriageY = useCallback(
    (key: GbifRangeKey | null) => {
      setState(prev => {
        const next = { ...prev, triageY: key, triageBox: null };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setGbifChartKey = useCallback(
    (key: GbifRangeKey) => {
      setState(prev => {
        const next = { ...prev, gbifChartKey: key };
        queueMicrotask(() => syncUrl(next, false));
        return next;
      });
    },
    [syncUrl]
  );

  const setGbifRecordMode = useCallback(
    (mode: GbifRecordMode) => {
      setState(prev => {
        const next = { ...prev, gbifRecordMode: mode };
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
        gbifRanges: emptyGbifRanges(),
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
        triageBox: null,
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

  // `replace` overwrites the current history entry instead of pushing one, for
  // a caller that has just pushed its own entry for the same click (Clear all
  // switching back from Not Evaluated) so one back-press still undoes it all.
  const clearAllFiltersAndTaxa = useCallback((opts?: { replace?: boolean }) => {
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
        gbifRanges: emptyGbifRanges(),
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
        triageBox: null,
        ...EMPTY_EXACT_FILTERS,
        sortField: null,
        sortDirection: "desc" as const,
        sortField2: null,
        sortDirection2: "desc" as const,
        species: null,
        tab: null,
      };
      queueMicrotask(() => syncUrl(next, !opts?.replace));
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
    gbifRanges: state.gbifRanges,
    gbifChartKey: state.gbifChartKey ?? DEFAULT_GBIF_CHART_KEY,
    triageBox: state.triageBox ?? null,
    triageY: state.triageY ?? null,
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
    gbifRecordMode: state.gbifRecordMode,
    mapSortKey: state.mapSortKey,
    mapSortDirection: state.mapSortDirection,

    setColMatch,
    setColReasons,
    setViewMode,
    setLayoutMode,
    navigateToTaxonSubgroup,
    exitLayoutModeForTaxon,
    returnToLayoutMode,
    enterCountryDrilldown,
    setSelectedTaxa,
    setSelectedSubgroups,
    setSelectedCategories,
    setSelectedYearRanges,
    setSelectedAssessmentYears,
    setSelectedDescribedYears,
    setSelectedCountries,
    setGbifRanges,
    setGbifChartKey,
    setTriageBox,
    setTriageY,
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
    setGbifRecordMode,
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
