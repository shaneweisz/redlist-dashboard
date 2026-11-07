"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { CHART_SEARCH_CLASS, CHART_SEARCH_INPUT_CLASS, CHART_SELECT_CLASS, ChartPager } from "./chart-controls";

const FilterBarChart = dynamic(
  () => import("./FilterBarChart"),
  { ssr: false, loading: () => <div className="h-full animate-pulse bg-zinc-200 dark:bg-zinc-800 rounded" /> }
);

type ChartEntry = { code: string; count: number; label: string };
export type ViewMode = "assessors" | "reviewers" | "facilitators" | "contributors" | "institutions";

/** Menu order, label and bar colour for each credit type the chart can show. */
export const MODES: ReadonlyArray<{ mode: ViewMode; label: string; color: string }> = [
  { mode: "assessors", label: "Assessors", color: "#8b5cf6" },
  { mode: "reviewers", label: "Reviewers", color: "#818cf8" },
  // Facilitators: the individuals behind an organisational assessor (all bird
  // assessments are assessed by "BirdLife International").
  { mode: "facilitators", label: "Facilitators", color: "#2dd4bf" },
  // Contributors: credited without being assessor or reviewer — by far the
  // longest credit line (~8.5 names per assessment against ~2 for the others).
  { mode: "contributors", label: "Contributors", color: "#f59e0b" },
  // Institutions: the organisation(s) behind the assessment. Only ~155 distinct
  // values Red-List-wide, so this one is short enough to page through.
  { mode: "institutions", label: "Institutions", color: "#38bdf8" },
];

const MODE_LABEL: Record<ViewMode, string> =
  Object.fromEntries(MODES.map((m) => [m.mode, m.label])) as Record<ViewMode, string>;

interface AssessorChartProps {
  /**
   * Counts for the ACTIVE mode only. The parent builds one chart, not five —
   * each one is a full pass over the filtered species (parsing every credit
   * name), and only the selected mode is ever on screen.
   */
  data: ChartEntry[];
  /** The selected items for the currently active tab */
  selectedItems: Set<string>;
  onBarClick: (data: { payload?: { code?: string } }, event: React.MouseEvent) => void;
  /** Shift+drag across the bars to select everyone swept over */
  onRangeSelect?: (codes: string[], event: MouseEvent | React.MouseEvent) => void;
  onItemToggle: (code: string) => void;
  loading?: boolean;
  viewMode: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  /** When false, render a static title instead of the Assessors/Reviewers toggle. */
  showToggle?: boolean;
  /** Title shown when showToggle is false. */
  title?: string;
}

const PAGE_SIZE = 10;

