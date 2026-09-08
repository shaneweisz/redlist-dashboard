"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { buildQs, type ViewMode } from "../hooks/useFilterParams";
import { CATEGORY_COLORS } from "../config/taxa";
import { findNode, getViewRootForNode } from "../lib/taxonomy-utils";
import { ALL_HABITAT_SEASONS, ALL_HABITAT_IMPORTANCE, ALL_HABITAT_SUITABILITY } from "../lib/habitat-filter";
import {
  captureSearchNoResults,
  captureSearchResultSelected,
} from "@/lib/analytics/events";

export interface SearchResult {
  /**
   * The row this result selects in the species table — `sis-<sis_taxon_id>` for an
   * assessed species, `col-<col_id>` for a Not Evaluated one (see lib/species-row-key).
   * Null for a GBIF species with no CoL link: it has no row in any list, so selecting
   * it navigates by name only, with no detail panel opened.
   */
  species_key: string | null;
  sis_taxon_id: number | null;
  col_id: string | null;
  scientific_name: string;
  common_name: string | null;
  taxon_id: string;
  taxon_group: string;
  category: string;
  gbif_species_key: string | null;
  gbif_occurrence_count: number | null;
  assessment_id: number | null;
  assessment_date: string | null;
  countries: string[];
  class_name: string | null;
  order_name: string | null;
  family: string | null;
  // The node this species sits in — its family where known — see selectResult.
  node_id: string | null;
  matched_synonym?: string | null;
}

// A taxon (class/order/family/genus) the query matched — pinned above the species
// hits. Selecting it browses the whole taxon via ?taxa=<taxon>, or — when nodeId
// resolved server-side — via the curated/dynamic node it corresponds to (see
// selectTaxon), so the taxa-summary table's ancestor-breadcrumb rows populate too.
interface TaxonSuggestion {
  name: string;
  rank: "class" | "order" | "family" | "genus";
  taxon: string;
  nodeId: string | null;
}

/**
 * Module-level cache of the last selected search result.
 * RedListView reads this to construct the preview without an API call.
 */
let lastSelectedResult: SearchResult | null = null;
export function getLastSearchResult(): SearchResult | null {
  return lastSelectedResult;
}
export function clearLastSearchResult(): void {
  lastSelectedResult = null;
}

