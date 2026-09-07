"use client";

import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from "react";
import {
  ComposableMap,
  Geographies,
  Geography,
  ZoomableGroup,
} from "react-simple-maps";
import { geoArea, geoCentroid } from "d3-geo";
import { IUCN_REGION_ORDER, matchingRegions, iucnRegionCountries } from "@/lib/regions";
import { NAME_TO_ALPHA2, ALPHA2_TO_NAME } from "@/lib/countries";
import { splitEmbeddedTerritories } from "@/lib/map-territories";
import CountryStatsList from "./CountryStatsList";
import type { MapViewMode, MapSortKey } from "@/hooks/useFilterParams";

// Using the recommended TopoJSON from react-simple-maps
const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";

// What the shapes call each country, so a search for "Cabo Verde" or
// "Dem. Rep. Congo" still finds it under its full name. More than one shape
// can share a code (Ashmore and Cartier is drawn separately from Australia).
const SHAPE_NAMES_BY_CODE: Record<string, string[]> = {};
for (const [name, code] of Object.entries(NAME_TO_ALPHA2)) {
  (SHAPE_NAMES_BY_CODE[code] ||= []).push(name);
}

// Every country the app can filter by — not just the ones the shapes draw.
// Antarctica, Gibraltar, Bouvet Island, the U.S. Minor Outlying Islands and
// IUCN's "Disputed Territory" all carry Red List data but have no shape at
// this resolution, and were missing from search altogether while this list was
// built from shape names. They select like any other country; they just have
// nowhere to zoom to.
const SEARCHABLE_COUNTRIES = Object.entries(ALPHA2_TO_NAME)
  .map(([code, label]) => ({
    code,
    label,
    haystack: [label, ...(SHAPE_NAMES_BY_CODE[code] ?? [])].join(" ").toLowerCase(),
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

// Zoom depth by country size, keyed by code rather than shape name — a country
// can be drawn under several labels, and one label ("Kosovo") can stand for a
// country that isn't small at all.
const SMALL_COUNTRY_CODES = new Set([
  "AD", "AG", "AI", "AS", "AW", "AX", "BB", "BH", "BL", "BM", "BN", "BQ", "BV", "BZ",
  "CC", "CV", "CW", "CX", "CY", "DJ", "DM", "FM", "FO", "GD", "GG", "GI", "GM", "GP",
  "GW", "HK", "IM", "JE", "JM", "KI", "KM", "KN", "KW", "KY", "LB", "LC", "LI", "LS",
  "LU", "MC", "ME", "MF", "MH", "MK", "MO", "MP", "MQ", "MS", "MT", "MU", "MV", "NF",
  "NR", "NU", "PM", "PN", "PW", "QA", "RE", "SC", "SG", "SH", "SI", "SJ", "SM", "ST",
  "SX", "SZ", "TC", "TK", "TO", "TT", "TV", "VA", "VC", "VG", "VI", "WF", "WS", "YT",
]);
const LARGE_COUNTRY_CODES = new Set(["RU", "CA", "US", "CN", "BR", "AU", "IN", "AR"]);

export interface CountryStats {
  [countryCode: string]: {
    occurrences: number;
    species: number;
    outdated?: number;
  };
}

// Linear gradient for % outdated: green (0%) -> amber (50%) -> red (100%).
// Unlike the species/occurrence heatmap, % is already bounded and roughly
// uniformly distributed, so a plain linear scale (no log) keeps countries
// distinguishable across the full range instead of clumping most into one bucket.
function getOutdatedColor(percent: number): string {
  const p = Math.max(0, Math.min(100, percent));
  const green: [number, number, number] = [34, 197, 94]; // #22c55e
  const amber: [number, number, number] = [234, 179, 8]; // #eab308
  const red: [number, number, number] = [239, 68, 68]; // #ef4444
  const [from, to, t] = p <= 50 ? [green, amber, p / 50] : [amber, red, (p - 50) / 50];
  const [r, g, b] = from.map((c, i) => Math.round(c + (to[i] - c) * t));
  return `rgb(${r}, ${g}, ${b})`;
}

// Color scale for heatmap: pale green -> medium green -> dark green
function getHeatmapColor(value: number, maxValue: number): string {
  if (value === 0 || maxValue === 0) return "#f5f5f4"; // stone-100

  // Use log scale with high power to push most countries to pale end
  // Higher power = more countries appear pale, only highest values get dark
  const logValue = Math.log10(value + 1);
  const logMax = Math.log10(maxValue + 1);
  const ratio = Math.pow(logValue / logMax, 2.0);

  // Color scale: #dcfce7 (green-100) -> #86efac (green-300) -> #22c55e (green-500) -> #166534 (green-800)
  if (ratio < 0.33) {
    // Pale green to light green
    const t = ratio * 3;
    const r = Math.round(220 + (134 - 220) * t);
    const g = Math.round(252 + (239 - 252) * t);
    const b = Math.round(231 + (172 - 231) * t);
    return `rgb(${r}, ${g}, ${b})`;
  } else if (ratio < 0.66) {
    // Light green to medium green
    const t = (ratio - 0.33) * 3;
    const r = Math.round(134 + (34 - 134) * t);
    const g = Math.round(239 + (197 - 239) * t);
    const b = Math.round(172 + (94 - 172) * t);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // Medium green to dark green
    const t = (ratio - 0.66) * 3;
    const r = Math.round(34 + (22 - 34) * t);
    const g = Math.round(197 + (101 - 197) * t);
    const b = Math.round(94 + (52 - 94) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

type ColorMode = "species" | "occurrences" | "outdated";

const ALL_TAXA_IDS = ["mammals", "birds", "reptiles", "amphibians", "fishes", "invertebrates", "plantae", "fungi"];

interface WorldMapProps {
  selectedCountries: Set<string>;
  onCountrySelect: (countryCode: string, countryName: string, event: React.MouseEvent) => void;
  selectedTaxon?: string | null;
  // Optional pre-computed stats (for Red List species counts - avoids API call)
  precomputedStats?: CountryStats;
  // Same shape as precomputedStats, but with no filters applied beyond taxon/
  // subgroup selection — the "true total" shown in the tooltip alongside the
  // (possibly filtered) precomputedStats count, so e.g. "100% outdated" while
  // the Outdated filter is on doesn't read as a fact about the country.
  precomputedStatsTotal?: CountryStats;
  // Which taxa are selected (determines which GBIF occurrence stats to fetch)
  selectedTaxa?: Set<string>;
  // Label for the species count in tooltips (default: "# Assessed")
  speciesLabel?: string;
  // Callback when a region is selected from the dropdown (sets country filter)
  /** Set the country selection from the region picker (a union of whole regions). */
  onRegionsChange?: (countries: Set<string>) => void;
  // Whether the "endemics only" filter is active (single-country species)
  endemicsOnly?: boolean;
  // Callback to toggle the endemics-only filter
  onEndemicsToggle?: () => void;
  // Optional footer content rendered inside the panel below the map
  footer?: React.ReactNode;
  // Whether to show the Species/GBIF color mode toggle (only accurate for top-level taxa)
  showGbifToggle?: boolean;
  // Whether the "% Needs Updating" color mode is meaningful (false for unassessed/NE species views,
  // where every species has no assessment date rather than an outdated one)
  showOutdatedMode?: boolean;
  // Whether to show the color-mode <select> at all (species/outdated/GBIF) — false
  // for new-assessments/NE views, where it's not just missing its "% Needs Updating"
  // option but pointless outright: color-coding a map of species that are all,
  // definitionally, unassessed conveys nothing. Independent of showGbifToggle/
  // showOutdatedMode (which only control which OPTIONS appear once shown).
  showColorModeDropdown?: boolean;
  // Map/List toggle + list-view sort, URL-synced (see useFilterParams.ts's
  // mapViewMode/mapSortKey/mapSortDirection) so a sorted list view is a
  // shareable link. Falls back to local state when omitted (e.g. tests).
  mapViewMode?: MapViewMode;
  onMapViewModeChange?: (mode: MapViewMode) => void;
  mapSortKey?: MapSortKey;
  mapSortDirection?: "asc" | "desc";
  onMapSortChange?: (key: MapSortKey, direction: "asc" | "desc") => void;
  // When true, hovering a country calls onCountryHover (in addition to the
  // tooltip), so e.g. the country-view landing page's table can preview a
  // country as you scan the map rather than requiring a click. Deliberately
  // separate from onCountrySelect/onClick — hover previews, it doesn't
  // select, so the caller can keep its real (locked-in) selection state
  // untouched by mouse movement. Default false — the other WorldMap usages
  // (Charts row 2's country filter, the CITES map) still expect click-to-
  // select only.
  selectOnHover?: boolean;
  // Called with the hovered country's code on mouseenter, and null on
  // mouseleave, only while selectOnHover is true.
  onCountryHover?: (countryCode: string | null) => void;
}

const DEFAULT_CENTER: [number, number] = [10, 10];
const DEFAULT_ZOOM = 1.5;
const MIN_ZOOM = 1.0;
const MAX_ZOOM = 8.0;

function WorldMap({ selectedCountries, onCountrySelect, selectedTaxon, precomputedStats, precomputedStatsTotal, selectedTaxa, speciesLabel = "# Assessed", onRegionsChange, endemicsOnly = false, onEndemicsToggle, footer, showGbifToggle = true, showOutdatedMode = true, showColorModeDropdown = true, mapViewMode, onMapViewModeChange, mapSortKey, mapSortDirection, onMapSortChange, selectOnHover = false, onCountryHover }: WorldMapProps) {
  const [hoveredCountry, setHoveredCountry] = useState<string | null>(null);
  const [hoveredCountryCode, setHoveredCountryCode] = useState<string | null>(null);
  const [speciesStats, setSpeciesStats] = useState<CountryStats>(precomputedStats || {});
  const [occurrenceStats, setOccurrenceStats] = useState<CountryStats | null>(null);
  const [loading, setLoading] = useState(!precomputedStats);
  const [occurrenceLoading, setOccurrenceLoading] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>("species");
  // Falls back to local state when uncontrolled (mapViewMode/onMapViewModeChange
  // omitted) — see the same pattern for sort just below.
  const [localViewMode, setLocalViewMode] = useState<MapViewMode>("map");
  const viewMode = mapViewMode ?? localViewMode;
  const setViewMode = onMapViewModeChange ?? setLocalViewMode;
  const [localSortKey, setLocalSortKey] = useState<MapSortKey>("species");
  const [localSortDir, setLocalSortDir] = useState<"asc" | "desc">("desc");
  const sortKey = mapSortKey ?? localSortKey;
  const sortDir = mapSortDirection ?? localSortDir;
  const setSort = useCallback(
    (key: MapSortKey, dir: "asc" | "desc") => {
      if (onMapSortChange) onMapSortChange(key, dir);
      else { setLocalSortKey(key); setLocalSortDir(dir); }
    },
    [onMapSortChange]
  );

  // Reset to species mode if GBIF is hidden while it's the active mode
  // (Species and % Outdated stay available regardless of showGbifToggle,
  // since unlike GBIF occurrence counts they already reflect active filters.)
  useEffect(() => {
    setColorMode(mode => {
      if (mode === "occurrences" && !showGbifToggle) return "species";
      if (mode === "outdated" && !showOutdatedMode) return "species";
      return mode;
    });
  }, [showGbifToggle, showOutdatedMode]);

  // Zoom & pan state
  const [center, setCenter] = useState<[number, number]>(DEFAULT_CENTER);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  // Country search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  const filteredCountries = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return SEARCHABLE_COUNTRIES.filter(c => c.haystack.includes(q)).slice(0, 8);
  }, [searchQuery]);

  // Selecting always works; zooming only when the country has a shape to
  // centre on (Antarctica is drawn but excluded from the map, and Gibraltar,
  // Tuvalu and Bouvet Island aren't drawn at this resolution at all).
  const handleSelectCountry = useCallback((code: string, label: string) => {
    const coords = centroidsRef.current[code];
    if (coords) {
      setCenter(coords);
      // Small-country zoom capped lower than it used to be (was 6) — at 6 a
      // small island could fill the whole visible frame, right where the
      // bottom-left Map/List toggle and bottom-right zoom controls overlay it.
      setZoom(SMALL_COUNTRY_CODES.has(code) ? 4.5 : LARGE_COUNTRY_CODES.has(code) ? 2.5 : 4);
    }
    setSearchQuery("");
    setSearchOpen(false);
    onCountrySelect(code, label, { ctrlKey: true, metaKey: false } as unknown as React.MouseEvent);
  }, [onCountrySelect]);

  const handleResetZoom = useCallback(() => {
    setCenter(DEFAULT_CENTER);
    setZoom(DEFAULT_ZOOM);
  }, []);

  const handleZoomIn = useCallback(() => {
    setZoom((z: number) => Math.min(z * 1.5, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z: number) => Math.max(z / 1.5, MIN_ZOOM));
  }, []);

  // Prevent trackpad zoom/scroll from zooming the whole page when over the map
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Close search dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Centroids computed from TopoJSON geometries (computed once on first render)
  const centroidsRef = useRef<Record<string, [number, number]>>({});

  // Cache occurrence results by taxa key to avoid refetching on toggle
  const occurrenceCacheRef = useRef<Record<string, CountryStats>>({});

  // Use precomputed stats for species counts, otherwise fetch from API
  useEffect(() => {
    if (precomputedStats) {
      setSpeciesStats(precomputedStats);
      setLoading(false);
      return;
    }

    if (!selectedTaxon) {
      setSpeciesStats({});
      setLoading(false);
      return;
    }

    setLoading(true);
    fetch(`/api/country/stats?taxon=${encodeURIComponent(selectedTaxon)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.stats) {
          setSpeciesStats(data.stats);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedTaxon, precomputedStats]);

  // Stable key for the current taxa selection
  const taxaKey = useMemo(() => {
    if (!selectedTaxa || selectedTaxa.size === 0) return "all";
    return Array.from(selectedTaxa).sort().join(",");
  }, [selectedTaxa]);

  // Fetch real per-country occurrence counts from GBIF API in the background
  // All taxa fire in parallel; map updates once when all resolve
  useEffect(() => {
    // Use cached result if available
    if (occurrenceCacheRef.current[taxaKey]) {
      setOccurrenceStats(occurrenceCacheRef.current[taxaKey]);
      return;
    }

    const taxaToFetch = taxaKey === "all" ? ALL_TAXA_IDS : taxaKey.split(",");

    setOccurrenceLoading(true);
    const controller = new AbortController();

    Promise.all(
      taxaToFetch.map(taxon =>
        fetch(`/api/country/stats?taxon=${encodeURIComponent(taxon)}`, { signal: controller.signal })
          .then(res => res.json())
          .then(data => (data.stats || {}) as CountryStats)
          .catch(() => ({} as CountryStats))
      )
    ).then(results => {
      if (controller.signal.aborted) return;
      const combined: CountryStats = {};
      for (const stats of results) {
        for (const [code, stat] of Object.entries(stats)) {
          if (!combined[code]) combined[code] = { occurrences: 0, species: 0 };
          combined[code].occurrences += stat.occurrences;
        }
      }
      occurrenceCacheRef.current[taxaKey] = combined;
      setOccurrenceStats(combined);
    }).finally(() => {
      if (!controller.signal.aborted) setOccurrenceLoading(false);
    });

    return () => controller.abort();
  }, [taxaKey]);

  // Invalidate occurrence cache when taxa change
  useEffect(() => {
    setOccurrenceStats(occurrenceCacheRef.current[taxaKey] || null);
  }, [taxaKey]);

  // Active stats for coloring based on mode ("outdated" reuses the species stats,
  // since outdated counts are computed alongside species counts, not fetched separately)
  const activeStats = colorMode === "occurrences" ? (occurrenceStats || {}) : speciesStats;

  // Which regions (if any) are currently selected as a whole — shared by the
  // region control's own checked state (below) and the list view (which narrows
  // its rows to them, same as the map already implicitly does via the blue
  // highlight over those regions' shapes). See matchingRegions' own doc comment
  // for exactly what "as a whole" means.
  const activeRegions = useMemo(() => matchingRegions(selectedCountries), [selectedCountries]);

  // Region picker popover — a checkbox list rather than a <select> so more than
  // one region can be active at once ("North America + South America"), which a
  // native single-value select cannot express. Ticking a box unions that
  // region's countries into the same selectedCountries set an individual
  // country click writes, so nothing downstream needs a separate region concept.
  const [regionMenuOpen, setRegionMenuOpen] = useState(false);
  const regionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!regionMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (regionMenuRef.current && !regionMenuRef.current.contains(e.target as Node)) {
        setRegionMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [regionMenuOpen]);

  const toggleRegion = useCallback((region: string) => {
    const codes = iucnRegionCountries(region);
    const next = new Set(selectedCountries);
    // Ticking adds the whole region; unticking removes exactly what ticking
    // added, so a region toggled on and back off leaves any individually
    // picked countries elsewhere untouched.
    if (codes.every((c) => next.has(c))) codes.forEach((c) => next.delete(c));
    else codes.forEach((c) => next.add(c));
    onRegionsChange?.(next);
  }, [selectedCountries, onRegionsChange]);

  // Calculate max value for heatmap scaling (unused in "outdated" mode, which uses a fixed 0-100% gradient)
  const maxValue = Object.values(activeStats).reduce(
    (max, stat) => Math.max(max, colorMode === "species" ? stat.species : stat.occurrences),
    0
  );

  const getCountryColor = (alpha2: string | undefined, isSelected: boolean): string => {
    if (isSelected) return "#3b82f6"; // blue-500 for selected
    if (!alpha2) return "#f4f4f5";

    const stats = activeStats[alpha2];
    if (!stats) return "#f4f4f5";

    if (colorMode === "outdated") {
      if (!stats.species) return "#f4f4f5";
      return getOutdatedColor(((stats.outdated || 0) / stats.species) * 100);
    }

    const value = colorMode === "species" ? stats.species : stats.occurrences;
    return getHeatmapColor(value, maxValue);
  };

  const hoveredSpeciesStats = hoveredCountryCode ? speciesStats[hoveredCountryCode] : null;
  const hoveredTotalStats = hoveredCountryCode ? precomputedStatsTotal?.[hoveredCountryCode] : null;
  const hoveredOccurrenceStats = hoveredCountryCode && occurrenceStats ? occurrenceStats[hoveredCountryCode] : null;

  return (
    // h-full covers CSS Grid stretch parents (definite track size, percentage
    // heights resolve fine there); flex-1/min-h-0 covers a flex-column parent
    // whose own height only comes from ITS flex-grow — a plain block ancestor
    // sized that way doesn't count as "definite" for a percentage-height (h-full)
    // child in Chromium, so that combination silently collapses to content size
    // without this. Both are inert unless the actual parent matches their layout
    // mode, so having both covers each caller without affecting the other.
    <div className="relative bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-3 h-full flex-1 min-h-0 flex flex-col">
      {/* Header with controls */}
      <div className="flex items-center justify-between mb-1 gap-2">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0">
          Country
        </h2>
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {/* Country search */}
          <div ref={searchContainerRef} className="relative">
            <div className="flex items-center bg-zinc-100 dark:bg-zinc-800 rounded-md">
              <svg className="w-3 h-3 ml-1.5 text-zinc-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search country..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSearchOpen(true);
                  setHighlightedIndex(0);
                }}
                onFocus={() => { if (searchQuery) setSearchOpen(true); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHighlightedIndex(i => Math.min(i + 1, filteredCountries.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlightedIndex(i => Math.max(i - 1, 0));
                  } else if (e.key === "Enter" && filteredCountries[highlightedIndex]) {
                    e.preventDefault();
                    handleSelectCountry(filteredCountries[highlightedIndex].code, filteredCountries[highlightedIndex].label);
                  } else if (e.key === "Escape") {
                    setSearchOpen(false);
                    setSearchQuery("");
                    searchInputRef.current?.blur();
                  }
                }}
                className="bg-transparent text-[11px] text-zinc-700 dark:text-zinc-300 placeholder-zinc-400 px-1.5 py-1 w-28 focus:w-36 transition-all outline-none"
              />
            </div>
            {/* Search dropdown */}
            {searchOpen && filteredCountries.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-52 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg z-30 overflow-hidden">
                {filteredCountries.map(({ code, label }, i) => (
                  <button
                    key={code}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${i === highlightedIndex ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"}`}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    onClick={() => handleSelectCountry(code, label)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Color mode: Species and % Outdated are always accurate; GBIF only when
              no extra filters are active (its counts aren't filterable per-country).
              Only meaningful for the choropleth itself — hidden in List view, which
              shows every column directly rather than color-coding by just one. */}
          {viewMode === "map" && showColorModeDropdown && (
            <select
              value={colorMode}
              onChange={(e) => setColorMode(e.target.value as ColorMode)}
              className="text-[10px] bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-1.5 py-0.5 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="species">{speciesLabel}</option>
              {showOutdatedMode && <option value="outdated">% Needs Updating</option>}
              {showGbifToggle && <option value="occurrences"># GBIF Obs</option>}
            </select>
          )}
          {onEndemicsToggle && (
            <button
              onClick={onEndemicsToggle}
              title="Show only species endemic to a single country"
              aria-pressed={endemicsOnly}
              className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors border ${
                endemicsOnly
                  ? "bg-teal-500 text-white border-teal-500 shadow-sm"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              Endemics
            </button>
          )}
          {onRegionsChange && (
            <div className="relative" ref={regionMenuRef}>
              <button
                type="button"
                onClick={() => setRegionMenuOpen(prev => !prev)}
                aria-expanded={regionMenuOpen}
                title={activeRegions.length ? activeRegions.join(", ") : "Filter by IUCN region"}
                className={`text-[10px] border rounded-md px-1.5 py-0.5 max-w-[110px] truncate focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                  activeRegions.length
                    ? "bg-blue-500 text-white border-blue-500"
                    : "bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                }`}
              >
                {activeRegions.length === 0
                  ? "All Regions"
                  : activeRegions.length === 1
                    ? activeRegions[0]
                    : `${activeRegions.length} regions`} ▾
              </button>
              {regionMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-56 max-h-72 overflow-y-auto">
                  {IUCN_REGION_ORDER.map(region => (
                    <label
                      key={region}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={activeRegions.includes(region)}
                        onChange={() => toggleRegion(region)}
                        className="rounded border-zinc-300 dark:border-zinc-600 text-blue-600 focus:ring-blue-500"
                      />
                      {region}
                    </label>
                  ))}
                  {activeRegions.length > 0 && (
                    <button
                      type="button"
                      onClick={() => onRegionsChange(new Set())}
                      className="w-full text-left px-3 py-1.5 mt-1 border-t border-zinc-200 dark:border-zinc-700 text-xs text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-700/50"
                    >
                      Clear regions
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Hover tooltip (map view only) */}
      {viewMode === "map" && hoveredCountry && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-10 bg-white dark:bg-zinc-800 px-3 py-2 rounded-lg shadow-lg text-sm text-zinc-700 dark:text-zinc-300 pointer-events-none border border-zinc-200 dark:border-zinc-700 min-w-[140px]">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">{hoveredCountry}</div>
          {hoveredSpeciesStats || hoveredOccurrenceStats ? (
            <div className="mt-1 space-y-0.5">
              {hoveredSpeciesStats && (
                <div className="flex justify-between gap-4 text-xs">
                  <span className="text-zinc-500">{speciesLabel}</span>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300 tabular-nums">
                    {formatNumber(hoveredSpeciesStats.species)}
                    {/* Filters (e.g. Outdated, a category) can narrow this below the country's
                        true total — show that total too so the count doesn't read as absolute. */}
                    {hoveredTotalStats && hoveredTotalStats.species !== hoveredSpeciesStats.species && (
                      <span className="text-zinc-400 font-normal"> (of {formatNumber(hoveredTotalStats.species)})</span>
                    )}
                  </span>
                </div>
              )}
              {showOutdatedMode && hoveredSpeciesStats && hoveredSpeciesStats.species > 0 && (
                <>
                  <div className="flex justify-between gap-4 text-xs">
                    <span className="text-zinc-500"># Needs Updating</span>
                    <span className="font-medium text-zinc-700 dark:text-zinc-300 tabular-nums">
                      {formatNumber(hoveredSpeciesStats.outdated || 0)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 text-xs">
                    <span className="text-zinc-500">% Needs Updating</span>
                    <span className="font-medium text-zinc-700 dark:text-zinc-300 tabular-nums">
                      {(((hoveredSpeciesStats.outdated || 0) / hoveredSpeciesStats.species) * 100).toFixed(1)}%
                    </span>
                  </div>
                </>
              )}
              {showGbifToggle && (
              <div className="flex justify-between gap-4 text-xs">
                <span className="text-zinc-500"># GBIF Obs</span>
                {occurrenceLoading ? (
                  <span className="text-zinc-400 tabular-nums">...</span>
                ) : hoveredOccurrenceStats ? (
                  <span className="font-medium text-zinc-700 dark:text-zinc-300 tabular-nums">{formatNumber(hoveredOccurrenceStats.occurrences)}</span>
                ) : (
                  <span className="text-zinc-400 tabular-nums">{colorMode === "occurrences" ? "..." : "—"}</span>
                )}
              </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-zinc-400 mt-1">No data available</div>
          )}
        </div>
      )}

      {/* List view: sortable table alternative, same stats/selection/click-through.
          Narrowed to activeRegions' countries when whole regions are selected —
          same scope the map already implies via its blue region highlight.
          Shares this relative wrapper with the map below (rather than each
          having its own) so the Map/List toggle can overlay bottom-left of
          whichever one is actually showing. */}
      {/* min-h-[200px] is the map's own floor, moved up here off the map itself
          so List inherits it: the map is display:none in List view, so a floor
          left on it would let the card shrink to whatever the list is instead —
          and the list, absolutely filled into this box below, would then have no
          height to fill. Held here, the two views are exactly the same size,
          which is the point: switching to List can't resize the card. */}
      <div className="relative flex-1 min-h-[200px] flex flex-col">
      {viewMode === "list" && (
        // absolute inset-0 so the list takes the box the map would have had
        // rather than sizing this card itself — 10 rows of countries nearly
        // doubled the height of the Country filter card (#487). It pages at
        // whatever the box actually holds; see CountryStatsList's `fit`.
        <div className="absolute inset-0 flex flex-col">
          <CountryStatsList
            stats={activeStats}
            selectedCountries={selectedCountries}
            onCountrySelect={onCountrySelect}
            speciesLabel={speciesLabel}
            showOutdatedMode={showOutdatedMode}
            regionsFilter={activeRegions}
            sortKey={sortKey}
            sortDir={sortDir}
            onSortChange={setSort}
          />
        </div>
      )}

      {/* Map */}
      <div className={viewMode === "list" ? "hidden" : "flex-1 rounded-lg overflow-hidden relative"} ref={mapContainerRef} style={{ touchAction: "none" }}>
        {(loading || (colorMode === "occurrences" && !occurrenceStats)) && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-zinc-900/50 z-10">
            <svg className="animate-spin h-5 w-5 text-zinc-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
        )}
        <ComposableMap
          projection="geoNaturalEarth1"
          projectionConfig={{
            scale: 140,
            center: [0, 0],
          }}
          style={{ width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }}
        >
          <ZoomableGroup
            center={center}
            zoom={zoom}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            onMoveEnd={({ coordinates, zoom: z }) => {
              setCenter(coordinates as [number, number]);
              setZoom(z);
            }}
          >
            {/* parseGeographies runs before the SVG paths are projected, which
                is the only point where an overseas territory can still be cut
                out of the parent shape it ships inside (French Guiana out of
                France, say) — after this, each is an ordinary country feature. */}
            <Geographies geography={GEO_URL} parseGeographies={splitEmbeddedTerritories}>
              {({ geographies }) => {
                // Compute centroids from geometry on first load
                /* eslint-disable react-hooks/immutability -- one-time cache populated from render callback data */
                if (Object.keys(centroidsRef.current).length === 0) {
                  // Keyed by code, so search can zoom without knowing what the
                  // shape is called. Where several shapes share a code — Ashmore
                  // and Cartier under AU, Somaliland under SO — the largest one
                  // wins, so we centre on the country rather than its outlier.
                  const areas: Record<string, number> = {};
                  for (const geo of geographies) {
                    const code = NAME_TO_ALPHA2[geo.properties.name];
                    if (!code || geo.properties.name === "Antarctica") continue;
                    const area = geoArea(geo);
                    if (areas[code] !== undefined && areas[code] >= area) continue;
                    areas[code] = area;
                    const [lng, lat] = geoCentroid(geo);
                    centroidsRef.current[code] = [lng, lat];
                  }
                }
                /* eslint-enable react-hooks/immutability */
                return geographies
                  .filter((geo) => geo.properties.name !== "Antarctica")
                  .map((geo) => {
                  const countryName = geo.properties.name;
                  const alpha2 = NAME_TO_ALPHA2[countryName];
                  const isSelected = alpha2 ? selectedCountries.has(alpha2) : false;
                  const fillColor = getCountryColor(alpha2, isSelected);

                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      onMouseEnter={() => {
                        // The shape's own label is abbreviated ("Dem. Rep.
                        // Congo"); ALPHA2_TO_NAME has the full name.
                        setHoveredCountry(alpha2 ? ALPHA2_TO_NAME[alpha2] ?? countryName : countryName);
                        setHoveredCountryCode(alpha2);
                        if (selectOnHover && alpha2) {
                          onCountryHover?.(alpha2);
                        }
                      }}
                      onMouseLeave={() => {
                        setHoveredCountry(null);
                        setHoveredCountryCode(null);
                        // Unconditional (not gated on selectOnHover, unlike
                        // onMouseEnter above) — self-heals a stale preview
                        // left over from before a country got locked in, so
                        // it can't resurface later if the lock is cleared.
                        onCountryHover?.(null);
                      }}
                      onClick={(event) => {
                        if (alpha2) {
                          onCountrySelect(alpha2, countryName, event);
                        }
                      }}
                      style={{
                        default: {
                          fill: fillColor,
                          stroke: "#a1a1aa",
                          strokeWidth: 0.5,
                          outline: "none",
                          cursor: alpha2 ? "pointer" : "default",
                        },
                        hover: {
                          fill: isSelected ? "#2563eb" : alpha2 ? "#a3e635" : "#f4f4f5",
                          stroke: "#71717a",
                          strokeWidth: 0.75,
                          outline: "none",
                          cursor: alpha2 ? "pointer" : "default",
                        },
                        pressed: {
                          fill: "#1d4ed8",
                          stroke: "#52525b",
                          strokeWidth: 1,
                          outline: "none",
                        },
                      }}
                    />
                  );
                });
              }}
            </Geographies>
          </ZoomableGroup>
        </ComposableMap>
        {/* Zoom controls */}
        <div className="absolute bottom-2 right-2 flex flex-col gap-1 z-10">
          {zoom > MIN_ZOOM && (
            <button
              onClick={handleResetZoom}
              className="w-7 h-7 flex items-center justify-center rounded bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 text-[10px] font-medium transition-colors"
              title="Reset zoom"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
          <button
            onClick={handleZoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 flex items-center justify-center rounded bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium transition-colors"
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={handleZoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 flex items-center justify-center rounded bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium transition-colors"
            title="Zoom out"
          >
            &minus;
          </button>
        </div>
      </div>
      {/* Map/List toggle — a sortable table alternative to the choropleth for
          users who'd rather scan/sort a list than read a map. Bottom-left,
          overlaying whichever of the two is currently showing (see the shared
          relative wrapper above), mirroring the zoom controls' bottom-right spot. */}
      <div className="absolute bottom-2 left-2 z-10 flex items-center bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-0.5 text-[10px] shadow-sm">
        {(["map", "list"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            aria-pressed={viewMode === mode}
            className={`px-1.5 py-0.5 rounded capitalize transition-colors ${
              viewMode === mode
                ? "bg-zinc-800 dark:bg-zinc-200 text-white dark:text-zinc-900"
                : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            }`}
          >
            {mode}
          </button>
        ))}
      </div>
      </div>
      {footer}
    </div>
  );
}

export default memo(WorldMap);