export default function AssessorChart({
  data,
  selectedItems,
  onBarClick,
  onRangeSelect,
  onItemToggle,
  loading,
  viewMode,
  onViewModeChange,
  showToggle = true,
  title,
}: AssessorChartProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [searchPage, setSearchPage] = useState(0);

  const activeData = data;
  const activeLabel = MODE_LABEL[viewMode].toLowerCase();
  const activeColor = MODES.find(m => m.mode === viewMode)!.color;
  // Person names ("Rutherford, C.A.") fit the default axis; organisation names
  // ("Botanic Gardens Conservation International") do not, and at the person-name
  // width every institution truncates to an ellipsis, making the axis unreadable.
  // Give that one mode a wider axis and a longer cap.
  const isInstitutions = viewMode === "institutions";
  const yAxisWidth = isInstitutions ? 230 : 150;
  const yAxisTickMaxLength = isInstitutions ? 36 : 22;

  // Global max for consistent bar scaling across pages
  const globalMax = activeData.length > 0 ? activeData[0].count : 0;

  const totalPages = Math.ceil(activeData.length / PAGE_SIZE);
  const paginated = activeData.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Search results: filtered + sorted desc by count
  const searchResults = useMemo(() => {
    if (!search) return [];
    const q = search.toLowerCase();
    return activeData.filter(r => r.code.toLowerCase().includes(q));
  }, [activeData, search]);

  const searchTotalPages = Math.ceil(searchResults.length / PAGE_SIZE);
  const paginatedSearchResults = searchResults.slice(searchPage * PAGE_SIZE, (searchPage + 1) * PAGE_SIZE);

  // Reset pages when search changes
  const handleSearchChange = (value: string) => {
    setSearch(value);
    setSearchPage(0);
    if (!value) setPage(0);
  };

  // Reset search and pages when toggling view mode
  const handleViewModeChange = (mode: ViewMode) => {
    onViewModeChange?.(mode);
    setSearch("");
    setPage(0);
    setSearchPage(0);
  };

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
      <div className="flex items-center gap-2 mb-1.5">
        {showToggle ? (
          /* Credit-type picker. A segmented control fitted three modes beside the
             search box; at five it no longer fits, so this is a select. */
          <select
            value={viewMode}
            onChange={(e) => handleViewModeChange(e.target.value as ViewMode)}
            aria-label="Credit type"
            className={`shrink-0 ${CHART_SELECT_CLASS}`}
          >
            {MODES.map(({ mode, label }) => (
              <option key={mode} value={mode}>{label}</option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0">{title}</span>
        )}

        {/* Search input, in the header row alongside the toggle */}
        <div className={`flex-1 min-w-0 ${CHART_SEARCH_CLASS}`}>
          <svg className="w-3 h-3 text-zinc-400 shrink-0 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={`Search ${activeLabel}...`}
            className={`flex-1 ${CHART_SEARCH_INPUT_CLASS}`}
          />
          {search && (
            <div className="shrink-0 flex items-center gap-1 text-[10px] text-zinc-400">
              <span>{searchResults.length} result{searchResults.length !== 1 ? "s" : ""}</span>
              <button
                onClick={() => handleSearchChange("")}
                className="rounded hover:bg-zinc-200 dark:hover:bg-zinc-700"
                title="Clear search"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ height: 240 }} className="flex items-center justify-center">
        {loading ? (
          <svg
            className="animate-spin h-5 w-5 text-zinc-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : search ? (
          // Search results: simple list view
          <div className="w-full h-full">
            {paginatedSearchResults.length > 0 ? (
              <div className="space-y-0.5">
                {paginatedSearchResults.map((entry) => {
                  const isSelected = selectedItems.has(entry.code);
                  return (
                    <button
                      key={entry.code}
                      onClick={() => onItemToggle(entry.code)}
                      className={`w-full flex items-center justify-between px-2 py-1 rounded text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors ${
                        isSelected
                          ? "bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300"
                          : "text-zinc-700 dark:text-zinc-300"
                      }`}
                    >
                      <span className="truncate mr-2">{entry.code}</span>
                      <span className="text-zinc-400 tabular-nums flex-shrink-0">{entry.count.toLocaleString()}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="text-xs text-zinc-400">No matching {activeLabel}</span>
            )}
          </div>
        ) : paginated.length > 0 ? (
          <FilterBarChart
            // Remount when the axis geometry changes: recharts lays the Y axis
            // out once and ignores a later width prop on the same instance, so
            // without this the institutions axis keeps the person-name width and
            // its longer labels run under the bars.
            key={isInstitutions ? "institutions" : "names"}
            data={paginated}
            dataKey="code"
            selectedItems={selectedItems}
            onBarClick={onBarClick}
            onRangeSelect={onRangeSelect}
            barColor={activeColor}
            yAxisWidth={yAxisWidth}
            leftMargin={-30}
            rightMargin={55}
            xAxisMax={globalMax}
            labelFormatter={(name) => name}
            yAxisTickMaxLength={yAxisTickMaxLength}
          />
        ) : (
          <span className="text-xs text-zinc-400">No {activeLabel} data</span>
        )}
      </div>

      {/* Pagination */}
      {(() => {
        const activePage = search ? searchPage : page;
        const activeTotal = search ? searchResults.length : activeData.length;
        const activePages = search ? searchTotalPages : totalPages;
        const setActivePage = search ? setSearchPage : setPage;
        if (activePages <= 1) return null;
        return (
          <div className="flex justify-center mt-1">
            <ChartPager
              label={`${(activePage * PAGE_SIZE + 1).toLocaleString()}–${Math.min((activePage + 1) * PAGE_SIZE, activeTotal).toLocaleString()} of ${activeTotal.toLocaleString()}`}
              canPrev={activePage > 0}
              canNext={activePage < activePages - 1}
              onPrev={() => setActivePage(p => Math.max(0, p - 1))}
              onNext={() => setActivePage(p => Math.min(activePages - 1, p + 1))}
              noun={activeLabel}
            />
          </div>
        );
      })()}
    </div>
  );
}
