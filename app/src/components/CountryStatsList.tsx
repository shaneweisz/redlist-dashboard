"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { FaFilter } from "react-icons/fa";
import { type CountryStats } from "./WorldMap";
import { ALPHA2_TO_NAME } from "@/lib/countries";
import { iucnRegionCountries } from "@/lib/regions";

type SortKey = "name" | "species" | "outdated" | "percentOutdated";
type SortDir = "asc" | "desc";
type FilterKey = "species" | "outdated" | "percentOutdated";

// Per-column min/max filter — kept as strings (not numbers) so a field can sit
// empty (no bound) or mid-edit without fighting a parsed/reformatted value.
interface RangeFilter {
  min: string;
  max: string;
}
const EMPTY_RANGE: RangeFilter = { min: "", max: "" };

// Blank bound = unbounded on that side; a non-numeric bound (still being
// typed, e.g. "-" or "") doesn't filter anything out rather than hiding
// every row while the input is mid-edit.
function inRange(value: number, filter: RangeFilter): boolean {
  if (filter.min !== "") {
    const min = Number(filter.min);
    if (!Number.isNaN(min) && value < min) return false;
  }
  if (filter.max !== "") {
    const max = Number(filter.max);
    if (!Number.isNaN(max) && value > max) return false;
  }
  return true;
}

interface CountryStatsListProps {
  stats: CountryStats;
  selectedCountries: Set<string>;
  onCountrySelect: (countryCode: string, countryName: string, event: React.MouseEvent) => void;
  speciesLabel?: string;
  showOutdatedMode?: boolean;
  // Narrows rows to the selected IUCN regions' countries — same scope the map
  // already implies via its blue region highlight (see WorldMap's activeRegions).
  // Empty means no region narrowing.
  regionsFilter?: string[];
  // Controlled sort (falls back to local state when omitted) so a sorted list
  // view is a shareable URL — see WorldMap's mapSortKey/mapSortDirection.
  sortKey?: SortKey;
  sortDir?: SortDir;
  onSortChange?: (key: SortKey, dir: SortDir) => void;
}

// How many rows a page holds is measured, not fixed: this list is absolutely
// filled into exactly the box the map would have occupied (see WorldMap), so it
// has to page at whatever that box holds rather than force the card taller —
// 10 text-sm rows are two-thirds of Country View's full-height panel but nearly
// double the Country FILTER card, which is only as tall as the 200px map inside
// it. Below, `fit` carries both halves of that answer.
//
// The compact scale is the same one this table ran at before Country View gave
// it a full-height panel — micro-text reads as cramped there, and as the only
// way to show a useful number of countries in a small filter card.
const DENSE_MAX_HEIGHT = 340; // available box below which the compact scale kicks in
const DENSE_ROW_H = 25; // text-xs + py-1 + border, pre-paint fallback only
const ROW_H = 37; // text-sm + py-2 + border, likewise
const MIN_ROWS = 3; // never page fewer than this, however short the box

function percentOutdatedOf(species: number, outdated: number): number {
  return species > 0 ? (outdated / species) * 100 : 0;
}

function SortHeader({
  label,
  active,
  dir,
  align = "right",
  widthClass,
  dense,
  onClick,
  filterButton,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  align?: "left" | "right";
  widthClass?: string;
  dense?: boolean;
  onClick: () => void;
  filterButton?: React.ReactNode;
}) {
  return (
    // The label wraps rather than truncating: "# Needs Updating" doesn't fit one
    // line of a quarter-width column in the Country filter card, and an ellipsed
    // "# Needs U…" beside an ellipsed "% Needs …" leaves the two indistinguishable.
    // Two lines cost ~16px of header once, which the row fit below accounts for;
    // in Country View's full-width panel there's room for one line and nothing
    // wraps at all. Same call the species table's long headers make (see
    // RedListView's SPECIES_TH_LABEL). The sort caret and filter icon sit beside
    // the label in a flex rather than trailing its last word, so they stay put
    // however the text breaks.
    <th
      className={`font-medium text-zinc-500 dark:text-zinc-400 cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-200 ${dense ? "text-xs px-2 py-1" : "text-sm px-3 py-2"} ${align === "left" ? "text-left" : "text-right"} ${widthClass ?? ""}`}
      onClick={onClick}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <span className={`flex items-center gap-0.5 ${align === "left" ? "justify-start" : "justify-end"}`}>
        <span className="leading-tight break-words min-w-0">{label}</span>
        <span className="w-3 shrink-0 text-zinc-400">{active ? (dir === "asc" ? "▲" : "▼") : ""}</span>
        {filterButton}
      </span>
    </th>
  );
}

