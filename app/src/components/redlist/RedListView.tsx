"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import TaxaSummary from "./TaxaSummary";
import NewLiteratureSinceAssessment from "../LiteratureSearch";
import { GBIF_CHECKLIST_KEY, gbifOccurrenceParams, taxonGroupCountsPreservedSpecimens } from "@/lib/gbif";
import RedListAssessments from "../RedListAssessments";
import CitesSummary from "../CitesSummary";
import WikipediaSummary from "../WikipediaSummary";
import EolSummary from "../EolSummary";
import TaxaIcon from "../TaxaIcon";
import { type CountryStats } from "../WorldMap";
import { ALPHA2_TO_NAME } from "@/lib/countries";
import { CATEGORY_COLORS, TAXA_BY_ID, THREATENED_CATEGORIES } from "@/config/taxa";
import { speciesMatchesNode, getNodeDef, getViewRootForNode, findNode, matchesBreakdownName, breakdownDisplayName } from "@/lib/taxonomy-utils";
import { dynamicNodeDisplayName } from "@/lib/dynamic-taxon";
import ReviewerChart from "./ReviewerChart";
import { ColLink, linkNames, NoMatchLine } from "@/components/redlist/revision-links";
import { REVISION_BARS, visibleBars, barForReason, acceptedNameSentence, GENUS_DIFFERS_REASON, RENAMED_REASON, REVISION_REASON_SHORT, REVISION_REASON_SUMMARY, revisionReasons, matchesRevisionFilter, isFlagged, colUrl, colDatasetUrl, colTaxonUrl, splitSummary, lumpSentence, type SplitSummary, newRevisionTally, tallyRevision, barTotal, REVISION_CAVEAT, type ColRevision } from "@/lib/col-revision";
import type { ColProvenance } from "@/app/api/col/provenance/route";
import { parseAssessors, parseInstitutions } from "@/lib/parseAssessors";
import { iucnRegionCountries, matchingRegions } from "@/lib/regions";
import { useFilterParams, type SortField, type MapViewMode } from "@/hooks/useFilterParams";
import { HABITAT_CATEGORIES } from "@/lib/habitat-classification";
import { readViewPreference, writeViewPreference } from "@/lib/view-preference";
import { parseHabitatEntries, matchesHabitatFilter as matchesHabitatCriteria, coarseKnownCategories, isRestrictiveSelection, ALL_HABITAT_SEASONS, ALL_HABITAT_IMPORTANCE, ALL_HABITAT_SUITABILITY } from "@/lib/habitat-filter";
import { type RedListSpecies } from "@/hooks/useRedListSpeciesQuery";
import { useSpeciesCache } from "@/contexts/SpeciesCacheContext";
import { isOutdated, outdatedCutoffDate } from "@/lib/outdated";

import CandidatesTable from "../CandidatesTable";
import { CREDIT_ROLES, type CreditRole } from "@/lib/credit-candidates";
import { getLastSearchResult, clearLastSearchResult, type SearchResult } from "../SpeciesSearchBar";
import { migratePinnedSpecies } from "@/lib/species-row-key";

// Species list is served by the DuckDB/Parquet-backed /api/redlist/species route.
const SPECIES_API = "/api/redlist/species";

type DetailTab = "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "candidates" | "col" | "eol";
/** Tab names that appear in shared links but are no longer tabs of their own. */
type LegacyDetailTab = DetailTab | "assessors" | "reviewers";

// Encyclopedia of Life tab is hidden for now. The tab, its panel and the
// /api/eol routes are all still here — flip this back to true to bring it back.
const SHOW_EOL_TAB = false;

// Wikipedia tab is hidden for now. The tab, its panel and the WikipediaSummary
// component are all still here — flip this back to true to bring it back.
const SHOW_WIKIPEDIA_TAB = false;

// A ?tab=eol link (or a stale one) shouldn't strand the user on a tab with no
// button in the bar, so fall back to the default tab while EoL is hidden.
function visibleTab(tab: LegacyDetailTab | null | undefined): DetailTab {
  if (!tab) return "gbif";
  // The Suggested Assessors and Suggested Reviewers tabs merged into one tab with
  // a credit-line toggle; a link naming either still opens it (on that role — see
  // roleFromLegacyTab).
  if (tab === "assessors" || tab === "reviewers") return "candidates";
  if (tab === "eol" && !SHOW_EOL_TAB) return "gbif";
  if (tab === "wikipedia" && !SHOW_WIKIPEDIA_TAB) return "gbif";
  return tab;
}

/** The credit line a legacy ?tab= asked for, so such a link lands where it meant to. */
function roleFromLegacyTab(tab: LegacyDetailTab | null | undefined): CreditRole | null {
  return tab === "assessors" || tab === "reviewers" ? tab : null;
}

// Dynamically import OccurrenceMapRow to avoid SSR issues with Leaflet
const OccurrenceMapRow = dynamic(
  () => import("@/components/mapping/OccurrenceMapRow"),
  { ssr: false }
);

// iNat-only observations panel, shown when a species has no GBIF backbone match
const InatObservationsPanel = dynamic(
  () => import("../InatObservationsPanel"),
  { ssr: false }
);

// Dynamically import WorldMap to avoid SSR issues
const WorldMap = dynamic(
  () => import("../WorldMap"),
  { ssr: false }
);

// Dynamically import FilterBarChart to reduce initial bundle size (recharts is ~200KB)
const FilterBarChart = dynamic(
  () => import("./FilterBarChart"),
  { ssr: false, loading: () => <div className="h-full animate-pulse bg-zinc-200 dark:bg-zinc-800 rounded" /> }
);

// Dedicated vertical bar chart for "Year of Latest Assessment" view
const YearBarChart = dynamic(
  () => import("./YearBarChart"),
  { ssr: false, loading: () => <div className="h-full animate-pulse bg-zinc-200 dark:bg-zinc-800 rounded" /> }
);

// Simple spinner component for loading states
function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin h-5 w-5 text-zinc-400 ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

// Use RedListSpecies from the hook; alias for convenience
type Species = RedListSpecies;

/** IUCN threat classification hierarchy */
const THREAT_CATEGORIES: { code: string; label: string; children: { code: string; label: string }[] }[] = [
  { code: "1", label: "Development", children: [
    { code: "1.1", label: "Housing & urban areas" }, { code: "1.2", label: "Commercial & industrial areas" }, { code: "1.3", label: "Tourism & recreation areas" },
  ]},
  { code: "2", label: "Agriculture", children: [
    { code: "2.1", label: "Crops" }, { code: "2.2", label: "Wood & pulp plantations" }, { code: "2.3", label: "Livestock farming & ranching" }, { code: "2.4", label: "Aquaculture" },
  ]},
  { code: "3", label: "Energy & Mining", children: [
    { code: "3.1", label: "Oil & gas drilling" }, { code: "3.2", label: "Mining & quarrying" }, { code: "3.3", label: "Renewable energy" },
  ]},
  { code: "4", label: "Transport", children: [
    { code: "4.1", label: "Roads & railroads" }, { code: "4.2", label: "Utility & service lines" }, { code: "4.3", label: "Shipping lanes" }, { code: "4.4", label: "Flight paths" },
  ]},
  { code: "5", label: "Harvesting", children: [
    { code: "5.1", label: "Hunting & trapping" }, { code: "5.2", label: "Gathering plants" }, { code: "5.3", label: "Logging & wood harvesting" }, { code: "5.4", label: "Fishing & harvesting" },
  ]},
  { code: "6", label: "Disturbance", children: [
    { code: "6.1", label: "Recreational activities" }, { code: "6.2", label: "War & military" }, { code: "6.3", label: "Work & other activities" },
  ]},
  { code: "7", label: "System modifications", children: [
    { code: "7.1", label: "Fire & fire suppression" }, { code: "7.2", label: "Dams & water management" }, { code: "7.3", label: "Other modifications" },
  ]},
  { code: "8", label: "Invasive species", children: [
    { code: "8.1", label: "Invasive non-native species" }, { code: "8.2", label: "Problematic native species" }, { code: "8.3", label: "Introduced genetic material" }, { code: "8.4", label: "Unknown origin species" }, { code: "8.5", label: "Viral/prion diseases" }, { code: "8.6", label: "Diseases of unknown cause" },
  ]},
  { code: "9", label: "Pollution", children: [
    { code: "9.1", label: "Domestic & urban waste water" }, { code: "9.2", label: "Industrial & military effluents" }, { code: "9.3", label: "Agricultural & forestry effluents" },
    { code: "9.4", label: "Garbage & solid waste" }, { code: "9.5", label: "Air-borne pollutants" }, { code: "9.6", label: "Excess energy (light, thermal, noise)" },
  ]},
  { code: "10", label: "Geological events", children: [
    { code: "10.1", label: "Volcanoes" }, { code: "10.2", label: "Earthquakes/tsunamis" }, { code: "10.3", label: "Avalanches/landslides" },
  ]},
  { code: "11", label: "Climate change", children: [
    { code: "11.1", label: "Habitat shifting & alteration" }, { code: "11.2", label: "Droughts" }, { code: "11.3", label: "Temperature extremes" }, { code: "11.4", label: "Storms & flooding" }, { code: "11.5", label: "Other impacts" },
  ]},
  { code: "12", label: "Other", children: [
    { code: "12.1", label: "Other threat" },
  ]},
];


interface CriteriaNode {
  code: string;
  label: string;
  children: CriteriaNode[];
}

// Roman-numeral sub-items shared by B1b/B1c/B2b/B2c ("continuing decline in" /
// "extreme fluctuations in" — same list of 5 parameters either way).
const ROMAN_NUMERAL_LABELS: Record<string, string> = {
  i: "extent of occurrence",
  ii: "area of occupancy",
  iii: "area, extent, and/or quality of habitat",
  iv: "number of locations or subpopulations",
  v: "number of mature individuals",
};
function romanChildren(prefix: string, numerals: readonly string[]): CriteriaNode[] {
  return numerals.map(r => ({ code: `${prefix}(${r})`, label: `${prefix}(${r}) — ${ROMAN_NUMERAL_LABELS[r]}`, children: [] }));
}
const B_ROMANS = ["i", "ii", "iii", "iv", "v"] as const;
function bSubclauses(num: string): CriteriaNode[] {
  return [
    { code: `B${num}a`, label: `B${num}a — Severely fragmented or few locations`, children: [] },
    { code: `B${num}b`, label: `B${num}b — Continuing decline in`, children: romanChildren(`B${num}b`, B_ROMANS) },
    { code: `B${num}c`, label: `B${num}c — Extreme fluctuations in`, children: romanChildren(`B${num}c`, B_ROMANS) },
  ];
}
function aSubclauses(num: string): CriteriaNode[] {
  return [
    { code: `A${num}a`, label: `A${num}a — Direct observation`, children: [] },
    { code: `A${num}b`, label: `A${num}b — Index of abundance`, children: [] },
    { code: `A${num}c`, label: `A${num}c — Decline in area of occupancy, extent of occurrence, and/or habitat quality`, children: [] },
    { code: `A${num}d`, label: `A${num}d — Levels of exploitation`, children: [] },
    { code: `A${num}e`, label: `A${num}e — Effects of introduced taxa, hybridization, pathogens, pollutants, competitors, or parasites`, children: [] },
  ];
}

// IUCN Red List criteria (A-E), their numbered sub-criteria (A1-A4/B1-B2/C1-C2/D1-D2/E),
// and — where the framework defines them — the sub-clause letters and roman-numeral
// qualifiers beneath those. Depth varies genuinely by branch, not just by how far someone
// bothered to fill it in: A's a-e are evidence types with no further split; B1/B2's a/b/c
// share one vocabulary, with only b/c carrying the 5 roman-numeral "declining/fluctuating
// in ___" qualifiers; C1 and D1/D2/E have no sub-clauses at all; C2's a/b differ from B's
// a/b/c entirely (population structure vs. extreme fluctuations), with only a(i)/a(ii)
// going one level deeper. See https://www.iucnredlist.org/resources/categories-and-criteria.
const CRITERIA_CATEGORIES: CriteriaNode[] = [
  { code: "A", label: "A — Population reduction", children: [
    { code: "A1", label: "A1 — Past reduction, reversible & understood & ceased", children: aSubclauses("1") },
    { code: "A2", label: "A2 — Past reduction, may not be reversible", children: aSubclauses("2") },
    { code: "A3", label: "A3 — Future reduction projected", children: aSubclauses("3") },
    { code: "A4", label: "A4 — Reduction, past and future", children: aSubclauses("4") },
  ]},
  { code: "B", label: "B — Small range", children: [
    { code: "B1", label: "B1 — Extent of occurrence", children: bSubclauses("1") },
    { code: "B2", label: "B2 — Area of occupancy", children: bSubclauses("2") },
  ]},
  { code: "C", label: "C — Small population & decline", children: [
    { code: "C1", label: "C1 — Continuing decline (quantified rate)", children: [] },
    { code: "C2", label: "C2 — Continuing decline (fragmented/fluctuating/subpopulations)", children: [
      { code: "C2a", label: "C2a — Population structure", children: [
        { code: "C2a(i)", label: "C2a(i) — No subpopulation estimated to contain more than X mature individuals", children: [] },
        { code: "C2a(ii)", label: "C2a(ii) — ~100% of individuals in one subpopulation", children: [] },
      ]},
      { code: "C2b", label: "C2b — Extreme fluctuations in number of mature individuals", children: [] },
    ]},
  ]},
  { code: "D", label: "D — Very small or restricted population", children: [
    { code: "D1", label: "D1 — Very small population", children: [] },
    { code: "D2", label: "D2 — Restricted area of occupancy / very few locations", children: [] },
  ]},
  { code: "E", label: "E — Quantitative analysis", children: [] },
];

function findCriteriaNode(nodes: CriteriaNode[], code: string): CriteriaNode | null {
  for (const node of nodes) {
    if (node.code === code) return node;
    const found = findCriteriaNode(node.children, code);
    if (found) return found;
  }
  return null;
}

// Splits a criteria string on top-level "; " or ", " separators — real assessment data
// uses both inconsistently (e.g. "B1+2c, D2" alongside "A3c; B2b(iii)") — without
// splitting on commas *inside* a roman-numeral group like "(i,ii,iii)".
function splitCriteriaTopLevel(criteria: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of criteria) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if ((ch === ";" || ch === ",") && depth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) segments.push(current);
  return segments.map(s => s.trim()).filter(Boolean);
}

// Parses a raw IUCN criteria string into every code it satisfies, at every level: top
// letter, number (B1), sub-clause (B1a), and roman-numeral qualifier (B1b(iii)). E.g.
// "B1ab(iii)+2ab(iii)" -> ["B1","B1a","B1b","B1b(iii)","B2","B2a","B2b","B2b(iii)"].
// Handles two real-world conventions for "+N" continuations (both seen in production
// data): full repetition ("B1ab(iii)+2ab(iii)", sub-clauses spelled out for each number)
// and B's compact form ("B1+2c", sub-clauses given once for the whole chain) — the
// compact form is only safe to assume for B, since B1/B2 share one sub-clause vocabulary,
// unlike e.g. C1/C2 which don't (so "C1+2a(i)" must NOT retroactively give C1 a sub-clause
// it doesn't have).
function parseCriteriaCodes(criteria: string | null | undefined): string[] {
  if (!criteria) return [];
  const codes = new Set<string>();
  for (const segment of splitCriteriaTopLevel(criteria)) {
    const parts = segment.split("+").map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    let letter: string | null = null;
    const parsed: { numberCode: string; rest: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const headMatch = i === 0 ? part.match(/^([A-E])(\d*)/) : part.match(/^(\d+)/);
      if (!headMatch) { if (i === 0) break; else continue; }
      if (i === 0) letter = headMatch[1];
      if (!letter) continue;
      const num = i === 0 ? headMatch[2] : headMatch[1];
      parsed.push({ numberCode: letter + num, rest: part.slice(headMatch[0].length) });
    }
    if (letter === "B") {
      const withRest = parsed.filter(p => p.rest !== "");
      if (withRest.length === 1 && parsed.length > 1) {
        const shared = withRest[0].rest;
        for (const p of parsed) p.rest = shared;
      }
    }
    for (const { numberCode, rest } of parsed) {
      codes.add(numberCode);
      const subRe = /([a-e])(?:\(([^)]*)\))?/g;
      let sm: RegExpExecArray | null;
      while ((sm = subRe.exec(rest)) !== null) {
        const subCode = numberCode + sm[1];
        codes.add(subCode);
        if (sm[2]) {
          for (const numeral of sm[2].split(",").map(x => x.trim()).filter(Boolean)) {
            codes.add(`${subCode}(${numeral})`);
          }
        }
      }
    }
  }
  return [...codes];
}

// Season chip options for the Habitat card's season multi-select — full IUCN
// labels (used for matching and as the button title) paired with a shorter
// display label so five chips fit in a narrow card.
const HABITAT_SEASON_OPTIONS: { value: string; short: string }[] = [
  { value: "Resident", short: "Resident" },
  { value: "Breeding Season", short: "Breeding" },
  { value: "Non-Breeding Season", short: "Non-breeding" },
  { value: "Passage", short: "Passage" },
  { value: "Seasonal Occurrence Unknown", short: "Unknown" },
];

// Importance dropdown options — same checkbox-multi-select shape as season,
// covering all 3 possible parseHabitatEntries().importance values.
// Allowed values for the remembered view toggles — passed to readViewPreference
// so a stale or hand-edited localStorage value can never reach a component.
const YEARS_CHART_MODES = ["range", "year"] as const;
const CREDIT_CHART_MODES = ["assessors", "reviewers", "facilitators", "contributors", "institutions"] as const;
const MAP_VIEW_MODES = ["map", "list"] as const;
type CreditChartMode = (typeof CREDIT_CHART_MODES)[number];

const CATEGORY_ORDER: Record<string, number> = {
  EX: 0, EW: 1, CR: 2, EN: 3, VU: 4, NT: 5, LC: 6, DD: 7, NE: 8,
};

/**
 * Ascending comparison of two species on one sortable column.
 *
 * Shared by the primary and the user-chosen secondary sort so "sort by X then
 * within that by Y" orders on Y exactly the way sorting by Y alone would.
 * Direction is applied by the caller (negating this) rather than passed in, so
 * the two levels can carry independent directions.
 *
 * Missing values compare as -1 throughout, which parks them at the bottom under
 * the desc default — matching how the table reads "no data" as "least".
 */
function compareBy(field: SortField, a: Species, b: Species): number {
  switch (field) {
    case "year": {
      const dateA = a.assessment_date ? new Date(a.assessment_date).getTime() : 0;
      const dateB = b.assessment_date ? new Date(b.assessment_date).getTime() : 0;
      return dateA - dateB;
    }
    case "category":
      return (CATEGORY_ORDER[a.category] ?? 99) - (CATEGORY_ORDER[b.category] ?? 99);
    case "totalGbif":
      return (a.gbif_occurrence_count ?? -1) - (b.gbif_occurrence_count ?? -1);
    case "newGbif":
      return (a.gbif_observations_after_assessment_year ?? -1) - (b.gbif_observations_after_assessment_year ?? -1);
    case "pctNewGbif": {
      const pct = (s: Species) =>
        (s.gbif_occurrence_count && s.gbif_occurrence_count > 0 && s.gbif_observations_after_assessment_year != null)
          ? s.gbif_observations_after_assessment_year / s.gbif_occurrence_count : -1;
      return pct(a) - pct(b);
    }
    case "describedYear":
      return (a.described_year ?? -1) - (b.described_year ?? -1);
  }
}

const HABITAT_IMPORTANCE_OPTIONS: { value: string; short: string }[] = [
  { value: "Major", short: "Major" },
  { value: "Not major", short: "Minor" },
  { value: "Unknown", short: "Unknown" },
];

// Suitability dropdown options — same checkbox-multi-select shape as importance,
// covering all 3 possible parseHabitatEntries().suitability values.
const HABITAT_SUITABILITY_OPTIONS: { value: string; short: string }[] = [
  { value: "Suitable", short: "Suitable" },
  { value: "Marginal", short: "Marginal" },
  { value: "Unknown", short: "Unknown" },
];

interface InatDefaultImage {
  squareUrl: string | null;
  mediumUrl: string | null;
}

interface GbifMatchStatus {
  matchType: string;
  matchedName?: string;
  matchedRank?: string;
}

interface SpeciesDetails {
  criteria: string | null;
  commonName: string | null;
  gbifUrl: string | null;
  gbifOccurrences: number | null;
  gbifOccurrencesSinceAssessment: number | null;
  gbifMatchStatus: GbifMatchStatus | null;
  // undefined = still loading (show spinner), null = fetched, no image
  inatDefaultImage: InatDefaultImage | null | undefined;
  // Whether criteria/gbifMatchStatus have been fetched (to avoid re-fetching on null)
  criteriaFetched?: boolean;
  gbifMatchFetched?: boolean;
}

// A search hit as a species row: everything the search index knows, with the
// assessment-only fields (trend, criteria, threats, assessors, …) left empty — the same
// shape and the same absent-field handling as a Not-Evaluated row from the species list.
// Lets the searched species be rendered before (or without) the taxon's own list.
// Null for a search hit the table can't address — a GBIF species with no CoL link,
// which is in no node's NE list to be previewed into. The search still navigates to
// it by name; only the auto-opened detail panel is skipped.
function previewFromSearchResult(r: SearchResult): RedListSpecies | null {
  if (!r.species_key) return null;
  return {
    species_key: r.species_key,
    sis_taxon_id: r.sis_taxon_id,
    col_id: r.col_id,
    assessment_id: r.assessment_id,
    scientific_name: r.scientific_name,
    common_name: r.common_name,
    family: r.family,
    category: r.category,
    assessment_date: r.assessment_date,
    year_published: null,
    population_trend: null,
    countries: r.countries,
    class_name: r.class_name,
    order_name: r.order_name,
    taxon_group: r.taxon_group,
    taxon_id: r.taxon_id,
    described_year: null,
    gbif_species_key: r.gbif_species_key,
    gbif_occurrence_count: r.gbif_occurrence_count,
    gbif_observations_after_assessment_year: null,
    latest_assessors: null,
    latest_reviewers: null,
    latest_facilitators: null,
    latest_contributors: null,
    latest_institutions: null,
    previous_assessments: [],
    systems: [],
    growth_forms: [],
    movement_pattern: null,
    possibly_extinct: false,
    possibly_extinct_in_the_wild: false,
    criteria: null,
    threat_codes: [],
    habitat_codes: [],
    assessment_count: null,
  };
}

// Debounced search input — manages own state for instant typing, debounces parent updates.
// Filters the currently-visible species table by name in place, composing with whatever
// pill filters are already active (e.g. Mammals + EN + Mexico, then narrow to "mouse") —
// distinct from the page header's SpeciesSearchBar, which navigates to a taxon/species
// instead of narrowing the current view. Placeholder text keeps the two from reading as
// duplicates of each other.
function DebouncedSearchInput({
  onSearch,
  initialValue = "",
  placeholder = "Filter by name...",
  className,
}: {
  onSearch: (value: string) => void;
  initialValue?: string;
  placeholder?: string;
  className?: string;
}) {
  const [localValue, setLocalValue] = useState(initialValue);

  useEffect(() => {
    setLocalValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    const timer = setTimeout(() => {
      onSearch(localValue.toLowerCase());
    }, 200);
    return () => clearTimeout(timer);
  }, [localValue, onSearch]);

  return (
    <input
      type="text"
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      placeholder={placeholder}
      className={className}
    />
  );
}

/**
 * The filter axes a cross-filter chart can opt out of — see matchesFilters.
 * Naming follows the URL params where they exist, so a skip set reads against
 * the address bar.
 */
type FilterAxis =
  | "search" | "categories" | "countries" | "years" | "assessmentYears" | "obs"
  | "assessmentCounts" | "systems" | "trends" | "movement" | "threats" | "criteria"
  | "habitat" | "endemics" | "growthForms" | "assessors" | "reviewers" | "facilitators"
  | "contributors" | "institutions" | "revision";

// Species-table column classes. Deliberately the same treatment as the taxa summary
// table above it (TaxaSummary's numericThClasses and friends): sentence-case bold
// headers rather than the small-caps tracked ones this table used, so the two read as
// one system instead of two unrelated tables stacked on a page.
//
// No column rules, where that table has them: its cells are composites (count, bar,
// percent), so a rule is what shows where one column's three parts end, while every
// cell here is a single value that alignment and padding already separate. Ruling them
// only laid a grid over the data.
//
// Written out in full rather than composed from fragments — Tailwind only sees class
// names it can read literally in the source.
const SPECIES_TH = "px-2 md:px-4 py-3 text-sm font-bold text-zinc-600 dark:text-zinc-300";
const SPECIES_TH_SORTABLE = "cursor-pointer hover:text-zinc-900 dark:hover:text-zinc-100 select-none";
// Spelled-out headers ("GBIF Records Since Assessment") are wider than the numbers
// under them, and six nowrap headers pushed the table past its container on a normal
// laptop — a horizontal scrollbar to read a column title, while the data itself fits.
// So the long ones wrap inside a width the values still fit in, which costs a header
// line and buys back ~250px. The taxa summary table wraps its own headers the same way
// (numericThWrapClasses). Short ones (Category) keep one line.
//
// A fixed width, not a max: as a max it was only an upper bound, so once the table came
// under width pressure the column squeezed below it and "GBIF Records Since Assessment"
// broke onto a third line.
//
// Each label carries its own width — the narrowest box that still fits the wider of the
// two lines it should break into, measured at this size and weight:
//
//   Assessment / Date               84   ("Assessment" 83)
//   Total GBIF / Records            72   ("Total GBIF" 70)
//   GBIF Records / Since Assessment 124  ("Since Assessment" 124)
//   Year Described                  104  (one line, 102 — new-assessments has the room)
//   GBIF Records                    96   (one line, 94 — likewise)
//
// One shared width would have to be the largest of them, which is what left Assessment
// Date and Total GBIF Records ~50px wider than their text and put a gutter of dead space
// between the date and the number beside it.
const SPECIES_TH_LABEL = "leading-tight";
const SPECIES_TH_NOWRAP = "whitespace-nowrap";

const skipSet = (...axes: FilterAxis[]): ReadonlySet<FilterAxis> => new Set(axes);

// A chart's own axis, so its bars keep showing what clicking them would select.
const SKIP_YEARS = skipSet("years", "assessmentYears");
const SKIP_OBS = skipSet("obs");
const SKIP_ASSESSMENT_COUNTS = skipSet("assessmentCounts");
const SKIP_COUNTRIES = skipSet("countries");
// Threats, Criteria and Habitat additionally ignore the endemics and growth-form
// toggles. That is inherited behaviour, not a principle — preserved here so this
// refactor changes no number, and now at least visible rather than buried in
// three separately-drifting copies of the clause list.
const SKIP_THREATS = skipSet("threats", "endemics", "growthForms");

// CR/EN/VU as a Set, for the Threats chart's "threatened only" scope.
const THREATENED_SET = new Set<string>(THREATENED_CATEGORIES);
const SKIP_CRITERIA = skipSet("criteria", "endemics", "growthForms");
const SKIP_HABITAT = skipSet("habitat", "endemics", "growthForms");
// The credits chart cross-filters against the OTHER credit types itself (see
// buildCreditChart), so it skips all five here.
const SKIP_CREDITS = skipSet("assessors", "reviewers", "facilitators", "contributors", "institutions");
// The revision chart's own two axes are one filter (matchesColFilter). It
// inherits the same endemics/growth-form blind spot as the three above, having
// been written from the Criteria chart's clause list.
const SKIP_REVISION = skipSet("revision", "endemics", "growthForms");

// GBIF occurrence-count bucket for a species — the bars on the GBIF Records
// chart, and the single-value card that replaces that chart when the view is
// narrowed to one searched species.
function gbifObsBucket(count: number | null | undefined): string {
  const obs = count ?? 0;
  if (obs === 0) return "0";
  if (obs <= 10) return "1-10";
  if (obs <= 100) return "11-100";
  if (obs <= 1000) return "101-1K";
  if (obs <= 10000) return "1K-10K";
  return "10K+";
}

// Explain IUCN Red List criteria codes
// See: https://www.iucnredlist.org/resources/categories-and-criteria
function explainCriteria(criteria: string): string {
  if (!criteria) return "";

  const explanations: string[] = [];

  // Criterion A: Population size reduction
  if (criteria.includes("A1")) explanations.push("past population reduction, reversible");
  else if (criteria.includes("A2")) explanations.push("past population reduction, may not be reversible");
  else if (criteria.includes("A3")) explanations.push("future population reduction projected");
  else if (criteria.includes("A4")) explanations.push("population reduction past & future");
  else if (criteria.startsWith("A")) explanations.push("population reduction");

  // Criterion B: Geographic range (small range + fragmented/declining/fluctuating)
  if (criteria.includes("B1")) explanations.push("restricted extent of occurrence");
  if (criteria.includes("B2")) explanations.push("restricted area of occupancy");

  // Criterion C: Small population size and decline
  if (criteria.startsWith("C") || criteria.includes("+C")) explanations.push("small declining population");

  // Criterion D: Very small or restricted population
  if (criteria.startsWith("D") || criteria.includes("+D")) explanations.push("very small/restricted population");

  // Criterion E: Quantitative analysis
  if (criteria.startsWith("E") || criteria.includes("+E")) explanations.push("extinction probability analysis");

  return explanations.length > 0 ? ` (${explanations.join("; ")})` : "";
}

// Quick hover tooltip using portal
function HoverTooltip({ children, text }: { children: React.ReactNode; text: string }) {
  const [isHovered, setIsHovered] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (isHovered && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
      });
    }
  }, [isHovered]);

  return (
    <span
      ref={triggerRef}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
      {isHovered && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[99999] px-2 py-1 text-xs bg-zinc-800 text-zinc-200 rounded shadow-lg max-w-[250px] text-center"
          style={{
            top: position.top,
            left: position.left,
            transform: 'translateX(-50%) translateY(-100%)',
          }}
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}


// A HoverTooltip you can move the pointer INTO — so its content can be read at
// leisure, selected and copied, and so links inside it are clickable. HoverTooltip closes the moment the pointer
// leaves the trigger, which makes the gap between trigger and panel
// uncrossable; this keeps the panel open while the pointer is over either, with
// a short grace period covering the transit. Separate from HoverTooltip rather
// than replacing it: this one costs a timer and a second set of handlers per
// instance, and the ~40 plain tooltips (icons, badges, column headers) hold
// nothing worth selecting.
/** How long the panel will wait for `prepare` before opening regardless. Long
 *  enough for a warm ChecklistBank call (~90ms) plus slack, short enough that a
 *  slow or dead one never holds the tooltip hostage. */
const PREPARE_MAX_WAIT_MS = 400;

function SelectableHoverTooltip({ children, content, prepare }: {
  children: React.ReactNode;
  content: React.ReactNode;
  /** Warm anything the panel needs before it opens, so nothing lands late and
   *  reflows it. Bounded by PREPARE_MAX_WAIT_MS; failure is not a blocker. */
  prepare?: () => Promise<unknown>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bumped on every enter/leave so a resolving prepare() from an earlier hover
  // can't open a panel the pointer has already left.
  const hoverToken = useRef(0);

  const open = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // The panel grows upward from the trigger, so its ceiling is the room above
      // it. Paging keeps content bounded, but a full page opened from a row near
      // the top of the viewport can still outgrow that — clamp so it can never
      // render off-screen.
      setPosition({ top: rect.top - 6, left: rect.left + rect.width / 2, maxHeight: Math.max(140, rect.top - 16) });
    }
    setIsOpen(true);
  };

  const enter = () => {
    const token = ++hoverToken.current;
    if (!prepare || isOpen) { open(); return; }
    // Position now (the trigger's box is what it is), but hold the reveal until
    // the panel's content is settled — otherwise the provenance block lands a
    // beat later and shoves everything taller under the pointer.
    let done = false;
    const reveal = () => {
      if (done || hoverToken.current !== token) return;
      done = true;
      open();
    };
    void prepare().then(reveal, reveal);
    setTimeout(reveal, PREPARE_MAX_WAIT_MS);
  };

  // Grace period, not an immediate close: the pointer has to cross a few px of
  // dead space to reach the panel, and every one of those frames is a mouseleave.
  const scheduleClose = () => {
    hoverToken.current++;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setIsOpen(false), 220);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  return (
    <span ref={triggerRef} onMouseEnter={enter} onMouseLeave={scheduleClose}>
      {children}
      {isOpen && typeof document !== "undefined" && createPortal(
        <div
          role="tooltip"
          onMouseEnter={open}
          onMouseLeave={scheduleClose}
          className="fixed z-[99999] px-2 py-1.5 text-xs leading-relaxed bg-zinc-800 text-zinc-200 rounded shadow-lg max-w-[400px] text-left select-text cursor-text overflow-y-auto overscroll-contain"
          style={{ top: position.top, left: position.left, maxHeight: position.maxHeight, transform: "translateX(-50%) translateY(-100%)" }}
        >
          {content}
        </div>,
        document.body
      )}
    </span>
  );
}


// The ⚑ tooltip's body. Every species it names links to that species' own
// Catalogue of Life record — those names are the actionable part ("what is
// Hedlundia minima?"), and a link per name beats one link on the flag, which
// could only ever point at a single record.
/** Provenance per CoL record, cached for the page's lifetime — the tooltip
 *  unmounts on every close, so without this a second hover refetches. */
const colProvenanceCache = new Map<string, ColProvenance | null>();
const colProvenanceInFlight = new Map<string, Promise<void>>();

/**
 * Warm the cache for one CoL record. Awaited by the tooltip BEFORE it opens, so
 * the provenance block is there from the first frame rather than appearing a
 * moment later and shoving the panel taller — see SelectableHoverTooltip's
 * `prepare`. Never rejects: a failed lookup caches null and the block is simply
 * absent.
 */