export function SpeciesSearchBar() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [taxaResults, setTaxaResults] = useState<TaxonSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [loading, setLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The query and results as they are RIGHT NOW, for the analytics call in the
  // select handlers below. Those handlers deliberately keep empty dep arrays —
  // taking `query` as a dep would rebuild them on every keystroke — so they
  // cannot close over the live values directly (#524).
  const queryRef = useRef("");
  const resultsRef = useRef<SearchResult[]>([]);
  const taxaResultsRef = useRef<TaxonSuggestion[]>([]);
  queryRef.current = query;
  resultsRef.current = results;
  taxaResultsRef.current = taxaResults;
  // The last query already reported as finding nothing, so a re-render (or the
  // user tabbing away and back) doesn't report the same dead end twice.
  const reportedNoResultsRef = useRef<string | null>(null);

  // Warm-start: pre-load the search index on mount so first search is fast
  useEffect(() => {
    fetch("/api/search/warm").catch(() => {});
  }, []);

  // Debounced fetch
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setTaxaResults([]);
      setIsOpen(false);
      return;
    }

    const timeout = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&limit=10`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        setResults(data.results);
        setTaxaResults(data.taxa ?? []);
        setIsOpen(true);
        setHighlightIndex(-1);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setResults([]);
        setTaxaResults([]);
        setIsOpen(false);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => {
      clearTimeout(timeout);
      abortRef.current?.abort();
    };
  }, [query]);

  // A query that settled and found nothing (#524).
  //
  // Waits considerably longer than the 250ms fetch debounce above, and requires
  // the fetch to have finished: mid-word a query legitimately matches nothing
  // ("Panthe" before "Panthera"), and reporting those would fill the "failed
  // searches" list with prefixes of successful ones. 1.2s idle is roughly the
  // point where someone has stopped typing and is looking at an empty dropdown.
  useEffect(() => {
    if (loading || query.trim().length < 2) return;
    if (results.length > 0 || taxaResults.length > 0) return;
    if (reportedNoResultsRef.current === query) return;

    const timeout = setTimeout(() => {
      reportedNoResultsRef.current = query;
      captureSearchNoResults(query);
    }, 1200);
    return () => clearTimeout(timeout);
  }, [query, loading, results.length, taxaResults.length]);

  // Click outside to close
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selectResult = useCallback(
    (result: SearchResult) => {
      captureSearchResultSelected({
        query: queryRef.current,
        resultName: result.scientific_name,
        resultType: "species",
        resultCategory: result.category ?? null,
        // Position in the combined dropdown, taxon suggestions included, so the
        // number matches what the user actually looked down.
        rank: taxaResultsRef.current.length + resultsRef.current.indexOf(result),
      });
      lastSelectedResult = result;
      const viewMode: ViewMode = result.category === "NE" ? "new-assessments" : "reassessments";

      // Open on the node the species actually sits in — its family where CoL knows one
      // (node_id, resolved server-side) — split into display-root + sub-group exactly like
      // selectTaxon does. That is what puts its lineage on screen as the taxa table's
      // ancestor rows (Invertebrates → Insects → Lepidoptera → Nymphalidae) instead of
      // dropping the user at the bare top-level taxon, and on the not-evaluated side it is
      // also what makes the species listable at all: that view loads one node's NE list and
      // an aggregate like Invertebrates (~1.3M NE) is over the cap, so it could only ever
      // show the "too many to load at once" prompt there (#453).
      const viewRoot = result.node_id ? getViewRootForNode(result.node_id) : null;
      const subgroup = viewRoot && result.node_id !== viewRoot ? result.node_id : null;

      // Build URL with species selected — all filter state is driven from the URL
      const qs = buildQs({
        viewMode,
        taxa: new Set([viewRoot ?? result.taxon_id]),
        subgroups: subgroup ? new Set([subgroup]) : new Set(),
        categories: new Set(),
        yearRanges: new Set(),
        assessmentYears: new Set(),
        describedYears: new Set(),
        countries: new Set(),
        obsRanges: new Set(),
        assessmentCounts: new Set(),
        systems: new Set(),
        populationTrends: new Set(),
        movementPatterns: new Set(),
        threats: new Set(),
        criteria: new Set(),
        habitat: new Set(),
        habitatBreadth: null,
        habitatImportance: new Set(ALL_HABITAT_IMPORTANCE),
        habitatSeasons: new Set(ALL_HABITAT_SEASONS),
        habitatSuitability: new Set(ALL_HABITAT_SUITABILITY),
        endemicsOnly: false,
        growthForms: new Set(),
        assessors: new Set(),
        reviewers: new Set(),
        facilitators: new Set(),
        contributors: new Set(),
        institutions: new Set(),
        search: result.scientific_name,
        sortField: null,
        sortField2: null,
        sortDirection2: "desc" as const,
        sortDirection: "desc",
        species: result.species_key,
        tab: "gbif",
      });

      window.history.pushState(null, "", "/" + qs);
      window.dispatchEvent(new PopStateEvent("popstate"));

      setQuery("");
      setResults([]);
      setTaxaResults([]);
      setIsOpen(false);
    },
    []
  );

  // Browse a whole taxon (e.g. Felidae, or the genus Panthera). When suggestTaxa resolved a real
  // node (nodeId) for it — a curated static node, or a well-formed dynamic drilldown
  // id — select it as a display-root + sub-group pair, exactly like clicking through
  // TaxaSummary's own tree would: this is what makes the ancestor-breadcrumb rows
  // (Mammals → Carnivora → Felidae → ...) populate above the table, and gives the
  // per-taxon stat card a proper curated label instead of the generic arbitrary-rank
  // fallback. Otherwise (nodeId null) fall back to the old bare ?taxa=<taxon> browse,
  // which still flows through resolveWhere → querySpecies just like a curated node,
  // just without a resolvable tree position. No species is preselected either way.
  // Preserve the current view: from the new-assessments view, browsing a taxon shows
  // its not-evaluated species (charts come from the assessed/reassessments view).
  const selectTaxon = useCallback((t: TaxonSuggestion) => {
    captureSearchResultSelected({
      query: queryRef.current,
      resultName: t.taxon,
      resultType: "taxon",
      resultCategory: null,
      rank: taxaResultsRef.current.indexOf(t),
    });
    const currentView: ViewMode =
      new URLSearchParams(window.location.search).get("view") === "new-assessments"
        ? "new-assessments"
        : "reassessments";
    const viewRoot = t.nodeId ? getViewRootForNode(t.nodeId) : null;
    const taxa = viewRoot ?? t.taxon;
    const subgroup = viewRoot && t.nodeId !== viewRoot ? t.nodeId : null;
    const qs = buildQs({
      viewMode: currentView,
      taxa: new Set([taxa]),
      subgroups: subgroup ? new Set([subgroup]) : new Set(),
      categories: new Set(),
      yearRanges: new Set(),
      assessmentYears: new Set(),
      describedYears: new Set(),
      countries: new Set(),
      obsRanges: new Set(),
      assessmentCounts: new Set(),
      systems: new Set(),
      populationTrends: new Set(),
      movementPatterns: new Set(),
      threats: new Set(),
      criteria: new Set(),
      habitat: new Set(),
      habitatBreadth: null,
      habitatImportance: new Set(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set(ALL_HABITAT_SUITABILITY),
      endemicsOnly: false,
      growthForms: new Set(),
      assessors: new Set(),
      reviewers: new Set(),
      facilitators: new Set(),
      contributors: new Set(),
      institutions: new Set(),
      search: "",
      sortField: null,
      sortField2: null,
      sortDirection2: "desc" as const,
      sortDirection: "desc",
      species: null,
      tab: null,
    });
    window.history.pushState(null, "", "/" + qs);
    window.dispatchEvent(new PopStateEvent("popstate"));

    setQuery("");
    setResults([]);
    setTaxaResults([]);
    setIsOpen(false);
  }, []);

  // Keyboard navigation runs over a single combined list: taxon suggestions first,
  // then species. An index < taxaResults.length picks a taxon; the rest pick species.
  const totalItems = taxaResults.length + results.length;
  const activateIndex = (i: number) => {
    if (i < taxaResults.length) selectTaxon(taxaResults[i]);
    else selectResult(results[i - taxaResults.length]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || totalItems === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => (i < totalItems - 1 ? i + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => (i > 0 ? i - 1 : totalItems - 1));
    } else if (e.key === "Enter" && highlightIndex >= 0) {
      e.preventDefault();
      activateIndex(highlightIndex);
    } else if (e.key === "Escape") {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  };

  function getTaxonLabel(taxonId: string): string {
    const node = findNode(taxonId);
    return node?.name ?? taxonId;
  }

  return (
    <div ref={containerRef} className="relative w-full sm:w-[18.23rem] md:w-[21.87rem]">
      <div className="relative">
        {/* Magnifying glass icon */}
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.length >= 2 && setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search for a species or taxon..."
          className="w-full pl-10 pr-8 py-1.5 text-base rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:focus:ring-zinc-500"
        />
        {/* Clear button */}
        {query && (
          <button
            onClick={() => {
              setQuery("");
              setResults([]);
              setTaxaResults([]);
              setIsOpen(false);
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {/* Loading spinner */}
        {loading && (
          <div className="absolute right-8 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 rounded-full animate-spin border-2 border-zinc-300 dark:border-zinc-600" style={{ borderTopColor: 'transparent' }} />
          </div>
        )}
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 max-h-80 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg">
          {/* Higher-rank taxon suggestions, pinned above species hits */}
          {taxaResults.map((t, i) => (
            <button
              key={`taxon-${t.rank}-${t.taxon}`}
              onClick={() => selectTaxon(t)}
              onMouseEnter={() => setHighlightIndex(i)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-700/60 ${
                i === highlightIndex
                  ? "bg-zinc-100 dark:bg-zinc-700"
                  : "hover:bg-zinc-50 dark:hover:bg-zinc-700/50"
              }`}
            >
              <svg className="h-4 w-4 shrink-0 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h10M4 18h6" />
              </svg>
              <span className="flex-1 min-w-0 text-zinc-900 dark:text-zinc-100">
                {/* Genus names are italicised by taxonomic convention (as the species
                    hits below already are); class/order/family names are not. */}
                Browse <span className={`font-medium${t.rank === "genus" ? " italic" : ""}`}>{t.name}</span>
              </span>
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                {t.rank}
              </span>
            </button>
          ))}
          {results.length === 0 && taxaResults.length === 0 && !loading ? (
            <div className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
              No species found
            </div>
          ) : (
            results.map((result, ri) => {
              const i = taxaResults.length + ri;
              return (
              <button
                key={`${result.species_key ?? result.scientific_name}-${result.taxon_group}`}
                onClick={() => selectResult(result)}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                  i === highlightIndex
                    ? "bg-zinc-100 dark:bg-zinc-700"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-700/50"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <span className="italic text-zinc-900 dark:text-zinc-100">
                    {result.scientific_name}
                  </span>
                  {result.common_name && (
                    <span className="text-zinc-500 dark:text-zinc-400 ml-1">
                      ({result.common_name})
                    </span>
                  )}
                  {result.matched_synonym && (
                    <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-1">
                      syn. <span className="italic">{result.matched_synonym}</span>
                    </span>
                  )}
                  <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-2">
                    {getTaxonLabel(result.taxon_id)}
                  </span>
                </div>
                {/* Category badge */}
                <span
                  className="shrink-0 text-xs font-medium px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: CATEGORY_COLORS[result.category] ?? "#6b7280",
                    color: ["VU", "NT", "LC", "NE"].includes(result.category) ? "#18181b" : "#ffffff",
                  }}
                >
                  {result.category}
                </span>
              </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