// Filter icon for one numeric column — the convention most data-grid libraries
// use (AG Grid, Material-UI DataGrid, Ant Design's Table) for keeping a
// column's own controls out of a permanent row: an icon in the header that's
// tinted when a filter's actually active, opening a small min/max popover on
// click instead of taking up space at rest. stopPropagation so clicking it
// doesn't also trigger the header's onClick (sort).
function FilterIconButton({
  active,
  isOpen,
  onClick,
}: {
  active: boolean;
  isOpen: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={`ml-1 p-0.5 rounded align-middle transition-colors ${
        active
          ? "text-blue-600 dark:text-blue-400"
          : isOpen
          ? "text-zinc-600 dark:text-zinc-300"
          : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
      }`}
      title="Filter"
      aria-label="Filter this column"
    >
      <FaFilter size={11} />
    </button>
  );
}

/**
 * Sortable table alternative to WorldMap's choropleth — same data (CountryStats),
 * same onCountrySelect click-through behavior, for users who'd rather scan/sort a
 * list than read a map (requested alongside the country-view landing page, but
 * useful independently of it — see WorldMap.tsx's Map/List toggle).
 */
// Stable empty default: an inline [] would be a fresh array every render and
// would bust the regionCodes memo below on each one.
const EMPTY_REGIONS: string[] = [];