function prefetchColProvenance(colId: string): Promise<void> {
  if (colProvenanceCache.has(colId)) return Promise.resolve();
  const existing = colProvenanceInFlight.get(colId);
  if (existing) return existing;
  const p = fetch(`/api/col/provenance?colId=${encodeURIComponent(colId)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d: ColProvenance | null) => { colProvenanceCache.set(colId, d); })
    .finally(() => { colProvenanceInFlight.delete(colId); });
  colProvenanceInFlight.set(colId, p);
  return p;
}

/**
 * Where CoL's record came from — scrutiny, source dataset, and the record on the
 * source's own site. Reads the cache only: whatever `prepare` managed to fetch
 * before the panel opened is what shows, and nothing arrives later to reflow it.
 */
function ColProvenanceBlock({ colId }: { colId: string }) {
  const data = colProvenanceCache.get(colId);
  if (!data) return null;
  const source = [data.sourceAlias, data.sourceTitle].filter(Boolean).join(": ");
  // Name only: CoL's scrutinizerDate is a batch timestamp, not the date this
  // record was vetted, so pairing the two states something untrue.
  const scrutiny = data.scrutinizer;
  if (!source && !scrutiny && !data.link) return null;

  const link = (href: string, text: string) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-blue-300 hover:text-blue-200 underline"
    >
      {text}
    </a>
  );
  // The full URL wraps to two or three lines and says less than its host does.
  let recordHost = "";
  if (data.link) {
    try { recordHost = new URL(data.link).hostname.replace(/^www\./, ""); } catch { recordHost = data.link; }
  }

  // A two-column grid rather than inline text: the label column sizes to the
  // longest label, so the values line up instead of starting at three different
  // places.
  return (
    <div className="mt-2 pt-2 border-t border-zinc-600/60 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-zinc-400">
      {scrutiny && (
        <>
          {/* Not CoL's own page label, "Taxonomic scrutiny" — that names the
              activity and reads as a fragment once its date is gone. ColDP
              defines the field as "the person who is the latest scrutinizer who
              revised or reviewed the taxonomic concept", which is a person, so
              the label is a person's. */}
          <span className="text-zinc-500">Reviewed by:</span>
          <span>{scrutiny}</span>
        </>
      )}
      {source && (
        <>
          <span className="text-zinc-500">Source:</span>
          <span>{data.sourceKey != null ? link(colDatasetUrl(data.sourceKey), source) : source}</span>
        </>
      )}
      {data.link && (
        <>
          <span className="text-zinc-500">Original record:</span>
          <span>{link(data.link, recordHost)}</span>
        </>
      )}
    </div>
  );
}


/** Split-off species per tooltip page. A handful of aggregates run long —
 *  Rubus fruticosus has 73 — and the list names every one of them rather than
 *  standing in for the tail, so it pages instead of growing without bound.
 *  Five keeps the panel to a glanceable height: entries wrap to two lines once
 *  the old name is long, which a page of ten often is. */
const SPLIT_PAGE_SIZE = 5;

function RevisionTooltipContent({ flag, name, category }: { flag: ColRevision; name: string; category?: string }) {
  // Resets to the first page on every open: the panel is only mounted while the
  // tooltip is up, so there is no stale page to come back to.
  const [splitPage, setSplitPage] = useState(0);
  // colLink/linkNames now live in revision-links.tsx, shared with the SSC
  // panel's Explanation column so the same finding links the same way in both.
  const colLink = (text: string, colId?: string) => <ColLink text={text} colId={colId} />;
  // The row's own species is a link too, wherever its name appears in the
  // sentence — for reasons that name no second species ("provisional",
  // "extinct flag") it is the only record there is to open, and even where a
  // second species IS named, "what does CoL say about THIS one" is the question
  // the flag raises. A lump's lead also names the CoL species the group is filed
  // under, which is the most useful target in it, so that gets linked too.
  const linkSubject = (text: string): React.ReactNode => linkNames(text, [
    { name, href: colTaxonUrl(flag, name) },
    // For a lump, CoL's accepted name for the shared record — flag.colId IS that
    // record, so it is the right target even when the name is nobody's own.
    ...(flag.lumpedUnder && flag.colId ? [{ name: flag.lumpedUnder, href: colUrl(flag.colId) }] : []),
  ]);

  // A listed group — split-off species, or the other assessments sharing a
  // lumped CoL record. Both name several species, both page, and in both the
  // second name on each row is the evidence, so they render the same way.
  const renderList = (key: string, summary: SplitSummary) => {
    const pages = Math.ceil(summary.entries.length / SPLIT_PAGE_SIZE);
    const from = splitPage * SPLIT_PAGE_SIZE;
    const to = Math.min(from + SPLIT_PAGE_SIZE, summary.entries.length);
    const step = (delta: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setSplitPage((p) => Math.min(pages - 1, Math.max(0, p + delta)));
    };
    const arrow = "px-1 text-zinc-300 hover:text-white disabled:text-zinc-600 disabled:hover:text-zinc-600";
    return (
      <span key={key}>
        {linkSubject(summary.lead)}
        <ul className="mt-1 space-y-0.5">
          {summary.entries.slice(from, to).map((e) => (
            <li key={e.name} className="flex gap-1.5">
              <span aria-hidden className="text-zinc-500">•</span>
              <span>
                {colLink(e.name, e.colId)}
                {e.category && <span className="text-zinc-400"> ({e.category})</span>}
                {/* The old infraspecific name that now resolves to this species
                    IS the evidence for the split, and CoL only shows it from
                    this side — so link it too. */}
                {e.previousName && (
                  <span className="text-zinc-400"> — previously {colLink(e.previousName, e.previousColId)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        {summary.entries.length > SPLIT_PAGE_SIZE && (
          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-zinc-400">
            <button type="button" onClick={step(-1)} disabled={splitPage === 0} className={arrow} aria-label="Previous species">‹</button>
            <span>{from + 1}–{to} of {summary.entries.length}</span>
            <button type="button" onClick={step(1)} disabled={splitPage >= pages - 1} className={arrow} aria-label="More species">›</button>
          </div>
        )}
      </span>
    );
  };

  // The three signals are independent, so each renders on its own terms — a
  // lumped species no longer carries a `reason` at all (see revisionReasons),
  // which is why the lump list can't hang off one.
  //
  // Each carries the code it came from so the block can be headed with the same
  // label the chart uses. Without it the tooltip states a finding without saying
  // which finding, and a reader who filtered by a bar has no way to tell which
  // sentence is the one they clicked.
  const sentences: { code: string; node: React.ReactNode }[] = [];
  const lump = lumpSentence(flag, name, category);
  if (lump) {
    sentences.push({ code: "lumped", node: (
      <span key="lump">
        {lump.before}
        {lump.members.map((m, i) => (
          <React.Fragment key={m.name}>
            {i > 0 && (i === lump.members.length - 1 ? " and " : ", ")}
            {colLink(m.name, m.colId)}
            {m.category && <span className="text-zinc-400"> ({m.category})</span>}
          </React.Fragment>
        ))}
        {lump.mid}
        {lump.under && <>{", "}{colLink(lump.under.name, lump.under.colId)}</>}
        {lump.after}
      </span>
    ) });
  }
  // NOT `else`: see revisionSentences. A species can be lumped AND carry a
  // no-match reason, and its tooltip has to show every finding its own flag is
  // filterable by, or a bar returns a row that never explains itself.
  if (flag.reason != null && !(lump && flag.reason === "lumped")) {
    sentences.push({ code: flag.reason, node: (
      <span key="no-match">
        <NoMatchLine
          flag={flag}
          subject={name}
          extraTargets={flag.lumpedUnder && flag.colId ? [{ name: flag.lumpedUnder, href: colUrl(flag.colId) }] : []}
        />
      </span>
    ) });
  }
  const accepted = acceptedNameSentence(flag, name);
  if (accepted) {
    sentences.push({ code: flag.genusDiffers ? GENUS_DIFFERS_REASON : RENAMED_REASON, node: (
      <span key="accepted">
        {linkSubject(accepted.before)}
        {colLink(accepted.detail, flag.acceptedColId)}
        {accepted.after}
      </span>
    ) });
  }
  const split = splitSummary(flag, name);
  if (split) sentences.push({ code: "split", node: renderList("split", split) });

  return (
    <>
      {/* One block per signal: a species can be both lumped and split, and the
          two are separate findings rather than one running sentence. */}
      <div className="space-y-2.5">
        {sentences.map(({ code, node }, i) => (
          <div key={i}>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-300/80">
              {/* The BAR's words, not the reason's: a reader who filtered by
                  "No 1:1 CoL match" has to recognise the block it returned.
                  The sentence under it still gives the specific reason. */}
              {barForReason(code)?.label ?? REVISION_REASON_SHORT[code] ?? code}
            </div>
            <div className="mt-0.5">{node}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] italic leading-snug text-zinc-400">{REVISION_CAVEAT}</p>
      {flag.colId && <ColProvenanceBlock colId={flag.colId} />}
    </>
  );
}


function GbifInfoTooltip() {
  const [isHovered, setIsHovered] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (isHovered && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
      });
    }
  }, [isHovered]);

  return (
    <span
      ref={triggerRef}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <svg className="w-3 h-3 text-zinc-400 dark:text-zinc-500 cursor-help" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      {isHovered && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[99999] bg-zinc-900 dark:bg-zinc-800 text-white text-[9px] leading-snug rounded px-2 py-1.5 shadow-lg w-64"
          style={{
            top: position.top,
            left: position.left,
            transform: 'translateX(-50%) translateY(-100%)',
          }}
        >
          <div className="font-medium text-[10px] mb-0.5">Georeferenced GBIF records only:</div>
          <div className="text-zinc-400"><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">hasCoordinate=true</code> · <code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">hasGeospatialIssue=false</code></div>
          <div className="font-medium text-zinc-100 mt-1">Included:</div>
          <ul className="text-zinc-300 list-disc list-inside">
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">HUMAN_OBSERVATION</code> <span className="text-zinc-400">(e.g. iNat, eBird)</span></li>
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">MACHINE_OBSERVATION</code> <span className="text-zinc-400">(e.g. camera traps)</span></li>
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">MATERIAL_SAMPLE</code> <span className="text-zinc-400">(e.g. eDNA)</span></li>
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">OCCURRENCE</code></li>
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">OBSERVATION</code></li>
          </ul>
          <div className="font-medium text-zinc-100 mt-1">Plants &amp; fungi also (not animals):</div>
          <ul className="text-zinc-300 list-disc list-inside">
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">PRESERVED_SPECIMEN</code> <span className="text-zinc-400">(e.g. herbaria, fungaria)</span></li>
          </ul>
          <div className="font-medium text-zinc-100 mt-1">Excluded:</div>
          <ul className="text-zinc-300 list-disc list-inside">
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">MATERIAL_CITATION</code> <span className="text-zinc-400">(may include fossils)</span></li>
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">FOSSIL_SPECIMEN</code></li>
            <li><code className="bg-zinc-800 dark:bg-zinc-700 px-0.5 rounded">LIVING_SPECIMEN</code> <span className="text-zinc-400">(e.g. zoos)</span></li>
          </ul>
        </div>,
        document.body
      )}
    </span>
  );
}

interface RedListViewProps {
  viewMode?: "reassessments" | "new-assessments";
  onViewModeChange?: (mode: "reassessments" | "new-assessments") => void;
  sharedTaxa?: Set<string>;
  sharedSubgroups?: Set<string>;
  onTaxaChange?: (taxa: Set<string>) => void;
  onSubgroupsChange?: (subgroups: Set<string>) => void;
  // Namespaces this instance's URL params (e.g. "_b" turns `taxa` into `taxa_b`) so
  // two instances can share one URL without clobbering each other — compare mode's
  // second panel. Defaults to "" (today's single-dashboard behavior).
  paramSuffix?: string;
}

export default function RedListView({ viewMode = "reassessments", onViewModeChange, sharedTaxa, sharedSubgroups, onTaxaChange, onSubgroupsChange, paramSuffix = "" }: RedListViewProps = {}) {
  const isNewAssessments = viewMode === "new-assessments";

  // The ">10 yrs old" outdated threshold is computed against this everywhere
  // in this component (species filtering, the by-year chart, the map, the
  // toggle's tooltip) instead of "today" — TaxaSummary's own table numbers
  // (data/taxa-summary.json) are baked in at the last sync, not live, so
  // computing "outdated" against today's wall-clock date here would drift
  // further from the table's counts the longer it's been since the last
  // rebuild. Falls back to isOutdated/outdatedCutoffDate's own `now =
  // new Date()` default until this resolves (same fetch OutdatedInfoIcon
  // in TaxaSummary.tsx already makes, kept independent rather than shared
  // state since it's a one-off, cached-for-an-hour value either component
  // can fetch on its own).
  const [dataAsOf, setDataAsOf] = useState<Date | undefined>(undefined);
  useEffect(() => {
    fetch("/api/data-sync-date")
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (data?.dataAsOf) setDataAsOf(new Date(data.dataAsOf)); })
      .catch(() => {});
  }, []);

  // The species table scrolls horizontally on narrow screens, so an expanded
  // detail row's `<td colSpan>` is as wide as the (often off-screen) table, not
  // the viewport. Expose the scroll container's *visible* width as a CSS var so
  // the detail panel can size itself to fit the screen instead of overflowing.
  const tableScrollCleanupRef = useRef<(() => void) | null>(null);
  const tableScrollRef = useCallback((el: HTMLDivElement | null) => {
    tableScrollCleanupRef.current?.();
    tableScrollCleanupRef.current = null;
    if (!el) return;
    const update = () => el.style.setProperty("--view-width", `${el.clientWidth}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    tableScrollCleanupRef.current = () => ro.disconnect();
  }, []);
  // Filters synced with URL search params for shareable links
  const {
    layoutMode, setLayoutMode,
    originLayout,
    navigateToTaxonSubgroup,
    exitCountryModeForTaxon,
    returnToLayoutMode,
    enterCountryDrilldown,
    selectedTaxa, setSelectedTaxa,
    selectedSubgroups, setSelectedSubgroups,
    selectedCategories, setSelectedCategories,
    selectedYearRanges, setSelectedYearRanges,
    selectedAssessmentYears, setSelectedAssessmentYears,
    selectedDescribedYears, setSelectedDescribedYears,
    selectedCountries, setSelectedCountries,
    selectedObsRanges, setSelectedObsRanges,
    selectedAssessmentCounts, setSelectedAssessmentCounts,
    selectedSystems, setSelectedSystems,
    selectedPopulationTrends, setSelectedPopulationTrends,
    selectedMovementPatterns, setSelectedMovementPatterns,
    selectedThreats, setSelectedThreats,
    threatsScope, setThreatsScope,
    selectedCriteria, setSelectedCriteria,
    colMatch, setColMatch,
    selectedColReasons, setColReasons,
    selectedHabitat, setSelectedHabitat,
    habitatBreadth, setHabitatBreadth,
    selectedHabitatImportance, setSelectedHabitatImportance,
    selectedHabitatSeasons, setSelectedHabitatSeasons,
    selectedHabitatSuitability, setSelectedHabitatSuitability,
    breakdownFilter, setBreakdownFilter,
    endemicsOnly, setEndemicsOnly,
    selectedGrowthForms, setSelectedGrowthForms,
    selectedAssessors, setSelectedAssessors,
    selectedFacilitators, setSelectedFacilitators,
    selectedContributors, setSelectedContributors,
    selectedInstitutions, setSelectedInstitutions,
    sortField2, sortDirection2, setSort2,
    selectedReviewers, setSelectedReviewers,
    searchFilter, setSearchFilter,
    exactFilters, setExactFilters,
    sortField, sortDirection, setSort,
    mapViewMode, mapSortKey, mapSortDirection, setMapViewMode, setMapSort,
    clearAllFilters,
    clearAllFiltersAndTaxa,
    setViewMode: setUrlViewMode,
    species: urlSpecies, tab: urlTab,
    setSpeciesParam, setTabParam,
    fromPopstateRef,
  } = useFilterParams(paramSuffix);

  // Both habitat checkbox-dropdowns default to "everything checked" (see
  // useFilterParams.ts) — only a proper subset actually restricts anything,
  // so "is this filter active" (for badges/gating/chips) checks that, not
  // just `.size > 0`.
  const habitatImportanceActive = isRestrictiveSelection(selectedHabitatImportance, ALL_HABITAT_IMPORTANCE);
  const habitatSeasonsActive = isRestrictiveSelection(selectedHabitatSeasons, ALL_HABITAT_SEASONS);
  const habitatSuitabilityActive = isRestrictiveSelection(selectedHabitatSuitability, ALL_HABITAT_SUITABILITY);

  const cache = useSpeciesCache();
  const speciesApiUrl = useCallback(
    (taxonId: string, categoryParam: string) => `${SPECIES_API}?taxon=${encodeURIComponent(taxonId)}${categoryParam}`,
    []
  );

  // Country view needs real per-country location data, which Not Evaluated
  // species don't have (no assessment means no assessment_locations row) — see
  // the matching disabled-option guard in TaxaSummary's layoutModeSelect. Exit
  // back to the taxonomic default if New Assessments is switched on while
  // already in country view, rather than leaving an unreachable-but-still-active
  // mode selected.
  useEffect(() => {
    if (isNewAssessments && layoutMode === "country") setLayoutMode(null);
  }, [isNewAssessments, layoutMode, setLayoutMode]);

  // Initialize from shared state on mount (when switching from another view)
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (sharedTaxa && sharedTaxa.size > 0 && selectedTaxa.size === 0) {
      setSelectedTaxa(sharedTaxa);
    }
    if (sharedSubgroups && sharedSubgroups.size > 0 && selectedSubgroups.size === 0) {
      setSelectedSubgroups(sharedSubgroups);
    }
  }, [sharedTaxa, sharedSubgroups, selectedTaxa, selectedSubgroups, setSelectedTaxa, setSelectedSubgroups]);

  // Sync taxa/subgroup changes up to parent
  useEffect(() => {
    onTaxaChange?.(selectedTaxa);
  }, [selectedTaxa, onTaxaChange]);

  useEffect(() => {
    onSubgroupsChange?.(selectedSubgroups);
  }, [selectedSubgroups, onSubgroupsChange]);

  // Sync viewMode prop to URL params (skip initial mount to avoid overwriting URL before page hydrates)
  const viewModeInitializedRef = useRef(false);
  useEffect(() => {
    if (!viewModeInitializedRef.current) {
      viewModeInitializedRef.current = true;
      return;
    }
    setUrlViewMode(viewMode);
  }, [viewMode, setUrlViewMode]);

  // Reset to Assessed whenever the taxon/sub-group selection changes — Not
  // Evaluated is something to opt into per-taxon, not a mode that should
  // silently follow you from one taxon to the next (you'd otherwise land on a
  // brand-new taxon already in NE mode from browsing a previous one, with no
  // visual cue you're not seeing its Assessed data). Skips the very first
  // render so a shared link's own ?view=new-assessments still works.
  const prevSelectionRef = useRef<{ taxa: Set<string>; subgroups: Set<string> } | null>(null);
  useEffect(() => {
    const prev = prevSelectionRef.current;
    prevSelectionRef.current = { taxa: selectedTaxa, subgroups: selectedSubgroups };
    if (prev === null) return;
    // Skip going from no taxa to some taxa too — this is URL hydration
    // (useFilterParams starts empty then populates from URL on mount), not a
    // user browsing to a new taxon. Without this, a shared link combining
    // ?view=new-assessments&taxa=X hydrates its taxa a render after this
    // effect's first (skipped, prev === null) run, so that second run sees
    // an empty→populated transition, misreads it as a real taxon change, and
    // immediately resets straight back to Assessed — the exact case the
    // "very first render" skip above was meant to protect (see the same
    // hydration guard on the "reset all other filters" effect below).
    if (prev.taxa.size === 0 && prev.subgroups.size === 0) return;
    const setsEqual = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));
    const changed = !setsEqual(prev.taxa, selectedTaxa) || !setsEqual(prev.subgroups, selectedSubgroups);
    if (changed && isNewAssessments) onViewModeChange?.("reassessments");
  }, [selectedTaxa, selectedSubgroups, isNewAssessments, onViewModeChange]);

  // Reset mode-specific filter state when switching between reassessments and
  // new-assessments. The shared species cache (SpeciesCacheContext) is NOT cleared
  // here — it's keyed by the exact request URL, which already differs between modes
  // (`?taxon=X` vs `?taxon=X&category=NE`), so each mode's data survives the switch
  // independently and toggling back to a mode already loaded for the current taxon
  // is instant instead of re-fetching from scratch every time.
  const prevViewModeRef = useRef(viewMode);
  useEffect(() => {
    if (prevViewModeRef.current === viewMode) return;
    prevViewModeRef.current = viewMode;
    // Clear assessment-specific filters (preserve search + species so search-bar navigation survives mode
    // switch; also preserve selectedSubgroups — new-assessments mode fetches a selected sub-group directly
    // (see the fetch effect below), so e.g. toggling Unassessed while viewing an SSC group should stay
    // scoped to that group, not fall back to all of Mammals)
    setSelectedCategories(new Set());
    setSelectedYearRanges(new Set());
    setSelectedAssessmentYears(new Set());
    setSelectedDescribedYears(new Set());
    setSelectedCountries(new Set());
    setSelectedObsRanges(new Set());
    setSelectedAssessmentCounts(new Set());
    setSelectedSystems(new Set());
    setSelectedPopulationTrends(new Set());
    setSelectedMovementPatterns(new Set());
    setSelectedThreats(new Set());
    setExpandedThreat(new Set());
    setSelectedCriteria(new Set());
    setExpandedCriteria(new Set());
    setSelectedHabitat(new Set());
    setExpandedHabitat(new Set());
    setHabitatBreadth(null);
    setSelectedHabitatImportance(new Set(ALL_HABITAT_IMPORTANCE));
    setSelectedHabitatSeasons(new Set(ALL_HABITAT_SEASONS));
    setSelectedHabitatSuitability(new Set(ALL_HABITAT_SUITABILITY));
    setEndemicsOnly(false);
    setSelectedGrowthForms(new Set());
    setSelectedAssessors(new Set());
    setSelectedReviewers(new Set());
    setSelectedFacilitators(new Set());
    setSelectedContributors(new Set());
    setSelectedInstitutions(new Set());
    setSort(null, "desc");
    setShowOnlyStarred(false);
    // Clear "all" taxa selection when switching to new-assessments (NE dataset too large for "all")
    if (viewMode === "new-assessments") {
      setSelectedTaxa(prev => prev.has("all") ? new Set<string>() : prev);
    }
  }, [viewMode, setSelectedTaxa, setSelectedCategories, setSelectedYearRanges, setSelectedAssessmentYears, setSelectedDescribedYears, setSelectedCountries, setSelectedObsRanges, setSelectedAssessmentCounts, setSelectedSystems, setSelectedPopulationTrends, setSelectedMovementPatterns, setSelectedThreats, setSelectedCriteria, setSelectedHabitat, setHabitatBreadth, setSelectedHabitatImportance, setSelectedHabitatSeasons, setSelectedHabitatSuitability, setEndemicsOnly, setSelectedGrowthForms, setSelectedAssessors, setSelectedReviewers, setSelectedFacilitators, setSelectedContributors, setSelectedInstitutions, setSort]);

  // Set by the navigations that already produce a complete, fully-specified
  // state in one atomic update (a sub-group selection that also moves the view
  // root, "All Species" resetting everything) — the generic per-field reset
  // effect below must not run a second, partial pass over what they just set.
  const skipClearOnTaxaChangeRef = useRef(false);

  // Taxon toggle handler (used by TaxaSummary)
  // Regular click: select only that taxon (or deselect if already sole selection)
  // Cmd/Ctrl+Click on taxon row: multi-select toggle (expands taxa summary to show all rows)
  const handleToggleTaxon = useCallback((taxonId: string, event: React.MouseEvent) => {
    const isMulti = event.metaKey || event.ctrlKey;

    // Clicking a specific taxon row while browsing a country-scoped bare
    // summary table (Country view, one country selected, no taxon picked yet
    // — see TaxaSummary's countryMode rendering) exits to the full charts+
    // species-table view, still scoped to that country (selectedCountries
    // untouched). Atomic (one history push) via exitCountryModeForTaxon, so
    // a single "back" press cleanly restores the Country View landing page
    // instead of layoutMode and taxa unwinding as separate history entries.
    // The "all" row and multi-select (ctrl/cmd-click) cases fall through to
    // the general path below instead — rarer, and "all" isn't a real taxon
    // drill-down (see its own branch just below).
    if (layoutMode === "country" && taxonId !== "all" && !isMulti) {
      exitCountryModeForTaxon(taxonId);
      return;
    }
    if (layoutMode === "country") setLayoutMode(null);

    // "all" row behavior:
    // - If anything is selected (nested view), return to landing page
    // - Only select "all" when clicking from the landing page itself (nothing selected)
    // Disabled in new-assessments mode (NE dataset too large for "all")
    if (taxonId === "all") {
      if (selectedTaxa.size > 0 || selectedSubgroups.size > 0) {
        if (originLayout === "country") {
          // Came from Country View's landing page via a taxon drill-down
          // (exitCountryModeForTaxon) — return there instead of the generic
          // default view. See originLayout's own doc in useFilterParams.ts.
          // fromPopstateRef first: this taxa non-empty→empty transition is
          // part of one atomic, fully-specified navigation (countries stays
          // as-is), not a generic "taxon deselected" — without the ref, the
          // "reset filters on taxa change" effect below would immediately
          // clear the very countries this navigation means to keep (see its
          // own comment on enterCountryDrilldown for the same escape hatch).
          fromPopstateRef.current = true;
          returnToLayoutMode("country");
          return;
        }
        // Return to the landing page — the same table a fresh visit lands on,
        // so this drops every filter along with the taxa/sub-group selection,
        // the header search bar's `search=` and any open species panel with
        // them. Atomic (clearAllFiltersAndTaxa is one setState + one history
        // push) rather than a taxa-clear that leaves the reset to the effect
        // below: one back-press then returns to the drill-down instead of
        // unwinding through a half-cleared intermediate. The ref tells that
        // effect this transition is already complete, so it doesn't run a
        // second, redundant pass over it.
        skipClearOnTaxaChangeRef.current = true;
        clearAllFiltersAndTaxa();
        setShowOnlyStarred(false);
        return;
      }
      // On landing page: toggle "all" on/off (disabled in new-assessments — NE dataset too large)
      if (isNewAssessments) return;
      setSelectedTaxa(prev => {
        if (prev.has("all")) return new Set<string>();
        return new Set(["all"]);
      });
      return;
    }

    // Single click on already-sole-selected taxon: keep selected (TaxaSummary
    // handles expand/collapse toggle). Clear search/species if active.
    if (!isMulti && selectedTaxa.size === 1 && selectedTaxa.has(taxonId)) {
      if (searchFilter || urlSpecies != null) {
        clearAllFilters();
      }
      return;
    }

    setSelectedTaxa(prev => {
      if (isMulti) {
        // Remove "all" if present when multi-selecting specific taxa
        const next = new Set(prev);
        next.delete("all");
        if (next.has(taxonId)) {
          next.delete(taxonId);
        } else {
          next.add(taxonId);
        }
        return next;
      }
      // Switching to a different taxon — clear subgroups
      setSelectedSubgroups(new Set());
      return new Set([taxonId]);
    });
  }, [setSelectedTaxa, setSelectedSubgroups, selectedTaxa, selectedSubgroups, isNewAssessments, searchFilter, urlSpecies, clearAllFilters, clearAllFiltersAndTaxa, layoutMode, setLayoutMode, exitCountryModeForTaxon, originLayout, returnToLayoutMode, fromPopstateRef]);

  // Reset all other filters when taxa selection changes
  const prevTaxaRef = useRef(selectedTaxa);
  useEffect(() => {
    const prev = prevTaxaRef.current;
    prevTaxaRef.current = selectedTaxa;
    // Consume the popstate flag up front, before any early return below.
    // parseParams builds a fresh Set on every popstate, so this effect re-runs
    // for each one — but a popstate that doesn't *change* the taxa (searching a
    // species from within the taxon it already sits in) used to bail out at the
    // contents check with the flag still raised, and the next genuine taxon
    // click would then read that stale flag and skip its reset entirely,
    // leaving the previous taxon's filters applied to the new one.
    const fromPopstate = fromPopstateRef.current;
    fromPopstateRef.current = false;
    // Skip if taxa haven't actually changed (same reference or same contents)
    if (prev === selectedTaxa) return;
    if (prev.size === selectedTaxa.size && [...selectedTaxa].every(t => prev.has(t))) return;
    // Skip clearing when taxa changed as a side-effect of subgroup selection
    if (skipClearOnTaxaChangeRef.current) {
      skipClearOnTaxaChangeRef.current = false;
      return;
    }
    // Skip clearing when the taxa change came from URL navigation (popstate) —
    // the URL already contains the complete state (e.g. from search bar navigation).
    if (fromPopstate) return;
    // Skip clearing when going from no taxa to some taxa — this happens during
    // URL hydration (useFilterParams starts empty then populates from URL) and
    // there are no taxa-specific filters to reset when nothing was selected before.
    if (prev.size === 0) return;
    clearAllFilters();
    setShowOnlyStarred(false);
  }, [selectedTaxa, clearAllFilters, fromPopstateRef]);

  const [showOnlyStarred, setShowOnlyStarred] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  // Set, not a single string (like expandedCriteria below) — multi-selecting
  // two top-level threats (cmd-click) should show pills below BOTH, not just
  // whichever was clicked last.
  const [expandedThreat, setExpandedThreat] = useState<Set<string>>(new Set());

  // Keep the threats drill-down in sync with the selection. Whenever an expanded
  // top-level category is no longer represented in the selection — because the
  // threats were cleared (Clear all / chip ×), a child was deselected, or the view
  // was reset — collapse that category's pills so no stale level lingers.
  // Independent per category, mirroring expandedCriteria's effect below.
  useEffect(() => {
    setExpandedThreat(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const ec of prev) {
        const stillSelected = Array.from(selectedThreats).some(c => c === ec || c.startsWith(ec + "."));
        if (!stillSelected) { next.delete(ec); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [selectedThreats]);

  // Set, not a single string, so multiple branches can be drilled into and stay open
  // at once (e.g. B1b AND C2a both expanded simultaneously) — needed for proper
  // multi-select across branches; a single "last expanded" value would collapse
  // whichever branch you weren't currently clicking in.
  const [expandedCriteria, setExpandedCriteria] = useState<Set<string>>(new Set());

  // Mirrors the threats drill-down effect above: collapse each expanded branch once
  // it's no longer represented in the selection (independently — clearing one
  // branch's selection doesn't touch another still-selected branch's expansion).
  useEffect(() => {
    setExpandedCriteria(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const ec of prev) {
        const stillSelected = Array.from(selectedCriteria).some(c => c === ec || c.startsWith(ec));
        if (!stillSelected) { next.delete(ec); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [selectedCriteria]);

  // Habitat drill-down — Set-based like expandedThreat above, for the same
  // reason: multi-selecting two top-level habitats should show pills below
  // both.
  const [expandedHabitat, setExpandedHabitat] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedHabitat(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const ec of prev) {
        const stillSelected = Array.from(selectedHabitat).some(c => c === ec || c.startsWith(ec + "."));
        if (!stillSelected) { next.delete(ec); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [selectedHabitat]);

  // Habitat chart pagination — 18 top-level categories is more than
  // comfortably fits in the card's fixed chart height, so page through them
  // (max 10/page) rather than scroll. Clamped inline (not reset via effect)
  // so a shrinking result set after other filters change just lands on the
  // last valid page instead of an empty one.
  const [habitatPage, setHabitatPage] = useState(0);
  const HABITAT_PAGE_SIZE = 10;

  // Assessors/Reviewers chart: one merged, toggleable chart (like an earlier
  // version of this page had) instead of two permanently side-by-side charts
  // — halves the vertical space these together take up, at the cost of one
  // click to see the other list. Local-only UI state, not URL-synced (same as
  // e.g. habitatPage above) since it's a view toggle, not a filter.
  const [assessorReviewerMode, setAssessorReviewerMode] = useState<CreditChartMode>("assessors");
  // Restore the remembered Assessors/Reviewers/Facilitators tab after mount
  // (see the years toggle above for why it is an effect and not an initializer).
  // The tab is display-only — it changes which names are charted, never which
  // species the table shows — so there is no shared-link ambiguity to guard.
  useEffect(() => {
    const stored = readViewPreference("creditChartMode", CREDIT_CHART_MODES);
    if (stored) setAssessorReviewerMode(stored);
  }, []);
  const changeCreditChartMode = useCallback((mode: CreditChartMode) => {
    setAssessorReviewerMode(mode);
    writeViewPreference("creditChartMode", mode);
  }, []);

  // Which credit line the Suggested Experts tab ranks. Remembered like the chart
  // toggle above (someone at BirdLife wants Facilitators every session), but under
  // its own key: the two are different surfaces and picking one shouldn't move the
  // other. A legacy ?tab=assessors/reviewers link names a role explicitly, and an
  // explicit choice in the URL beats the remembered one — so it wins the race with
  // the restore effect by seeding the initial state.
  const roleFromUrlRef = useRef(false);
  const storedRoleAppliedRef = useRef(false);
  const [candidateRole, setCandidateRole] = useState<CreditRole>("assessors");
  useEffect(() => {
    // A legacy ?tab=assessors/reviewers link names a role explicitly, and an
    // explicit choice in the URL beats the remembered one. It arrives LATE:
    // useFilterParams hydrates from window.location in its own mount effect, so
    // urlTab is still null on the first pass through here — which is why this
    // latches when the role turns up rather than reading it once at mount.
    // Opening the tab then rewrites ?tab= to "candidates", and that must not undo
    // it either: without the latch, a ?tab=reviewers link opened on Facilitators
    // for anyone whose remembered choice was Facilitators.
    const legacy = roleFromLegacyTab(urlTab);
    if (legacy) {
      roleFromUrlRef.current = true;
      setCandidateRole(legacy);
      return;
    }
    if (roleFromUrlRef.current || storedRoleAppliedRef.current) return;
    storedRoleAppliedRef.current = true;
    const stored = readViewPreference("candidateRole", CREDIT_ROLES);
    if (stored) setCandidateRole(stored);
  }, [urlTab]);
  const changeCandidateRole = useCallback((role: CreditRole) => {
    setCandidateRole(role);
    writeViewPreference("candidateRole", role);
  }, []);

  // Map/List is URL state (mapview=), so the stored preference applies only
  // when the URL is silent about it — a link that says "list" stays a list for
  // whoever opens it, regardless of what they last chose here.
  const mapPrefRestored = useRef(false);
  useEffect(() => {
    if (mapPrefRestored.current) return;
    mapPrefRestored.current = true;
    if (new URLSearchParams(window.location.search).has("mapview")) return;
    const stored = readViewPreference("countryViewMode", MAP_VIEW_MODES);
    if (stored && stored !== mapViewMode) setMapViewMode(stored);
  }, [mapViewMode, setMapViewMode]);

  const changeMapViewMode = useCallback((mode: MapViewMode) => {
    setMapViewMode(mode);
    writeViewPreference("countryViewMode", mode);
  }, [setMapViewMode]);

  // Breadth/Importance/Season/Suitability dropdown menus in the Habitat card header
  // (replacing a wall of individual toggle buttons — Breadth is a single-select
  // Specialist/Generalist choice, Exclude minor a single checkbox, Season a
  // multi-select list of all 5 IUCN values).
  // Threats card's scope dropdown (threatened-only vs all species).
  const [threatsScopeMenuOpen, setThreatsScopeMenuOpen] = useState(false);
  const threatsScopeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!threatsScopeMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (threatsScopeMenuRef.current && !threatsScopeMenuRef.current.contains(e.target as Node)) {
        setThreatsScopeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [threatsScopeMenuOpen]);

  const [habitatBreadthMenuOpen, setHabitatBreadthMenuOpen] = useState(false);
  const [habitatImportanceMenuOpen, setHabitatImportanceMenuOpen] = useState(false);
  const [habitatSeasonMenuOpen, setHabitatSeasonMenuOpen] = useState(false);
  const [habitatSuitabilityMenuOpen, setHabitatSuitabilityMenuOpen] = useState(false);
  const habitatBreadthMenuRef = useRef<HTMLDivElement>(null);
  const habitatImportanceMenuRef = useRef<HTMLDivElement>(null);
  const habitatSeasonMenuRef = useRef<HTMLDivElement>(null);
  const habitatSuitabilityMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!habitatBreadthMenuOpen && !habitatImportanceMenuOpen && !habitatSeasonMenuOpen && !habitatSuitabilityMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (habitatBreadthMenuRef.current && !habitatBreadthMenuRef.current.contains(e.target as Node)) {
        setHabitatBreadthMenuOpen(false);
      }
      if (habitatImportanceMenuRef.current && !habitatImportanceMenuRef.current.contains(e.target as Node)) {
        setHabitatImportanceMenuOpen(false);
      }
      if (habitatSeasonMenuRef.current && !habitatSeasonMenuRef.current.contains(e.target as Node)) {
        setHabitatSeasonMenuOpen(false);
      }
      if (habitatSuitabilityMenuRef.current && !habitatSuitabilityMenuRef.current.contains(e.target as Node)) {
        setHabitatSuitabilityMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [habitatBreadthMenuOpen, habitatImportanceMenuOpen, habitatSeasonMenuOpen, habitatSuitabilityMenuOpen]);

  // Stable callback for debounced search input
  const handleSearch = useCallback((value: string) => {
    setSearchFilter(value);
  }, [setSearchFilter]);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const PAGE_SIZE = pageSize;

  // ── Data fetching ────────────────────────────────────────────────────
  // Species are fetched and cached in the shared SpeciesCacheContext (keyed by
  // the exact request URL, e.g. `/api/redlist/species?taxon=birds`), not local
  // component state — this is what lets compare mode's two panels share a
  // fetch when they pick the same taxon, and it naturally keeps Assessed vs Not
  // Evaluated data for the same taxon separate too, since their URLs differ
  // (`?taxon=birds` vs `?taxon=birds&category=NE`) without needing an explicit
  // mode-prefixed cache key.
  const error = useMemo(() => {
    if (selectedTaxa.size === 0) return null;
    const fetchSet = isNewAssessments && selectedSubgroups.size > 0 ? [...selectedSubgroups] : [...selectedTaxa];
    const categoryParam = isNewAssessments ? "&category=NE" : "";
    for (const t of fetchSet) {
      if (isNewAssessments && t === "all") continue;
      const err = cache.errors[speciesApiUrl(t, categoryParam)];
      if (err) return err;
    }
    return null;
  }, [selectedTaxa, selectedSubgroups, isNewAssessments, cache.errors, speciesApiUrl]);

  // Prefetch all species on mount so taxa clicks feel instant (skip for new-assessments — NE
  // dataset too large). Idempotent via the shared cache's request() — a no-op once
  // `?taxon=all` is cached or already in flight (e.g. requested by another compare-mode panel,
  // or by the per-taxon effect below reaching "all" first).
  useEffect(() => {
    if (isNewAssessments) return;
    cache.request(`${SPECIES_API}?taxon=all`);
  // Depends on cache.request specifically, not the whole cache object: the
  // linter conservatively wants the whole object for any method call off a
  // hook-returned value, but cache.request's identity only ever changes
  // together with cache.entries (see SpeciesCacheContext) — depending on the
  // whole object here would additionally re-run this effect on every
  // loadingUrls/errors-only update, e.g. another compare-mode panel's fetch
  // completing or failing, which has nothing to do with this taxon.
  }, [isNewAssessments, cache.request]); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine which taxa need fetching, and request them from the shared cache
  useEffect(() => {
    if (selectedTaxa.size === 0) return;

    // In new-assessments mode, a drill-down fetches the SUB-GROUP directly so a sub-group of
    // a too-large aggregate (e.g. crustaceans under invertebrates, beetles under insects)
    // loads on its own instead of being filtered out of the parent's empty (tooLarge) result.
    const fetchSet = isNewAssessments && selectedSubgroups.size > 0
      ? [...selectedSubgroups]
      : [...selectedTaxa];
    const categoryParam = isNewAssessments ? "&category=NE" : "";

    // If "all" is already cached, no individual fetches needed — "all" data covers everything.
    if (cache.entries[speciesApiUrl("all", categoryParam)] && !selectedTaxa.has("all")) return;

    for (const taxonId of fetchSet) {
      if (isNewAssessments && taxonId === "all") continue; // NE dataset too large for "all"
      cache.request(speciesApiUrl(taxonId, categoryParam));
    }
  // cache.entries (for the "all" fast-path check above) + cache.request
  // specifically, not the whole cache object — see the prefetch effect
  // above for why depending on the whole object over-triggers this.
  }, [selectedTaxa, selectedSubgroups, isNewAssessments, cache.entries, cache.request, speciesApiUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Loading" means one of THIS panel's currently-relevant URLs is still in flight —
  // deliberately not "is anything in the shared cache loading", since in compare mode
  // that set can include requests belonging to the other panel entirely.
  const speciesLoading = useMemo(() => {
    if (selectedTaxa.size === 0) return false;
    const fetchSet = isNewAssessments && selectedSubgroups.size > 0 ? [...selectedSubgroups] : [...selectedTaxa];
    const categoryParam = isNewAssessments ? "&category=NE" : "";
    return fetchSet.some(t => !(isNewAssessments && t === "all") && cache.loadingUrls.has(speciesApiUrl(t, categoryParam)));
  }, [selectedTaxa, selectedSubgroups, isNewAssessments, cache.loadingUrls, speciesApiUrl]);

  // Merge species from all fetched taxa relevant to current selection
  const assessedSpecies = useMemo(() => {
    if (selectedTaxa.size === 0) return [];
    const categoryParam = isNewAssessments ? "&category=NE" : "";
    // If "all" is cached for this mode, use it directly
    const allEntry = cache.entries[speciesApiUrl("all", categoryParam)];
    if (allEntry) return allEntry.species;
    // In new-assessments mode a drill-down is fetched per sub-group, so merge those caches
    // when sub-groups are selected; otherwise merge the per-taxon caches.
    const sourceIds = isNewAssessments && selectedSubgroups.size > 0 ? [...selectedSubgroups] : [...selectedTaxa];
    let merged: RedListSpecies[] = [];
    for (const taxonId of sourceIds) {
      const entry = cache.entries[speciesApiUrl(taxonId, categoryParam)];
      if (entry) merged = merged.concat(entry.species);
    }
    return merged;
  }, [selectedTaxa, selectedSubgroups, cache.entries, isNewAssessments, speciesApiUrl]);

  // assessedSpecies already contains NE species in new-assessments mode (the
  // main fetch above handles that); in Assessed mode it's assessed-only.
  const species = assessedSpecies;

  // Filter by selected taxa + subgroup only — no other filters applied. This is
  // the "true total" baseline the Country map tooltip shows alongside its fully
  // filtered count (see countryStatsForMapTotal below), since every memo past
  // this point narrows further.
  const taxaFilteredSpeciesBase = useMemo(() => {
    let filtered = species;
    // In new-assessments mode with a sub-group selected, species were fetched per sub-group
    // (taxon_id = the sub-group), so the speciesMatchesNode filter below is authoritative —
    // skip the parent taxon_id filter, which would otherwise drop them.
    if (selectedTaxa.size > 0 && !selectedTaxa.has("all") && !(isNewAssessments && selectedSubgroups.size > 0)) {
      // Display-root entries (the 8 taxa) match by taxon_id. Any selected taxon
      // that isn't a taxonomy node — an arbitrary rank like ?taxa=turdidae or
      // ?taxa=panthera — is matched against the species' own class/order/family/genus
      // (#261). Genus is derived from the leading word of the scientific name, the
      // same way the server's resolveWhere does it (no genus column exists).
      const arbitrary = [...selectedTaxa].filter((t) => t !== "all" && !findNode(t)).map((t) => t.toLowerCase());
      filtered = filtered.filter((s) =>
        (s.taxon_id != null && selectedTaxa.has(s.taxon_id)) ||
        (arbitrary.length > 0 && arbitrary.some((v) =>
          (s.class_name ?? "").toLowerCase() === v ||
          (s.order_name ?? "").toLowerCase() === v ||
          (s.family ?? "").toLowerCase() === v ||
          matchesBreakdownName(s, "genus", v))),
      );
    }
    if (selectedSubgroups.size > 0) {
      filtered = filtered.filter(s =>
        Array.from(selectedSubgroups).some(sg => speciesMatchesNode(s, sg))
      );
    }
    // Narrow to one breakdown row from a described-species popover (bd= URL param —
    // see TaxaSummary.tsx's BreakdownList). Gated on the filter's own nodeId still
    // being selected: a stale bd= surviving a later, unrelated navigation (any
    // setSelectedSubgroups/setSelectedTaxa call resets it, but this is a second,
    // cheap line of defense) becomes inert instead of silently hiding every species.
    if (breakdownFilter && selectedSubgroups.has(breakdownFilter.nodeId)) {
      filtered = filtered.filter(s => matchesBreakdownName(s, breakdownFilter.rank, breakdownFilter.name, breakdownFilter.nodeId));
      // CoL Match / No CoL Match split within this name's Assessed count (only
      // meaningful for assessed species, which is all `species` is in reassessments
      // mode — the id lists are only ever sent alongside view=reassessments).
      if (breakdownFilter.onlyIds?.length) {
        const ids = new Set(breakdownFilter.onlyIds);
        filtered = filtered.filter(s => s.sis_taxon_id != null && ids.has(s.sis_taxon_id));
      } else if (breakdownFilter.excludeIds?.length) {
        const ids = new Set(breakdownFilter.excludeIds);
        filtered = filtered.filter(s => s.sis_taxon_id == null || !ids.has(s.sis_taxon_id));
      }
    }
    return filtered;
  }, [species, selectedTaxa, selectedSubgroups, isNewAssessments, breakdownFilter]);

  // Exact URL-only base filters (obs / assessment-year / described-year bounds —
  // outdated is applied separately below, not here). Applied here on the base set
  // so every chart AND the table inherit them — and identically to the bucket-free
  // /browse + MCP query, which is what makes an agent's dashboard link reproduce
  // the same species set. Mirrors species-filter numeric bounds.
  const taxaFilteredSpeciesExceptOutdated = useMemo(() => {
    let filtered = taxaFilteredSpeciesBase;
    const { minObs, maxObs, minAssessmentYear, maxAssessmentYear, minDescribedYear, maxDescribedYear } = exactFilters;
    if (minObs != null || maxObs != null) {
      filtered = filtered.filter(s => {
        const obs = s.gbif_occurrence_count ?? 0;
        return (minObs == null || obs >= minObs) && (maxObs == null || obs <= maxObs);
      });
    }
    if (minAssessmentYear != null || maxAssessmentYear != null) {
      filtered = filtered.filter(s => {
        const y = s.assessment_date ? parseInt(s.assessment_date.slice(0, 4), 10) : NaN;
        if (Number.isNaN(y)) return false;
        return (minAssessmentYear == null || y >= minAssessmentYear) && (maxAssessmentYear == null || y <= maxAssessmentYear);
      });
    }
    if (minDescribedYear != null || maxDescribedYear != null) {
      filtered = filtered.filter(s =>
        s.described_year != null
        && (minDescribedYear == null || s.described_year >= minDescribedYear)
        && (maxDescribedYear == null || s.described_year <= maxDescribedYear));
    }
    return filtered;
  }, [taxaFilteredSpeciesBase, exactFilters]);

  // Outdated is excluded from taxaFilteredSpeciesExceptOutdated (above) so the
  // Range/Year chart (which shares this same "when was this species assessed"
  // dimension) can show the full distribution and mute — not remove — bars that
  // don't match the Outdated toggle, mirroring how the Conservation Status chart
  // mutes bars for selectedCategories rather than dropping them. Every other
  // memo/the table uses this outdated-filtered version, so the Outdated button
  // behaves like a real, dashboard-wide filter everywhere except its own chart.
  const taxaFilteredSpeciesNoPreview = useMemo(() => {
    if (!exactFilters.outdated) return taxaFilteredSpeciesExceptOutdated;
    const wantOutdated = exactFilters.outdated === "yes";
    return taxaFilteredSpeciesExceptOutdated.filter(s => isOutdated(s.assessment_date, dataAsOf) === wantOutdated);
  }, [taxaFilteredSpeciesExceptOutdated, exactFilters.outdated, dataAsOf]);

  // Helper to check if species matches year range filter
  const matchesYearRangeFilter = useCallback((assessmentDate: string | null, yearRanges: Set<string> = selectedYearRanges): boolean => {
    if (yearRanges.size === 0) return true;
    if (!assessmentDate) return false;
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const yearsSince = (Date.now() - new Date(assessmentDate).getTime()) / msPerYear;
    for (const range of yearRanges) {
      switch (range) {
        case "<1 year": if (yearsSince < 1) return true; break;
        case "1-5 years": if (yearsSince >= 1 && yearsSince < 5) return true; break;
        case "5-10 years": if (yearsSince >= 5 && yearsSince < 10) return true; break;
        case "10-20 years": if (yearsSince >= 10 && yearsSince < 20) return true; break;
        case "20+ years": if (yearsSince >= 20) return true; break;
      }
    }
    return false;
  }, [selectedYearRanges]);

  // Helper to check if species matches specific assessment year(s) filter
  const matchesAssessmentYearFilter = useCallback((assessmentDate: string | null, years: Set<string> = selectedAssessmentYears): boolean => {
    if (years.size === 0) return true;
    if (!assessmentDate) return false;
    const year = String(new Date(assessmentDate).getFullYear());
    return years.has(year);
  }, [selectedAssessmentYears]);

  // Helper to check if species matches GBIF observation range filter
  const matchesObsRangeFilter = useCallback((obsCount: number | null | undefined, obsRanges: Set<string> = selectedObsRanges): boolean => {
    if (obsRanges.size === 0) return true;
    const obs = obsCount ?? 0;
    for (const range of obsRanges) {
      switch (range) {
        case "0": if (obs === 0) return true; break;
        case "1-10": if (obs >= 1 && obs <= 10) return true; break;
        case "11-100": if (obs >= 11 && obs <= 100) return true; break;
        case "101-1K": if (obs >= 101 && obs <= 1000) return true; break;
        case "1K-10K": if (obs >= 1001 && obs <= 10000) return true; break;
        case "10K+": if (obs > 10000) return true; break;
      }
    }
    return false;
  }, [selectedObsRanges]);

  // Bucket a species' assessment_count into a chart-bar label. 5+ collapses the
  // long tail (a handful of species have 8-9 historical assessments) into one bar.
  const assessmentCountBucket = useCallback((count: number | null | undefined): string => {
    const n = count ?? 1;
    return n >= 5 ? "5+" : String(n);
  }, []);

  // Helper to check if species matches the number-of-assessments filter (#423 item 1)
  const matchesAssessmentCountFilter = useCallback((count: number | null | undefined, counts: Set<string> = selectedAssessmentCounts): boolean => {
    if (counts.size === 0) return true;
    return counts.has(assessmentCountBucket(count));
  }, [selectedAssessmentCounts, assessmentCountBucket]);

  // CoL description-year range bucket for a species (NE/new-assessments only).
  // "Unknown" covers names CoL has no datable source for (chiefly plants/fungi,
  // whose author citations omit the year and lack a dated reference).
  const describedYearBucket = useCallback((year: number | null | undefined): string => {
    if (year == null) return "Unknown";
    if (year < 1900) return "pre-1900";
    if (year < 1950) return "1900-1949";
    if (year < 2000) return "1950-1999";
    if (year < 2010) return "2000-2009";
    if (year < 2020) return "2010-2019";
    return "2020+";
  }, []);

  // Helper to check if species matches the described-year bucket filter
  const matchesDescribedYearFilter = useCallback((year: number | null | undefined, buckets: Set<string> = selectedDescribedYears): boolean => {
    if (buckets.size === 0) return true;
    return buckets.has(describedYearBucket(year));
  }, [selectedDescribedYears, describedYearBucket]);

  // Credits from the latest assessment. These are denormalized inline on the
  // species list (latest_assessors/latest_reviewers/latest_facilitators/
  // latest_contributors/latest_institutions) so the filters work without the
  // full history array (which is fetched lazily for the detail panel).
  const getSpeciesAssessors = useCallback((s: Species): string[] => {
    return parseAssessors(s.latest_assessors);
  }, []);

  const getSpeciesReviewers = useCallback((s: Species): string[] => {
    return parseAssessors(s.latest_reviewers);
  }, []);

  // Facilitators are the individuals behind an organisational assessor. Every
  // bird assessment credits "BirdLife International" as the assessor, so the
  // assessor filter cannot pick out one person's work — the facilitator can.
  const getSpeciesFacilitators = useCallback((s: Species): string[] => {
    return parseAssessors(s.latest_facilitators);
  }, []);

  // Contributors are credited without being assessor or reviewer — workshop
  // participants, data providers. The longest of the credit lines by a distance
  // (~8.5 names per assessment), so this is the costliest getter to run.
  const getSpeciesContributors = useCallback((s: Species): string[] => {
    return parseAssessors(s.latest_contributors);
  }, []);

  // Institutions are organisations, not people — see parseInstitutions, which
  // the /browse + MCP filter shares so both surfaces split a line the same way.
  const getSpeciesInstitutions = useCallback((s: Species): string[] => {
    return parseInstitutions(s.latest_institutions);
  }, []);

  // Track which view is active in the years-since-assessed chart ("range" buckets vs specific year).
  // Defaults to "year" when a specific-year filter is already active (e.g. from URL).
  const [yearsChartMode, setYearsChartMode] = useState<"range" | "year">(
    () => (selectedAssessmentYears.size > 0 ? "year" : "range")
  );
  // If the URL hydrates with specific years — or an explicit min/max year range
  // (still accepted from /browse, the MCP server and hand-built links, though
  // the UI now selects years by shift+dragging the chart) — surface the year
  // view, so a shared link opens on the chart its filter applies to.
  useEffect(() => {
    if (selectedAssessmentYears.size > 0
      || exactFilters.minAssessmentYear != null
      || exactFilters.maxAssessmentYear != null) {
      setYearsChartMode("year");
    }
  }, [selectedAssessmentYears, exactFilters.minAssessmentYear, exactFilters.maxAssessmentYear]);

  // Restore the remembered Range/Year choice — after mount, not in the state
  // initializer, so server and first client render agree. Skipped when the URL
  // already implies a view (specific years, or an explicit year range), which
  // must win so a shared link renders the same for whoever opens it.
  const yearsPrefRestored = useRef(false);
  useEffect(() => {
    if (yearsPrefRestored.current) return;
    yearsPrefRestored.current = true;
    if (selectedAssessmentYears.size > 0) return;
    if (exactFilters.minAssessmentYear != null || exactFilters.maxAssessmentYear != null) return;
    const stored = readViewPreference("yearsChartMode", YEARS_CHART_MODES);
    if (stored) setYearsChartMode(stored);
  }, [selectedAssessmentYears, exactFilters.minAssessmentYear, exactFilters.maxAssessmentYear]);

  // One place that both moves the toggle and remembers it, so the two can't
  // drift apart (every caller goes through this rather than setYearsChartMode).
  const changeYearsChartMode = useCallback((mode: "range" | "year") => {
    setYearsChartMode(mode);
    writeViewPreference("yearsChartMode", mode);
  }, []);
  // Paginate the by-year chart: show 10 years at a time, defaulting to the most recent
  const YEARS_PAGE_SIZE = 10;
  const [yearsPage, setYearsPage] = useState(0);

  // Helper to check if species matches the assessors filter.
  // Case-insensitive SUBSTRING match — same semantics as the /browse + MCP
  // `assessors` filter, so an agent's dashboard link reproduces the same set.
  // (A chart click adds a full name, which substring-matches itself; the only
  // difference is the rare case where one full name is a substring of another.)
  const matchesAssessorsFilter = useCallback((s: Species): boolean => {
    if (selectedAssessors.size === 0) return true;
    const sels = [...selectedAssessors].map(x => x.toLowerCase());
    return getSpeciesAssessors(s).some(a => { const al = a.toLowerCase(); return sels.some(x => al.includes(x)); });
  }, [selectedAssessors, getSpeciesAssessors]);

  // Helper to check if species matches the reviewers filter (substring, as above).
  const matchesReviewersFilter = useCallback((s: Species): boolean => {
    if (selectedReviewers.size === 0) return true;
    const sels = [...selectedReviewers].map(x => x.toLowerCase());
    return getSpeciesReviewers(s).some(r => { const rl = r.toLowerCase(); return sels.some(x => rl.includes(x)); });
  }, [selectedReviewers, getSpeciesReviewers]);

  // Helper to check if species matches the facilitators filter (substring, as above).
  const matchesFacilitatorsFilter = useCallback((s: Species): boolean => {
    if (selectedFacilitators.size === 0) return true;
    const sels = [...selectedFacilitators].map(x => x.toLowerCase());
    return getSpeciesFacilitators(s).some(f => { const fl = f.toLowerCase(); return sels.some(x => fl.includes(x)); });
  }, [selectedFacilitators, getSpeciesFacilitators]);

  // Helper to check if species matches the contributors filter (substring, as above).
  const matchesContributorsFilter = useCallback((s: Species): boolean => {
    if (selectedContributors.size === 0) return true;
    const sels = [...selectedContributors].map(x => x.toLowerCase());
    return getSpeciesContributors(s).some(c => { const cl = c.toLowerCase(); return sels.some(x => cl.includes(x)); });
  }, [selectedContributors, getSpeciesContributors]);

  // Helper to check if species matches the institutions filter (substring, as above).
  const matchesInstitutionsFilter = useCallback((s: Species): boolean => {
    if (selectedInstitutions.size === 0) return true;
    const sels = [...selectedInstitutions].map(x => x.toLowerCase());
    return getSpeciesInstitutions(s).some(i => { const il = i.toLowerCase(); return sels.some(x => il.includes(x)); });
  }, [selectedInstitutions, getSpeciesInstitutions]);

  // Possible-taxonomic-revision filter (#col-match): `colMatch` is the coarse
  // toggle — "flagged" = this species has no clean 1:1 Catalogue of Life match,
  // "clean" = it does — and `selectedColReasons` narrows the flagged bucket to
  // specific reasons (lumped, subspecies, not-in-checklist…). Selecting a reason
  // implies flagged, so it doesn't need the toggle set as well. Same shape as
  // habitatBreadth + selectedHabitat.
  const matchesColFilter = useCallback(
    (s: Species): boolean => matchesRevisionFilter(s.col_revision, colMatch, selectedColReasons),
    [colMatch, selectedColReasons],
  );

  // Is either half of that filter active? The ⚑ marker on a species row keys off
  // this — see the row itself for why the flag is opt-in rather than always on.
  const colFilterActive = colMatch != null || selectedColReasons.size > 0;

  // Consolidates all 5 habitat-related filters into one predicate (rather than 5
  // separate inline checks repeated at every filter site) since major/resident both
  // need the full parsed entry list, not just codes — cheaper to parse once per
  // species per call than to re-derive it 2-3x over.
  // The specialists/exclude-minor/season/suitability logic itself lives in
  // @/lib/habitat-filter (a pure function, unit tested) — this just binds it to
  // the component's current filter state.
  const matchesHabitatFilter = useCallback((s: Species): boolean =>
    matchesHabitatCriteria(s.habitat_codes, {
      selectedHabitat,
      breadth: habitatBreadth,
      importance: selectedHabitatImportance,
      seasons: selectedHabitatSeasons,
      suitability: selectedHabitatSuitability,
    }),
  [selectedHabitat, habitatBreadth, selectedHabitatImportance, selectedHabitatSeasons, selectedHabitatSuitability]);

  // The threat filter, in one place — every chart's cross-filtered count and the
  // species table itself run this, so they can't disagree about what a selected
  // threat means. Two parts:
  //  - the code match itself: prefix-based, so picking a top-level category
  //    ("11") matches every sub-threat under it ("11.1", "11.4", …);
  //  - the scope: under the default "threatened" scope a threat selection ALSO
  //    excludes non-threatened species. IUCN's feedback is that threat coding is
  //    only reliable for CR/EN/VU assessments, so filtering by a threat shouldn't
  //    surface species whose threat data isn't trustworthy — and the Threats
  //    chart's bars (see threatCounts) then count exactly the species that
  //    clicking them selects. "All species" opts back in to the fuller data.
  // Inert while nothing is selected: the scope narrows the threat axis, it is
  // not a standing "threatened only" filter on the whole dashboard.
  const matchesThreatFilter = useCallback((s: Species): boolean => {
    if (selectedThreats.size === 0) return true;
    if (threatsScope === "threatened" && !THREATENED_SET.has(s.category)) return false;
    return s.threat_codes?.some(tc => Array.from(selectedThreats).some(sel => tc === sel || tc.startsWith(sel + "."))) ?? false;
  }, [selectedThreats, threatsScope]);

  // Species details cache (images, criteria, common names)
  const [speciesDetails, setSpeciesDetails] = useState<Record<string, SpeciesDetails>>({});
  // Lazy assessment-history cache, keyed by sis_taxon_id. The species list no
  // longer carries the full history array; it's fetched when a detail row opens.
  const [assessmentHistory, setAssessmentHistory] = useState<Record<number, Species["previous_assessments"]>>({});
  // Catalogue of Life synonyms for the open species (detail panel's CoL tab), fetched lazily.
  type SynInfo = { col_id: string | null; accepted_name: string | null; accepted_authorship: string | null; synonyms: { name: string; authorship: string | null; status: string }[] };
  const [synonymsBySpecies, setSynonymsBySpecies] = useState<Record<string, SynInfo>>({});

  // Row expansion state (initialized from URL params if present)
  const [selectedSpeciesKey, setSelectedSpeciesKeyRaw] = useState<string | null>(urlSpecies);
  const [activeDetailTab, setActiveDetailTabRaw] = useState<DetailTab>(visibleTab(urlTab));
  // Track which tabs have been visited so we only mount (and fetch data for) a tab on first click
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(new Set([visibleTab(urlTab)]));
  const urlSpeciesHandledRef = useRef(false);
  // Track whether a tab change was initiated programmatically (click) vs URL navigation (popstate)
  const programmaticTabChangeRef = useRef(false);
  // Whether the user has explicitly picked a tab for the currently open species.
  // When the occurrence tab turns up no records for a not-evaluated species we
  // auto-switch to Catalogue of Life — but only while the user hasn't chosen a tab.
  const manualTabSelectionRef = useRef(false);
  // Guards the auto-switch so it fires at most once per opened species.
  const autoColSwitchedRef = useRef(false);

  // Wrap setters to sync with URL
  const setSelectedSpeciesKey = useCallback((key: string | null) => {
    setSelectedSpeciesKeyRaw(key);
    setSpeciesParam(key, key != null ? "gbif" : "gbif");
    if (key != null) {
      setActiveDetailTabRaw("gbif");
      setVisitedTabs(new Set(["gbif"]));
      manualTabSelectionRef.current = false;
      autoColSwitchedRef.current = false;
    }
  }, [setSpeciesParam]);

  const setActiveDetailTab = useCallback((tab: DetailTab, isManual = true) => {
    setActiveDetailTabRaw(tab);
    programmaticTabChangeRef.current = true;
    if (isManual) manualTabSelectionRef.current = true;
    setTabParam(tab);
    setVisitedTabs(prev => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, [setTabParam]);

  // When the occurrence tab (GBIF + iNat) reports no records for a not-evaluated
  // species, fall back to the Catalogue of Life tab — unless the user has already
  // navigated to a tab themselves.
  const handleOccurrenceEmpty = useCallback(() => {
    if (manualTabSelectionRef.current || autoColSwitchedRef.current) return;
    autoColSwitchedRef.current = true;
    setActiveDetailTab("col", false);
  }, [setActiveDetailTab]);
  // Sync species/tab from URL params (fires on popstate, e.g. back/forward or search bar navigation).
  // The param IS the row key (`sis-…`/`col-…`), so it needs no per-view translation.
  useEffect(() => {
    if (urlSpecies != null) {
      // Skip visitedTabs reset for programmatic (click) tab changes – only reset on URL navigation
      if (programmaticTabChangeRef.current) {
        programmaticTabChangeRef.current = false;
        return;
      }
      setSelectedSpeciesKeyRaw(urlSpecies);
      setActiveDetailTabRaw(visibleTab(urlTab));
      setVisitedTabs(new Set([visibleTab(urlTab)]));
      // A tab pinned in the URL counts as an explicit choice, so don't auto-switch.
      manualTabSelectionRef.current = visibleTab(urlTab) !== "gbif";
      autoColSwitchedRef.current = false;
      urlSpeciesHandledRef.current = false; // allow auto-page-navigate for new species
    } else {
      // `species=` is gone — close the detail panel. Not just the back button:
      // navigating to another taxa/sub-group row drops the species drill-down
      // with it (SPECIES_SCOPED_RESET in useFilterParams), and without this the
      // row expansion is local state that would keep the old species' panel
      // open under a table it no longer belongs to.
      setSelectedSpeciesKeyRaw(null);
      setActiveDetailTabRaw("gbif");
      setVisitedTabs(new Set(["gbif"]));
      manualTabSelectionRef.current = false;
      autoColSwitchedRef.current = false;
      urlSpeciesHandledRef.current = false;
    }
  }, [urlSpecies, urlTab]);

  // Single-species fast path: use cached search result to render the detail panel
  // immediately without waiting for the bulk table to load.
  const [singleSpeciesPreview, setSingleSpeciesPreview] = useState<RedListSpecies | null>(null);
  useEffect(() => {
    if (urlSpecies == null) {
      setSingleSpeciesPreview(null);
      return;
    }
    // Skip if species is already in bulk-loaded data
    const bulkTaxon = selectedTaxa.size === 1 ? [...selectedTaxa][0] : "all";
    const bulkUrl = speciesApiUrl(bulkTaxon, isNewAssessments ? "&category=NE" : "");
    const allSpecies = cache.entries[bulkUrl]?.species ?? [];
    if (allSpecies.some(s => s.species_key === urlSpecies)) {
      setSingleSpeciesPreview(null);
      return;
    }

    // Use cached search result to construct preview (no API call needed)
    const cached = getLastSearchResult();
    if (cached && cached.species_key === urlSpecies) {
      clearLastSearchResult();
      setSingleSpeciesPreview(previewFromSearchResult(cached));
      urlSpeciesHandledRef.current = true;
      return;
    }

    // Reload or shared link: the cached result only survives an in-page search, so
    // re-resolve the species by the name the search bar left in `search=`. Without this
    // the link renders an empty list whenever the taxon's own list doesn't carry the
    // species — while it's still loading, or permanently for one excluded from the
    // not-evaluated universe by a CoL id collision (see taxaFilteredSpecies).
    if (!searchFilter) return;
    let cancelled = false;
    fetch(`/api/search?q=${encodeURIComponent(searchFilter)}&limit=10`)
      .then(r => (r.ok ? r.json() : null))
      .then((data: { results?: SearchResult[] } | null) => {
        if (cancelled || !data) return;
        const hit = data.results?.find(r => r.species_key === urlSpecies);
        if (!hit) return;
        setSingleSpeciesPreview(previewFromSearchResult(hit));
        urlSpeciesHandledRef.current = true;
      })
      .catch(() => { /* preview is a nicety — the list path still applies */ });
    return () => { cancelled = true; };
  }, [urlSpecies]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear preview once the species appears in bulk-loaded data
  useEffect(() => {
    if (!singleSpeciesPreview) return;
    if (assessedSpecies.some(s => s.species_key === singleSpeciesPreview.species_key)) {
      setSingleSpeciesPreview(null);
    }
  }, [assessedSpecies, singleSpeciesPreview]);

  // Fold the searched species (?species=, previewed from the cached search result) into the
  // species set the charts and table are built from, so the single-species view resolves
  // while the taxon's own list is still loading — or when that list simply doesn't contain
  // it. The latter is real: an NE species whose CoL id was claimed by an assessed congener
  // (a synonym mismatch — Pararge aegeria's id is held by the assessed Pararge xiphioides)
  // is filtered out of the not-evaluated universe as "already assessed", so search is the
  // only way to reach it and the list it lands in will never list it.
  // Dedupe by row key alone. This used to need a name-equality fallback for NE species,
  // because a row from the NE list was keyed on its CoL id while the same species from
  // search was keyed on its GBIF one — two different keys for one species. Both sides
  // resolve through species_link to the same `col-…` key now, so the keys match.
  const taxaFilteredSpecies = useMemo(() => {
    if (!singleSpeciesPreview) return taxaFilteredSpeciesNoPreview;
    if (taxaFilteredSpeciesNoPreview.some(s => s.species_key === singleSpeciesPreview.species_key)) {
      return taxaFilteredSpeciesNoPreview;
    }
    return [singleSpeciesPreview, ...taxaFilteredSpeciesNoPreview];
  }, [taxaFilteredSpeciesNoPreview, singleSpeciesPreview]);

  const [mounted, setMounted] = useState(false);


  // Pinned species as ordered array (persisted to localStorage)
  const [pinnedSpecies, setPinnedSpecies] = useState<string[]>([]);
  const pinnedSet = useMemo(() => new Set(pinnedSpecies), [pinnedSpecies]); // For O(1) lookup

  // Drag state for reordering pinned species
  const [draggedSpecies, setDraggedSpecies] = useState<string | null>(null);
  const [dragOverSpecies, setDragOverSpecies] = useState<string | null>(null);

  const pinnedStorageKey = isNewAssessments ? "new-assessments-pinned-species" : "redlist-pinned-species";

  useEffect(() => {
    setMounted(true);
  }, []);

  // Load pinned species from localStorage (re-load when viewMode changes)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(pinnedStorageKey);
      // Pins were stored as numbers before the key was namespaced; migrate in place so
      // existing pins survive (assessed ones exactly — see migratePinnedSpecies).
      setPinnedSpecies(migratePinnedSpecies(stored ? JSON.parse(stored) : []));
    } catch {
      setPinnedSpecies([]);
    }
  }, [pinnedStorageKey]);

  // Save pinned species to localStorage
  const savePinnedSpecies = (newPinned: string[]) => {
    setPinnedSpecies(newPinned);
    try {
      localStorage.setItem(pinnedStorageKey, JSON.stringify(newPinned));
    } catch {
      // Ignore localStorage errors
    }
  };

  // Toggle pin status
  const togglePinned = (speciesKey: string) => {
    if (pinnedSet.has(speciesKey)) {
      savePinnedSpecies(pinnedSpecies.filter(k => k !== speciesKey));
    } else {
      savePinnedSpecies([...pinnedSpecies, speciesKey]);
    }
  };

  // Drag handlers for reordering
  const handleDragStart = (e: React.DragEvent, speciesKey: string) => {
    if (!pinnedSet.has(speciesKey)) return;
    setDraggedSpecies(speciesKey);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, speciesKey: string) => {
    e.preventDefault();
    if (!draggedSpecies || !pinnedSet.has(speciesKey)) return;
    setDragOverSpecies(speciesKey);
  };

  const handleDragLeave = () => {
    setDragOverSpecies(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedSpecies || draggedSpecies === targetId) {
      setDraggedSpecies(null);
      setDragOverSpecies(null);
      return;
    }

    const draggedIdx = pinnedSpecies.indexOf(draggedSpecies);
    const targetIdx = pinnedSpecies.indexOf(targetId);

    if (draggedIdx === -1 || targetIdx === -1) {
      setDraggedSpecies(null);
      setDragOverSpecies(null);
      return;
    }

    // Reorder the array
    const newPinned = [...pinnedSpecies];
    newPinned.splice(draggedIdx, 1);
    newPinned.splice(targetIdx, 0, draggedSpecies);
    savePinnedSpecies(newPinned);

    setDraggedSpecies(null);
    setDragOverSpecies(null);
  };

  const handleDragEnd = () => {
    setDraggedSpecies(null);
    setDragOverSpecies(null);
  };

  // ── Cross-filter chart data (client-computed) ────────────────────────

  const matchesSearch = useCallback((s: Species) => {
    if (!searchFilter) return true;
    return s.scientific_name.toLowerCase().includes(searchFilter) ||
      !!s.common_name?.toLowerCase().includes(searchFilter);
  }, [searchFilter]);

  // Category chart: apply all filters EXCEPT category
  const categoryDataWithPercent = useMemo(() => {
    const counts: Record<string, number> = {};
    taxaFilteredSpecies.forEach(s => {
      if (s.category === "NE") return;
      if (!matchesSearch(s)) return;
      if (selectedCountries.size > 0 && !s.countries.some(c => selectedCountries.has(c))) return;
      if (selectedYearRanges.size > 0 && !matchesYearRangeFilter(s.assessment_date, selectedYearRanges)) return;
      if (selectedAssessmentYears.size > 0 && !matchesAssessmentYearFilter(s.assessment_date, selectedAssessmentYears)) return;
      if (selectedObsRanges.size > 0 && !matchesObsRangeFilter(s.gbif_occurrence_count, selectedObsRanges)) return;
      if (selectedAssessmentCounts.size > 0 && !matchesAssessmentCountFilter(s.assessment_count, selectedAssessmentCounts)) return;
      if (selectedSystems.size > 0 && !s.systems?.some(sys => selectedSystems.has(sys))) return;
      if (selectedPopulationTrends.size > 0 && (!s.population_trend || !selectedPopulationTrends.has(s.population_trend))) return;
      if (selectedMovementPatterns.size > 0 && (!s.movement_pattern || !selectedMovementPatterns.has(s.movement_pattern))) return;
      if (!matchesThreatFilter(s)) return;
      if (selectedCriteria.size > 0 && !parseCriteriaCodes(s.criteria).some(code => Array.from(selectedCriteria).some(sel => code === sel || code.startsWith(sel)))) return;
      if (endemicsOnly && s.countries.length !== 1) return;
      if (selectedGrowthForms.size > 0 && !s.growth_forms?.some(gf => selectedGrowthForms.has(gf))) return;
      if (!matchesAssessorsFilter(s)) return;
      if (!matchesHabitatFilter(s)) return;
      if (!matchesReviewersFilter(s)) return;
      if (!matchesFacilitatorsFilter(s)) return;
      if (!matchesContributorsFilter(s)) return;
      if (!matchesInstitutionsFilter(s)) return;
      if (!matchesColFilter(s)) return;
      counts[s.category] = (counts[s.category] || 0) + 1;
    });
    const DISPLAY_ORDER = ["EX", "EW", "CR", "EN", "VU", "NT", "LC", "DD"];
    const total = DISPLAY_ORDER.reduce((sum, code) => sum + (counts[code] || 0), 0);
    return DISPLAY_ORDER.map(code => ({
      code,
      name: code,
      count: counts[code] || 0,
      color: CATEGORY_COLORS[code] || "#999",
      percent: total > 0 ? Math.round(((counts[code] || 0) / total) * 100) : 0,
      label: `${(counts[code] || 0).toLocaleString()} (${total > 0 ? Math.round(((counts[code] || 0) / total) * 100) : 0}%)`,
    }));
  }, [taxaFilteredSpecies, selectedCountries, selectedYearRanges, selectedObsRanges, selectedSystems, selectedPopulationTrends, selectedMovementPatterns, matchesThreatFilter, selectedCriteria, matchesHabitatFilter, endemicsOnly, selectedGrowthForms, matchesSearch, matchesAssessorsFilter, matchesReviewersFilter, matchesFacilitatorsFilter, matchesContributorsFilter, matchesInstitutionsFilter, matchesColFilter, matchesObsRangeFilter, selectedAssessmentCounts, matchesAssessmentCountFilter, matchesYearRangeFilter, selectedAssessmentYears, matchesAssessmentYearFilter]);

  // Year chart: apply all filters EXCEPT year range AND outdated (see
  // taxaFilteredSpeciesExceptOutdated above) — buckets align exactly with the
  // ── One filter predicate for every cross-filter chart ────────────────
  //
  // Each chart shows what WOULD match if you clicked a bar, so each applies
  // every filter except the axis it is itself the control for — Threats applies
  // everything but the threat selection, and so on. That used to be twelve
  // hand-maintained copies of the same clause list, which drifted: the
  // taxonomic-revision filter was added to all twelve and still missed the
  // credits chart (a thirteenth copy in matchesNonCreditFilters), which then
  // reported unfiltered counts until it was spotted.
  //
  // Now the clause list lives once and each caller passes the axes it skips, so
  // "what does this chart deliberately ignore?" is a visible argument rather
  // than an absence you have to notice. The skip sets below are exactly what the
  // old inline chains did, quirks included — see SKIP_THREATS et al.
  const matchesFilters = useCallback((s: Species, skip: ReadonlySet<FilterAxis>): boolean => {
    if (!skip.has("search") && !matchesSearch(s)) return false;
    if (!skip.has("categories") && selectedCategories.size > 0 && !selectedCategories.has(s.category)) return false;
    if (!skip.has("countries") && selectedCountries.size > 0 && !s.countries.some(c => selectedCountries.has(c))) return false;
    // Year filters are gated on NE throughout: an unassessed species has no
    // assessment date to compare against.
    if (!skip.has("years") && s.category !== "NE" && selectedYearRanges.size > 0 && !matchesYearRangeFilter(s.assessment_date, selectedYearRanges)) return false;
    if (!skip.has("assessmentYears") && s.category !== "NE" && selectedAssessmentYears.size > 0 && !matchesAssessmentYearFilter(s.assessment_date, selectedAssessmentYears)) return false;
    if (!skip.has("obs") && selectedObsRanges.size > 0 && !matchesObsRangeFilter(s.gbif_occurrence_count, selectedObsRanges)) return false;
    if (!skip.has("assessmentCounts") && selectedAssessmentCounts.size > 0 && !matchesAssessmentCountFilter(s.assessment_count, selectedAssessmentCounts)) return false;
    if (!skip.has("systems") && selectedSystems.size > 0 && !s.systems?.some(sys => selectedSystems.has(sys))) return false;
    if (!skip.has("trends") && selectedPopulationTrends.size > 0 && (!s.population_trend || !selectedPopulationTrends.has(s.population_trend))) return false;
    if (!skip.has("movement") && selectedMovementPatterns.size > 0 && (!s.movement_pattern || !selectedMovementPatterns.has(s.movement_pattern))) return false;
    if (!skip.has("threats") && !matchesThreatFilter(s)) return false;
    if (!skip.has("criteria") && selectedCriteria.size > 0 && !parseCriteriaCodes(s.criteria).some(code => Array.from(selectedCriteria).some(sel => code === sel || code.startsWith(sel)))) return false;
    if (!skip.has("endemics") && endemicsOnly && s.countries.length !== 1) return false;
    if (!skip.has("growthForms") && selectedGrowthForms.size > 0 && !s.growth_forms?.some(gf => selectedGrowthForms.has(gf))) return false;
    if (!skip.has("assessors") && !matchesAssessorsFilter(s)) return false;
    if (!skip.has("habitat") && !matchesHabitatFilter(s)) return false;
    if (!skip.has("reviewers") && !matchesReviewersFilter(s)) return false;
    if (!skip.has("facilitators") && !matchesFacilitatorsFilter(s)) return false;
    if (!skip.has("contributors") && !matchesContributorsFilter(s)) return false;
    if (!skip.has("institutions") && !matchesInstitutionsFilter(s)) return false;
    if (!skip.has("revision") && !matchesColFilter(s)) return false;
    return true;
  }, [matchesSearch, selectedCategories, selectedCountries, selectedYearRanges, matchesYearRangeFilter,
      selectedAssessmentYears, matchesAssessmentYearFilter, selectedObsRanges, matchesObsRangeFilter,
      selectedAssessmentCounts, matchesAssessmentCountFilter, selectedSystems, selectedPopulationTrends,
      selectedMovementPatterns, matchesThreatFilter, selectedCriteria, endemicsOnly, selectedGrowthForms,
      matchesAssessorsFilter, matchesHabitatFilter, matchesReviewersFilter, matchesFacilitatorsFilter,
      matchesContributorsFilter, matchesInstitutionsFilter, matchesColFilter]);

  // isOutdated() threshold (>10 years) so the Outdated toggle mutes rather than
  // zeroes out the buckets that don't match.
  const assessmentYearData = useMemo(() => {
    const now = Date.now();
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const ranges = [
      { range: "<1 year", shortRange: "<1y", count: 0, minYear: 0 },
      { range: "1-5 years", shortRange: "1-5y", count: 0, minYear: 1 },
      { range: "5-10 years", shortRange: "5-10y", count: 0, minYear: 5 },
      { range: "10-20 years", shortRange: "10-20y", count: 0, minYear: 10 },
      { range: "20+ years", shortRange: ">20y", count: 0, minYear: 20 },
    ];
    taxaFilteredSpeciesExceptOutdated.forEach(s => {
      if (!matchesFilters(s, SKIP_YEARS)) return;
      if (!s.assessment_date || s.category === "NE") return;
      const yearsSince = (now - new Date(s.assessment_date).getTime()) / msPerYear;
      if (yearsSince < 1) ranges[0].count++;
      else if (yearsSince < 5) ranges[1].count++;
      else if (yearsSince < 10) ranges[2].count++;
      else if (yearsSince < 20) ranges[3].count++;
      else ranges[4].count++;
    });
    const total = ranges.reduce((sum, r) => sum + r.count, 0);
    return ranges.map(r => ({
      ...r,
      label: `${r.count.toLocaleString()} (${total > 0 ? Math.round((r.count / total) * 100) : 0}%)`,
    }));
  }, [taxaFilteredSpeciesExceptOutdated, matchesFilters]);

  // Assessments-by-year chart: apply all filters EXCEPT the year-based ones
  // (selectedYearRanges, selectedAssessmentYears) AND outdated. The Range bucket
  // chart and the Year chart share a single cross-filter facet ("when was this
  // species assessed"), so we exclude selectedYearRanges/selectedAssessmentYears
  // here — the by-year chart should always show the full timeline so users can
  // switch/expand their year selection regardless of what they picked in the
  // range view, and vice-versa — and we exclude outdated for the same reason
  // isOutdated is excluded from assessmentYearData above.
  const assessmentYearsByYearData = useMemo(() => {
    const counts: Record<string, number> = {};
    taxaFilteredSpeciesExceptOutdated.forEach(s => {
      if (!matchesFilters(s, SKIP_YEARS)) return;
      if (!s.assessment_date || s.category === "NE") return;
      const year = String(new Date(s.assessment_date).getFullYear());
      counts[year] = (counts[year] || 0) + 1;
    });
    const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
    // Sort years ascending so the horizontal chart reads chronologically (oldest → newest)
    return Object.entries(counts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([year, count]) => ({
        code: year,
        count,
        label: `${count.toLocaleString()} (${total > 0 ? Math.round((count / total) * 100) : 0}%)`,
      }));
  }, [taxaFilteredSpeciesExceptOutdated, matchesFilters]);

  const yearsTotalPages = Math.max(1, Math.ceil(assessmentYearsByYearData.length / YEARS_PAGE_SIZE));
  const paginatedAssessmentYearsData = useMemo(
    () => assessmentYearsByYearData.slice(yearsPage * YEARS_PAGE_SIZE, (yearsPage + 1) * YEARS_PAGE_SIZE),
    [assessmentYearsByYearData, yearsPage]
  );
  // Global max across all years so the Y-axis scale stays fixed as users page
  const yearsGlobalMax = useMemo(
    () => assessmentYearsByYearData.reduce((m, d) => Math.max(m, d.count), 0),
    [assessmentYearsByYearData]
  );

  // Jump to the most recent page when Year view is first entered — either on
  // the initial mount (when the URL already selects a specific year) or on the
  // Range → Year toggle. A ref initialized to `null` detects "never been in
  // year view before". Unrelated cross-filter changes that reshape
  // yearsTotalPages don't teleport the user, because this effect only fires
  // its body on the transition, not on every dataset update.
  const prevYearsChartModeRef = useRef<"range" | "year" | null>(null);
  useEffect(() => {
    if (yearsChartMode === "year" && prevYearsChartModeRef.current !== "year") {
      setYearsPage(Math.max(0, yearsTotalPages - 1));
    }
    prevYearsChartModeRef.current = yearsChartMode;
  }, [yearsChartMode, yearsTotalPages]);
  // Clamp yearsPage into the valid range when the dataset shrinks beneath it,
  // but preserve the user's current page otherwise so cross-filter tweaks
  // don't bounce them away from the years they were browsing.
  useEffect(() => {
    if (yearsPage > yearsTotalPages - 1) {
      setYearsPage(Math.max(0, yearsTotalPages - 1));
    }
  }, [yearsPage, yearsTotalPages]);

  // GBIF observations chart: apply all filters EXCEPT obs range
  const gbifObsData = useMemo(() => {
    const ranges = [
      { range: "0", shortRange: "0", count: 0 },
      { range: "1-10", shortRange: "1-10", count: 0 },
      { range: "11-100", shortRange: "11-100", count: 0 },
      { range: "101-1K", shortRange: "101-1K", count: 0 },
      { range: "1K-10K", shortRange: "1K-10K", count: 0 },
      { range: "10K+", shortRange: "10K+", count: 0 },
    ];
    const byBucket: Record<string, number> = Object.fromEntries(ranges.map((r, i) => [r.range, i]));
    taxaFilteredSpecies.forEach(s => {
      if (!matchesFilters(s, SKIP_OBS)) return;
      ranges[byBucket[gbifObsBucket(s.gbif_occurrence_count)]].count++;
    });
    const total = ranges.reduce((sum, r) => sum + r.count, 0);
    return ranges.map(r => ({
      ...r,
      label: `${r.count.toLocaleString()} (${total > 0 ? Math.round((r.count / total) * 100) : 0}%)`,
    }));
  }, [taxaFilteredSpecies, matchesFilters]);

  // Number of Assessments chart (#423 item 1): apply all filters EXCEPT the
  // assessment-count selection itself. NE species have no assessment history
  // (assessment_count is null) so they're excluded, same as other
  // assessment-only charts.
  const assessmentCountData = useMemo(() => {
    const buckets = [
      { range: "1", shortRange: "1", count: 0 },
      { range: "2", shortRange: "2", count: 0 },
      { range: "3", shortRange: "3", count: 0 },
      { range: "4", shortRange: "4", count: 0 },
      { range: "5+", shortRange: "5+", count: 0 },
    ];
    const byBucket: Record<string, number> = { "1": 0, "2": 1, "3": 2, "4": 3, "5+": 4 };
    taxaFilteredSpecies.forEach(s => {
      if (!matchesFilters(s, SKIP_ASSESSMENT_COUNTS)) return;
      if (s.category === "NE") return;
      buckets[byBucket[assessmentCountBucket(s.assessment_count)]].count++;
    });
    const total = buckets.reduce((sum, r) => sum + r.count, 0);
    return buckets.map(r => ({
      ...r,
      label: `${r.count.toLocaleString()} (${total > 0 ? Math.round((r.count / total) * 100) : 0}%)`,
    }));
  }, [taxaFilteredSpecies, assessmentCountBucket, matchesFilters]);

  // Year Described chart (NE / new-assessments only): per-bucket counts, cross-filtered
  // by every OTHER active filter (search, country, GBIF obs) but NOT the described-year
  // selection itself. Only NE rows carry described_year; in new-assessments all rows are NE.
  const describedYearData = useMemo(() => {
    const buckets = ["pre-1900", "1900-1949", "1950-1999", "2000-2009", "2010-2019", "2020+", "Unknown"];
    const counts: Record<string, number> = Object.fromEntries(buckets.map(b => [b, 0]));
    taxaFilteredSpecies.forEach(s => {
      if (s.category !== "NE") return;
      if (!matchesSearch(s)) return;
      if (selectedCountries.size > 0 && !s.countries.some(c => selectedCountries.has(c))) return;
      if (!matchesObsRangeFilter(s.gbif_occurrence_count)) return;
      counts[describedYearBucket(s.described_year)]++;
    });
    const total = buckets.reduce((sum, b) => sum + counts[b], 0);
    return buckets
      .map(b => ({
        range: b,
        shortRange: b,
        count: counts[b],
        label: `${counts[b].toLocaleString()} (${total > 0 ? Math.round((counts[b] / total) * 100) : 0}%)`,
      }))
      .filter(d => d.count > 0);
  }, [taxaFilteredSpecies, selectedCountries, matchesSearch, matchesObsRangeFilter, describedYearBucket]);

  // Country chart: apply all filters EXCEPT country
  const { countryStatsForMap } = useMemo(() => {
    const counts: Record<string, number> = {};
    const outdatedCounts: Record<string, number> = {};
    taxaFilteredSpecies.forEach(s => {
      if (!matchesFilters(s, SKIP_COUNTRIES)) return;
      // Gated on NE the same way the assessment-year filters above are, since NE species have no assessment.
      const outdated = s.category !== "NE" && isOutdated(s.assessment_date, dataAsOf);
      s.countries.forEach(code => {
        counts[code] = (counts[code] || 0) + 1;
        if (outdated) outdatedCounts[code] = (outdatedCounts[code] || 0) + 1;
      });
    });
    const sorted = Object.entries(counts)
      .sort((a, b) => {
        const nameA = ALPHA2_TO_NAME[a[0]] || a[0];
        const nameB = ALPHA2_TO_NAME[b[0]] || b[0];
        return nameA.localeCompare(nameB);
      })
      .map(([code]) => code);
    const statsForMap = Object.fromEntries(
      Object.entries(counts).map(([code, count]) => [
        code,
        { occurrences: 0, species: count, outdated: outdatedCounts[code] || 0 }
      ])
    );
    return { countryCounts: counts, uniqueCountries: sorted, countryStatsForMap: statsForMap };
  }, [taxaFilteredSpecies, dataAsOf, matchesFilters]);

  // True per-country totals — taxon/subgroup selection only, no other filters —
  // so the Country map tooltip can show "142 of 3,847 total" instead of just
  // "142" when a filter (e.g. Needs Updating, a category) narrows the country's
  // species count. Without this, e.g. "% Needs Updating: 100%" while the Needs Updating
  // toggle is on reads as a fact about the country instead of a tautology.
  const countryStatsForMapTotal = useMemo(() => {
    const counts: Record<string, number> = {};
    const outdatedCounts: Record<string, number> = {};
    taxaFilteredSpeciesBase.forEach(s => {
      const outdated = s.category !== "NE" && isOutdated(s.assessment_date, dataAsOf);
      s.countries.forEach(code => {
        counts[code] = (counts[code] || 0) + 1;
        if (outdated) outdatedCounts[code] = (outdatedCounts[code] || 0) + 1;
      });
    });
    return Object.fromEntries(
      Object.entries(counts).map(([code, count]) => [
        code,
        { occurrences: 0, species: count, outdated: outdatedCounts[code] || 0 }
      ])
    );
  }, [taxaFilteredSpeciesBase, dataAsOf]);

  // Realm counts: apply all filters EXCEPT systems (for realm button tooltips)
  const realmCounts = useMemo(() => {
    const counts: Record<string, number> = { Terrestrial: 0, Freshwater: 0, Marine: 0 };
    taxaFilteredSpecies.forEach(s => {
      if (!matchesSearch(s)) return;
      if (selectedCategories.size > 0 && !selectedCategories.has(s.category)) return;
      if (selectedCountries.size > 0 && !s.countries.some(c => selectedCountries.has(c))) return;
      if (s.category !== "NE" && selectedYearRanges.size > 0 && !matchesYearRangeFilter(s.assessment_date, selectedYearRanges)) return;
      if (s.category !== "NE" && selectedAssessmentYears.size > 0 && !matchesAssessmentYearFilter(s.assessment_date, selectedAssessmentYears)) return;
      if (selectedObsRanges.size > 0 && !matchesObsRangeFilter(s.gbif_occurrence_count, selectedObsRanges)) return;
      if (selectedAssessmentCounts.size > 0 && !matchesAssessmentCountFilter(s.assessment_count, selectedAssessmentCounts)) return;
      if (selectedPopulationTrends.size > 0 && (!s.population_trend || !selectedPopulationTrends.has(s.population_trend))) return;
      if (selectedMovementPatterns.size > 0 && (!s.movement_pattern || !selectedMovementPatterns.has(s.movement_pattern))) return;
      if (!matchesThreatFilter(s)) return;
      if (selectedCriteria.size > 0 && !parseCriteriaCodes(s.criteria).some(code => Array.from(selectedCriteria).some(sel => code === sel || code.startsWith(sel)))) return;
      if (endemicsOnly && s.countries.length !== 1) return;
      if (selectedGrowthForms.size > 0 && !s.growth_forms?.some(gf => selectedGrowthForms.has(gf))) return;
      if (!matchesAssessorsFilter(s)) return;
      if (!matchesHabitatFilter(s)) return;
      if (!matchesReviewersFilter(s)) return;
      if (!matchesFacilitatorsFilter(s)) return;
      if (!matchesContributorsFilter(s)) return;
      if (!matchesInstitutionsFilter(s)) return;
      if (!matchesColFilter(s)) return;
      for (const sys of s.systems ?? []) {
        if (sys in counts) counts[sys]++;
      }
    });
    return counts;
  }, [taxaFilteredSpecies, selectedCategories, selectedCountries, selectedYearRanges, selectedObsRanges, selectedPopulationTrends, selectedMovementPatterns, matchesThreatFilter, selectedCriteria, matchesHabitatFilter, matchesSearch, matchesAssessorsFilter, matchesReviewersFilter, matchesFacilitatorsFilter, matchesContributorsFilter, matchesInstitutionsFilter, matchesColFilter, endemicsOnly, matchesObsRangeFilter, selectedAssessmentCounts, matchesAssessmentCountFilter, matchesYearRangeFilter, selectedGrowthForms, selectedAssessmentYears, matchesAssessmentYearFilter]);

  // Population trend counts: apply all filters EXCEPT population trend
  const populationTrendCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    taxaFilteredSpecies.forEach(s => {
      if (!s.population_trend) return;
      if (!matchesSearch(s)) return;
      if (selectedCategories.size > 0 && !selectedCategories.has(s.category)) return;
      if (selectedCountries.size > 0 && !s.countries.some(c => selectedCountries.has(c))) return;
      if (s.category !== "NE" && selectedYearRanges.size > 0 && !matchesYearRangeFilter(s.assessment_date, selectedYearRanges)) return;
      if (s.category !== "NE" && selectedAssessmentYears.size > 0 && !matchesAssessmentYearFilter(s.assessment_date, selectedAssessmentYears)) return;
      if (selectedObsRanges.size > 0 && !matchesObsRangeFilter(s.gbif_occurrence_count, selectedObsRanges)) return;
      if (selectedAssessmentCounts.size > 0 && !matchesAssessmentCountFilter(s.assessment_count, selectedAssessmentCounts)) return;
      if (selectedSystems.size > 0 && !s.systems?.some(sys => selectedSystems.has(sys))) return;
      if (selectedMovementPatterns.size > 0 && (!s.movement_pattern || !selectedMovementPatterns.has(s.movement_pattern))) return;
      if (!matchesThreatFilter(s)) return;
      if (selectedCriteria.size > 0 && !parseCriteriaCodes(s.criteria).some(code => Array.from(selectedCriteria).some(sel => code === sel || code.startsWith(sel)))) return;
      if (endemicsOnly && s.countries.length !== 1) return;
      if (selectedGrowthForms.size > 0 && !s.growth_forms?.some(gf => selectedGrowthForms.has(gf))) return;
      if (!matchesAssessorsFilter(s)) return;
      if (!matchesHabitatFilter(s)) return;
      if (!matchesReviewersFilter(s)) return;
      if (!matchesFacilitatorsFilter(s)) return;
      if (!matchesContributorsFilter(s)) return;
      if (!matchesInstitutionsFilter(s)) return;
      if (!matchesColFilter(s)) return;
      counts[s.population_trend] = (counts[s.population_trend] || 0) + 1;
    });
    return counts;
  }, [taxaFilteredSpecies, selectedCategories, selectedCountries, selectedYearRanges, selectedObsRanges, selectedSystems, selectedMovementPatterns, matchesThreatFilter, selectedCriteria, matchesHabitatFilter, matchesSearch, matchesAssessorsFilter, matchesReviewersFilter, matchesFacilitatorsFilter, matchesContributorsFilter, matchesInstitutionsFilter, matchesColFilter, endemicsOnly, matchesObsRangeFilter, selectedAssessmentCounts, matchesAssessmentCountFilter, matchesYearRangeFilter, selectedGrowthForms, selectedAssessmentYears, matchesAssessmentYearFilter]);

  // Movement pattern counts: apply all filters EXCEPT movement pattern
  const movementPatternCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    taxaFilteredSpecies.forEach(s => {
      if (!s.movement_pattern) return;
      if (!matchesSearch(s)) return;
      if (selectedCategories.size > 0 && !selectedCategories.has(s.category)) return;
      if (selectedCountries.size > 0 && !s.countries.some(c => selectedCountries.has(c))) return;
      if (s.category !== "NE" && selectedYearRanges.size > 0 && !matchesYearRangeFilter(s.assessment_date, selectedYearRanges)) return;
      if (s.category !== "NE" && selectedAssessmentYears.size > 0 && !matchesAssessmentYearFilter(s.assessment_date, selectedAssessmentYears)) return;
      if (selectedObsRanges.size > 0 && !matchesObsRangeFilter(s.gbif_occurrence_count, selectedObsRanges)) return;
      if (selectedAssessmentCounts.size > 0 && !matchesAssessmentCountFilter(s.assessment_count, selectedAssessmentCounts)) return;
      if (selectedSystems.size > 0 && !s.systems?.some(sys => selectedSystems.has(sys))) return;
      if (selectedPopulationTrends.size > 0 && (!s.population_trend || !selectedPopulationTrends.has(s.population_trend))) return;
      if (!matchesThreatFilter(s)) return;
      if (selectedCriteria.size > 0 && !parseCriteriaCodes(s.criteria).some(code => Array.from(selectedCriteria).some(sel => code === sel || code.startsWith(sel)))) return;
      if (endemicsOnly && s.countries.length !== 1) return;
      if (selectedGrowthForms.size > 0 && !s.growth_forms?.some(gf => selectedGrowthForms.has(gf))) return;
      if (!matchesAssessorsFilter(s)) return;
      if (!matchesHabitatFilter(s)) return;
      if (!matchesReviewersFilter(s)) return;
      if (!matchesFacilitatorsFilter(s)) return;
      if (!matchesContributorsFilter(s)) return;
      if (!matchesInstitutionsFilter(s)) return;
      if (!matchesColFilter(s)) return;
      counts[s.movement_pattern] = (counts[s.movement_pattern] || 0) + 1;
    });
    return counts;
  }, [taxaFilteredSpecies, selectedCategories, selectedCountries, selectedYearRanges, selectedObsRanges, selectedSystems, selectedPopulationTrends, matchesThreatFilter, selectedCriteria, matchesHabitatFilter, matchesSearch, matchesAssessorsFilter, matchesReviewersFilter, matchesFacilitatorsFilter, matchesContributorsFilter, matchesInstitutionsFilter, matchesColFilter, endemicsOnly, matchesObsRangeFilter, selectedAssessmentCounts, matchesAssessmentCountFilter, matchesYearRangeFilter, selectedGrowthForms, selectedAssessmentYears, matchesAssessmentYearFilter]);

  // Threat counts: apply all filters EXCEPT threats (count species per prefix, deduplicated)
  // Threat counts per code, plus the denominator (`threatTotal`) for percentages:
  // every in-view species that passes the same filters, with or without a threat
  // coded. The threat *selection* is intentionally excluded here, so both the
  // counts and the percentage stay stable as threats are clicked.
  //
  // The scope is NOT excluded, though: under the default "threatened" scope both
  // the counts and the denominator are restricted to CR/EN/VU, because IUCN's
  // feedback is that threat coding on non-threatened assessments isn't reliable
  // enough to chart. SKIP_THREATS drops the whole threats axis (scope included —
  // it lives in matchesThreatFilter), so the restriction is re-applied here.
  const { threatCounts, threatTotal } = useMemo(() => {
    const counts: Record<string, number> = {};
    let total = 0;
    taxaFilteredSpecies.forEach(s => {
      if (!matchesFilters(s, SKIP_THREATS)) return;
      if (threatsScope === "threatened" && !THREATENED_SET.has(s.category)) return;
      total++;
      if (!s.threat_codes?.length) return;
      // Deduplicate: count each prefix at most once per species
      const counted = new Set<string>();
      for (const tc of s.threat_codes) {
        const parts = tc.split(".");
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join(".");
          if (!counted.has(prefix)) {
            counted.add(prefix);
            counts[prefix] = (counts[prefix] || 0) + 1;
          }
        }
      }
    });
    return { threatCounts: counts, threatTotal: total };
  }, [taxaFilteredSpecies, matchesFilters, threatsScope]);

  // Criteria counts: apply all filters EXCEPT criteria (count species per code — at every
  // depth: letter, number, sub-clause, roman numeral — deduplicated per species) — mirrors
  // threatCounts/threatTotal above, including a `criteriaTotal` denominator used for the bar
  // chart's percentage label. Unlike threatTotal (every in-view species), criteriaTotal only
  // counts species that HAVE criteria data — species can and often do satisfy more than one
  // top-level letter (e.g. B1+B2 both listed), so percentages are share-of-species-with-
  // criteria and are expected to sum to over 100%, not a partition of all in-view species.
  // parseCriteriaCodes already returns the full set of codes a species satisfies at every
  // level (e.g. ["B1","B1a","B1b","B1b(iii)"]); the top-level letter's own count is derived
  // separately here (via `letters`) rather than reusing a same-named code, since D/E's bare
  // letter ("D") is otherwise indistinguishable from a "number" level entry and would
  // double-count.
  const { criteriaCounts, criteriaTotal } = useMemo(() => {
    const counts: Record<string, number> = {};
    let total = 0;
    taxaFilteredSpecies.forEach(s => {
      if (!matchesFilters(s, SKIP_CRITERIA)) return;
      const codes = parseCriteriaCodes(s.criteria);
      if (codes.length === 0) return;
      total++;
      const letters = new Set(codes.map(c => c[0]));
      // Bare-letter codes (D, E — no trailing digit) ARE the top-level letter, so
      // skip them here to avoid double-counting against the `letters` loop below.
      for (const code of codes) if (code.length > 1) counts[code] = (counts[code] || 0) + 1;
      for (const letter of letters) counts[letter] = (counts[letter] || 0) + 1;
    });
    return { criteriaCounts: counts, criteriaTotal: total };
  }, [taxaFilteredSpecies, matchesFilters]);

  // Taxonomic-revision counts: apply every filter EXCEPT this chart's own two
  // (colMatch/colReasons — hence no matchesColFilter here), so each reason bar
  // stays visible and comparable once one of them is picked, and the
  // Flagged/Clean toggle keeps showing what it WOULD select. Same
  // "cross-filter, minus my own axis" rule as threatCounts/criteriaCounts.
  //
  // The six no-match reasons partition their own set, but "Split" is an
  // orthogonal property, so the seven bars together don't partition the flagged
  // species — see RevisionTally for why forcing them to would be worse. The
  // tally carries the overlap so the card can show the arithmetic rather than
  // leave a 1.5% gap for someone to find. Species-level totals DO partition:
  // flagged + clean is every in-view species.
  const colTally = useMemo(() => {
    const tally = newRevisionTally();
    taxaFilteredSpecies.forEach(s => {
      if (!matchesFilters(s, SKIP_REVISION)) return;
      tallyRevision(tally, s.col_revision);
    });
    return tally;
  }, [taxaFilteredSpecies, matchesFilters]);

  // Habitat counts: apply all filters EXCEPT habitat (all 4 dimensions — code
  // selection, specialists/major/resident toggles — so the drill-down counts and
  // toggle buttons show what WOULD match if clicked, not what already does).
  // Distinct codes per species are prefix-counted the same way threatCounts does
  // (both are "." hierarchical), deduplicated so a species with both "1.1" and
  // "1.2" only counts once toward top-level "1". `habitatTotal` (species with
  // habitat data, after the breadth refinement) is the percentage denominator —
  // like criteriaTotal, not threatTotal: a species with 2+ habitats is a
  // "generalist" by definition, so percentages here are expected to sum past
  // 100% too.
  const { habitatCounts, habitatTotal } = useMemo(() => {
    const counts: Record<string, number> = {};
    let total = 0;
    taxaFilteredSpecies.forEach(s => {
      if (!matchesFilters(s, SKIP_HABITAT)) return;
      // selectedHabitat itself is excluded from this cross-filter (so every bar
      // stays visible to compare against, even once one is picked) but Breadth/
      // Importance/Season are refinements, not "the axis being explored" —
      // they DO narrow these counts, same as any other active filter.
      const entries = parseHabitatEntries(s.habitat_codes);
      if (entries.length === 0) return;
      const codes = Array.from(new Set(entries.map(e => e.code)));
      if (habitatBreadth) {
        const known = coarseKnownCategories(codes);
        if (habitatBreadth === "specialist" && known.size !== 1) return;
        if (habitatBreadth === "generalist" && known.size < 2) return;
      }
      total++;
      const counted = new Set<string>();
      for (const code of codes) {
        const parts = code.split(".");
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join(".");
          if (counted.has(prefix)) continue;
          // Importance/Season/Suitability are checked against entries belonging to
          // THIS bar's category specifically — e.g. with "Not major" unchecked, the
          // Forest bar only counts species whose Forest entry (not some other
          // habitat of theirs) is confirmed non-minor.
          if (habitatImportanceActive || habitatSeasonsActive || habitatSuitabilityActive) {
            const relevantForPrefix = entries.filter(e => e.code === prefix || e.code.startsWith(prefix + "."));
            if (habitatImportanceActive && !relevantForPrefix.some(e => selectedHabitatImportance.has(e.importance))) continue;
            if (habitatSeasonsActive && !relevantForPrefix.some(e => selectedHabitatSeasons.has(e.season))) continue;
            if (habitatSuitabilityActive && !relevantForPrefix.some(e => selectedHabitatSuitability.has(e.suitability))) continue;
          }
          counted.add(prefix);
          counts[prefix] = (counts[prefix] || 0) + 1;
        }
      }
    });
    return { habitatCounts: counts, habitatTotal: total };
  }, [taxaFilteredSpecies, habitatBreadth, selectedHabitatImportance, selectedHabitatSeasons, selectedHabitatSuitability, habitatImportanceActive, habitatSeasonsActive, habitatSuitabilityActive, matchesFilters]);

  // Handle region filter — select all countries in the chosen region
  // The region picker hands back a whole country set (a union of the regions
  // ticked), so this is a straight assignment — regions are not their own piece
  // of state, they are just a fast way to select countries.
  const handleRegionsChange = useCallback((countries: Set<string>) => {
    setSelectedCountries(countries);
  }, [setSelectedCountries]);

  // The credit chart counts names over the same filtered species set whichever
  // credit type is selected: every active filter EXCEPT the credit filter the
  // chart itself drives, so clicking a bar narrows the table without emptying the
  // chart you clicked in. Shared here rather than copied per credit type — they
  // differ only in which names they pull and which credit filter they leave out.
  // Every filter EXCEPT the five credit ones, for the credit chart — which
  // cross-filters against the other four credits separately (see buildCreditChart).
  //
  // This restates the same clause list the per-chart memos above run inline, and
  // that duplication is a live trap: the taxonomic-revision filter was added to
  // all twelve inline chains and silently missed here, leaving the credits chart
  // reporting unfiltered counts. Anything added to one belongs in the other.
  const matchesNonCreditFilters = useCallback(
    (s: Species): boolean => matchesFilters(s, SKIP_CREDITS),
    [matchesFilters]);

  // `total` is the percentage denominator: species carrying at least one name of
  // this credit type. Like criteria/habitat, one assessment can list several
  // people, so the percentages are expected to sum past 100%.
  const buildCreditChart = useCallback((
    getNames: (s: Species) => string[],
    otherCreditFilters: Array<(s: Species) => boolean>,
  ) => {
    const counts: Record<string, number> = {};
    let total = 0;
    taxaFilteredSpecies.forEach(s => {
      if (!matchesNonCreditFilters(s)) return;
      if (!otherCreditFilters.every(f => f(s))) return;
      const names = getNames(s);
      if (names.length === 0) return;
      total++;
      for (const n of names) counts[n] = (counts[n] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        code: name,
        count,
        label: `${count.toLocaleString()} (${total > 0 ? Math.round((count / total) * 100) : 0}%)`,
      }));
  }, [taxaFilteredSpecies, matchesNonCreditFilters]);

  // Only the SELECTED credit type is counted. Each pass walks every filtered
  // species and parses every name on the line, and contributors alone average
  // ~8.5 names per assessment — building all five up front to render one would
  // cost five times over on every filter change. Building the visible one is a
  // single pass, so five credit types now cost less than the three eager memos
  // this replaced.
  const creditChartData = useMemo(() => {
    switch (assessorReviewerMode) {
      case "assessors":
        return buildCreditChart(getSpeciesAssessors, [matchesReviewersFilter, matchesFacilitatorsFilter, matchesContributorsFilter, matchesInstitutionsFilter]);
      case "reviewers":
        return buildCreditChart(getSpeciesReviewers, [matchesAssessorsFilter, matchesFacilitatorsFilter, matchesContributorsFilter, matchesInstitutionsFilter]);
      case "facilitators":
        return buildCreditChart(getSpeciesFacilitators, [matchesAssessorsFilter, matchesReviewersFilter, matchesContributorsFilter, matchesInstitutionsFilter]);
      case "contributors":
        return buildCreditChart(getSpeciesContributors, [matchesAssessorsFilter, matchesReviewersFilter, matchesFacilitatorsFilter, matchesInstitutionsFilter]);
      case "institutions":
        return buildCreditChart(getSpeciesInstitutions, [matchesAssessorsFilter, matchesReviewersFilter, matchesFacilitatorsFilter, matchesContributorsFilter]);
    }
  }, [assessorReviewerMode, buildCreditChart,
      getSpeciesAssessors, getSpeciesReviewers, getSpeciesFacilitators, getSpeciesContributors, getSpeciesInstitutions,
      matchesAssessorsFilter, matchesReviewersFilter, matchesFacilitatorsFilter, matchesContributorsFilter, matchesInstitutionsFilter]);

  // ── Client-side filtering and sorting ──────────────────────────────
  const { filteredSpecies, sortedSpecies } = useMemo(() => {
    const filtered = taxaFilteredSpecies.filter((s) => {
      const matchesCategory = selectedCategories.size === 0 || selectedCategories.has(s.category);
      const matchesYear = s.category === "NE" || (matchesYearRangeFilter(s.assessment_date) && matchesAssessmentYearFilter(s.assessment_date));
      // Described-year applies to NE rows only (the only ones carrying described_year).
      const matchesDescribed = s.category !== "NE" || matchesDescribedYearFilter(s.described_year);
      const matchesObs = matchesObsRangeFilter(s.gbif_occurrence_count);
      const matchesAssessmentCount = matchesAssessmentCountFilter(s.assessment_count);
      const matchesCountry = selectedCountries.size === 0 || s.countries.some(c => selectedCountries.has(c));
      const matchesSystem = selectedSystems.size === 0 || s.systems?.some(sys => selectedSystems.has(sys));
      const matchesTrend = selectedPopulationTrends.size === 0 || (s.population_trend != null && selectedPopulationTrends.has(s.population_trend));
      const matchesMovement = selectedMovementPatterns.size === 0 || (s.movement_pattern != null && selectedMovementPatterns.has(s.movement_pattern));
      const matchesThreat = matchesThreatFilter(s);
      const matchesCriteria = selectedCriteria.size === 0 || parseCriteriaCodes(s.criteria).some(code => Array.from(selectedCriteria).some(sel => code === sel || code.startsWith(sel)));
      const matchesHabitat = matchesHabitatFilter(s);
      const matchesEndemic = !endemicsOnly || s.countries.length === 1;
      const matchesGrowth = selectedGrowthForms.size === 0 || s.growth_forms?.some(gf => selectedGrowthForms.has(gf));
      const matchesSearch =
        !searchFilter ||
        s.scientific_name.toLowerCase().includes(searchFilter) ||
        s.common_name?.toLowerCase().includes(searchFilter);
      const matchesAssessor = matchesAssessorsFilter(s);
      const matchesReviewer = matchesReviewersFilter(s);
      const matchesFacilitator = matchesFacilitatorsFilter(s);
      const matchesContributor = matchesContributorsFilter(s);
      const matchesInstitution = matchesInstitutionsFilter(s);
      const matchesCol = matchesColFilter(s);
      const matchesStarred = !showOnlyStarred || pinnedSet.has(s.species_key);
      return matchesCategory && matchesYear && matchesDescribed && matchesObs && matchesAssessmentCount && matchesCountry && matchesSystem && matchesTrend && matchesMovement && matchesThreat && matchesCriteria && matchesHabitat && matchesEndemic && matchesGrowth && matchesSearch && matchesAssessor && matchesReviewer && matchesFacilitator && matchesContributor && matchesInstitution && matchesCol && matchesStarred;
    });

    const sorted = [...filtered].sort((a, b) => {
      if (showOnlyStarred) {
        const aIdx = pinnedSpecies.indexOf(a.species_key);
        const bIdx = pinnedSpecies.indexOf(b.species_key);
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      }

      // Primary, then the user's chosen secondary (shift/cmd-click a second
      // header), then total GBIF desc, then row key. compareBy is shared by the
      // first two so "sort by X then Y" means the same thing at either level.
      // With no explicit sort, new-assessments defaults to total GBIF desc and
      // everything else to assessment date desc.
      const primaryField: SortField = sortField ?? (isNewAssessments ? "totalGbif" : "year");
      const primaryCmp = compareBy(primaryField, a, b);
      const primary = sortDirection === "asc" ? primaryCmp : -primaryCmp;
      if (primary !== 0) return primary;

      if (sortField2 && sortField2 !== primaryField) {
        const secondaryCmp = compareBy(sortField2, a, b);
        const secondary = sortDirection2 === "asc" ? secondaryCmp : -secondaryCmp;
        if (secondary !== 0) return secondary;
      }

      // Implicit tiebreaker: total GBIF desc, then stable row-key order. Kept
      // below the explicit secondary so the old behaviour still applies once
      // the user's own columns have run out of discriminating power.
      const gbifCmp = (b.gbif_occurrence_count ?? -1) - (a.gbif_occurrence_count ?? -1);
      if (gbifCmp !== 0) return gbifCmp;

      return a.species_key.localeCompare(b.species_key);
    });

    return { filteredSpecies: filtered, sortedSpecies: sorted };
  }, [taxaFilteredSpecies, selectedCategories, selectedCountries, selectedSystems, selectedPopulationTrends, selectedMovementPatterns, matchesThreatFilter, selectedCriteria, matchesHabitatFilter, endemicsOnly, selectedGrowthForms, searchFilter, showOnlyStarred, pinnedSet, pinnedSpecies, sortField, sortDirection, sortField2, sortDirection2, matchesAssessorsFilter, matchesReviewersFilter, matchesFacilitatorsFilter, matchesContributorsFilter, matchesInstitutionsFilter, matchesColFilter, isNewAssessments, matchesObsRangeFilter, matchesAssessmentCountFilter, matchesYearRangeFilter, matchesAssessmentYearFilter, matchesDescribedYearFilter]);

  // Giant aggregates (insects, invertebrates…) are capped at 400k server-side; surface
  // a banner so the list reads as "showing N of M — drill into a sub-group for the rest".
  const neTruncation = useMemo(() => {
    if (!isNewAssessments) return null;
    let truncated = false; let neTotal = 0; let shown = 0;
    for (const t of selectedTaxa) {
      const info = cache.entries[speciesApiUrl(t, "&category=NE")];
      if (info?.truncated) { truncated = true; neTotal += info.neTotal ?? 0; shown += info.species.length; }
    }
    return truncated ? { neTotal, shown } : null;
  }, [isNewAssessments, selectedTaxa, cache.entries, speciesApiUrl]);

  // A giant aggregate (insects, invertebrates) exceeds the cap — the API returns no rows
  // and flags tooLarge. Don't render the charts/list; prompt a drill-down into a sub-group.
  // Only applies with no sub-group selected (sub-groups are always under the cap).
  const neTooLarge = useMemo(() => {
    if (!isNewAssessments) return null;
    // Reflect the actually-fetched target: a selected sub-group (e.g. insects under
    // invertebrates) if any, otherwise the top-level taxon. So a too-large sub-group shows
    // the drill-down prompt while a manageable sibling (crustaceans, beetles) loads.
    const targets = selectedSubgroups.size > 0 ? [...selectedSubgroups] : [...selectedTaxa];
    const names: string[] = [];
    let neTotal = 0;
    for (const t of targets) {
      const info = cache.entries[speciesApiUrl(t, "&category=NE")];
      if (info?.tooLarge) { names.push(findNode(t)?.name ?? t); neTotal += info.neTotal ?? 0; }
    }
    return names.length > 0 ? { names, neTotal } : null;
  }, [isNewAssessments, selectedTaxa, selectedSubgroups, cache.entries, speciesApiUrl]);

  // ── Client-side pagination ─────────────────────────────────────────
  const totalFiltered = filteredSpecies.length;
  const totalPages = Math.ceil(sortedSpecies.length / PAGE_SIZE);
  const paginatedSpeciesBase = sortedSpecies.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  // Include single-species preview at the top of the page when bulk data hasn't loaded yet
  const paginatedSpecies = useMemo(() => {
    if (!singleSpeciesPreview) return paginatedSpeciesBase;
    // De-dupe by row key — a searched species and its loaded list row now carry the
    // same one, so the preview collapses into the row instead of doubling it.
    if (paginatedSpeciesBase.some(s => s.species_key === singleSpeciesPreview.species_key)) {
      return paginatedSpeciesBase;
    }
    return [singleSpeciesPreview, ...paginatedSpeciesBase];
  }, [paginatedSpeciesBase, singleSpeciesPreview]);

  // ── Single species mode: show info card instead of charts ──────────
  // Only activate when arrived via the main search bar (which sets the
  // `species` URL param). Filters that incidentally narrow results to one
  // species should keep showing the regular charts view.
  const isSingleSpecies = filteredSpecies.length === 1 && urlSpecies != null;
  const singleSpecies = isSingleSpecies ? filteredSpecies[0] : null;
  const singleSpeciesAssessors = useMemo(() => singleSpecies ? getSpeciesAssessors(singleSpecies) : [], [singleSpecies, getSpeciesAssessors]);
  const singleSpeciesReviewers = useMemo(() => singleSpecies ? getSpeciesReviewers(singleSpecies) : [], [singleSpecies, getSpeciesReviewers]);
  const singleSpeciesFacilitators = useMemo(() => singleSpecies ? getSpeciesFacilitators(singleSpecies) : [], [singleSpecies, getSpeciesFacilitators]);
  const singleSpeciesContributors = useMemo(() => singleSpecies ? getSpeciesContributors(singleSpecies) : [], [singleSpecies, getSpeciesContributors]);
  const singleSpeciesInstitutions = useMemo(() => singleSpecies ? getSpeciesInstitutions(singleSpecies) : [], [singleSpecies, getSpeciesInstitutions]);

  // Helper to get country display name
  const getCountryName = (code: string) => ALPHA2_TO_NAME[code] || code;

  // Map selection handlers (Cmd/Ctrl+click for multi-select, regular click replaces)
  const handleCountrySelect = (countryCode: string, _countryName: string, event: React.MouseEvent) => {
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setSelectedCountries(prev => {
      if (isMultiSelect) {
        const next = new Set(prev);
        if (next.has(countryCode)) next.delete(countryCode);
        else next.add(countryCode);
        return next;
      } else {
        if (prev.size === 1 && prev.has(countryCode)) return new Set();
        return new Set([countryCode]);
      }
    });
  };



  // Handle sort toggle
  // The ↓/↑ arrow in a sortable column header, plus a ①/② rank badge once a
  // secondary sort is active — with only one sort running the badge is noise, so
  // it appears only when there is actually an order to disambiguate.
  const SortIndicator = ({ field }: { field: SortField }) => {
    const effectivePrimary: SortField = sortField ?? (isNewAssessments ? "totalGbif" : "year");
    const isPrimary = field === effectivePrimary;
    const isSecondary = !isPrimary && sortField2 === field;
    if (!isPrimary && !isSecondary) return null;

    const direction = isPrimary ? sortDirection : sortDirection2;
    const showRank = !!sortField2 && sortField2 !== effectivePrimary;
    // New-assessments keeps its existing emerald accent; everything else red.
    const color = isNewAssessments && isPrimary ? "text-emerald-500" : "text-red-500";
    return (
      <span className={`${color} whitespace-nowrap`}>
        {showRank && <span className="text-[9px] align-super mr-0.5">{isPrimary ? "①" : "②"}</span>}
        {direction === "desc" ? "↓" : "↑"}
      </span>
    );
  };

  // Plain click drives the primary sort (desc → asc → off, as before).
  // Shift or Cmd/Ctrl+click drives the SECONDARY sort — "sort within the first"
  // — on the same three-step cycle. Cmd/Ctrl is accepted alongside Shift
  // because it already means "add this to the selection" on every chart in this
  // dashboard, so it is the modifier people reach for first here too.
  const handleSort = (field: SortField, event?: React.MouseEvent) => {
    const isSecondary = !!event && (event.shiftKey || event.metaKey || event.ctrlKey);

    if (isSecondary) {
      // A secondary that matches the primary would be a no-op tiebreaker;
      // promote it to primary instead of silently doing nothing.
      if (field === (sortField ?? "year")) {
        setSort(field, sortDirection === "desc" ? "asc" : "desc");
      } else if (sortField2 === field) {
        if (sortDirection2 === "desc") setSort2(field, "asc");
        else setSort2(null, "desc");
      } else {
        setSort2(field, "desc");
      }
      setCurrentPage(1);
      return;
    }

    const currentField = sortField === null ? "year" : sortField;
    if (currentField === field) {
      if (sortDirection === "desc") {
        setSort(field, "asc");
      } else {
        setSort(null, "desc");
      }
    } else {
      setSort(field, "desc");
    }
    // Clearing/changing the primary leaves a secondary on a now-identical
    // column meaningless — drop it rather than let it linger invisibly.
    if (sortField2 === field) setSort2(null, "desc");
    setCurrentPage(1);
  };

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedTaxa, selectedCategories, selectedYearRanges, selectedAssessmentYears, selectedDescribedYears, selectedObsRanges, selectedAssessors, selectedReviewers, searchFilter, selectedCountries, showOnlyStarred]);

  // Auto-navigate to the page containing the URL-selected species
  useEffect(() => {
    if (urlSpeciesHandledRef.current || selectedSpeciesKey == null || sortedSpecies.length === 0) return;
    const idx = sortedSpecies.findIndex(s => s.species_key === selectedSpeciesKey);
    if (idx >= 0) {
      const page = Math.floor(idx / PAGE_SIZE) + 1;
      setCurrentPage(page);
      urlSpeciesHandledRef.current = true;
    }
  }, [sortedSpecies, selectedSpeciesKey, isNewAssessments, PAGE_SIZE]);

  // Populate basic speciesDetails from DB data (GBIF counts instant, no API calls)
  // inatDefaultImage / openAlexPaperCount / papersAtAssessment are left as undefined → spinner
  useEffect(() => {
    const newDetails: Record<string, SpeciesDetails> = {};
    for (const s of paginatedSpecies) {
      if (speciesDetails[s.species_key]) continue; // Already have details

      if (s.gbif_species_key) {
        newDetails[s.species_key] = {
          criteria: null,
          commonName: s.common_name || null,
          gbifUrl: `https://www.gbif.org/species/${s.gbif_species_key}`,
          gbifOccurrences: s.gbif_occurrence_count ?? null,
          gbifOccurrencesSinceAssessment: s.gbif_observations_after_assessment_year ?? null,
          gbifMatchStatus: { matchType: 'EXACT' },
          inatDefaultImage: undefined, // Loading — fetched per-page below
        };
      } else {
        newDetails[s.species_key] = {
          criteria: null,
          commonName: s.common_name || null,
          gbifUrl: null,
          gbifOccurrences: null,
          gbifOccurrencesSinceAssessment: null,
          gbifMatchStatus: { matchType: 'NONE' },
          inatDefaultImage: undefined, // Loading
        };
      }
    }
    if (Object.keys(newDetails).length > 0) {
      setSpeciesDetails((prev) => ({ ...prev, ...newDetails }));
    }
  }, [paginatedSpecies, speciesDetails]);

  // Fetch iNat profile pic for visible species (lightweight per-page calls)
  // Also resolve GBIF match status for species not found in CSV (HIGHERRANK vs NONE)
  useEffect(() => {
    const speciesToFetch = paginatedSpecies.filter(
      (s) => {
        const d = speciesDetails[s.species_key];
        // Fetch if we have basic details but inatDefaultImage is still undefined (not yet fetched)
        return d && d.inatDefaultImage === undefined;
      }
    );
    if (speciesToFetch.length === 0) return;

    const controller = new AbortController();
    const { signal } = controller;

    async function fetchLightweightDetails() {
      const promises = speciesToFetch.map(async (s) => {
        try {
          // Build parallel fetch list: iNat image + GBIF match check for species not in CSV
          const fetchPromises: [Promise<Response>, Promise<Response | null>] = [
            // Proxied through our own API route (not called directly against
            // iNaturalist) so the edge cache is shared across visitors
            // instead of every browser re-fetching the same species fresh.
            fetch(
              `/api/inat/thumbnail?name=${encodeURIComponent(s.scientific_name)}`,
              { signal }
            ),
            // Check GBIF match status for species missing from CSV
            !s.gbif_species_key
              ? fetch(
                  // v2, with the classification the row already carries. v1
                  // ignores checklistKey outright and hands back a Backbone
                  // integer, which then builds a link that finds nothing.
                  `https://api.gbif.org/v2/species/match?${new URLSearchParams({
                    checklistKey: GBIF_CHECKLIST_KEY,
                    scientificName: s.scientific_name,
                    ...(s.class_name ? { class: s.class_name } : {}),
                    ...(s.order_name ? { order: s.order_name } : {}),
                    ...(s.family ? { family: s.family } : {}),
                  })}`,
                  { signal }
                )
              : Promise.resolve(null),
          ];

          const [inatRes, gbifMatchRes] = await Promise.all(fetchPromises);

          let inatDefaultImage: InatDefaultImage | null = null;
          if (inatRes.ok) {
            const inatData = await inatRes.json();
            inatDefaultImage = inatData.inatDefaultImage || null;
          }

          let gbifMatchStatus: GbifMatchStatus | null = null;
          if (gbifMatchRes?.ok) {
            const gbifMatch = await gbifMatchRes.json();
            gbifMatchStatus = {
              matchType: gbifMatch.diagnostics?.matchType || 'NONE',
              matchedName: gbifMatch.usage?.name,
              matchedRank: gbifMatch.usage?.rank,
            };
          }

          return { key: s.species_key, inatDefaultImage, gbifMatchStatus };
        } catch {
          return { key: s.species_key, inatDefaultImage: null, gbifMatchStatus: null };
        }
      });

      const results = await Promise.all(promises);
      if (signal.aborted) return;

      const updates: Record<string, Partial<SpeciesDetails>> = {};
      for (const r of results) {
        updates[r.key] = {
          inatDefaultImage: r.inatDefaultImage,
          gbifMatchFetched: true,
          ...(r.gbifMatchStatus ? { gbifMatchStatus: r.gbifMatchStatus } : {}),
        };
      }
      setSpeciesDetails((prev) => {
        const next = { ...prev };
        for (const [key, update] of Object.entries(updates)) {
          if (next[key]) {
            next[key] = { ...next[key], ...update };
          }
        }
        return next;
      });
    }

    fetchLightweightDetails();
    return () => controller.abort("cleanup");
  }, [paginatedSpecies, speciesDetails]);

  // Fetch IUCN criteria on row expansion (lightweight — no GBIF calls; the map handles those)
  useEffect(() => {
    if (!selectedSpeciesKey) return;
    const s = paginatedSpecies.find((sp) => sp.species_key === selectedSpeciesKey);
    if (!s || s.category === "NE") return;
    const existing = speciesDetails[s.species_key];
    if (!existing || existing.criteriaFetched) return;

    async function fetchCriteria() {
      if (!s || !s.assessment_id) return;
      try {
        const res = await fetch(
          `/api/redlist/assessment/${s.assessment_id}`
        );
        if (res.ok) {
          const data = await res.json();
          setSpeciesDetails((prev) => ({
            ...prev,
            [s.species_key]: {
              ...prev[s.species_key],
              criteria: data.criteria || null,
              criteriaFetched: true,
            },
          }));
        }
      } catch {
        // Ignore errors
      }
    }

    fetchCriteria();
  }, [selectedSpeciesKey, paginatedSpecies, speciesDetails]);

  // Lazily fetch the full assessment history for the open species (the list
  // carries only the latest assessors/reviewers/facilitators; the history array is
  // fetched here on demand for the Red List Assessments tab).
  useEffect(() => {
    if (!selectedSpeciesKey) return;
    const s = paginatedSpecies.find((sp) => sp.species_key === selectedSpeciesKey);
    const sis = s?.sis_taxon_id;
    if (!s || s.category === "NE" || !sis || assessmentHistory[sis]) return;
    let aborted = false;
    (async () => {
      try {
        const res = await fetch(`/api/redlist/species/history?id=${sis}`);
        if (res.ok) {
          const data = await res.json();
          if (!aborted) setAssessmentHistory((prev) => ({ ...prev, [sis]: data.previous_assessments ?? [] }));
        }
      } catch {
        // Ignore — the panel falls back to an empty history.
      }
    })();
    return () => { aborted = true; };
  }, [selectedSpeciesKey, paginatedSpecies, assessmentHistory]);

  // Lazily fetch CoL synonyms for the open species — only once the CoL tab is opened.
  // Keyed by the row key, which already encodes which id the lookup uses (`col-…` →
  // by CoL id, `sis-…` → resolved server-side through species_link).
  useEffect(() => {
    if (selectedSpeciesKey == null || !visitedTabs.has("col")) return;
    const s = paginatedSpecies.find((sp) => sp.species_key === selectedSpeciesKey);
    const key = s?.species_key ?? null;
    if (!s || !key || synonymsBySpecies[key]) return;
    const qs = s.col_id ? `col=${encodeURIComponent(s.col_id)}` : `sis=${s.sis_taxon_id}`;
    let aborted = false;
    (async () => {
      try {
        const res = await fetch(`/api/redlist/synonyms?${qs}`);
        if (res.ok) { const data = await res.json(); if (!aborted) setSynonymsBySpecies((prev) => ({ ...prev, [key]: data })); }
      } catch { /* panel falls back to empty */ }
    })();
    return () => { aborted = true; };
  }, [selectedSpeciesKey, visitedTabs, paginatedSpecies, synonymsBySpecies]);

  // Handle category bar click (Cmd/Ctrl+click for multi-select, regular click replaces)
  const handleCategoryClick = (data: { payload?: { code?: string } }, event: React.MouseEvent) => {
    const code = data.payload?.code;
    if (!code) return;
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setSelectedCategories(prev => {
      if (isMultiSelect) {
        // Toggle in/out of set
        const next = new Set(prev);
        if (next.has(code)) {
          next.delete(code);
        } else {
          next.add(code);
        }
        return next;
      } else {
        // Single select: toggle off if already selected, otherwise replace
        if (prev.size === 1 && prev.has(code)) {
          return new Set();
        }
        return new Set([code]);
      }
    });
  };

  // Whether the current selection is exactly the "Threatened" set (CR, EN, VU)
  const isThreatenedSelected =
    selectedCategories.size === THREATENED_CATEGORIES.length &&
    THREATENED_CATEGORIES.every((c) => selectedCategories.has(c));

  // "Threatened" shortcut: select CR, EN and VU at once (toggle off if already exactly that set)
  const handleThreatenedClick = () => {
    setSelectedCategories(isThreatenedSelected ? new Set() : new Set<string>(THREATENED_CATEGORIES));
  };

  // "Outdated" shortcut: filter to species assessed >10 years ago (mirrors isOutdated in species-store.ts)
  const isOutdatedSelected = exactFilters.outdated === "yes";
  const handleOutdatedClick = () => {
    setExactFilters({ outdated: isOutdatedSelected ? null : "yes" });
  };

  // Mutes (doesn't remove) the Range/Year chart bars that don't match the Outdated
  // toggle — mirrors how selectedCategories mutes bars in the Conservation Status
  // chart rather than dropping them. An actual bar click (selectedYearRanges) takes
  // priority if present, since that's a more specific user choice.
  const yearRangeSelectedItems = useMemo(() => {
    if (selectedYearRanges.size > 0) return selectedYearRanges;
    if (!exactFilters.outdated) return selectedYearRanges;
    return new Set(
      exactFilters.outdated === "yes"
        ? ["10-20 years", "20+ years"]
        : ["<1 year", "1-5 years", "5-10 years"]
    );
  }, [selectedYearRanges, exactFilters.outdated]);

  // Same idea for the by-year chart — a whole calendar year is treated as
  // "outdated" if it's on or before the cutoff year (coarser than the precise
  // isOutdated() threshold, since this chart only has year-level granularity).
  const assessmentYearSelectedItems = useMemo(() => {
    if (selectedAssessmentYears.size > 0) return selectedAssessmentYears;
    if (!exactFilters.outdated) return selectedAssessmentYears;
    const cutoffYear = outdatedCutoffDate(dataAsOf).getFullYear();
    const wantOutdated = exactFilters.outdated === "yes";
    const matching = new Set<string>();
    assessmentYearsByYearData.forEach(d => {
      const isYearOutdated = Number(d.code) <= cutoffYear;
      if (isYearOutdated === wantOutdated) matching.add(d.code);
    });
    return matching;
  }, [selectedAssessmentYears, exactFilters.outdated, assessmentYearsByYearData, dataAsOf]);

  // Handle year range bar click (Cmd/Ctrl+click for multi-select, regular click replaces)
  const handleYearClick = (data: { payload?: { range?: string } }, event: React.MouseEvent) => {
    const range = data.payload?.range;
    if (!range) return;
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setSelectedYearRanges(prev => {
      if (isMultiSelect) {
        const next = new Set(prev);
        if (next.has(range)) {
          next.delete(range);
        } else {
          next.add(range);
        }
        return next;
      } else {
        if (prev.size === 1 && prev.has(range)) {
          return new Set();
        }
        return new Set([range]);
      }
    });
  };

  // Handle specific assessment year bar click (Cmd/Ctrl+click for multi-select)
  const handleAssessmentYearClick = (data: { payload?: { code?: string } }, event: React.MouseEvent) => {
    const year = data.payload?.code;
    if (!year) return;
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setSelectedAssessmentYears(prev => {
      if (isMultiSelect) {
        const next = new Set(prev);
        if (next.has(year)) next.delete(year);
        else next.add(year);
        return next;
      } else {
        if (prev.size === 1 && prev.has(year)) return new Set();
        return new Set([year]);
      }
    });
  };
  // Handle GBIF observation range bar click
  const handleObsClick = (data: { payload?: { range?: string } }, event: React.MouseEvent) => {
    const range = data.payload?.range;
    if (!range) return;
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setSelectedObsRanges(prev => {
      if (isMultiSelect) {
        const next = new Set(prev);
        if (next.has(range)) next.delete(range);
        else next.add(range);
        return next;
      } else {
        if (prev.size === 1 && prev.has(range)) return new Set();
        return new Set([range]);
      }
    });
  };

  // Handle Number of Assessments bar click
  const handleAssessmentCountClick = (data: { payload?: { range?: string } }, event: React.MouseEvent) => {
    const range = data.payload?.range;
    if (!range) return;
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setSelectedAssessmentCounts(prev => {
      if (isMultiSelect) {
        const next = new Set(prev);
        if (next.has(range)) next.delete(range);
        else next.add(range);
        return next;
      } else {
        if (prev.size === 1 && prev.has(range)) return new Set();
        return new Set([range]);
      }
    });
  };

  // "Reassessed" shortcut (#423 item 1): one click selects every bucket >= 2,
  // flagging species that have been reassessed at least once (1+ reassessment
  // = 2+ total assessments). Toggling off clears the selection entirely,
  // mirroring the Outdated shortcut.
  const REASSESSED_BUCKETS = ["2", "3", "4", "5+"];
  const isReassessedSelected = REASSESSED_BUCKETS.every(b => selectedAssessmentCounts.has(b)) && selectedAssessmentCounts.size === REASSESSED_BUCKETS.length;
  const handleReassessedClick = () => {
    setSelectedAssessmentCounts(isReassessedSelected ? new Set() : new Set(REASSESSED_BUCKETS));
  };

  // Handle Year Described bucket bar click
  const handleDescribedYearClick = (data: { payload?: { range?: string } }, event: React.MouseEvent) => {
    const range = data.payload?.range;
    if (!range) return;
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setSelectedDescribedYears(prev => {
      if (isMultiSelect) {
        const next = new Set(prev);
        if (next.has(range)) next.delete(range);
        else next.add(range);
        return next;
      } else {
        if (prev.size === 1 && prev.has(range)) return new Set();
        return new Set([range]);
      }
    });
  };

  // Assessors and reviewers each get their own chart, so the click/toggle
  // handlers are parameterised by which selection setter they target.
  type SetSelection = React.Dispatch<React.SetStateAction<Set<string>>>;

  // Shift+drag across a chart selects every bar the drag swept over (see
  // FilterBarChart/YearBarChart's onRangeSelect). Plain shift+drag replaces the
  // selection; holding Cmd/Ctrl as well adds to it, which is how a range wider
  // than what's on screen gets built — e.g. the by-year chart pages 10 years at
  // a time, so 2005-2020 is one drag per page.
  const makeRangeSelect = useCallback((setter: SetSelection) =>
    (keys: string[], event: MouseEvent | React.MouseEvent) => {
      const isAdditive = event.metaKey || event.ctrlKey;
      setter(prev => isAdditive ? new Set([...prev, ...keys]) : new Set(keys));
    }, []);
  const rangeSelectCategories = useMemo(() => makeRangeSelect(setSelectedCategories), [makeRangeSelect, setSelectedCategories]);
  const rangeSelectYearRanges = useMemo(() => makeRangeSelect(setSelectedYearRanges), [makeRangeSelect, setSelectedYearRanges]);
  const rangeSelectAssessmentYears = useMemo(() => makeRangeSelect(setSelectedAssessmentYears), [makeRangeSelect, setSelectedAssessmentYears]);
  const rangeSelectObsRanges = useMemo(() => makeRangeSelect(setSelectedObsRanges), [makeRangeSelect, setSelectedObsRanges]);
  const rangeSelectDescribedYears = useMemo(() => makeRangeSelect(setSelectedDescribedYears), [makeRangeSelect, setSelectedDescribedYears]);
  const rangeSelectAssessmentCounts = useMemo(() => makeRangeSelect(setSelectedAssessmentCounts), [makeRangeSelect, setSelectedAssessmentCounts]);
  const rangeSelectColReasons = useMemo(() => makeRangeSelect(setColReasons), [makeRangeSelect, setColReasons]);

  // Toggle a single assessor/reviewer in/out of selection (used by search list)
  const makeAssessorToggle = useCallback((setter: SetSelection) => (code: string) => {
    setter(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  // Which selection the credit chart drives, keyed by its active mode — so the
  // chart's selected pills, bar clicks and search toggles all follow the mode
  // without a chain of ternaries at each of the call sites.
  const creditSelection = useMemo(() => ({
    assessors: { selected: selectedAssessors, setter: setSelectedAssessors },
    reviewers: { selected: selectedReviewers, setter: setSelectedReviewers },
    facilitators: { selected: selectedFacilitators, setter: setSelectedFacilitators },
    contributors: { selected: selectedContributors, setter: setSelectedContributors },
    institutions: { selected: selectedInstitutions, setter: setSelectedInstitutions },
  }), [selectedAssessors, setSelectedAssessors, selectedReviewers, setSelectedReviewers,
       selectedFacilitators, setSelectedFacilitators, selectedContributors, setSelectedContributors,
       selectedInstitutions, setSelectedInstitutions]);

  // Handle assessor/reviewer bar click
  const makeAssessorClick = useCallback((setter: SetSelection) => (data: { payload?: { code?: string } }, event: React.MouseEvent) => {
    const code = data.payload?.code;
    if (!code) return;
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setter(prev => {
      if (isMultiSelect) {
        const next = new Set(prev);
        if (next.has(code)) next.delete(code);
        else next.add(code);
        return next;
      } else {
        if (prev.size === 1 && prev.has(code)) return new Set();
        return new Set([code]);
      }
    });
  }, []);

  const currentYear = new Date().getFullYear();
  // GBIF relaunched gbif.org on 18 June 2026 with Catalogue of Life Extended
  // Release as its default taxonomy. The gbif_species_key values stored here are
  // keys from the GBIF Backbone, which resolve to nothing under CoL — and GBIF
  // answers that with an empty result set rather than an error, so these links
  // silently landed on a search reading "0 records". Naming the backbone
  // checklist explicitly is GBIF's documented fix:
  //   https://data-blog.gbif.org/post/catalogue-of-life-taxonomic-backbone/
  //   "An old occurrence search link without the checklistKey parameter will
  //    return nothing"
  // The filter params are camelCase because that is what the new site documents;
  // the old snake_case spellings now survive only via GBIF's redirect layer.
  //
  // The backbone is frozen (last updated 2023), so the durable fix is to store
  // CoL keys in the pipeline instead — a much larger migration, tracked in #441.
  // Until then this keeps every link working.
  // Built from the shared module so the links and the queries behind the numbers
  // they sit next to can never name different checklists.
  const GBIF_FILTERS = gbifOccurrenceParams().toString();
  // Plants and fungi count preserved specimens and animals do not, so the filter
  // string follows the species: a herbarium-heavy plant linking to the animal
  // filter set lands on a search holding a fraction of the number clicked on.
  const GBIF_FILTERS_WITH_SPECIMENS = gbifOccurrenceParams({}, { includePreservedSpecimens: true }).toString();
  const gbifFiltersFor = (taxonGroup: string | undefined) =>
    taxonGroupCountsPreservedSpecimens(taxonGroup) ? GBIF_FILTERS_WITH_SPECIMENS : GBIF_FILTERS;
  const isNE = (s: Species) => s.category === "NE";

  // GBIF occurrence counts aren't filterable per-country/category/etc. — only show
  // that color/list column when no filter narrower than "a whole top-level taxon"
  // is active. Shared by both WorldMap instances (the always-visible Country chart
  // and the promoted country-view landing page) so they never disagree.
  const showGbifToggle =
    selectedSubgroups.size === 0
    && [...selectedTaxa].every(id => id in TAXA_BY_ID)
    && selectedCategories.size === 0
    && selectedYearRanges.size === 0
    && selectedAssessmentYears.size === 0
    && selectedObsRanges.size === 0
    && selectedAssessmentCounts.size === 0
    && selectedCountries.size === 0
    && selectedSystems.size === 0
    && selectedPopulationTrends.size === 0
    && selectedMovementPatterns.size === 0
    && selectedThreats.size === 0
    && selectedCriteria.size === 0
    && selectedHabitat.size === 0
    && !habitatBreadth
    && !habitatImportanceActive
    && !habitatSeasonsActive
    && !habitatSuitabilityActive
    && selectedGrowthForms.size === 0
    && selectedAssessors.size === 0
    && selectedReviewers.size === 0
    && selectedFacilitators.size === 0
    && selectedContributors.size === 0
    && selectedInstitutions.size === 0
    && !endemicsOnly
    && !searchFilter
    && !showOnlyStarred;

  // Any countries selected anywhere (not just via the Country view landing
  // page) scope TaxaSummary's own fetches too — clicking a country on the
  // normal "Charts row 2" map already narrowed every other chart/table; this
  // closes the one remaining inconsistency (the taxa tree staying global). One
  // country, a whole region, or an arbitrary multi-select are all just "the
  // set of currently selected countries" — the live per-country query counts
  // each species once regardless of how many of these codes it matches (see
  // country-taxa-summary-duckdb.ts's countriesWhere), so there's no reason to
  // special-case region vs. multi-select here.
  const countryScope = selectedCountries.size > 0 ? [...selectedCountries] : null;

  // Country view's own map click select — click-only (no hover preview: the
  // table only appears once a country is actually locked in, so scanning the
  // map with the mouse never itself changes what's shown below it). A plain
  // click always REPLACES the selection with just that country (clicking a
  // second country swaps to it, it doesn't add to the first) — except
  // clicking the already-sole-selected country again clears back to the
  // empty/map-only state. Only ctrl/cmd-click builds a multi-select, toggling
  // a country in/out of the set regardless of what's already selected.
  // Routed through enterCountryDrilldown so the country change stays atomic
  // with clearing taxa/subgroups (see its own comment).
  const handleCountryDrilldown = useCallback(
    (code: string, _name: string, event: React.MouseEvent) => {
      const isMultiSelect = event.metaKey || event.ctrlKey;
      enterCountryDrilldown(prev => {
        if (isMultiSelect) {
          const next = new Set(prev);
          if (next.has(code)) next.delete(code);
          else next.add(code);
          return next;
        }
        if (prev.size === 1 && prev.has(code)) return new Set();
        return new Set([code]);
      });
    },
    [enterCountryDrilldown]
  );

  // Pill removal (✕ button / Clear all) always removes just that one country
  // regardless of how many are selected — unlike a map click, it's never a
  // "replace the whole selection" gesture, so it can't reuse
  // handleCountryDrilldown's replace-on-plain-click semantics.
  const handleCountryRemove = useCallback(
    (code: string) => {
      enterCountryDrilldown(prev => {
        const next = new Set(prev);
        next.delete(code);
        return next;
      });
    },
    [enterCountryDrilldown]
  );

  // Country view's own per-country stats — a small precomputed, all-species
  // aggregate (see data/country-stats.json), fetched once and cached for the
  // session, NOT the client-side countryStatsForMap used elsewhere (that one
  // requires the currently-browsed taxon's full species array to already be
  // loaded, which is fine when you're already browsing e.g. Mammals for other
  // reasons, but would mean downloading the entire "All Species" dataset just
  // to show the landing map — multi-second blank-map delay for no reason,
  // since this data never varies by taxon selection on the landing page).
  const [countryLandingStats, setCountryLandingStats] = useState<CountryStats | null>(null);
  useEffect(() => {
    if (layoutMode !== "country" || countryLandingStats) return;
    fetch("/api/redlist/country-stats")
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (!data?.stats) return;
        const shaped: CountryStats = {};
        for (const [code, s] of Object.entries(data.stats as Record<string, { species: number; outdated: number }>)) {
          shaped[code] = { occurrences: 0, species: s.species, outdated: s.outdated };
        }
        setCountryLandingStats(shaped);
      })
      .catch(() => {});
  }, [layoutMode, countryLandingStats]);

  // Country view landing page content — a promoted WorldMap (its own Map/List
  // toggle applies here too), passed into TaxaSummary rather than duplicating a
  // second dynamic-import + prop-wiring of WorldMap there. Region-select
  // behaves the same as the normal "Charts row 2" map below: a region just
  // selects all its countries at once (handleRegionFilter), same as any other
  // multi-country selection. No endemics toggle here — the country-scoped
  // taxa summary is a live per-country DuckDB query that doesn't take an
  // endemics parameter, so the button would have nothing to actually filter.
  // Before countryLandingStats has actually arrived, don't mount WorldMap at
  // all — passing it an empty stats object rendered every country in its
  // no-data (white) fill for a beat before the real colors popped in. A
  // spinner card matching WorldMap's own root sizing (h-full flex-1 min-h-0)
  // avoids any layout jump when it's swapped in for the real map.
  const countryModeContent = countryLandingStats ? (
    <WorldMap
      selectedCountries={selectedCountries}
      onCountrySelect={handleCountryDrilldown}
      precomputedStats={countryLandingStats}
      selectedTaxa={selectedTaxa}
      speciesLabel={isNewAssessments ? "# Unassessed" : undefined}
      showOutdatedMode={!isNewAssessments}
      showGbifToggle={false}
      onRegionsChange={handleRegionsChange}
      mapViewMode={mapViewMode}
      onMapViewModeChange={changeMapViewMode}
      mapSortKey={mapSortKey}
      mapSortDirection={mapSortDirection}
      onMapSortChange={setMapSort}
    />
  ) : (
    <div className="relative bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-3 h-full flex-1 min-h-0 flex flex-col items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );

  // Selection chips — rendered by TaxaSummary in a dedicated row of its own,
  // above the table, once at least one country is locked in (the table only
  // mounts once something's selected — see TaxaSummary's countryScoped
  // gate). One chip per selected country (not collapsed into a region name,
  // unlike the atop-table "France ×" chip elsewhere), each individually
  // removable via handleCountryRemove, plus "Clear all" once there's more
  // than one.
  const countryPillsContent = selectedCountries.size > 0 && (
    <div className="flex flex-wrap items-center gap-1.5">
      {[...selectedCountries]
        .map(code => ({ code, name: ALPHA2_TO_NAME[code] ?? code }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ code, name }) => (
          <span
            key={code}
            className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-sm text-zinc-700 dark:text-zinc-300 max-w-full"
          >
            <span className="truncate">{name}</span>
            <button
              onClick={() => handleCountryRemove(code)}
              className="shrink-0 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
              title={`Remove ${name}`}
            >
              ✕
            </button>
          </span>
        ))}
      {selectedCountries.size > 1 && (
        <button
          onClick={() => enterCountryDrilldown(new Set())}
          className="text-sm text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 underline transition-colors"
        >
          Clear all
        </button>
      )}
    </div>
  );

  // Country map card — shared between Charts row 2 (new-assessments mode) and
  // More Filters (reassessments mode, moved there to keep the primary view
  // focused on Conservation Status / Years Since Assessed / Geospatial GBIF
  // Records; see the More Filters section below).
  const countryMapCard = (
    <div>
      {speciesLoading && assessedSpecies.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 min-h-[320px] flex flex-col">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Country
            </h2>
          </div>
          {/* The 180px box (not flex-1) is what lines this spinner up with the
              Year Described / GBIF Records ones beside it: those cards size their
              chart area to exactly 180px, so centering in the map card's full
              height — it reserves 320px for the map — dropped this one ~60px
              lower than the other two. The card keeps its own height; only the
              spinner moves. */}
          <div style={{ height: 180 }} className="flex items-center justify-center">
            <Spinner />
          </div>
        </div>
      ) : (
        <WorldMap
          selectedCountries={selectedCountries}
          onCountrySelect={handleCountrySelect}
          precomputedStats={countryStatsForMap}
          precomputedStatsTotal={countryStatsForMapTotal}
          selectedTaxa={selectedTaxa}
          speciesLabel={isNewAssessments ? "# Unassessed" : undefined}
          showOutdatedMode={!isNewAssessments}
          showColorModeDropdown={!isNewAssessments}
          onRegionsChange={handleRegionsChange}
          endemicsOnly={endemicsOnly}
          onEndemicsToggle={isNewAssessments ? undefined : () => setEndemicsOnly(!endemicsOnly)}
          showGbifToggle={showGbifToggle}
          mapViewMode={mapViewMode}
          onMapViewModeChange={changeMapViewMode}
          mapSortKey={mapSortKey}
          mapSortDirection={mapSortDirection}
          onMapSortChange={setMapSort}
        />
      )}
    </div>
  );

  // Taxonomic differences from Catalogue of Life — the SSC-group view's "No 1:1 CoL
  // Match" diagnostic, surfaced as an ordinary dashboard filter. The coarse
  // Flagged/Clean toggle sits in the header (it's a two-way choice, not a bar);
  // the bars below break the flagged bucket down by reason, which is the part
  // that actually says what KIND of taxonomic disagreement this is. Clicking a
  // reason implies flagged, so it also lights the toggle.
  const taxonomicRevisionCard = (() => {
    const loading = speciesLoading && assessedSpecies.length === 0;
    const barSelected = (bar: (typeof REVISION_BARS)[number]) =>
      bar.reasons.some(r => selectedColReasons.has(r));
    // Which bars are drawn, and the empty-bar rule, live in col-revision.ts.
    const barData = visibleBars(colTally.counts, selectedColReasons).map(({ bar, count }) => ({
      code: bar.label,
      rawCode: bar.key,
      count,
      label: count.toLocaleString(),
    }));
    // FilterBarChart keys selection off the displayed `code`, not our bar key.
    const selectedShort = new Set(REVISION_BARS.filter(barSelected).map(b => b.label));
    const barByLabel = new Map(REVISION_BARS.map(b => [b.label, b]));
    // Selecting a bar selects every reason it covers.
    const reasonsForLabel = (label: string) => barByLabel.get(label)?.reasons ?? [];
    // A reason narrowing implies flagged, so the Flagged button renders pressed
    // whenever one is active — and clicking it then has to mean "turn the whole
    // thing off", not "switch flagged on" (setColMatch(null) drops the reasons
    // with it). Without this, the button looked pressed but behaved as unpressed.
    const flaggedActive = colMatch === "flagged" || selectedColReasons.size > 0;
    const toggle = (value: "flagged" | "clean") => () =>
      setColMatch((value === "flagged" ? flaggedActive : colMatch === value) ? null : value);
    const toggleClass = (active: boolean, activeColor: string) =>
      `px-2 py-0.5 text-xs font-semibold rounded transition-colors ${
        active ? `${activeColor} text-white shadow-sm` : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
      }`;
    return (
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
        <div className="flex items-center justify-between gap-2 mb-1 min-h-[24px]">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1">
            Taxonomic differences from Catalogue of Life
            <HoverTooltip text="Assessed species whose name Catalogue of Life treats differently: either the IUCN name has no clean one-to-one match in the current Catalogue of Life checklist (lumped, now a subspecies, or not in the checklist yet), or Catalogue of Life now recognises species likely split out of it. Two checklists can differ without either being wrong — the Red List assesses the taxon its assessors scoped, Catalogue of Life maintains a nomenclatural checklist — so this says where they differ, not who is right. The split signal is a name-pattern heuristic. The no-match half is the same diagnostic the SSC group view shows as 'No 1:1 CoL Match'.">
              <svg className="w-3 h-3 text-zinc-400 dark:text-zinc-500 cursor-help" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
            </HoverTooltip>
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={toggle("flagged")}
              className={toggleClass(flaggedActive, "bg-amber-600")}
              aria-pressed={flaggedActive}
              title="Only species with no clean 1:1 Catalogue of Life match"
            >
              ⚑ {colTally.flagged.toLocaleString()}
            </button>
            <button
              type="button"
              onClick={toggle("clean")}
              className={toggleClass(colMatch === "clean", "bg-emerald-600")}
              aria-pressed={colMatch === "clean"}
              title="Only species with a clean 1:1 Catalogue of Life match"
            >
              Clean {colTally.clean.toLocaleString()}
            </button>
          </div>
        </div>
        {loading ? (
          <div style={{ height: 150 }} className="flex items-center justify-center"><Spinner className="h-4 w-4" /></div>
        ) : barData.length > 0 ? (
          <>
            <div style={{ height: Math.max(90, barData.length * 26) }}>
              <FilterBarChart
                data={barData}
                dataKey="code"
                selectedItems={selectedShort}
                onBarClick={(data: { payload?: { code?: string } }, event: React.MouseEvent) => {
                  const reasons = data.payload?.code ? reasonsForLabel(data.payload.code) : [];
                  if (!reasons.length) return;
                  // Cmd/ctrl-click adds a bar (reasons are mutually exclusive per
                  // species, so multi-select is a union), plain click replaces —
                  // same convention as Criteria/Threats. A bar carries all of its
                  // reasons in and out together, so the URL stays a reason list
                  // and matchesRevisionFilter needs no notion of bars.
                  const isMulti = event.metaKey || event.ctrlKey;
                  const has = reasons.every(r => selectedColReasons.has(r));
                  setColReasons(prev => {
                    const next = new Set(isMulti ? prev : []);
                    if (isMulti && has) reasons.forEach(r => next.delete(r));
                    else if (!isMulti && has && prev.size === reasons.length) return new Set<string>();
                    else reasons.forEach(r => next.add(r));
                    return next;
                  });
                }}
                // This chart's bars are keyed by their display label, not the
                // reason id (FilterBarChart renders `code` as the axis tick), so
                // a swept range comes back as short labels — map them before
                // handing off to the shared additive/replace semantics.
                onRangeSelect={(keys, event) => {
                  const reasons = keys.flatMap(k => [...reasonsForLabel(k)]);
                  if (reasons.length) rangeSelectColReasons(reasons, event);
                }}
                barColor="#d97706"
                yAxisWidth={180}
                rightMargin={60}
                // Just the label. It used to append the reason's one-line
                // summary, which made the hover box 635px wide inside a 506px
                // card — covering every bar, so you could not see which one you
                // were about to click, and clipping its own text off the edge.
                // The summary was there when the labels were cryptic ("Renamed",
                // "In XR, not Base"); they now say what they mean, and the
                // sentence lives in the ⚑ tooltip on each row where there is room
                // for it.
                labelFormatter={(short: string) => short}
              />
            </div>
            {/* Why the bars total more than the ⚑ count. Split, lumped and the
                no-match reasons are independent properties, not one axis, so a
                species can sit in more than one bar. Rather than leave that as a
                silent gap for a reader to trip over, state it — and only when
                this view actually contains an overlap. */}
            {colTally.multiSignal > 0 && (
              <p
                className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400"
                title="Each bar still selects exactly the species it counts. A species that has been both split and lumped, say, appears in both."
              >
                {colTally.multiSignal.toLocaleString()} of these carry more than one signal, so the bars
                {" "}total {barTotal(colTally).toLocaleString()}, not {colTally.flagged.toLocaleString()}.
              </p>
            )}
            <p className="mt-1.5 text-[11px] italic leading-snug text-zinc-500 dark:text-zinc-400">
              {REVISION_CAVEAT}
            </p>
            {selectedColReasons.size > 0 && (
              <button
                type="button"
                onClick={() => setColReasons(new Set<string>())}
                className="self-start mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 underline"
              >
                Clear reason filter
              </button>
            )}
          </>
        ) : (
          <div style={{ height: 90 }} className="flex items-center justify-center">
            <span className="text-sm text-zinc-400 dark:text-zinc-500">
              {colTally.clean > 0 ? "No differences flagged here" : "No Catalogue of Life match data"}
            </span>
          </div>
        )}
      </div>
    );
  })();

  // Shared by Criteria/Threats/Habitat (#436 follow-up): renders a bar chart
  // with pills inserted directly below whichever bar(s) are currently
  // expanded, instead of a separate section below the WHOLE chart. Splits
  // `data` into segments at each expanded item's position — one FilterBarChart
  // per segment — with that item's pills sandwiched right after its own
  // segment. Each segment sizes to its own bar count (no fixed height/scroll);
  // the card just grows to fit, since drill-down height is now unpredictable
  // (could land after any bar, not just "below everything"). Criteria can have
  // multiple simultaneously-expanded top-level letters (Set-based), so this
  // produces more than 2 segments in that case; Threats/Habitat only ever
  // have one expanded category, so at most 2.
  type DrilldownBarDatum = { code: string; rawCode: string; count: number; label: string };
  function renderInlineDrilldown(
    data: DrilldownBarDatum[],
    isExpanded: (rawCode: string) => boolean,
    renderPills: (rawCode: string) => React.ReactNode,
    chartProps: Omit<React.ComponentProps<typeof FilterBarChart>, "data">,
    // Per-row pixel height. Default (22) is Threats/Habitat's original sizing;
    // Criteria passes 32 to match Number of Assessments' bar thickness, since
    // that chart sits fixed at 170px for its always-5 buckets (170/5 = 34px
    // slot, minus FilterBarChart's internal 5px top/bottom margins = 32px).
    rowHeight = 22
  ): React.ReactNode {
    const segments: { bars: DrilldownBarDatum[]; pillsAfter: string | null }[] = [];
    let current: DrilldownBarDatum[] = [];
    for (const item of data) {
      current.push(item);
      if (isExpanded(item.rawCode)) {
        segments.push({ bars: current, pillsAfter: item.rawCode });
        current = [];
      }
    }
    if (current.length > 0) segments.push({ bars: current, pillsAfter: null });
    // Each segment is a separate <FilterBarChart>, so without a shared xAxisMax
    // every segment auto-scales its bars to its OWN local max count — the
    // segment after the pills would then stretch its bars to fill the width
    // even though they represent smaller counts than bars in the segment
    // before it. Fix the domain to the full dataset's max so bar length stays
    // comparable across segments, same as it was before the split existed.
    const globalMax = data.length > 0 ? Math.max(...data.map(d => d.count)) : 0;
    return segments.map((seg, i) => (
      <React.Fragment key={i}>
        {seg.bars.length > 0 && (
          <div style={{ height: Math.max(30, seg.bars.length * rowHeight + 8) }}>
            <FilterBarChart data={seg.bars} xAxisMax={globalMax} {...chartProps} />
          </div>
        )}
        {seg.pillsAfter && renderPills(seg.pillsAfter)}
      </React.Fragment>
    ));
  }

  // Threats card — reassessments mode only (new-assessments shows Geospatial
  // GBIF Records instead, in Charts row 2). Lives in More Filters, not the
  // primary view — see the More Filters section below.
  const threatsCard = (() => {
    // Map label→code for reverse lookup from chart clicks
    const threatLabelToCode = new Map(THREAT_CATEGORIES.map(c => [c.label, c.code]));
    // Bar label: count + share of the in-view species the scope covers — under
    // the default scope that's every in-view THREATENED species (see threatTotal).
    const threatBarLabel = (count: number) =>
      `${count.toLocaleString()} (${threatTotal > 0 ? Math.round((count / threatTotal) * 100) : 0}%)`;
    // Use label as `code` field so it displays on y-axis, sorted by count desc
    const threatBarData: DrilldownBarDatum[] = THREAT_CATEGORIES
      .map(({ code, label }) => ({ code: label, rawCode: code, count: threatCounts[code] ?? 0, label: threatBarLabel(threatCounts[code] ?? 0) }))
      .filter(d => d.count > 0)
      .sort((a, b) => b.count - a.count);
    // selectedItems needs to use labels too for dimming. A category counts as
    // "selected" for muting purposes if it's directly selected OR any of its
    // children are (so clicking a pill mutes every OTHER top-level bar, not
    // just the ones that are themselves literally selected) — otherwise this
    // set would always end up empty once only a child pill is picked, and no
    // muting would ever happen.
    const selectedThreatLabels = new Set(
      THREAT_CATEGORIES.filter(c =>
        Array.from(selectedThreats).some(sel => sel === c.code || sel.startsWith(c.code + "."))
      ).map(c => c.label)
    );
    const loading = speciesLoading && assessedSpecies.length === 0;
    // Pills' left edge lines up with where the bars themselves start (past the
    // y-axis label column), not the chart's left edge — yAxisWidth (155) +
    // FilterBarChart's default leftMargin (5).
    const renderThreatPills = (rawCode: string) => {
      const drillCat = THREAT_CATEGORIES.find(c => c.code === rawCode);
      if (!drillCat) return null;
      return (
        <div className="flex flex-wrap gap-1 pb-1" style={{ paddingLeft: 160 }}>
          {drillCat.children.map(child => {
            const count = threatCounts[child.code] ?? 0;
            if (count === 0) return null;
            const isSelected = selectedThreats.has(child.code);
            return (
              <button
                key={child.code}
                onClick={(e) => {
                  const isMulti = e.metaKey || e.ctrlKey;
                  setSelectedThreats(prev => {
                    if (isMulti) { const next = new Set(prev); if (next.has(child.code)) next.delete(child.code); else next.add(child.code); return next; }
                    if (prev.size === 1 && prev.has(child.code)) return new Set();
                    return new Set([child.code]);
                  });
                }}
                className={`px-1.5 py-0.5 text-[11px] rounded-full transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-violet-500 text-white"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                }`}
              >
                {child.label} ({count.toLocaleString()}, {threatTotal > 0 ? Math.round((count / threatTotal) * 100) : 0}%)
              </button>
            );
          })}
        </div>
      );
    };
    return (
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
        <div className="flex items-center justify-between mb-1 min-h-[24px] flex-wrap gap-1">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Threats</span>
          {/* Scope — which species the threat data is drawn from. Defaults to
              threatened (CR/EN/VU) on IUCN's own advice that threat coding is
              only reliable there; "All species" is the opt-out. Highlighted in
              the default state precisely because it IS narrowing the data: a
              default that quietly drops species should say so on the card.
              Mirrors the Habitat card's Breadth dropdown. */}
          <div className="relative" ref={threatsScopeMenuRef}>
            <button
              type="button"
              onClick={() => setThreatsScopeMenuOpen(prev => !prev)}
              className={`px-2 py-0.5 text-xs font-semibold rounded transition-colors ${
                threatsScope === "threatened"
                  ? "bg-orange-400 text-white shadow-sm"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
              aria-expanded={threatsScopeMenuOpen}
              title="Which species these threat counts are drawn from"
            >
              {threatsScope === "threatened" ? "Threatened only" : "All species"} ▾
            </button>
            {threatsScopeMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-72">
                {([
                  { value: "threatened" as const, label: "Threatened only", hint: "Critically Endangered, Endangered and Vulnerable assessments" },
                  { value: "all" as const, label: "All species", hint: "Also count threats coded on non-threatened assessments" },
                ]).map(({ value, label, hint }) => (
                  <label
                    key={value}
                    className="flex items-start gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="threats-scope"
                      checked={threatsScope === value}
                      onChange={() => { setThreatsScope(value); setThreatsScopeMenuOpen(false); }}
                      className="mt-0.5 border-zinc-300 dark:border-zinc-600 text-orange-500 focus:ring-orange-400"
                    />
                    <span>
                      {label}
                      <br />
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        {loading ? (
          <div style={{ height: 200 }} className="flex items-center justify-center"><Spinner /></div>
        ) : threatBarData.length > 0 ? (
          renderInlineDrilldown(
            threatBarData,
            (rawCode) => expandedThreat.has(rawCode),
            renderThreatPills,
            {
              dataKey: "code",
              selectedItems: selectedThreatLabels,
              onBarClick: (data: { payload?: { code?: string } }, event: React.MouseEvent) => {
                const label = data.payload?.code;
                const code = label ? threatLabelToCode.get(label) : undefined;
                if (!code) return;
                const isMulti = event.metaKey || event.ctrlKey;
                setSelectedThreats(prev => {
                  if (isMulti) { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next; }
                  if (prev.size === 1 && prev.has(code)) return new Set();
                  return new Set([code]);
                });
                setExpandedThreat(prev => { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next; });
              },
              barColor: "#fb923c",
              yAxisWidth: 155,
              rightMargin: 80,
              yAxisTickMaxLength: 22,
            }
          )
        ) : (
          <div style={{ height: 200 }} className="flex items-center justify-center"><span className="text-sm text-zinc-400 dark:text-zinc-500">No threat data</span></div>
        )}
      </div>
    );
  })();

  // Habitat card — same bar-chart + 2-level drill-down pattern as threatsCard
  // above (18 top-level categories is a similar scale to threats' 12, so a bar
  // chart with counts reads better here than Criteria's small pill set). Three
  // toggle buttons in the header (mirroring Conservation Status's "Threatened"
  // button) cover the issue's "specialists"/"major vs minor"/"resident vs"
  // asks — kept as simple independent booleans rather than a second Set-based
  // multi-select dimension, since each is a binary refinement, not a category.
  const habitatCard = (() => {
    const habitatLabelToCode = new Map(HABITAT_CATEGORIES.map(c => [c.label, c.code]));
    // Bar label: count + share of species with habitat data (see habitatTotal).
    const habitatBarLabel = (count: number) =>
      `${count.toLocaleString()} (${habitatTotal > 0 ? Math.round((count / habitatTotal) * 100) : 0}%)`;
    const habitatBarData: DrilldownBarDatum[] = HABITAT_CATEGORIES
      .map(({ code, label }) => ({ code: label, rawCode: code, count: habitatCounts[code] ?? 0, label: habitatBarLabel(habitatCounts[code] ?? 0) }))
      .filter(d => d.count > 0)
      .sort((a, b) => b.count - a.count);
    const habitatTotalPages = Math.max(1, Math.ceil(habitatBarData.length / HABITAT_PAGE_SIZE));
    const safeHabitatPage = Math.min(habitatPage, habitatTotalPages - 1);
    const pagedHabitatBarData = habitatBarData.slice(safeHabitatPage * HABITAT_PAGE_SIZE, (safeHabitatPage + 1) * HABITAT_PAGE_SIZE);
    const selectedHabitatLabels = new Set(
      HABITAT_CATEGORIES.filter(c =>
        Array.from(selectedHabitat).some(sel => sel === c.code || sel.startsWith(c.code + "."))
      ).map(c => c.label)
    );
    const loading = speciesLoading && assessedSpecies.length === 0;
    const renderHabitatPills = (rawCode: string) => {
      const drillCat = HABITAT_CATEGORIES.find(c => c.code === rawCode);
      if (!drillCat) return null;
      return (
        <div className="flex flex-wrap gap-1 pb-1" style={{ paddingLeft: 160 }}>
          {drillCat.children.map(child => {
            const count = habitatCounts[child.code] ?? 0;
            if (count === 0) return null;
            const isSelected = selectedHabitat.has(child.code);
            return (
              <button
                key={child.code}
                onClick={(e) => {
                  const isMulti = e.metaKey || e.ctrlKey;
                  setSelectedHabitat(prev => {
                    if (isMulti) { const next = new Set(prev); if (next.has(child.code)) next.delete(child.code); else next.add(child.code); return next; }
                    if (prev.size === 1 && prev.has(child.code)) return new Set();
                    return new Set([child.code]);
                  });
                }}
                className={`px-1.5 py-0.5 text-[11px] rounded-full transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-teal-600 text-white"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                }`}
              >
                {child.label} ({count.toLocaleString()}, {habitatTotal > 0 ? Math.round((count / habitatTotal) * 100) : 0}%)
              </button>
            );
          })}
        </div>
      );
    };
    const toggleClass = (active: boolean) => `px-2 py-0.5 text-xs font-semibold rounded transition-colors ${
      active ? "bg-teal-600 text-white shadow-sm" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
    }`;
    return (
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
        <div className="flex items-center justify-between mb-1 min-h-[24px] flex-wrap gap-1">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Habitat</span>
          <div className="flex items-center flex-wrap gap-1 justify-end">
            {/* Breadth — single-select Specialist/Generalist dropdown, replacing
                a plain "Specialists" toggle so the (exactly 1)/(2+) split is
                explicit rather than only having an on/off specialists switch. */}
            <div className="relative" ref={habitatBreadthMenuRef}>
              <button
                type="button"
                onClick={() => { setHabitatBreadthMenuOpen(prev => !prev); setHabitatImportanceMenuOpen(false); setHabitatSeasonMenuOpen(false); setHabitatSuitabilityMenuOpen(false); }}
                className={toggleClass(habitatBreadth !== null)}
                aria-expanded={habitatBreadthMenuOpen}
              >
                {habitatBreadth === "specialist" ? "Specialists" : habitatBreadth === "generalist" ? "Generalists" : "Breadth"} ▾
              </button>
              {habitatBreadthMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-60">
                  {([
                    { value: null, label: "All species", hint: null },
                    { value: "specialist" as const, label: "Specialists", hint: "Exactly one known top-level habitat category" },
                    { value: "generalist" as const, label: "Generalists", hint: "Two or more known top-level habitat categories" },
                  ]).map(({ value, label, hint }) => (
                    <label
                      key={label}
                      className="flex items-start gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
                    >
                      <input
                        type="radio"
                        name="habitat-breadth"
                        checked={habitatBreadth === value}
                        onChange={() => setHabitatBreadth(value)}
                        className="mt-0.5 border-zinc-300 dark:border-zinc-600 text-teal-600 focus:ring-teal-500"
                      />
                      <span>
                        {label}
                        {hint && (
                          <>
                            <br />
                            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{hint}</span>
                          </>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Importance — multi-select checkbox list, all checked by default
                (nothing excluded); unchecking e.g. "Minor" behaves like the old
                "Exclude minor" toggle but reads less ambiguously as one option
                among an explicit, fully-visible set (matching Season below). */}
            <div className="relative" ref={habitatImportanceMenuRef}>
              <button
                type="button"
                onClick={() => { setHabitatImportanceMenuOpen(prev => !prev); setHabitatBreadthMenuOpen(false); setHabitatSeasonMenuOpen(false); setHabitatSuitabilityMenuOpen(false); }}
                className={toggleClass(habitatImportanceActive)}
                aria-expanded={habitatImportanceMenuOpen}
              >
                Importance{habitatImportanceActive ? ` (${selectedHabitatImportance.size})` : ""} ▾
              </button>
              {habitatImportanceMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-48">
                  {HABITAT_IMPORTANCE_OPTIONS.map(({ value, short }) => (
                    <label
                      key={value}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
                      title={value === "Unknown" ? "Importance not recorded in the IUCN DB" : value}
                    >
                      <input
                        type="checkbox"
                        checked={selectedHabitatImportance.has(value)}
                        onChange={() => setSelectedHabitatImportance(prev => {
                          const next = new Set(prev);
                          if (next.has(value)) next.delete(value); else next.add(value);
                          return next;
                        })}
                        className="rounded border-zinc-300 dark:border-zinc-600 text-teal-600 focus:ring-teal-500"
                      />
                      {short}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Season — multi-select checkbox list in a dropdown, all checked by
                default (nothing excluded), covering all 5 IUCN season values. */}
            <div className="relative" ref={habitatSeasonMenuRef}>
              <button
                type="button"
                onClick={() => { setHabitatSeasonMenuOpen(prev => !prev); setHabitatBreadthMenuOpen(false); setHabitatImportanceMenuOpen(false); setHabitatSuitabilityMenuOpen(false); }}
                className={toggleClass(habitatSeasonsActive)}
                aria-expanded={habitatSeasonMenuOpen}
              >
                Season{habitatSeasonsActive ? ` (${selectedHabitatSeasons.size})` : ""} ▾
              </button>
              {habitatSeasonMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-48">
                  {HABITAT_SEASON_OPTIONS.map(({ value, short }) => (
                    <label
                      key={value}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
                      title={value}
                    >
                      <input
                        type="checkbox"
                        checked={selectedHabitatSeasons.has(value)}
                        onChange={() => setSelectedHabitatSeasons(prev => {
                          const next = new Set(prev);
                          if (next.has(value)) next.delete(value); else next.add(value);
                          return next;
                        })}
                        className="rounded border-zinc-300 dark:border-zinc-600 text-teal-600 focus:ring-teal-500"
                      />
                      {short}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Suitability — multi-select checkbox list, all checked by default
                (nothing excluded), covering all 3 IUCN suitability values. */}
            <div className="relative" ref={habitatSuitabilityMenuRef}>
              <button
                type="button"
                onClick={() => { setHabitatSuitabilityMenuOpen(prev => !prev); setHabitatBreadthMenuOpen(false); setHabitatImportanceMenuOpen(false); setHabitatSeasonMenuOpen(false); }}
                className={toggleClass(habitatSuitabilityActive)}
                aria-expanded={habitatSuitabilityMenuOpen}
              >
                Suitability{habitatSuitabilityActive ? ` (${selectedHabitatSuitability.size})` : ""} ▾
              </button>
              {habitatSuitabilityMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-48">
                  {HABITAT_SUITABILITY_OPTIONS.map(({ value, short }) => (
                    <label
                      key={value}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
                      title={value === "Unknown" ? "Suitability not recorded in the IUCN DB" : value}
                    >
                      <input
                        type="checkbox"
                        checked={selectedHabitatSuitability.has(value)}
                        onChange={() => setSelectedHabitatSuitability(prev => {
                          const next = new Set(prev);
                          if (next.has(value)) next.delete(value); else next.add(value);
                          return next;
                        })}
                        className="rounded border-zinc-300 dark:border-zinc-600 text-teal-600 focus:ring-teal-500"
                      />
                      {short}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {loading ? (
          <div style={{ height: 200 }} className="flex items-center justify-center"><Spinner /></div>
        ) : habitatBarData.length > 0 ? (
          <>
            {renderInlineDrilldown(
              pagedHabitatBarData,
              (rawCode) => expandedHabitat.has(rawCode),
              renderHabitatPills,
              {
                dataKey: "code",
                selectedItems: selectedHabitatLabels,
                onBarClick: (data: { payload?: { code?: string } }, event: React.MouseEvent) => {
                  const label = data.payload?.code;
                  const code = label ? habitatLabelToCode.get(label) : undefined;
                  if (!code) return;
                  const isMulti = event.metaKey || event.ctrlKey;
                  setSelectedHabitat(prev => {
                    if (isMulti) { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next; }
                    if (prev.size === 1 && prev.has(code)) return new Set();
                    return new Set([code]);
                  });
                  setExpandedHabitat(prev => { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next; });
                },
                barColor: "#0d9488",
                yAxisWidth: 155,
                rightMargin: 80,
                yAxisTickMaxLength: 22,
              }
            )}
            {habitatTotalPages > 1 && (
              <div className="shrink-0 flex items-center justify-between pt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                <button
                  onClick={() => setHabitatPage(p => Math.max(0, p - 1))}
                  disabled={safeHabitatPage === 0}
                  className="px-1.5 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Prev
                </button>
                <span className="tabular-nums">Page {safeHabitatPage + 1} of {habitatTotalPages}</span>
                <button
                  onClick={() => setHabitatPage(p => Math.min(habitatTotalPages - 1, p + 1))}
                  disabled={safeHabitatPage >= habitatTotalPages - 1}
                  className="px-1.5 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            )}
          </>
        ) : (
          <div style={{ height: 200 }} className="flex items-center justify-center"><span className="text-sm text-zinc-400 dark:text-zinc-500">No habitat data</span></div>
        )}
      </div>
    );
  })();

  // Renders one small pill row for a level of the Criteria drill-down (number,
  // sub-clause, or roman-numeral rows as the user drills deeper below the
  // top-level A-E bar chart — see CRITERIA_CATEGORIES' doc comment for why the
  // depth varies per branch). Indents a little more per level so a deep drill
  // (B -> B1 -> B1b -> B1b(iii)) still reads as a staircase, not a flat list.
  // A plain click replaces the whole selection with just this code (or clears
  // it, if it was already the sole selection) — the same single-select
  // convention every other filter chip in this file uses. Cmd/ctrl-click
  // instead TOGGLES this code in/out of selectedCriteria without touching the
  // rest, for real multi-select across branches (e.g. B1b(iii) AND C2a(i)
  // together). Independently, clicking a node with children toggles ITS OWN
  // membership in expandedCriteria (not a single shared "last expanded"
  // value), so drilling into one branch never collapses another branch you
  // already had open.
  const renderCriteriaRow = (nodes: CriteriaNode[], depth: number) => (
    // Depth 1's pills align with where the bar chart's bars start
    // (yAxisWidth 42 + leftMargin 5 = 47), same principle as Threats/Habitat's
    // top-level pills; deeper levels keep the original 10px-per-level
    // staircase on top of that base.
    <div className="flex flex-wrap gap-1" style={{ paddingLeft: 47 + (depth - 1) * 10 }}>
      {nodes.map(node => {
        const isSelected = selectedCriteria.has(node.code);
        const count = criteriaCounts[node.code] ?? 0;
        if (count === 0 && !isSelected) return null;
        return (
          <button
            key={node.code}
            onClick={(e) => {
              const isMulti = e.metaKey || e.ctrlKey;
              if (isMulti) {
                setSelectedCriteria(prev => { const next = new Set(prev); if (next.has(node.code)) next.delete(node.code); else next.add(node.code); return next; });
              } else {
                setSelectedCriteria(prev => (prev.size === 1 && prev.has(node.code)) ? new Set() : new Set([node.code]));
              }
              if (node.children.length > 0) {
                setExpandedCriteria(prev => { const next = new Set(prev); if (next.has(node.code)) next.delete(node.code); else next.add(node.code); return next; });
              }
            }}
            className={`px-1.5 py-0.5 text-[11px] rounded-full transition-colors cursor-pointer ${
              isSelected
                ? "bg-indigo-500 text-white"
                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            }`}
            title={node.label}
          >
            {node.code} ({count.toLocaleString()}, {criteriaTotal > 0 ? Math.round((count / criteriaTotal) * 100) : 0}%)
          </button>
        );
      })}
    </div>
  );

  // Recursively renders a level and, for every node in it that's currently expanded,
  // that node's children level right after — so any number of branches (at any depth)
  // can be open simultaneously, not just one linear drill path.
  const renderCriteriaLevel = (nodes: CriteriaNode[], depth: number): React.ReactNode => (
    <React.Fragment>
      {renderCriteriaRow(nodes, depth)}
      {nodes.map(node => (
        expandedCriteria.has(node.code) && node.children.length > 0 ? (
          <React.Fragment key={`${node.code}-children`}>{renderCriteriaLevel(node.children, depth + 1)}</React.Fragment>
        ) : null
      ))}
    </React.Fragment>
  );

  // Criteria card (#436): top-level A-E as a bar chart, same interaction as
  // Threats/Habitat's top-level chart — a bar click both selects the code and
  // toggles that branch's membership in expandedCriteria. Deliberately NOT
  // sorted by count (unlike Threats/Habitat) — A-E is a standardized, widely
  // recognized IUCN ordering, and reshuffling it by count would work against
  // that familiarity. Deeper levels stay exactly as before: renderCriteriaLevel's
  // recursive pill rows, unchanged — the issue's "opens pills not nested bars"
  // ask was already true for Criteria beyond the top level.
  const criteriaCard = (() => {
    // code === rawCode here (CRITERIA_CATEGORIES' top-level code is already
    // the bare letter) — bare letters on the axis match Number of
    // Assessments' bare short labels so the two charts' bar geometry lines up
    // when they sit side by side; the full description moves to the tooltip
    // via labelFormatter below instead of living on the axis.
    // Bar label: count + share of species that have criteria data (see
    // criteriaTotal) — not all in-view species, so these can sum past 100%
    // for species listed under multiple letters (e.g. B1+B2).
    const criteriaBarLabel = (count: number) =>
      `${count.toLocaleString()} (${criteriaTotal > 0 ? Math.round((count / criteriaTotal) * 100) : 0}%)`;
    const criteriaBarData: DrilldownBarDatum[] = CRITERIA_CATEGORIES
      .map(({ code }) => ({ code, rawCode: code, count: criteriaCounts[code] ?? 0, label: criteriaBarLabel(criteriaCounts[code] ?? 0) }))
      .filter(d => d.count > 0 || selectedCriteria.has(d.rawCode));
    // A top-level letter counts as "selected" (and so isn't muted) if it OR
    // any of its selected descendants (e.g. "B1b" under "B") is selected.
    const selectedCriteriaCodes = new Set(
      CRITERIA_CATEGORIES.filter(c =>
        Array.from(selectedCriteria).some(sel => sel === c.code || sel.startsWith(c.code))
      ).map(c => c.code)
    );
    const loading = speciesLoading && assessedSpecies.length === 0;
    const renderCriteriaPills = (rawCode: string) => {
      const node = CRITERIA_CATEGORIES.find(n => n.code === rawCode);
      if (!node) return null;
      return <div className="pb-1">{renderCriteriaLevel(node.children, 1)}</div>;
    };
    return (
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
        <div className="flex items-center justify-between mb-1 min-h-[24px]">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Assessment Criteria</span>
        </div>
        {loading ? (
          <div style={{ height: 90 }} className="flex items-center justify-center"><Spinner className="h-4 w-4" /></div>
        ) : criteriaBarData.length > 0 ? (
          renderInlineDrilldown(
            criteriaBarData,
            (rawCode) => expandedCriteria.has(rawCode),
            renderCriteriaPills,
            {
              dataKey: "code",
              selectedItems: selectedCriteriaCodes,
              onBarClick: (data: { payload?: { code?: string } }, event: React.MouseEvent) => {
                const code = data.payload?.code;
                if (!code) return;
                const isMulti = event.metaKey || event.ctrlKey;
                if (isMulti) {
                  setSelectedCriteria(prev => { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next; });
                } else {
                  setSelectedCriteria(prev => (prev.size === 1 && prev.has(code)) ? new Set() : new Set([code]));
                }
                const node = CRITERIA_CATEGORIES.find(n => n.code === code);
                if (node && node.children.length > 0) {
                  setExpandedCriteria(prev => { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next; });
                }
              },
              barColor: "#6366f1",
              yAxisWidth: 42,
              rightMargin: 85,
              labelFormatter: (code: string) => CRITERIA_CATEGORIES.find(c => c.code === code)?.label ?? code,
            },
            32
          )
        ) : (
          <div style={{ height: 90 }} className="flex items-center justify-center"><span className="text-sm text-zinc-400 dark:text-zinc-500">No criteria data</span></div>
        )}
      </div>
    );
  })();

  return (
    <div className="space-y-1 min-w-0 flex-1 flex flex-col min-h-0">
      {/* Always show Taxa Summary table */}
      {/* Country View's landing map is sized by a flex chain that runs from
          page.tsx's min-h-screen box, through <main>, through this component's
          root, down to TaxaSummary's own `flex-1 min-h-0` map wrapper — each
          link has to be a flex container that passes the slack down. This
          wrapper is a plain block box, so it collapsed to the
          map's intrinsic height and the landing map rendered at roughly half
          height with dead space below it. Re-join the chain here, but only for
          the landing state: once a country's picked the map lives in a 2-col
          grid whose height comes from the table beside it, and in every
          non-country layout this wrapper holds the full taxa table, which
          should keep sizing to its own content. */}
      <div
        className={layoutMode === "country" && !countryScope ? "flex-1 min-h-0 flex flex-col" : undefined}
      >
      <TaxaSummary
        onToggleTaxon={handleToggleTaxon}
        selectedTaxa={selectedTaxa}
        selectedSubgroups={selectedSubgroups}
        disableAllSpecies={isNewAssessments}
        viewMode={viewMode}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        countryModeContent={countryModeContent}
        countryPillsContent={countryPillsContent}
        countryScope={countryScope}
        onToggleSubgroup={(sgId) => {
          // Clicking a view root ancestor → clear subgroups to show its children.
          // If the currently-selected subgroup is an SSC group, we got here by
          // drilling out of SSC groups mode — return to that flat table instead
          // of falling through to the plain taxon tree view.
          if (selectedTaxa.has(sgId)) {
            if ([...selectedSubgroups].some(id => id.startsWith("ssc-"))) {
              returnToLayoutMode("ssc");
              return;
            }
            setSelectedSubgroups(new Set());
            return;
          }
          const wasSelected = selectedSubgroups.has(sgId);
          if (wasSelected) {
            // Already selected — no-op (TaxaSummary handles expand/collapse,
            // ancestors handle navigation)
            return;
          } else {
            // Selecting: set exactly this one subgroup
            setSelectedSubgroups(new Set([sgId]));
            // Ensure the correct view root is selected for species fetching
            const viewRoot = getViewRootForNode(sgId);
            if (viewRoot && (!selectedTaxa.has(viewRoot) || selectedTaxa.size !== 1)) {
              skipClearOnTaxaChangeRef.current = true;
              setSelectedTaxa(new Set([viewRoot]));
            }
          }
        }}
        onNavigateToSubgroup={(taxonId, subgroupId) => {
          // Navigate directly to a taxon + subgroup atomically (avoids clearAllFilters race,
          // and pushes a single history entry so one back-press undoes the whole navigation —
          // including exiting Table 1a/SSC groups mode, which this also clears)
          skipClearOnTaxaChangeRef.current = true;
          navigateToTaxonSubgroup(taxonId, subgroupId);
        }}
      />
      </div>

      {/* Error state */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-6 py-4 rounded-lg">
          <p className="font-medium">Failed to load {isNewAssessments ? "" : "Red List "}data</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      )}

      {/* Charts, search, and species table - only visible after a taxon is selected.
          Hidden in country mode too: TaxaSummary's own countryModeContent (the
          promoted WorldMap) is the entire page there, and selectedTaxa is only
          "all" in that mode as a side effect of loading species for the map's own
          stats (see setLayoutMode), not a real drill-down into All Species. */}
      {selectedTaxa.size > 0 && layoutMode !== "country" && (
      // The drill-down prompt is about not being able to list a whole giant taxon — it
      // must not swallow a specific species the user searched for, which is already in
      // hand (singleSpeciesPreview) and needs no list to render.
      neTooLarge && !singleSpeciesPreview ? (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-amber-200 dark:border-amber-900/40 px-6 py-10 text-center">
          <p className="text-base font-medium text-zinc-700 dark:text-zinc-200">
            {neTooLarge.names.join(" & ")} has {neTooLarge.neTotal.toLocaleString()} not-evaluated species — too many to load at once.
          </p>
          <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
            Open a sub-group (a class or order — e.g. Beetles, Crustaceans) above to view its charts and species list.
          </p>
        </div>
      ) : (
      <div className="space-y-3">

          {/* Single species header — skeleton while loading */}
          {!isSingleSpecies && urlSpecies != null && speciesLoading && (
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-5 py-4 flex items-center gap-4 animate-pulse">
              <div className="w-24 h-24 bg-zinc-200 dark:bg-zinc-700 rounded flex-shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-5 bg-zinc-200 dark:bg-zinc-700 rounded w-48" />
                <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded w-32" />
              </div>
            </div>
          )}
          {/* Single species header */}
          {isSingleSpecies && singleSpecies && (() => {
            const details = speciesDetails[singleSpecies.species_key];
            return (
              <div
                className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-5 py-4 flex items-center gap-4"
              >
                {details?.inatDefaultImage === undefined ? (
                  <div className="w-24 h-24 bg-zinc-100 dark:bg-zinc-800 rounded flex-shrink-0 flex items-center justify-center">
                    <span className="inline-block animate-spin h-5 w-5 border-2 border-zinc-400 border-t-transparent rounded-full" />
                  </div>
                ) : details?.inatDefaultImage?.squareUrl ? (
                  <img
                    src={details.inatDefaultImage.mediumUrl || details.inatDefaultImage.squareUrl}
                    alt=""
                    className="w-24 h-24 object-cover rounded flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-red-400"
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const preview = document.getElementById('image-preview');
                      if (preview) {
                        (preview as HTMLImageElement).src = details.inatDefaultImage?.mediumUrl || details.inatDefaultImage?.squareUrl || '';
                        preview.style.display = 'block';
                        preview.style.top = `${rect.top - 192 - 8}px`;
                        preview.style.left = `${rect.left}px`;
                      }
                    }}
                    onMouseLeave={() => {
                      const preview = document.getElementById('image-preview');
                      if (preview) preview.style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-24 h-24 bg-zinc-100 dark:bg-zinc-800 rounded flex items-center justify-center text-zinc-400 flex-shrink-0">
                    <TaxaIcon taxonId={singleSpecies.taxon_id || "all"} size={40} />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="italic font-semibold text-zinc-900 dark:text-zinc-100 text-lg">
                    {singleSpecies.scientific_name}
                  </div>
                  {singleSpecies.common_name && (
                    <div className="text-zinc-500 dark:text-zinc-400 text-sm">
                      {singleSpecies.common_name}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Charts row 1: bar charts (new-assessments mode only shows GBIF Observations) */}
          {!isNewAssessments && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Conservation Status */}
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Conservation Status</span>
                {!(isSingleSpecies && singleSpecies) && (
                  <button
                    type="button"
                    onClick={handleThreatenedClick}
                    className={`px-2 py-0.5 text-xs font-semibold rounded transition-colors ${
                      isThreatenedSelected
                        ? "bg-red-600 text-white shadow-sm"
                        : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                    }`}
                    aria-pressed={isThreatenedSelected}
                    title="Select Critically Endangered, Endangered and Vulnerable"
                  >
                    Threatened
                  </button>
                )}
              </div>
              <div className="flex-1 min-h-[150px] flex items-center justify-center">
                {speciesLoading && assessedSpecies.length === 0 ? (
                  <Spinner />
                ) : isSingleSpecies && singleSpecies ? (
                  <span
                    className="px-5 py-2.5 text-2xl font-bold rounded text-center"
                    style={{
                      backgroundColor: (CATEGORY_COLORS[singleSpecies.category] || "#999") + "20",
                      color: singleSpecies.category === "EX" || singleSpecies.category === "EW" ? "#fff" : CATEGORY_COLORS[singleSpecies.category] || "#999",
                      ...(singleSpecies.category === "EX" || singleSpecies.category === "EW" ? { backgroundColor: CATEGORY_COLORS[singleSpecies.category] } : {}),
                    }}
                  >
                    {{ EX: "Extinct", EW: "Extinct in the Wild", CR: "Critically Endangered", EN: "Endangered", VU: "Vulnerable", NT: "Near Threatened", LC: "Least Concern", DD: "Data Deficient", NE: "Not Evaluated" }[singleSpecies.category] || singleSpecies.category}
                  </span>
                ) : categoryDataWithPercent.length > 0 ? (
                  <FilterBarChart
                    data={categoryDataWithPercent}
                    dataKey="code"
                    selectedItems={selectedCategories}
                    onBarClick={handleCategoryClick}
                    onRangeSelect={rangeSelectCategories}
                    yAxisWidth={26}
                    rightMargin={55}
                    labelFormatter={(code) => ({
                      EX: "Extinct",
                      EW: "Extinct in the Wild",
                      CR: "Critically Endangered",
                      EN: "Endangered",
                      VU: "Vulnerable",
                      NT: "Near Threatened",
                      LC: "Least Concern",
                      DD: "Data Deficient",
                    }[code] || code)}
                  />
                ) : null}
              </div>
            </div>

            {/* Years Since Assessed / Year of Latest Assessment */}
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
              {/* The charts row is a fixed-width 3-up grid, so this header always has
                  ~305px to work with, whatever the viewport. Title + the "10+ yrs old"
                  button + the view select came to ~341px, which wrapped the two controls onto
                  a row of their own; the sizes below (and on both controls) are what
                  fits them beside the title instead. It still wraps rather than
                  overflowing if a platform's text runs wider than the ~6px to spare. */}
              <div className="flex flex-wrap items-center justify-between mb-1 gap-x-1.5 gap-y-1">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                  {yearsChartMode === "range" ? "Years Since Assessed" : "Year of Latest Assessment"}
                </span>
                <div className="flex items-center gap-1">
                  {/* Outdated shortcut: filter to species assessed >10 years ago (mirrors the Threatened button).
                      Range-view only — the Year view's muting is only year-granular, so the button's precise
                      cutoff date doesn't line up as cleanly there. */}
                  {!(isSingleSpecies && singleSpecies) && yearsChartMode === "range" && (
                    <button
                      type="button"
                      onClick={handleOutdatedClick}
                      className={`px-1 py-0.5 text-[11px] font-semibold rounded transition-colors ${
                        isOutdatedSelected
                          ? "bg-red-600 text-white shadow-sm"
                          : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                      }`}
                      aria-pressed={isOutdatedSelected}
                      title={`Filter to species last assessed before ${outdatedCutoffDate(dataAsOf).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`}
                    >
                      10+ yrs old
                    </button>
                  )}
                  {/* Pagination controls (year view only, and only when multiple pages) */}
                  {!(isSingleSpecies && singleSpecies) && yearsChartMode === "year" && yearsTotalPages > 1 && (() => {
                    const firstYear = paginatedAssessmentYearsData[0]?.code;
                    const lastYear = paginatedAssessmentYearsData[paginatedAssessmentYearsData.length - 1]?.code;
                    const label = firstYear && lastYear
                      ? (firstYear === lastYear ? firstYear : `${firstYear}–${lastYear}`)
                      : "";
                    const canPrev = yearsPage > 0;
                    const canNext = yearsPage < yearsTotalPages - 1;
                    return (
                      <div className="inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                        <button
                          type="button"
                          onClick={() => canPrev && setYearsPage(p => Math.max(0, p - 1))}
                          disabled={!canPrev}
                          className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label="Previous years"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6" />
                          </svg>
                        </button>
                        <span className="tabular-nums min-w-[64px] text-center" aria-live="polite" aria-atomic="true">{label}</span>
                        <button
                          type="button"
                          onClick={() => canNext && setYearsPage(p => Math.min(yearsTotalPages - 1, p + 1))}
                          disabled={!canNext}
                          className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label="Next years"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </button>
                      </div>
                    );
                  })()}
                  {!(isSingleSpecies && singleSpecies) && (
                    // appearance-none + our own chevron: a native select reserves a
                    // chunk of width for the platform's own arrow (wider still on
                    // macOS) that no amount of padding reclaims. The chevron is an SVG
                    // rather than a "▾" glyph so its width doesn't vary by platform
                    // font either — see the header's note on how little room there is.
                    <div className="relative">
                      <select
                        value={yearsChartMode}
                        onChange={(e) => changeYearsChartMode(e.target.value as "range" | "year")}
                        aria-label="Year chart view"
                        className="appearance-none text-[11px] font-semibold bg-zinc-100 dark:bg-zinc-800 rounded-md pl-1 pr-3 py-0.5 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                      >
                        <option value="range">Range</option>
                        <option value="year">Year</option>
                      </select>
                      <svg aria-hidden className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 w-2 h-2 text-zinc-500 dark:text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1 min-h-[150px] flex flex-col">
                {speciesLoading && assessedSpecies.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center"><Spinner /></div>
                ) : isSingleSpecies && singleSpecies ? (
                  <div className="flex-1 flex items-center justify-center">
                    {(() => {
                      if (!singleSpecies.assessment_date) return (
                        <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">N/A</span>
                      );
                      const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
                      const elapsed = Date.now() - new Date(singleSpecies.assessment_date).getTime();
                      const yearsSince = elapsed / msPerYear;
                      const range = yearsSince < 1 ? "<1y" : yearsSince < 5 ? "1-5y" : yearsSince < 10 ? "5-10y" : yearsSince < 20 ? "10-20y" : ">20y";
                      return (
                        <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">
                          {range}
                        </span>
                      );
                    })()}
                  </div>
                ) : yearsChartMode === "range" ? (
                  assessmentYearData.length > 0 ? (
                    <div className="flex-1 flex items-center justify-center">
                      <FilterBarChart
                        data={assessmentYearData}
                        dataKey="shortRange"
                        selectedItems={yearRangeSelectedItems}
                        onBarClick={handleYearClick}
                        onRangeSelect={rangeSelectYearRanges}
                        barColor="#3b82f6"
                        yAxisWidth={36}
                        rightMargin={85}
                      />
                    </div>
                  ) : null
                ) : paginatedAssessmentYearsData.length > 0 ? (
                  <div className="flex-1">
                    <YearBarChart
                      data={paginatedAssessmentYearsData}
                      selectedItems={assessmentYearSelectedItems}
                      onBarClick={handleAssessmentYearClick}
                      onRangeSelect={rangeSelectAssessmentYears}
                      barColor="#3b82f6"
                      yMax={yearsGlobalMax}
                    />
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-sm text-zinc-400 dark:text-zinc-500">No assessments</span>
                  </div>
                )}
              </div>
            </div>

            {/* GBIF Records */}
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1">GBIF Records <GbifInfoTooltip /></span>
                              </div>
              <div className="flex-1 min-h-[150px] flex items-center justify-center">
                {speciesLoading && assessedSpecies.length === 0 ? (
                  <Spinner />
                ) : isSingleSpecies && singleSpecies ? (
                  <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">
                    {gbifObsBucket(singleSpecies.gbif_occurrence_count)}
                  </span>
                ) : gbifObsData.length > 0 ? (
                  <FilterBarChart
                    data={gbifObsData}
                    dataKey="shortRange"
                    selectedItems={selectedObsRanges}
                    onBarClick={handleObsClick}
                    onRangeSelect={rangeSelectObsRanges}
                    barColor="#10b981"
                    yAxisWidth={42}
                    rightMargin={85}
                  />
                ) : null}
              </div>
            </div>
          </div>
          )}

          {/* Charts row 2 (new-assessments mode only): Country map + Year
              Described + GBIF Records, 3-col, 1/3 each. For
              reassessments, Country map + Threats live in More Filters
              instead (below) — decluttered out of the always-visible primary
              view now that they're not the only geographic/threat filter
              (see countryMapCard/threatsCard, defined above). */}
          {isNewAssessments && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {countryMapCard}

            {/* Year Described */}
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1">
                  Year Described
                  <HoverTooltip text="Year the species was scientifically described, from the Catalogue of Life. Available for ~99% of animals; many plants, fungi and algae have no datable record in CoL and fall under 'Unknown'.">
                    <svg className="w-3 h-3 text-zinc-400 dark:text-zinc-500 cursor-help" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 16v-4M12 8h.01" />
                    </svg>
                  </HoverTooltip>
                </span>
              </div>
              <div style={{ height: 180 }} className="flex items-center justify-center">
                {speciesLoading && assessedSpecies.length === 0 ? (
                  <Spinner />
                ) : isSingleSpecies && singleSpecies ? (
                  // One species is one bar — a chart of it says nothing the number
                  // doesn't. Show the year itself rather than its bucket: unlike the
                  // GBIF card below, the exact value is short enough to read at a glance.
                  <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">
                    {singleSpecies.described_year ?? "Unknown"}
                  </span>
                ) : describedYearData.length > 0 ? (
                  <FilterBarChart
                    data={describedYearData}
                    dataKey="shortRange"
                    selectedItems={selectedDescribedYears}
                    onBarClick={handleDescribedYearClick}
                    onRangeSelect={rangeSelectDescribedYears}
                    barColor="#3b82f6"
                    yAxisWidth={64}
                    rightMargin={85}
                  />
                ) : (
                  <span className="text-sm text-zinc-400 dark:text-zinc-500">No description-year data</span>
                )}
              </div>
            </div>

            {/* GBIF Records */}
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1">GBIF Records <GbifInfoTooltip /></span>
              </div>
              <div style={{ height: 180 }} className="flex items-center justify-center">
                {speciesLoading && assessedSpecies.length === 0 ? (
                  <Spinner />
                ) : isSingleSpecies && singleSpecies ? (
                  <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">
                    {gbifObsBucket(singleSpecies.gbif_occurrence_count)}
                  </span>
                ) : (
                  <FilterBarChart
                    data={gbifObsData}
                    dataKey="shortRange"
                    selectedItems={selectedObsRanges}
                    onBarClick={handleObsClick}
                    onRangeSelect={rangeSelectObsRanges}
                    barColor="#10b981"
                    yAxisWidth={42}
                    rightMargin={85}
                  />
                )}
              </div>
            </div>
          </div>
          )}

          {/* Country + Threats are always visible, alongside Charts row 1
              above — everything past that (Growth Form, Assessment
              Criteria/Number of Assessments, Realm/Movement/Trend,
              Habitat/Assessors-Reviewers) lives behind the "More Filters"
              toggle below. No independently-scrollable panel here anymore
              — nested scrollbars (the panel's own, inside the page's) read as
              confusing, so this reverts to plain click-to-expand instead. */}
          {!isNewAssessments && (
            <>
                {/* Country alongside the assessment credits. */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {countryMapCard}
                  {isSingleSpecies && singleSpecies ? (() => {
                    // Facilitators are absent on ~62% of latest assessments, and
                    // contributors (~67%) and institutions (~81%) more often still —
                    // each is only filled in particular circumstances — so
                    // "Contributors / None listed" is the common case, not the
                    // exception. Drop those cards rather than spend the row saying
                    // nothing. Assessors and Reviewers keep theirs: empty there is
                    // genuinely notable.
                    const cards = [
                      { title: "Assessors", names: singleSpeciesAssessors },
                      { title: "Reviewers", names: singleSpeciesReviewers },
                      ...(singleSpeciesFacilitators.length > 0
                        ? [{ title: "Facilitators", names: singleSpeciesFacilitators }]
                        : []),
                      ...(singleSpeciesContributors.length > 0
                        ? [{ title: "Contributors", names: singleSpeciesContributors }]
                        : []),
                      ...(singleSpeciesInstitutions.length > 0
                        ? [{ title: "Institutions", names: singleSpeciesInstitutions }]
                        : []),
                    ];
                    return (
                    <div className={`grid grid-cols-1 gap-3 ${cards.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
                      {cards.map(({ title, names }) => (
                        <div key={title} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</span>
                          </div>
                          <div className="overflow-y-auto mt-2" style={{ maxHeight: 260 }}>
                            {names.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {names.map((name) => (
                                  <span key={name} className="inline-block px-3 py-1.5 text-sm rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">{name}</span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-sm text-zinc-400 dark:text-zinc-500">None listed</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    );
                  })() : (
                    <ReviewerChart
                      data={creditChartData}
                      viewMode={assessorReviewerMode}
                      onViewModeChange={changeCreditChartMode}
                      selectedItems={creditSelection[assessorReviewerMode].selected}
                      onBarClick={makeAssessorClick(creditSelection[assessorReviewerMode].setter)}
                      onRangeSelect={makeRangeSelect(creditSelection[assessorReviewerMode].setter)}
                      onItemToggle={makeAssessorToggle(creditSelection[assessorReviewerMode].setter)}
                      loading={speciesLoading && assessedSpecies.length === 0}
                    />
                  )}
                </div>

                <button
                  onClick={() => setMoreFiltersOpen(prev => !prev)}
                  className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  <svg className={`w-3.5 h-3.5 transition-transform ${moreFiltersOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  More Filters
                  {(selectedGrowthForms.size + selectedHabitat.size + (habitatBreadth ? 1 : 0) + (habitatImportanceActive ? 1 : 0) + (habitatSeasonsActive ? 1 : 0) + (habitatSuitabilityActive ? 1 : 0) + selectedAssessmentCounts.size + selectedSystems.size + selectedMovementPatterns.size + selectedPopulationTrends.size + selectedCriteria.size + selectedAssessors.size + selectedReviewers.size + selectedFacilitators.size + selectedContributors.size + selectedInstitutions.size > 0) && (
                    <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">
                      {selectedGrowthForms.size + selectedHabitat.size + (habitatBreadth ? 1 : 0) + (habitatImportanceActive ? 1 : 0) + (habitatSeasonsActive ? 1 : 0) + (habitatSuitabilityActive ? 1 : 0) + selectedAssessmentCounts.size + selectedSystems.size + selectedMovementPatterns.size + selectedPopulationTrends.size + selectedCriteria.size + selectedAssessors.size + selectedReviewers.size + selectedFacilitators.size + selectedContributors.size + selectedInstitutions.size} active
                    </span>
                  )}
                </button>
            </>
          )}

          {!isNewAssessments && moreFiltersOpen && (
            <>
                {/* Growth Form (plants/fungi only) */}
                {(() => {
                  if (speciesLoading && assessedSpecies.length === 0) {
                    return (
                      <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0 w-20">Growth</span>
                        <Spinner className="h-4 w-4" />
                      </div>
                    );
                  }
                  // Compute growth form counts cross-filtered (exclude own filter)
                  const gfCounts: Record<string, number> = {};
                  taxaFilteredSpecies.forEach(s => {
                    if (!s.growth_forms?.length) return;
                    if (!matchesSearch(s)) return;
                    if (selectedCategories.size > 0 && !selectedCategories.has(s.category)) return;
                    if (selectedCountries.size > 0 && !s.countries.some(c => selectedCountries.has(c))) return;
                    if (s.category !== "NE" && selectedYearRanges.size > 0 && !matchesYearRangeFilter(s.assessment_date, selectedYearRanges)) return;
                    if (s.category !== "NE" && selectedAssessmentYears.size > 0 && !matchesAssessmentYearFilter(s.assessment_date, selectedAssessmentYears)) return;
                    if (selectedObsRanges.size > 0 && !matchesObsRangeFilter(s.gbif_occurrence_count, selectedObsRanges)) return;
                    if (selectedAssessmentCounts.size > 0 && !matchesAssessmentCountFilter(s.assessment_count, selectedAssessmentCounts)) return;
                    if (selectedSystems.size > 0 && !s.systems?.some(sys => selectedSystems.has(sys))) return;
                    if (selectedPopulationTrends.size > 0 && (!s.population_trend || !selectedPopulationTrends.has(s.population_trend))) return;
                    if (selectedMovementPatterns.size > 0 && (!s.movement_pattern || !selectedMovementPatterns.has(s.movement_pattern))) return;
                    if (!matchesThreatFilter(s)) return;
                    if (selectedCriteria.size > 0 && !parseCriteriaCodes(s.criteria).some(code => Array.from(selectedCriteria).some(sel => code === sel || code.startsWith(sel)))) return;
                    if (endemicsOnly && s.countries.length !== 1) return;
                    if (!matchesAssessorsFilter(s)) return;
                    if (!matchesHabitatFilter(s)) return;
                    if (!matchesReviewersFilter(s)) return;
                    if (!matchesFacilitatorsFilter(s)) return;
                    if (!matchesContributorsFilter(s)) return;
                    if (!matchesInstitutionsFilter(s)) return;
      if (!matchesColFilter(s)) return;
                    for (const gf of s.growth_forms) {
                      gfCounts[gf] = (gfCounts[gf] || 0) + 1;
                    }
                  });
                  const sorted = Object.entries(gfCounts).sort((a, b) => b[1] - a[1]);
                  if (sorted.length === 0) return null;
                  return (
                    <div className="flex items-start gap-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2">
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0 w-20 pt-1">Growth</span>
                      <div className="flex flex-wrap gap-1.5">
                        {sorted.map(([gf, count]) => {
                          const isSelected = selectedGrowthForms.has(gf);
                          return (
                            <button
                              key={gf}
                              onClick={(e) => {
                                const isMulti = e.metaKey || e.ctrlKey;
                                setSelectedGrowthForms(prev => {
                                  if (isMulti) { const next = new Set(prev); if (next.has(gf)) next.delete(gf); else next.add(gf); return next; }
                                  if (prev.size === 1 && prev.has(gf)) return new Set();
                                  return new Set([gf]);
                                });
                              }}
                              className={`px-2 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                                isSelected
                                  ? "bg-lime-500 text-white"
                                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                              }`}
                            >
                              {gf} ({count.toLocaleString()})
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Assessment Criteria alongside Number of Assessments. */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Criteria — top-level A-E bar chart (see criteriaCard);
                      clicking a bar both selects it as a filter AND expands
                      its next level below (number -> sub-clause -> roman
                      numeral, as deep as that branch goes) as pill rows via
                      renderCriteriaLevel, since criteria nests up to 4
                      levels vs. Threats/Habitat's 2. Cmd/ctrl-click for real
                      multi-select — any number of branches can be drilled
                      into and selected simultaneously (e.g. B1b(iii) AND
                      C2a(i) together), each independently expanded via
                      expandedCriteria (a Set, not a single "last expanded"
                      value). A species can satisfy multiple codes under the
                      same letter too (e.g. B1+B2, or B1a and B1b together),
                      so selecting any code matches species with that code
                      OR a more specific one beneath it (see
                      parseCriteriaCodes' startsWith-based matching). */}
                  {!isNewAssessments && criteriaCard}

                  {/* Number of Assessments (#423 item 1) — how many times a
                      species has been assessed, with a "Reassessed" shortcut
                      selecting every bucket >= 2 in one click (1+ reassessment
                      = 2+ total assessments, per the issue's explicit ask),
                      same shape as the Outdated shortcut next to Years Since
                      Assessed. */}
                  {!isNewAssessments && (
                    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Number of Assessments</span>
                        <button
                          type="button"
                          onClick={handleReassessedClick}
                          className={`px-2 py-0.5 text-xs font-semibold rounded transition-colors ${
                            isReassessedSelected
                              ? "bg-red-600 text-white shadow-sm"
                              : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                          }`}
                          aria-pressed={isReassessedSelected}
                          title="Filter to species assessed 2 or more times (reassessed at least once)"
                        >
                          Reassessed
                        </button>
                      </div>
                      <div style={{ height: 170 }} className="flex items-center justify-center">
                        {speciesLoading && assessedSpecies.length === 0 ? (
                          <Spinner />
                        ) : isSingleSpecies && singleSpecies ? (
                          <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">
                            {assessmentCountBucket(singleSpecies.assessment_count)}
                          </span>
                        ) : assessmentCountData.length > 0 ? (
                          <FilterBarChart
                            data={assessmentCountData}
                            dataKey="shortRange"
                            selectedItems={selectedAssessmentCounts}
                            onBarClick={handleAssessmentCountClick}
                            onRangeSelect={rangeSelectAssessmentCounts}
                            barColor="#8b5cf6"
                            yAxisWidth={42}
                            rightMargin={85}
                          />
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>

                {/* Realm, Movement, and Trend as three columns in one row. */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {/* Realm */}
                  <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0 w-20">Realm</span>
                    <div className="flex flex-wrap gap-1.5">
                      {speciesLoading && assessedSpecies.length === 0 ? (
                        <Spinner className="h-4 w-4" />
                      ) : (["Terrestrial", "Freshwater", "Marine"] as const).map(system => {
                        const isSelected = selectedSystems.has(system);
                        const count = realmCounts[system] ?? 0;
                        return (
                          <button
                            key={system}
                            onClick={(e) => {
                              const isMulti = e.metaKey || e.ctrlKey;
                              setSelectedSystems(prev => {
                                if (isMulti) { const next = new Set(prev); if (next.has(system)) next.delete(system); else next.add(system); return next; }
                                if (prev.size === 1 && prev.has(system)) return new Set();
                                return new Set([system]);
                              });
                            }}
                            className={`px-2 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                              isSelected
                                ? system === "Terrestrial" ? "bg-amber-500 text-white"
                                : system === "Freshwater" ? "bg-cyan-500 text-white"
                                : "bg-blue-600 text-white"
                                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                            }`}
                          >
                            {system} ({count.toLocaleString()})
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Movement Patterns */}
                  {!isNewAssessments && (
                    <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2">
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0 w-20">Movement</span>
                        <div className="flex flex-wrap gap-1.5">
                          {speciesLoading && assessedSpecies.length === 0 ? (
                            <Spinner className="h-4 w-4" />
                          ) : (["Full Migrant", "Altitudinal Migrant", "Nomadic", "Not a Migrant", "Unknown"] as const).map(pattern => {
                            const isSelected = selectedMovementPatterns.has(pattern);
                            const count = movementPatternCounts[pattern] ?? 0;
                            if (count === 0) return null;
                            return (
                              <button
                                key={pattern}
                                onClick={(e) => {
                                  const isMulti = e.metaKey || e.ctrlKey;
                                  setSelectedMovementPatterns(prev => {
                                    if (isMulti) { const next = new Set(prev); if (next.has(pattern)) next.delete(pattern); else next.add(pattern); return next; }
                                    if (prev.size === 1 && prev.has(pattern)) return new Set();
                                    return new Set([pattern]);
                                  });
                                }}
                                className={`px-2 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                                  isSelected
                                    ? "bg-teal-500 text-white"
                                    : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                                }`}
                              >
                                {pattern} ({count.toLocaleString()})
                              </button>
                            );
                          })}
                        </div>
                    </div>
                  )}

                  {/* Trend */}
                  <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0 w-20">Trend</span>
                    <div className="flex flex-wrap gap-1.5">
                      {speciesLoading && assessedSpecies.length === 0 ? (
                        <Spinner className="h-4 w-4" />
                      ) : (["Increasing", "Stable", "Decreasing", "Unknown"] as const).map(trend => {
                        const isSelected = selectedPopulationTrends.has(trend);
                        const count = populationTrendCounts[trend] ?? 0;
                        return (
                          <button
                            key={trend}
                            onClick={(e) => {
                              const isMulti = e.metaKey || e.ctrlKey;
                              setSelectedPopulationTrends(prev => {
                                if (isMulti) { const next = new Set(prev); if (next.has(trend)) next.delete(trend); else next.add(trend); return next; }
                                if (prev.size === 1 && prev.has(trend)) return new Set();
                                return new Set([trend]);
                              });
                            }}
                            className={`px-2 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                              isSelected
                                ? "bg-orange-500 text-white"
                                : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                            }`}
                          >
                            {trend === "Increasing" ? "↑" : trend === "Decreasing" ? "↓" : trend === "Stable" ? "→" : "?"} {trend} ({count.toLocaleString()})
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Habitat alongside Threats. */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {habitatCard}
                  {threatsCard}
                </div>

                {/* Taxonomic differences from CoL — assessed-only: the flag is a
                    property of an IUCN assessment's name, so it has no meaning
                    in the Not Evaluated (new-assessments) view, whose rows are
                    CoL species with no assessment to disagree with. */}
                {!isNewAssessments && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {taxonomicRevisionCard}
                  </div>
                )}

            </>
          )}

      {/* Species Table */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
        {/* Applied filters — every currently-active filter (including the
            selected taxon/subgroup/breakdown-name) as a removable pill,
            directly above the table they filter. Clear all resets everything
            here, taxon/subgroup included — Home is for the "go back to
            nothing selected at all" case; this is for "same taxon, different
            filters". The free-text box narrows the visible table by name in
            place, composing with the pills beside it — distinct from the page
            header's SpeciesSearchBar, which navigates elsewhere instead of
            narrowing here (see DebouncedSearchInput's own doc comment). */}
        <div className="p-3 md:p-4 border-b border-zinc-200 dark:border-zinc-800 rounded-t-xl">
          <div className="flex flex-wrap items-center gap-2 md:gap-4">
            <div className="relative flex-1 min-w-[140px] max-w-md">
              <DebouncedSearchInput
                onSearch={handleSearch}
                initialValue={searchFilter}
                className="w-full px-3 md:px-4 py-2 pl-9 md:pl-10 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 text-sm"
              />
              <svg
                className="absolute left-2.5 md:left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            {(selectedTaxa.size > 0 || selectedSubgroups.size > 0 || selectedCategories.size > 0 || selectedYearRanges.size > 0 || selectedAssessmentYears.size > 0 || selectedDescribedYears.size > 0 || selectedObsRanges.size > 0 || selectedAssessmentCounts.size > 0 || selectedCountries.size > 0 || selectedSystems.size > 0 || endemicsOnly || selectedGrowthForms.size > 0 || selectedPopulationTrends.size > 0 || selectedMovementPatterns.size > 0 || selectedThreats.size > 0 || selectedCriteria.size > 0 || selectedHabitat.size > 0 || habitatBreadth || colMatch || selectedColReasons.size > 0 || habitatImportanceActive || habitatSeasonsActive || habitatSuitabilityActive || selectedAssessors.size > 0 || selectedReviewers.size > 0 || selectedFacilitators.size > 0 || selectedContributors.size > 0 || selectedInstitutions.size > 0 || showOnlyStarred || exactFilters.outdated || exactFilters.minObs != null || exactFilters.maxObs != null || exactFilters.minAssessmentYear != null || exactFilters.maxAssessmentYear != null || exactFilters.minDescribedYear != null || exactFilters.maxDescribedYear != null) && (
              <button
                onClick={() => {
                  clearAllFiltersAndTaxa();
                  setShowOnlyStarred(false);
                  setExpandedThreat(new Set());
                  setExpandedCriteria(new Set());
                  setExpandedHabitat(new Set());
                }}
                title="Reset all filters and the selected taxon"
                className="px-2 md:px-3 py-1.5 rounded-lg text-xs md:text-sm font-medium transition-colors flex items-center gap-1 md:gap-1.5 bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700 shrink-0"
              >
                <svg className="w-3.5 h-3.5 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="hidden sm:inline">Clear all</span>
              </button>
            )}
            {pinnedSpecies.length > 0 && (
              <button
                onClick={() => setShowOnlyStarred(!showOnlyStarred)}
                className={`px-2 md:px-3 py-1.5 rounded-lg text-xs md:text-sm font-medium transition-colors flex items-center gap-1 md:gap-1.5 ${
                  showOnlyStarred
                    ? "bg-amber-500 text-white"
                    : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700"
                }`}
              >
                <svg className="w-4 h-4" fill={showOnlyStarred ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                </svg>
                <span className="hidden sm:inline">Starred</span> ({pinnedSpecies.length})
              </button>
            )}
            {Array.from(selectedTaxa).map(taxonId => (
              <button
                key={taxonId}
                onClick={() => setSelectedTaxa(prev => { const next = new Set(prev); next.delete(taxonId); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full flex items-center gap-1 hover:opacity-80"
                style={{ backgroundColor: (TAXA_BY_ID[taxonId]?.color || "#666") + "20", color: TAXA_BY_ID[taxonId]?.color || "#666" }}
              >
                {TAXA_BY_ID[taxonId]?.name || taxonId}
                <span className="text-sm">×</span>
              </button>
            ))}
            {Array.from(selectedSubgroups).map(sgId => {
              const sgInfo = getNodeDef(sgId);
              return (
                <button
                  key={sgId}
                  onClick={() => setSelectedSubgroups(prev => { const next = new Set(prev); next.delete(sgId); return next; })}
                  className="px-3 py-1.5 text-sm font-medium rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400 flex items-center gap-1 hover:opacity-80"
                >
                  {sgInfo?.node.name ?? dynamicNodeDisplayName(sgId)}
                  <span className="text-sm">×</span>
                </button>
              );
            })}
            {breakdownFilter && selectedSubgroups.has(breakdownFilter.nodeId) && (
              <button
                onClick={() => setBreakdownFilter(null)}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400 flex items-center gap-1 hover:opacity-80"
              >
                {breakdownDisplayName(breakdownFilter.rank, breakdownFilter.name)}
                {breakdownFilter.onlyIds?.length ? " — No CoL Match" : breakdownFilter.excludeIds?.length ? " — CoL Match" : ""}
                <span className="text-sm">×</span>
              </button>
            )}
            {!isNewAssessments && Array.from(selectedCategories).map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategories(prev => { const next = new Set(prev); next.delete(cat); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full flex items-center gap-1 hover:opacity-80"
                style={{ backgroundColor: CATEGORY_COLORS[cat] + "20", color: CATEGORY_COLORS[cat] }}
              >
                {cat}
                <span className="text-sm">×</span>
              </button>
            ))}
            {!isNewAssessments && Array.from(selectedYearRanges).map(range => (
              <button
                key={range}
                onClick={() => setSelectedYearRanges(prev => { const next = new Set(prev); next.delete(range); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 flex items-center gap-1 hover:opacity-80"
              >
                {range}
                <span className="text-sm">×</span>
              </button>
            ))}
            {!isNewAssessments && Array.from(selectedAssessmentYears).sort((a, b) => Number(b) - Number(a)).map(year => (
              <button
                key={`ay-${year}`}
                onClick={() => setSelectedAssessmentYears(prev => { const next = new Set(prev); next.delete(year); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 flex items-center gap-1 hover:opacity-80"
              >
                Assessed {year}
                <span className="text-sm">×</span>
              </button>
            ))}
            {isNewAssessments && Array.from(selectedDescribedYears).map(range => (
              <button
                key={`dy-${range}`}
                onClick={() => setSelectedDescribedYears(prev => { const next = new Set(prev); next.delete(range); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400 flex items-center gap-1 hover:opacity-80"
              >
                Described {range}
                <span className="text-sm">×</span>
              </button>
            ))}
            {Array.from(selectedObsRanges).map(range => (
              <button
                key={range}
                onClick={() => setSelectedObsRanges(prev => { const next = new Set(prev); next.delete(range); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400 flex items-center gap-1 hover:opacity-80"
              >
                {range} obs
                <span className="text-sm">×</span>
              </button>
            ))}
            {Array.from(selectedAssessmentCounts).map(count => (
              <button
                key={`assessment-count-${count}`}
                onClick={() => setSelectedAssessmentCounts(prev => { const next = new Set(prev); next.delete(count); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400 flex items-center gap-1 hover:opacity-80"
              >
                {count} {count === "1" ? "assessment" : "assessments"}
                <span className="text-sm">×</span>
              </button>
            ))}
            {(() => {
              if (selectedCountries.size === 0) return null;
              // A selection that exactly covers whole IUCN regions reads as those
              // regions rather than as their countries — two ticked regions is two
              // pills, not the nineteen country pills it expands to underneath.
              const regions = matchingRegions(selectedCountries);
              if (regions.length > 0) {
                return regions.map(region => (
                  <button
                    key={`region-${region}`}
                    onClick={() => setSelectedCountries(prev => {
                      const next = new Set(prev);
                      iucnRegionCountries(region).forEach(c => next.delete(c));
                      return next;
                    })}
                    className="px-3 py-1.5 text-sm font-medium rounded-full bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400 flex items-center gap-1 hover:opacity-80"
                  >
                    {region}
                    <span className="text-sm">×</span>
                  </button>
                ));
              }
              // Otherwise show individual country pills
              return Array.from(selectedCountries).map(code => (
                <button
                  key={code}
                  onClick={() => setSelectedCountries(prev => { const next = new Set(prev); next.delete(code); return next; })}
                  className="px-3 py-1.5 text-sm font-medium rounded-full bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400 flex items-center gap-1 hover:opacity-80"
                >
                  {getCountryName(code)}
                  <span className="text-sm">×</span>
                </button>
              ));
            })()}
            {Array.from(selectedGrowthForms).map(gf => (
              <button
                key={`gf-${gf}`}
                onClick={() => setSelectedGrowthForms(prev => { const next = new Set(prev); next.delete(gf); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-lime-100 text-lime-600 dark:bg-lime-900/30 dark:text-lime-400 flex items-center gap-1 hover:opacity-80"
              >
                {gf}
                <span className="text-sm">×</span>
              </button>
            ))}
            {endemicsOnly && (
              <button
                onClick={() => setEndemicsOnly(false)}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 flex items-center gap-1 hover:opacity-80"
              >
                Endemics only
                <span className="text-sm">×</span>
              </button>
            )}
            {Array.from(selectedPopulationTrends).map(trend => (
              <button
                key={`trend-${trend}`}
                onClick={() => setSelectedPopulationTrends(prev => { const next = new Set(prev); next.delete(trend); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400 flex items-center gap-1 hover:opacity-80"
              >
                {trend}
                <span className="text-sm">×</span>
              </button>
            ))}
            {Array.from(selectedMovementPatterns).map(pattern => (
              <button
                key={`mov-${pattern}`}
                onClick={() => setSelectedMovementPatterns(prev => { const next = new Set(prev); next.delete(pattern); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 flex items-center gap-1 hover:opacity-80"
              >
                {pattern}
                <span className="text-sm">×</span>
              </button>
            ))}
            {Array.from(selectedThreats).map(code => {
              const cat = THREAT_CATEGORIES.find(c => c.code === code);
              const sub = !cat ? THREAT_CATEGORIES.flatMap(c => c.children).find(c => c.code === code) : null;
              const label = cat?.label || sub?.label || code;
              return (
                <button
                  key={`threat-${code}`}
                  onClick={() => setSelectedThreats(prev => { const next = new Set(prev); next.delete(code); return next; })}
                  className="px-3 py-1.5 text-sm font-medium rounded-full bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400 flex items-center gap-1 hover:opacity-80"
                >
                  {label}
                  <span className="text-sm">×</span>
                </button>
              );
            })}
            {/* The threats scope only narrows anything once a threat is picked
                (see matchesThreatFilter), so it earns a chip exactly then —
                a permanent chip for a default that isn't filtering would be
                noise, and no chip at all would hide the fact that the species
                list has quietly dropped every non-threatened match. × widens to
                all species rather than clearing the threat itself. */}
            {selectedThreats.size > 0 && threatsScope === "threatened" && (
              <button
                onClick={() => setThreatsScope("all")}
                title="Threat data is only counted for Critically Endangered, Endangered and Vulnerable species"
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400 flex items-center gap-1 hover:opacity-80"
              >
                Threatened only
                <span className="text-sm">×</span>
              </button>
            )}
            {Array.from(selectedCriteria).map(code => {
              const label = findCriteriaNode(CRITERIA_CATEGORIES, code)?.label || code;
              return (
                <button
                  key={`criteria-${code}`}
                  onClick={() => setSelectedCriteria(prev => { const next = new Set(prev); next.delete(code); return next; })}
                  className="px-3 py-1.5 text-sm font-medium rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400 flex items-center gap-1 hover:opacity-80"
                >
                  {label}
                  <span className="text-sm">×</span>
                </button>
              );
            })}
            {Array.from(selectedHabitat).map(code => {
              const cat = HABITAT_CATEGORIES.find(c => c.code === code);
              const sub = !cat ? HABITAT_CATEGORIES.flatMap(c => c.children).find(c => c.code === code) : null;
              const label = cat?.label || sub?.label || code;
              return (
                <button
                  key={`habitat-${code}`}
                  onClick={() => setSelectedHabitat(prev => { const next = new Set(prev); next.delete(code); return next; })}
                  className="px-3 py-1.5 text-sm font-medium rounded-full bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 flex items-center gap-1 hover:opacity-80"
                >
                  {label}
                  <span className="text-sm">×</span>
                </button>
              );
            })}
            {/* Taxonomic-revision chips. colReasons implies flagged, so when
                reasons are picked they ARE the chips — a redundant "Flagged"
                chip beside them would need its own × that means something
                different (clear the toggle, keep the reasons?), which is a
                distinction without a use. */}
            {selectedColReasons.size === 0 && colMatch && (
              <button
                onClick={() => setColMatch(null)}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-500 flex items-center gap-1 hover:opacity-80"
              >
                {colMatch === "flagged" ? "⚑ Differs from Catalogue of Life" : "Clean CoL match"}
                <span className="text-sm">×</span>
              </button>
            )}
            {/* One chip per BAR, not per reason: "No 1:1 CoL match" covers six
                reasons, and six chips for one click would read as six filters. */}
            {REVISION_BARS.filter(bar => bar.reasons.some(r => selectedColReasons.has(r))).map(bar => (
              <button
                key={`col-bar-${bar.key}`}
                onClick={() => setColReasons(prev => {
                  const next = new Set(prev);
                  bar.reasons.forEach(r => next.delete(r));
                  return next;
                })}
                title={bar.reasons.map(r => REVISION_REASON_SUMMARY[r]).filter(Boolean).join("; ")}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-500 flex items-center gap-1 hover:opacity-80"
              >
                ⚑ {bar.label}
                <span className="text-sm">×</span>
              </button>
            ))}
            {habitatBreadth && (
              <button
                onClick={() => setHabitatBreadth(null)}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 flex items-center gap-1 hover:opacity-80"
              >
                Habitat {habitatBreadth === "specialist" ? "specialists" : "generalists"}
                <span className="text-sm">×</span>
              </button>
            )}
            {/* Importance/Season both default to "everything checked". The chip
                shows what's actually SELECTED (positive framing) rather than what's
                excluded — narrowing down to one or two values (e.g. "Major",
                "Resident") is the more common case, and reads far more clearly than
                spelling out every other unchecked value ("No Minor", "No Unknown",
                "No Breeding", ...). Clicking × removes it from the selection. */}
            {habitatImportanceActive && HABITAT_IMPORTANCE_OPTIONS.filter(({ value }) => selectedHabitatImportance.has(value)).map(({ value, short }) => (
              <button
                key={`habitat-importance-${value}`}
                onClick={() => setSelectedHabitatImportance(prev => { const next = new Set(prev); next.delete(value); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 flex items-center gap-1 hover:opacity-80"
              >
                {short} habitat
                <span className="text-sm">×</span>
              </button>
            ))}
            {habitatSeasonsActive && HABITAT_SEASON_OPTIONS.filter(({ value }) => selectedHabitatSeasons.has(value)).map(({ value, short }) => (
              <button
                key={`habitat-season-${value}`}
                onClick={() => setSelectedHabitatSeasons(prev => { const next = new Set(prev); next.delete(value); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 flex items-center gap-1 hover:opacity-80"
              >
                {short}
                <span className="text-sm">×</span>
              </button>
            ))}
            {habitatSuitabilityActive && HABITAT_SUITABILITY_OPTIONS.filter(({ value }) => selectedHabitatSuitability.has(value)).map(({ value, short }) => (
              <button
                key={`habitat-suitability-${value}`}
                onClick={() => setSelectedHabitatSuitability(prev => { const next = new Set(prev); next.delete(value); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 flex items-center gap-1 hover:opacity-80"
              >
                {short} suitability
                <span className="text-sm">×</span>
              </button>
            ))}
            {Array.from(selectedSystems).map(system => (
              <button
                key={system}
                onClick={() => setSelectedSystems(prev => { const next = new Set(prev); next.delete(system); return next; })}
                className={`px-3 py-1.5 text-sm font-medium rounded-full flex items-center gap-1 hover:opacity-80 ${
                  system === "Terrestrial" ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                  : system === "Freshwater" ? "bg-cyan-100 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400"
                  : "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                }`}
              >
                {system}
                <span className="text-sm">×</span>
              </button>
            ))}
            {!isNewAssessments && Array.from(selectedAssessors).map(name => (
              <button
                key={`a-${name}`}
                onClick={() => setSelectedAssessors(prev => { const next = new Set(prev); next.delete(name); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400 flex items-center gap-1 hover:opacity-80"
              >
                {name} <span className="text-[10px] opacity-60">(assessor)</span>
                <span className="text-sm">×</span>
              </button>
            ))}
            {!isNewAssessments && Array.from(selectedReviewers).map(name => (
              <button
                key={`r-${name}`}
                onClick={() => setSelectedReviewers(prev => { const next = new Set(prev); next.delete(name); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-900/30 dark:text-fuchsia-400 flex items-center gap-1 hover:opacity-80"
              >
                {name} <span className="text-[10px] opacity-60">(reviewer)</span>
                <span className="text-sm">×</span>
              </button>
            ))}
            {!isNewAssessments && Array.from(selectedFacilitators).map(name => (
              <button
                key={`f-${name}`}
                onClick={() => setSelectedFacilitators(prev => { const next = new Set(prev); next.delete(name); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 flex items-center gap-1 hover:opacity-80"
              >
                {name} <span className="text-[10px] opacity-60">(facilitator)</span>
                <span className="text-sm">×</span>
              </button>
            ))}
            {!isNewAssessments && Array.from(selectedContributors).map(name => (
              <button
                key={`c-${name}`}
                onClick={() => setSelectedContributors(prev => { const next = new Set(prev); next.delete(name); return next; })}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex items-center gap-1 hover:opacity-80"
              >
                {name} <span className="text-[10px] opacity-60">(contributor)</span>
                <span className="text-sm">×</span>
              </button>
            ))}
            {/* Institution names run far longer than the person-name pills above
                ("Centro Nacional de Conservação da Flora (CNCFlora)"), so this one
                truncates rather than pushing the whole row off screen; the full
                name stays available on hover. */}
            {!isNewAssessments && Array.from(selectedInstitutions).map(name => (
              <button
                key={`i-${name}`}
                onClick={() => setSelectedInstitutions(prev => { const next = new Set(prev); next.delete(name); return next; })}
                title={name}
                className="px-3 py-1.5 text-sm font-medium rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400 flex items-center gap-1 hover:opacity-80 max-w-[22rem]"
              >
                <span className="truncate">{name}</span>
                <span className="text-[10px] opacity-60 shrink-0">(institution)</span>
                <span className="text-sm shrink-0">×</span>
              </button>
            ))}
            {/* Exact URL-only filters (typically arrive via an agent/MCP dashboard
                link). Shown as chips so a human can see and clear them. */}
            {(() => {
              const ef = exactFilters;
              const chips: { key: keyof typeof ef; label: string }[] = [];
              if (ef.outdated) chips.push({ key: "outdated", label: ef.outdated === "yes" ? "Needs updating (>10 yrs)" : "Current (≤10 yrs)" });
              if (ef.minObs != null) chips.push({ key: "minObs", label: `≥ ${ef.minObs.toLocaleString()} obs` });
              if (ef.maxObs != null) chips.push({ key: "maxObs", label: `≤ ${ef.maxObs.toLocaleString()} obs` });
              if (ef.minAssessmentYear != null) chips.push({ key: "minAssessmentYear", label: `Assessed ≥ ${ef.minAssessmentYear}` });
              if (ef.maxAssessmentYear != null) chips.push({ key: "maxAssessmentYear", label: `Assessed ≤ ${ef.maxAssessmentYear}` });
              if (ef.minDescribedYear != null) chips.push({ key: "minDescribedYear", label: `Described ≥ ${ef.minDescribedYear}` });
              if (ef.maxDescribedYear != null) chips.push({ key: "maxDescribedYear", label: `Described ≤ ${ef.maxDescribedYear}` });
              return chips.map(c => (
                <button
                  key={`ef-${c.key}`}
                  onClick={() => setExactFilters({ [c.key]: null })}
                  className="px-3 py-1.5 text-sm font-medium rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300 flex items-center gap-1 hover:opacity-80"
                >
                  {c.label}
                  <span className="text-sm">×</span>
                </button>
              ));
            })()}
            <span className="ml-auto text-sm md:text-base font-semibold text-zinc-700 dark:text-zinc-300 tabular-nums flex items-center gap-2">
              {speciesLoading && totalFiltered === 0 && !singleSpeciesPreview ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <>{totalFiltered.toLocaleString()} species</>
              )}
            </span>
            {/* Assessed/Not Evaluated — a full view-mode switch (a different
                dataset entirely), moved here from the old dedicated stat-card
                row now that there isn't one. */}
            {onViewModeChange && (
              <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-xs shrink-0">
                <button
                  type="button"
                  onClick={() => onViewModeChange("reassessments")}
                  className={`px-2 py-1 font-medium transition-colors ${
                    !isNewAssessments
                      ? "bg-zinc-800 dark:bg-zinc-100 text-white dark:text-zinc-900"
                      : "bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  }`}
                >
                  Assessed
                </button>
                <button
                  type="button"
                  onClick={() => onViewModeChange("new-assessments")}
                  className={`px-2 py-1 font-medium transition-colors ${
                    isNewAssessments
                      ? "bg-zinc-800 dark:bg-zinc-100 text-white dark:text-zinc-900"
                      : "bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  }`}
                >
                  Not Evaluated
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Species table */}
        {speciesLoading && assessedSpecies.length === 0 && !singleSpeciesPreview ? (
          <div className="flex items-center justify-center py-12">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
        <>
        <div className="relative">
          {speciesLoading && !singleSpeciesPreview && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <Spinner className="h-6 w-6" />
            </div>
          )}
        {neTruncation && (
          <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-900/20 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-200">
            This group is very large — showing the first <strong>{neTruncation.shown.toLocaleString()}</strong>
            {neTruncation.neTotal > neTruncation.shown ? <> of {neTruncation.neTotal.toLocaleString()}</> : null} not-evaluated species. Open a sub-group (e.g. a class or order) to browse the rest.
          </div>
        )}
        <div
          ref={tableScrollRef}
          className={`bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-x-auto transition-opacity duration-150 ${speciesLoading && !singleSpeciesPreview ? "opacity-50 pointer-events-none" : ""}`}
          onScroll={(e) => {
            e.currentTarget.style.setProperty('--scroll-left', `${e.currentTarget.scrollLeft}px`);
          }}
        >
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800">
              <tr className="border-b border-zinc-200 dark:border-zinc-700">
                <th className="sticky left-0 z-10 bg-zinc-50 dark:bg-zinc-800 px-2 py-3 text-center text-sm font-bold text-zinc-600 dark:text-zinc-300 w-10">
                  <svg className="w-4 h-4 mx-auto text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                  </svg>
                </th>
                <th className="sticky left-[40px] z-10 bg-zinc-50 dark:bg-zinc-800 px-2 md:px-4 py-3 text-left text-sm font-bold text-zinc-600 dark:text-zinc-300">
                  Species
                </th>
                {!isNewAssessments && (
                <th
                  className={`${SPECIES_TH} text-left ${SPECIES_TH_NOWRAP} ${SPECIES_TH_SORTABLE}`}
                  onClick={(e) => handleSort("category", e)}
                >
                  <span className="flex items-center gap-1">
                    Category
                    <SortIndicator field="category" />
                  </span>
                </th>
                )}
                {!isNewAssessments && (
                <th
                  className={`${SPECIES_TH} text-left ${SPECIES_TH_SORTABLE}`}
                  onClick={(e) => handleSort("year", e)}
                >
                  <span className="flex items-center gap-1">
                    <span className={`${SPECIES_TH_LABEL} w-[84px]`}>Assessment Date</span>
                    <SortIndicator field="year" />
                  </span>
                </th>
                )}
                {isNewAssessments && (
                <th
                  className={`${SPECIES_TH} text-left ${SPECIES_TH_SORTABLE}`}
                  onClick={(e) => handleSort("describedYear", e)}
                >
                  <span className="flex items-center gap-1">
                    <span className={`${SPECIES_TH_LABEL} w-[104px]`}>Year Described</span>
                    <SortIndicator field="describedYear" />
                  </span>
                </th>
                )}
                <th
                  className={`${SPECIES_TH} text-right min-w-[60px] ${SPECIES_TH_SORTABLE}`}
                  onClick={(e) => handleSort("totalGbif", e)}
                >
                  <span className="flex items-center justify-end gap-1">
                    <span className={`${SPECIES_TH_LABEL} ${isNewAssessments ? "w-[96px]" : "w-[72px]"}`}>{isNewAssessments ? "GBIF Records" : "Total GBIF Records"}</span>
                    <GbifInfoTooltip />
                    <SortIndicator field="totalGbif" />
                  </span>
                </th>
                {!isNewAssessments && (
                <th
                  className={`${SPECIES_TH} text-right min-w-[60px] ${SPECIES_TH_SORTABLE}`}
                  onClick={(e) => handleSort("newGbif", e)}
                >
                  <span className="flex items-center justify-end gap-1">
                    <span className={`${SPECIES_TH_LABEL} w-[124px]`}>GBIF Records Since Assessment</span>
                    <HoverTooltip text="Records added after the assessment year (not the exact date). Uses the year following the assessment as the start of the range.">
                      <svg className="w-3 h-3 text-zinc-400 dark:text-zinc-500 cursor-help" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 16v-4M12 8h.01" />
                      </svg>
                    </HoverTooltip>
                    <SortIndicator field="newGbif" />
                  </span>
                </th>
                )}
                {!isNewAssessments && (
                <th
                  className={`${SPECIES_TH} text-right min-w-[60px] ${SPECIES_TH_SORTABLE}`}
                  onClick={(e) => handleSort("pctNewGbif", e)}
                >
                  <span className="flex items-center justify-end gap-1">
                    <span className={`${SPECIES_TH_LABEL} w-[124px]`}>% GBIF Records Since Assessment</span>
                    <SortIndicator field="pctNewGbif" />
                  </span>
                </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {paginatedSpecies.map((s) => {
                const speciesKey = s.species_key;
                const assessmentDateObj = s.assessment_date ? new Date(s.assessment_date) : null;
                const assessmentYear = assessmentDateObj ? assessmentDateObj.getFullYear() : null;
                const yearsSinceAssessment = assessmentDateObj
                  ? Math.floor((Date.now() - assessmentDateObj.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
                  : null;
                const details = speciesDetails[s.species_key];
                const gbifSpeciesKey = s.gbif_species_key || details?.gbifUrl?.split('/').pop() || null;
                // Suggested Assessors/Reviewers rank people over THIS species' own
                // lineage (its taxon group down to its genus), not over whatever taxon
                // is selected — so the ranking is the same wherever you reached the
                // species from. See getCreditCandidates.
                const candidateSpecies = {
                  taxonGroup: s.taxon_group,
                  scientificName: s.scientific_name,
                  className: s.class_name,
                  orderName: s.order_name,
                  family: s.family,
                  countries: s.countries,
                };
                const isPinned = pinnedSet.has(speciesKey);
                const isDragging = draggedSpecies === speciesKey;
                const isDragOver = dragOverSpecies === speciesKey && draggedSpecies !== speciesKey;
                return (
                  <React.Fragment key={speciesKey}>
                  <tr
                    className={`hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer ${selectedSpeciesKey === speciesKey ? "bg-zinc-100 dark:bg-zinc-800" : ""} ${isDragging ? "opacity-50" : ""} ${isDragOver ? "border-t-2 border-amber-500" : ""}`}
                    onClick={() => { setSelectedSpeciesKey(selectedSpeciesKey === speciesKey ? null : speciesKey); }}
                    draggable={isPinned && showOnlyStarred}
                    onDragStart={(e) => handleDragStart(e, speciesKey)}
                    onDragOver={(e) => handleDragOver(e, speciesKey)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, speciesKey)}
                    onDragEnd={handleDragEnd}
                  >
                    <td className={`sticky left-0 z-10 px-2 py-2 text-center ${selectedSpeciesKey === speciesKey ? "bg-zinc-100 dark:bg-zinc-800" : "bg-white dark:bg-zinc-900"}`}>
                      <div className="flex items-center justify-center gap-1">
                        {isPinned && showOnlyStarred && (
                          <span className="cursor-grab text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300" title="Drag to reorder">
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8-12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" />
                            </svg>
                          </span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePinned(speciesKey);
                          }}
                          className={`p-1 rounded transition-colors ${isPinned ? "text-amber-500 hover:text-amber-600" : "text-zinc-300 hover:text-amber-400 dark:text-zinc-600 dark:hover:text-amber-400"}`}
                          title={isPinned ? "Unpin species" : "Pin species"}
                        >
                          <svg className="w-4 h-4" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                          </svg>
                        </button>
                      </div>
                    </td>
                    <td className={`sticky left-[40px] z-10 px-2 md:px-4 py-2 ${selectedSpeciesKey === speciesKey ? "bg-zinc-100 dark:bg-zinc-800" : "bg-white dark:bg-zinc-900"}`}>
                      <div className="flex items-center gap-2">
                        {/* iNat profile pic */}
                        {details?.inatDefaultImage === undefined ? (
                          <div className="w-8 h-8 md:w-10 md:h-10 bg-zinc-100 dark:bg-zinc-800 rounded flex-shrink-0 flex items-center justify-center">
                            <span className="inline-block animate-spin h-4 w-4 border-2 border-zinc-400 border-t-transparent rounded-full" />
                          </div>
                        ) : details?.inatDefaultImage?.squareUrl ? (
                          <img
                            src={details.inatDefaultImage.squareUrl}
                            alt=""
                            className="w-8 h-8 md:w-10 md:h-10 object-cover rounded flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-red-400"
                            onMouseEnter={(e) => {
                              const img = e.currentTarget;
                              const rect = img.getBoundingClientRect();
                              const preview = document.getElementById('image-preview');
                              if (preview) {
                                (preview as HTMLImageElement).src = details.inatDefaultImage?.mediumUrl || details.inatDefaultImage?.squareUrl || '';
                                preview.style.display = 'block';
                                const showBelow = rect.bottom + 192 + 8 < window.innerHeight;
                                preview.style.top = showBelow ? `${rect.bottom + 8}px` : `${rect.top - 192 - 8}px`;
                                preview.style.left = `${rect.left}px`;
                              }
                            }}
                            onMouseLeave={() => {
                              const preview = document.getElementById('image-preview');
                              if (preview) {
                                preview.style.display = 'none';
                              }
                            }}
                          />
                        ) : (
                          <div className="w-8 h-8 md:w-10 md:h-10 bg-zinc-100 dark:bg-zinc-800 rounded flex items-center justify-center text-zinc-400 flex-shrink-0">
                            <TaxaIcon taxonId={s.taxon_id || "all"} size={18} />
                          </div>
                        )}
                        <div className="min-w-0">
                          <span
                            className="italic font-medium text-zinc-900 dark:text-zinc-100 text-xs md:text-sm"
                          >
                            {s.scientific_name}
                          </span>
                          {/* Possible-taxonomic-revision flag — see the
                              "Taxonomic differences from Catalogue of Life"
                              filter card. It opens the
                              CoL record the flag is about: the tooltip says what
                              CoL did, and the obvious next question is "show
                              me", which the filter chart already answers for the
                              "give me all of these" case. A species can carry
                              both signals, hence a list of sentences.

                              Shown only while that card is actually filtering
                              (colFilterActive). The flag answers a question the
                              reader has to have asked — "which of these differ
                              from CoL, and how?" — and on the unfiltered table
                              it was answering it unprompted, putting a caveat
                              about a second checklist beside names in a list
                              that is otherwise about assessments. Once a
                              flagged/clean or reason filter is on, the marker
                              earns its place: it says which signal each row
                              matched on, which is exactly what was asked. */}
                          {colFilterActive && isFlagged(s.col_revision) && (
                            <SelectableHoverTooltip
                              content={<RevisionTooltipContent flag={s.col_revision!} name={s.scientific_name} category={s.category} />}
                              prepare={s.col_revision!.colId ? () => prefetchColProvenance(s.col_revision!.colId!) : undefined}
                            >
                              <a
                                href={colTaxonUrl(s.col_revision!, s.scientific_name)}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`Differs from Catalogue of Life — ${revisionReasons(s.col_revision!).map(r => REVISION_REASON_SUMMARY[r] ?? r).join("; ")}. Open in Catalogue of Life`}
                                className="ml-1 align-middle text-amber-600 dark:text-amber-500 hover:text-amber-700 dark:hover:text-amber-400 text-xs"
                              >
                                ⚑
                              </a>
                            </SelectableHoverTooltip>
                          )}
                          {s.common_name && (
                            <div className="text-zinc-500 dark:text-zinc-400 text-xs truncate max-w-[140px] md:max-w-none">
                              {s.common_name}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    {!isNewAssessments && (
                    <td className="px-2 md:px-4 py-3 whitespace-nowrap">
                      {(() => {
                        const criteria = s.criteria ?? details?.criteria;
                        return criteria && !["DD", "LC", "NT", "EX", "EW", "NE"].includes(s.category) ? (
                        <HoverTooltip text={`${criteria}${explainCriteria(criteria)}`}>
                          <span
                            className="px-2 py-0.5 text-xs font-medium rounded cursor-help"
                            style={{
                              backgroundColor: CATEGORY_COLORS[s.category] + "20",
                              color: CATEGORY_COLORS[s.category],
                            }}
                          >
                            {s.category}
                          </span>
                        </HoverTooltip>
                      ) : (
                        <span
                          className="px-2 py-0.5 text-xs font-medium rounded"
                          style={{
                            backgroundColor: CATEGORY_COLORS[s.category] + "20",
                            color: s.category === "EX" || s.category === "EW" ? "#fff" : CATEGORY_COLORS[s.category],
                            ...(s.category === "EX" || s.category === "EW" ? { backgroundColor: CATEGORY_COLORS[s.category] } : {})
                          }}
                        >
                          {s.category}
                        </span>
                        );
                      })()}
                    </td>
                    )}
                    {!isNewAssessments && (
                    <td className="px-2 md:px-4 py-3 text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                      {isNE(s) ? <span className="text-zinc-400">N/A</span> : (
                        <>
                          <HoverTooltip
                            text={`Published: ${s.year_published || "N/A"}`}
                          >
                            <span
                              className="cursor-help"
                            >
                              {s.assessment_date
                                ? new Date(s.assessment_date).toLocaleDateString("en-GB", {
                                    day: "numeric",
                                    month: "short",
                                    year: "numeric",
                                  })
                                : "—"}
                            </span>
                          </HoverTooltip>
                          {yearsSinceAssessment !== null && isOutdated(s.assessment_date, dataAsOf) && (
                            <span className="ml-1 text-xs text-amber-600">({yearsSinceAssessment}y ago)</span>
                          )}
                        </>
                      )}
                    </td>
                    )}
                    {/* Year Described (CoL) */}
                    {isNewAssessments && (
                    <td className="px-2 md:px-4 py-3 text-zinc-600 dark:text-zinc-400 text-sm tabular-nums whitespace-nowrap">
                      {/* The searched-species preview row is built from the search result,
                          which carries no CoL description year — so it has none to show
                          until the taxon's own list lands. A "—" there says CoL has no
                          datable record for the name (the real meaning of the dash in this
                          column) when the year is merely late, so spin instead while the
                          list is still in flight. Once it isn't, the dash is honest again:
                          a preview still standing in after the fetch settles is a species
                          the list genuinely doesn't carry. */}
                      {s.described_year ?? (
                        s === singleSpeciesPreview && speciesLoading
                          ? <Spinner />
                          : <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    )}
                    {/* Total GBIF */}
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400 text-sm tabular-nums whitespace-nowrap">
                      {details?.gbifOccurrences != null && details?.gbifUrl ? (
                        <a
                          href={`https://www.gbif.org/occurrence/search?taxonKey=${details.gbifUrl.split('/').pop()}&${gbifFiltersFor(s.taxon_group)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline decoration-dotted hover:decoration-solid"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {details.gbifOccurrences.toLocaleString()}
                        </a>
                      ) : s.gbif_occurrence_count != null && s.gbif_species_key ? (
                        <a
                          href={`https://www.gbif.org/occurrence/search?taxonKey=${s.gbif_species_key}&${gbifFiltersFor(s.taxon_group)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline decoration-dotted hover:decoration-solid"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {s.gbif_occurrence_count.toLocaleString()}
                        </a>
                      ) : details?.gbifMatchStatus?.matchType === 'HIGHERRANK' || details?.gbifMatchStatus?.matchType === 'NONE' ? (
                        <HoverTooltip
                          text={details.gbifMatchStatus.matchType === 'HIGHERRANK'
                            ? `Name not found in GBIF (matched to ${details.gbifMatchStatus.matchedRank?.toLowerCase() || 'higher rank'} instead). May be due to a taxonomic split, synonym, or naming difference.`
                            : "Species not found in GBIF. May be due to a taxonomic split, synonym, or naming difference."}
                        >
                          <span className="text-zinc-400 cursor-help">?</span>
                        </HoverTooltip>
                      ) : "—"}
                    </td>
                    {/* New GBIF */}
                    {!isNewAssessments && (
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400 text-sm tabular-nums whitespace-nowrap">
                      {isNE(s) ? (
                        <span className="text-zinc-400">N/A</span>
                      ) : (() => {
                        const newObs = details?.gbifOccurrencesSinceAssessment ?? s.gbif_observations_after_assessment_year;
                        if (newObs == null) return "—";
                        const key = details?.gbifUrl?.split('/').pop() ?? s.gbif_species_key;
                        // A species assessed this year has no "since" range to
                        // link to — year=<next year>,<this year> is a reversed,
                        // meaningless range — so show the number unlinked.
                        if (key && assessmentYear && assessmentYear < currentYear) {
                          return (
                            <a
                              href={`https://www.gbif.org/occurrence/search?taxonKey=${key}&year=${assessmentYear + 1},${currentYear}&${gbifFiltersFor(s.taxon_group)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline decoration-dotted hover:decoration-solid"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {newObs.toLocaleString()}
                            </a>
                          );
                        }
                        return newObs.toLocaleString();
                      })()}
                    </td>
                    )}
                    {/* % New GBIF */}
                    {!isNewAssessments && (
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400 text-sm tabular-nums whitespace-nowrap">
                      {isNE(s) ? <span className="text-zinc-400">N/A</span> : (() => {
                        const total = details?.gbifOccurrences ?? s.gbif_occurrence_count;
                        const newObs = details?.gbifOccurrencesSinceAssessment ?? s.gbif_observations_after_assessment_year;
                        if (total == null || total === 0 || newObs == null) return "—";
                        const pct = (newObs / total) * 100;
                        return `${pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%`;
                      })()}
                    </td>
                    )}
                  </tr>
                  {selectedSpeciesKey === speciesKey && (
                    <tr>
                      <td colSpan={isNewAssessments ? 4 : 8} className="p-0 bg-zinc-50 dark:bg-zinc-800/30" style={{ width: 0 }}>
                        <div style={{ width: 'var(--view-width, 100%)', maxWidth: '100%', transform: 'translateX(var(--scroll-left, 0px))' }}>
                          {/* Tab bar */}
                          <div className="flex flex-wrap items-center border-b border-zinc-200 dark:border-zinc-700" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className={`shrink-0 px-2 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${activeDetailTab === "gbif" ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                                  onClick={() => setActiveDetailTab("gbif")}
                                >
                                  {gbifSpeciesKey ? "GBIF" : "iNaturalist"}
                                </button>
                                {(assessmentYear || s.category === "NE") && (
                                  <button
                                    className={`shrink-0 px-2 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${activeDetailTab === "literature" ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                                    onClick={() => setActiveDetailTab("literature")}
                                  >
                                    Literature
                                  </button>
                                )}
                                {s.category !== "NE" && (
                                  <button
                                    className={`shrink-0 px-2 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${activeDetailTab === "redlist" ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                                    onClick={() => setActiveDetailTab("redlist")}
                                  >
                                    IUCN Red List Assessments
                                  </button>
                                )}
                                <button
                                  className={`shrink-0 px-2 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${activeDetailTab === "cites" ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                                  onClick={() => setActiveDetailTab("cites")}
                                >
                                  CITES
                                </button>
                                <button
                                  className={`shrink-0 px-2 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${activeDetailTab === "col" ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                                  onClick={() => setActiveDetailTab("col")}
                                >
                                  Catalogue of Life
                                </button>
                                {SHOW_EOL_TAB && (
                                  <button
                                    className={`shrink-0 px-2 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${activeDetailTab === "eol" ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                                    onClick={() => setActiveDetailTab("eol")}
                                  >
                                    Encyclopedia of Life
                                  </button>
                                )}
                                {SHOW_WIKIPEDIA_TAB && (
                                  <button
                                    className={`shrink-0 px-2 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${activeDetailTab === "wikipedia" ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                                    onClick={() => setActiveDetailTab("wikipedia")}
                                  >
                                    Wikipedia
                                  </button>
                                )}
                                {s.category === "NE" && (
                                  <button
                                    className={`shrink-0 px-2 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${activeDetailTab === "candidates" ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                                    onClick={() => setActiveDetailTab("candidates")}
                                  >
                                    Suggested Experts
                                  </button>
                                )}
                          </div>
                          {/* Content — overflow-hidden so child components don't extend past viewport */}
                          <div style={{ overflow: 'hidden', width: '100%' }}>
                          {gbifSpeciesKey ? (
                            (visitedTabs.has("gbif")) && (
                            <div style={{ display: activeDetailTab === "gbif" ? undefined : "none" }}>
                              {/* nativeCountriesRedList is withheld for Not
                                  Evaluated species: there is no assessment, so
                                  `countries` there is derived from the GBIF
                                  occurrences themselves, and offering it as the
                                  "IUCN native range" would check the occurrence
                                  data against itself. */}
                              <OccurrenceMapRow
                                speciesKey={gbifSpeciesKey}
                                mounted={mounted}
                                assessmentYear={assessmentYear}
                                assessmentDate={s.assessment_date}
                                assessmentId={s.assessment_id}
                                sisTaxonId={s.sis_taxon_id}
                                category={s.category}
                                criteria={s.criteria}
                                taxonGroup={s.taxon_group}
                                scientificName={s.scientific_name}
                                nativeCountriesRedList={s.category === "NE" ? undefined : s.countries}
                                previousAssessments={(s.sis_taxon_id ? assessmentHistory[s.sis_taxon_id] : null) ?? s.previous_assessments}
                                onEmpty={s.category === "NE" ? handleOccurrenceEmpty : undefined}
                              />
                            </div>
                            )
                          ) : (visitedTabs.has("gbif")) && (
                            <div style={{ display: activeDetailTab === "gbif" ? undefined : "none" }}>
                              <InatObservationsPanel scientificName={s.scientific_name} mounted={mounted} onEmpty={s.category === "NE" ? handleOccurrenceEmpty : undefined} />
                            </div>
                          )}
                          {(assessmentYear || s.category === "NE") && (visitedTabs.has("literature")) && (
                            <div className="p-4" style={{ display: activeDetailTab === "literature" ? undefined : "none" }}>
                              <NewLiteratureSinceAssessment
                                scientificName={s.scientific_name}
                                assessmentYear={assessmentYear ?? 0}
                              />
                            </div>
                          )}
                          {(visitedTabs.has("col")) && (() => {
                            const syn = synonymsBySpecies[s.species_key];
                            return (
                            <div style={{ display: activeDetailTab === "col" ? undefined : "none" }}>
                              {!syn ? (
                                <div className="flex items-center justify-center p-8">
                                  <svg className="w-5 h-5 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                  </svg>
                                </div>
                              ) : !syn.col_id ? (
                                <div className="text-sm text-zinc-400 italic p-4">No Catalogue of Life match for <span className="italic">{s.scientific_name}</span>.</div>
                              ) : (
                                <div className="p-4 text-sm space-y-3">
                                  <div>
                                    <div className="text-xs uppercase tracking-wider text-zinc-400 mb-1">Accepted name (CoL)</div>
                                    <span className="italic text-zinc-900 dark:text-zinc-100">{syn.accepted_name ?? s.scientific_name}</span>
                                    {syn.accepted_authorship && <span className="text-zinc-500 dark:text-zinc-400"> {syn.accepted_authorship}</span>}
                                  </div>
                                  <div>
                                    <div className="text-xs uppercase tracking-wider text-zinc-400 mb-1">Synonyms ({syn.synonyms.length})</div>
                                    {syn.synonyms.length === 0 ? (
                                      <div className="text-zinc-500 dark:text-zinc-400">No synonyms recorded.</div>
                                    ) : (
                                      <ul className="space-y-0.5">
                                        {syn.synonyms.map((x, i) => (
                                          <li key={i}>
                                            <span className="italic text-zinc-700 dark:text-zinc-300">{x.name}</span>
                                            {x.authorship && <span className="text-zinc-500 dark:text-zinc-400"> {x.authorship}</span>}
                                            {x.status === "ambiguous synonym" && <span className="ml-1 text-xs text-amber-600 dark:text-amber-500">(ambiguous)</span>}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                  <a
                                    href={`https://www.catalogueoflife.org/data/taxon/${syn.col_id}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                                  >
                                    View on Catalogue of Life ↗
                                  </a>
                                </div>
                              )}
                            </div>
                            );
                          })()}
                          {SHOW_EOL_TAB && (visitedTabs.has("eol")) && (
                            <div style={{ display: activeDetailTab === "eol" ? undefined : "none" }}>
                              <EolSummary scientificName={s.scientific_name} />
                            </div>
                          )}
                          {s.category !== "NE" && (visitedTabs.has("redlist")) && (
                            <div style={{ display: activeDetailTab === "redlist" ? undefined : "none" }}>
                              <RedListAssessments
                                sisTaxonId={s.sis_taxon_id ?? undefined}
                                currentAssessmentId={s.assessment_id ?? 0}
                                currentCategory={s.category}
                                currentAssessmentDate={s.assessment_date}
                                previousAssessments={((s.sis_taxon_id ? assessmentHistory[s.sis_taxon_id] : null) ?? s.previous_assessments ?? []).map((a) => ({ year: a.year, assessment_id: a.id, category: a.category, assessors: a.assessors, reviewers: a.reviewers, facilitators: a.facilitators, contributors: a.contributors, institutions: a.institutions }))}
                                speciesUrl={`https://www.iucnredlist.org/species/${s.sis_taxon_id}/${s.assessment_id}`}
                              />
                            </div>
                          )}
                          {SHOW_WIKIPEDIA_TAB && (visitedTabs.has("wikipedia")) && (
                          <div style={{ display: activeDetailTab === "wikipedia" ? undefined : "none" }}>
                            <WikipediaSummary scientificName={s.scientific_name} />
                          </div>
                          )}
                          {(visitedTabs.has("cites")) && (
                          <div style={{ display: activeDetailTab === "cites" ? undefined : "none" }}>
                            <CitesSummary scientificName={s.scientific_name} />
                          </div>
                          )}
                          {s.category === "NE" && (visitedTabs.has("candidates")) && (
                            <div style={{ display: activeDetailTab === "candidates" ? undefined : "none" }}>
                              <CandidatesTable role={candidateRole} onRoleChange={changeCandidateRole} species={candidateSpecies} />
                            </div>
                          )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
              {totalFiltered === 0 && !speciesLoading && (
                <tr>
                  <td colSpan={isNewAssessments ? 4 : 8} className="px-4 py-8 text-center text-zinc-500">
                    No species found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </div>

        {/* Pagination */}
        {totalFiltered > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between px-3 md:px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 gap-2">
            <div className="flex items-center gap-3">
              <div className="text-xs md:text-sm text-zinc-500">
                {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, totalFiltered)} of {totalFiltered}
              </div>
              {/* Secondary-sort hint. Shown only while a secondary is NOT set, so
                  it teaches the gesture and then gets out of the way — the ①/②
                  header badges carry the state once it is in use. Hidden on
                  small screens, where the modifier gesture isn't available. */}
              {!sortField2 && (
                <span className="hidden lg:inline text-xs text-zinc-400 dark:text-zinc-500">
                  ⇧ or ⌘/Ctrl+click a second column to sort within the first
                </span>
              )}
              {sortField2 && (
                <button
                  onClick={() => { setSort2(null, "desc"); setCurrentPage(1); }}
                  className="hidden lg:inline text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline decoration-dotted"
                  title="Remove the secondary sort"
                >
                  Clear 2nd sort
                </button>
              )}
              <label className="flex items-center gap-1.5 text-xs md:text-sm text-zinc-500">
                <span>Rows</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs md:text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 focus:outline-none cursor-pointer"
                >
                  {[1, 2, 3, 5, 10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Prev
                </button>
                <span className="text-xs md:text-sm text-zinc-600 dark:text-zinc-400">
                  {currentPage} / {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
        </>
        )}
      </div>
      </div>
      ))}

      {/* Fixed image preview portal */}
      <img
        id="image-preview"
        alt=""
        className="fixed z-[9999] w-48 h-48 object-cover rounded shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pointer-events-none"
        style={{ display: 'none' }}
      />
    </div>
  );
}