export default function CountryStatsList({
  stats,
  selectedCountries,
  onCountrySelect,
  speciesLabel = "# Assessed",
  showOutdatedMode = true,
  regionsFilter = EMPTY_REGIONS,
  sortKey: controlledSortKey,
  sortDir: controlledSortDir,
  onSortChange,
}: CountryStatsListProps) {
  const [localSortKey, setLocalSortKey] = useState<SortKey>("species");
  const [localSortDir, setLocalSortDir] = useState<SortDir>("desc");
  const sortKey = controlledSortKey ?? localSortKey;
  const sortDir = controlledSortDir ?? localSortDir;
  const [page, setPage] = useState(0);

  // Per-column min/max — local only (not URL-synced like sort), same as the
  // map's own search/zoom state; narrowing the list this way is a scratch
  // exploration, not something worth making a shareable link out of.
  const [speciesFilter, setSpeciesFilter] = useState<RangeFilter>(EMPTY_RANGE);
  const [outdatedFilter, setOutdatedFilter] = useState<RangeFilter>(EMPTY_RANGE);
  const [percentOutdatedFilter, setPercentOutdatedFilter] = useState<RangeFilter>(EMPTY_RANGE);

  // Which column's filter popover is open (at most one at a time) + where to
  // portal it — computed from the clicked icon's own bounding rect, same
  // "fixed + getBoundingClientRect" pattern TaxaSummary's column-toggle menu
  // uses, so it escapes this table's own overflow-auto/table-fixed clipping.
  const [openFilterKey, setOpenFilterKey] = useState<FilterKey | null>(null);
  const [filterMenuPos, setFilterMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const filterMenuRef = useRef<HTMLDivElement>(null);

  const filterConfigs: Record<FilterKey, { value: RangeFilter; onChange: (next: RangeFilter) => void }> = {
    species: { value: speciesFilter, onChange: setSpeciesFilter },
    outdated: { value: outdatedFilter, onChange: setOutdatedFilter },
    percentOutdated: { value: percentOutdatedFilter, onChange: setPercentOutdatedFilter },
  };

  function toggleFilterMenu(key: FilterKey, e: React.MouseEvent<HTMLButtonElement>) {
    if (openFilterKey === key) {
      setOpenFilterKey(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setFilterMenuPos({ top: rect.bottom + 4, left: Math.max(4, rect.right - 150) });
    setOpenFilterKey(key);
  }

  // Close the filter popover on outside click — same pattern as TaxaSummary's
  // column-toggle menu / WorldMap's search dropdown.
  useEffect(() => {
    if (!openFilterKey) return;
    const handler = (e: MouseEvent) => {
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
        setOpenFilterKey(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openFilterKey]);

  // Rows per page + text scale, both read off the box this list is given (see
  // the constants above). The scroll viewport's own height comes from the
  // absolutely-filled parent minus the pagination footer — never from the rows
  // inside it — so measuring here can't feed back into what it measures.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ rows: number; dense: boolean }>({ rows: MIN_ROWS, dense: false });
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientHeight;
      if (avail <= 0) return; // hidden (display:none) — keep the last real fit
      const dense = avail < DENSE_MAX_HEIGHT;
      const headH = el.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      // The rendered row is the honest height (padding, border, whatever the
      // text wraps to); the constants only stand in before the first paint, and
      // for the "No data" row, which is nothing like a real one.
      const rowH =
        el.querySelector("tbody tr[data-country-row]")?.getBoundingClientRect().height ||
        (dense ? DENSE_ROW_H : ROW_H);
      const rows = Math.max(MIN_ROWS, Math.floor((avail - headH) / rowH));
      setFit(prev => (prev.rows === rows && prev.dense === dense ? prev : { rows, dense }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // fit.dense re-measures once the compact scale has actually rendered (the
    // viewport's own height doesn't change, so the observer wouldn't fire);
    // the column set changes the header's height by changing where it wraps.
  }, [fit.dense, showOutdatedMode, speciesLabel]);
  const pageSize = fit.rows;
  const dense = fit.dense;

  const regionCodes = useMemo(
    () => (regionsFilter.length
      ? new Set(regionsFilter.flatMap((r) => iucnRegionCountries(r)))
      : null),
    [regionsFilter]
  );

  const rows = useMemo(() => {
    return Object.entries(stats)
      .filter(([code, s]) => s.species > 0 && (!regionCodes || regionCodes.has(code)))
      .map(([code, s]) => ({
        code,
        name: ALPHA2_TO_NAME[code] ?? code,
        species: s.species,
        outdated: s.outdated ?? 0,
        percentOutdated: percentOutdatedOf(s.species, s.outdated ?? 0),
      }));
  }, [stats, regionCodes]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) =>
      inRange(r.species, speciesFilter) &&
      (!showOutdatedMode || (inRange(r.outdated, outdatedFilter) && inRange(r.percentOutdated, percentOutdatedFilter)))
    );
  }, [rows, speciesFilter, outdatedFilter, percentOutdatedFilter, showOutdatedMode]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filteredRows].sort((a, b) =>
      sortKey === "name" ? dir * a.name.localeCompare(b.name) : dir * (a[sortKey] - b[sortKey])
    );
  }, [filteredRows, sortKey, sortDir]);

  // Back to page 1 whenever the sort, filters, or the underlying row set
  // changes — otherwise switching sort/region/filters could strand the view
  // on a now-empty page. Adjusted during render (React's documented
  // alternative to an effect that just resets state) via a second piece of
  // state, not a ref — this project's lint rules disallow mutating a ref
  // during render.
  const resetKey = `${sortKey}|${sortDir}|${regionsFilter.join(",")}|${filteredRows.length}|${speciesFilter.min}|${speciesFilter.max}|${outdatedFilter.min}|${outdatedFilter.max}|${percentOutdatedFilter.min}|${percentOutdatedFilter.max}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setPage(0);
  }

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      const dir = sortDir === "asc" ? "desc" : "asc";
      if (onSortChange) onSortChange(key, dir);
      else setLocalSortDir(dir);
    } else {
      const dir = key === "name" ? "asc" : "desc";
      if (onSortChange) onSortChange(key, dir);
      else { setLocalSortKey(key); setLocalSortDir(dir); }
    }
  }

  const openFilterConfig = openFilterKey ? filterConfigs[openFilterKey] : null;
  const cellPad = dense ? "px-2 py-1" : "px-3 py-2";

  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div ref={viewportRef} className="flex-1 min-h-0 overflow-auto">
        {/* table-fixed + explicit column-width shares (rather than auto/content-based
            sizing) so the Country column truncates instead of wrapping long names
            ("United States of America") across multiple lines, whatever width this
            ends up at. The text scale follows the height on offer (see `fit`
            above): text-sm/py-2 in Country View's full-height panel, where
            micro-text reads as cramped, and the compact scale in the Country
            filter card, where it's the difference between showing three
            countries and showing seven. Min/max filters live behind each numeric
            header's filter icon (see FilterIconButton) rather than a permanent
            row, to keep the header compact regardless of available height. */}
        <table className={`w-full table-fixed border-collapse ${dense ? "text-xs" : "text-sm"}`}>
          <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 z-10">
            <tr>
              <SortHeader label="Country" active={sortKey === "name"} dir={sortDir} align="left" dense={dense} widthClass={showOutdatedMode ? "w-[28%]" : "w-1/2"} onClick={() => toggleSort("name")} />
              <SortHeader
                label={speciesLabel}
                active={sortKey === "species"}
                dir={sortDir}
                dense={dense}
                widthClass={showOutdatedMode ? "w-[24%]" : "w-1/2"}
                onClick={() => toggleSort("species")}
                filterButton={
                  <FilterIconButton
                    active={speciesFilter.min !== "" || speciesFilter.max !== ""}
                    isOpen={openFilterKey === "species"}
                    onClick={(e) => toggleFilterMenu("species", e)}
                  />
                }
              />
              {showOutdatedMode && (
                <SortHeader
                  label="# Needs Updating"
                  active={sortKey === "outdated"}
                  dir={sortDir}
                  dense={dense}
                  widthClass="w-[24%]"
                  onClick={() => toggleSort("outdated")}
                  filterButton={
                    <FilterIconButton
                      active={outdatedFilter.min !== "" || outdatedFilter.max !== ""}
                      isOpen={openFilterKey === "outdated"}
                      onClick={(e) => toggleFilterMenu("outdated", e)}
                    />
                  }
                />
              )}
              {showOutdatedMode && (
                <SortHeader
                  label="% Needs Updating"
                  active={sortKey === "percentOutdated"}
                  dir={sortDir}
                  dense={dense}
                  widthClass="w-[24%]"
                  onClick={() => toggleSort("percentOutdated")}
                  filterButton={
                    <FilterIconButton
                      active={percentOutdatedFilter.min !== "" || percentOutdatedFilter.max !== ""}
                      isOpen={openFilterKey === "percentOutdated"}
                      onClick={(e) => toggleFilterMenu("percentOutdated", e)}
                    />
                  }
                />
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const isSelected = selectedCountries.has(row.code);
              return (
                <tr
                  key={row.code}
                  data-country-row=""
                  onClick={(e) => onCountrySelect(row.code, row.name, e)}
                  className={`cursor-pointer border-b border-zinc-100 dark:border-zinc-800/50 last:border-0 ${
                    isSelected ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <td className={`${cellPad} text-zinc-700 dark:text-zinc-300 max-w-0`}>
                    <span className="block truncate" title={row.name}>{row.name}</span>
                  </td>
                  <td className={`${cellPad} text-right tabular-nums text-zinc-700 dark:text-zinc-300 whitespace-nowrap`}>{row.species.toLocaleString()}</td>
                  {showOutdatedMode && (
                    <td className={`${cellPad} text-right tabular-nums text-zinc-700 dark:text-zinc-300 whitespace-nowrap`}>{row.outdated.toLocaleString()}</td>
                  )}
                  {showOutdatedMode && (
                    <td className={`${cellPad} text-right tabular-nums text-zinc-700 dark:text-zinc-300 whitespace-nowrap`}>{row.percentOutdated.toFixed(1)}%</td>
                  )}
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={showOutdatedMode ? 4 : 2} className="px-2 py-8 text-center text-zinc-400 text-sm">
                  No data
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {sorted.length > 0 && (
        // Everything sits at the right end, leaving the footer's left for
        // WorldMap's floating Map/List toggle — it overlays bottom-left of
        // whichever view is showing (absolutely positioned against the shared
        // wrapper, not this component), which is exactly where the row count
        // used to be. The toggle used to be cleared by a 44px bottom margin
        // instead — affordable when the list could grow the card, but a seventh
        // of the Country filter card's height, i.e. two more countries on
        // screen, now that it can't.
        <div className={`flex items-center justify-end gap-3 px-3 py-1.5 border-t border-zinc-200 dark:border-zinc-800 shrink-0 text-zinc-500 dark:text-zinc-400 ${dense ? "text-xs" : "text-sm"}`}>
          <span>
            {clampedPage * pageSize + 1}–{Math.min((clampedPage + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
              className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              Prev
            </button>
            <span className="tabular-nums">{clampedPage + 1} / {pageCount}</span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={clampedPage >= pageCount - 1}
              className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              Next
            </button>
          </div>
        </div>
      )}
      {openFilterKey && openFilterConfig && typeof document !== "undefined" && createPortal(
        <div
          ref={filterMenuRef}
          className="fixed z-[9999] flex items-center gap-1 p-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg"
          style={{ top: filterMenuPos.top, left: filterMenuPos.left }}
        >
          <input
            type="number"
            inputMode="decimal"
            value={openFilterConfig.value.min}
            onChange={(e) => openFilterConfig.onChange({ ...openFilterConfig.value, min: e.target.value })}
            placeholder="min"
            aria-label="Minimum"
            autoFocus
            className="w-16 text-xs px-1.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="text-zinc-400 dark:text-zinc-500">–</span>
          <input
            type="number"
            inputMode="decimal"
            value={openFilterConfig.value.max}
            onChange={(e) => openFilterConfig.onChange({ ...openFilterConfig.value, max: e.target.value })}
            placeholder="max"
            aria-label="Maximum"
            className="w-16 text-xs px-1.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>,
        document.body
      )}
    </div>
  );
}
