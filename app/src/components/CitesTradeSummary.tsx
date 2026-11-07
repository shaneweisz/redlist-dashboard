"use client";

import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import dynamic from "next/dynamic";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { countryName, fmtQty } from "./cites-utils";
import { CHART_INPUT_CLASS, CHART_SELECT_CLASS, ChartPager } from "@/components/redlist/chart-controls";
import type { CountryAnnotation, TradeFlow } from "./TradeFlowMap";

const TradeFlowMap = dynamic(() => import("./TradeFlowMap"), { ssr: false });

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CompactRecord {
  y: number;
  s: string;
  p: string;
  t: string;
  u: string; // unit ("" = unit-less)
  q: number;
  e: string;
  i: string;
  o: string; // origin (re-export) — "" when same as exporter
}

interface YearData {
  year: number;
  quantity: number;
  records: number;
}

interface CodedData {
  code: string;
  label: string;
  records: number;
}

interface TermCount {
  term: string;
  records: number;
}

interface TermUnitData {
  term: string;
  unit: string;
  records: number;
  quantity: number;
}

interface CountryData {
  code: string;
  records: number;
  quantity: number;
}

interface TradeData {
  found: boolean;
  taxonId: string;
  totalRecords: number;
  yearRange: [number, number];
  byYear: YearData[];
  topPurposes: CodedData[];
  topSources: CodedData[];
  topExporters: CountryData[];
  topImporters: CountryData[];
  topFlows?: TradeFlow[];
  shipments?: CompactRecord[];
  allSources?: CodedData[];
  allPurposes?: CodedData[];
  allTerms?: TermCount[];
  allTermsByUnit?: TermUnitData[];
}

// Sources that indicate wild take — key concern for assessors
const WILD_SOURCE_CODES = new Set(["W", "X", "R", "U"]);

const SOURCE_LABELS: Record<string, string> = {
  A: "Artificially propagated",
  C: "Captive-bred",
  D: "Appendix I captive-bred",
  F: "F1 captive-born",
  I: "Confiscated/seized",
  O: "Pre-Convention",
  R: "Ranched",
  U: "Unknown",
  W: "Wild",
  X: "Marine",
};

const PURPOSE_LABELS: Record<string, string> = {
  B: "Breeding in captivity",
  E: "Educational",
  G: "Botanical garden",
  H: "Hunting trophy",
  L: "Law enforcement",
  M: "Medical/biomedical",
  N: "Reintroduction",
  P: "Personal",
  Q: "Circus/exhibition",
  S: "Scientific",
  T: "Commercial",
  Z: "Zoo",
};

/**
 * Number of most-recent calendar years to treat as "provisional". CITES annual
 * reports for year Y aren't due until 31 Oct of Y+1 and many Parties run years
 * behind, so the most recent years are always under-reported. We draw them
 * dashed + caption them rather than letting the line mislead readers into
 * thinking trade collapsed.
 */
const PROVISIONAL_YEARS = 3;

/** Stable key for a term+unit combination. */
function termUnitKey(term: string, unit: string): string {
  return `${term}|${unit}`;
}

/**
 * "Isolate" a category within a filter dimension: clicking a bar selects only
 * that one. Clicking the already-isolated category resets the dimension to all
 * (so a second click un-filters). Returns the next checked-state map.
 */
function isolateState(
  prev: Record<string, boolean>,
  allKeys: string[],
  key: string
): Record<string, boolean> {
  const onlyThis = allKeys.every((k) =>
    k === key ? prev[k] !== false : prev[k] === false
  );
  const next: Record<string, boolean> = {};
  for (const k of allKeys) next[k] = onlyThis ? true : k === key;
  return next;
}

/* ------------------------------------------------------------------ */
/*  Aggregation                                                        */
/* ------------------------------------------------------------------ */

interface Aggregated {
  totalRecords: number;
  byYear: YearData[];
  topSources: CodedData[];
  topPurposes: CodedData[];
  topExporters: CountryData[];
  topImporters: CountryData[];
  topFlows: TradeFlow[];
  reExportFlows: TradeFlow[];
  termsByUnit: TermUnitData[];
}

/** Aggregate a set of compact shipment records into the derived views. */
function aggregateShipments(rows: CompactRecord[]): Aggregated {
  const yearMap = new Map<number, { quantity: number; records: number }>();
  const sourceMap = new Map<string, number>();
  const purposeMap = new Map<string, number>();
  const exporterMap = new Map<string, { records: number; quantity: number }>();
  const importerMap = new Map<string, { records: number; quantity: number }>();
  const flowMap = new Map<string, { records: number; quantity: number }>();
  const reExportMap = new Map<string, { records: number; quantity: number }>();
  const termUnitMap = new Map<string, TermUnitData>();

  for (const r of rows) {
    const yEntry = yearMap.get(r.y) || { quantity: 0, records: 0 };
    yEntry.records++;
    yEntry.quantity += r.q;
    yearMap.set(r.y, yEntry);

    // Count blanks too, under code "" → "Unspecified", so they're filterable.
    sourceMap.set(r.s, (sourceMap.get(r.s) || 0) + 1);
    purposeMap.set(r.p, (purposeMap.get(r.p) || 0) + 1);

    if (r.e) {
      const e = exporterMap.get(r.e) || { records: 0, quantity: 0 };
      e.records++;
      e.quantity += r.q;
      exporterMap.set(r.e, e);
    }
    if (r.i) {
      const e = importerMap.get(r.i) || { records: 0, quantity: 0 };
      e.records++;
      e.quantity += r.q;
      importerMap.set(r.i, e);
    }
    if (r.e && r.i) {
      const key = `${r.e}->${r.i}`;
      const e = flowMap.get(key) || { records: 0, quantity: 0 };
      e.records++;
      e.quantity += r.q;
      flowMap.set(key, e);
    }
    // Re-export leg: where specimens originated (origin) before the exporter
    if (r.o && r.e) {
      const key = `${r.o}->${r.e}`;
      const e = reExportMap.get(key) || { records: 0, quantity: 0 };
      e.records++;
      e.quantity += r.q;
      reExportMap.set(key, e);
    }

    const tuKey = termUnitKey(r.t, r.u);
    const tu = termUnitMap.get(tuKey) || {
      term: r.t,
      unit: r.u,
      records: 0,
      quantity: 0,
    };
    tu.records++;
    tu.quantity += r.q;
    termUnitMap.set(tuKey, tu);
  }

  const byYear = Array.from(yearMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, v]) => ({ year, ...v }));

  const topSources = Array.from(sourceMap.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([code, records]) => ({
      code,
      label: code === "" ? "Unspecified" : SOURCE_LABELS[code] || code,
      records,
    }));

  const topPurposes = Array.from(purposeMap.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([code, records]) => ({
      code,
      label: code === "" ? "Unspecified" : PURPOSE_LABELS[code] || code,
      records,
    }));

  // Full sorted lists (not capped): the map colours every country that traded,
  // and the lists slice for display. Capping here previously hid genuine
  // traders (e.g. Cameroon, rank 16) from the map until a filter promoted them.
  const topExporters = Array.from(exporterMap.entries())
    .sort(([, a], [, b]) => b.records - a.records)
    .map(([code, v]) => ({ code, ...v }));

  const topImporters = Array.from(importerMap.entries())
    .sort(([, a], [, b]) => b.records - a.records)
    .map(([code, v]) => ({ code, ...v }));

  // Full sorted flow lists (not capped here): the map applies a user-controlled
  // cap on how many of the top flows to draw via its "Flows shown" control, so
  // we hand it everything and let it slice. Flows stay sorted by record count so
  // slicing the top N keeps the largest.
  const topFlows = Array.from(flowMap.entries())
    .sort(([, a], [, b]) => b.records - a.records)
    .map(([key, v]) => {
      const [from, to] = key.split("->");
      return { from, to, ...v };
    });

  const reExportFlows = Array.from(reExportMap.entries())
    .sort(([, a], [, b]) => b.records - a.records)
    .map(([key, v]) => {
      const [from, to] = key.split("->");
      return { from, to, ...v };
    });

  const termsByUnit = Array.from(termUnitMap.values()).sort(
    (a, b) => b.records - a.records
  );

  return {
    totalRecords: rows.length,
    byYear,
    topSources,
    topPurposes,
    topExporters,
    topImporters,
    topFlows,
    reExportFlows,
    termsByUnit,
  };
}

/* ------------------------------------------------------------------ */
/*  Interactive filter bar chart                                        */
/* ------------------------------------------------------------------ */

interface FilterBar {
  /** Stable key passed back to onToggle (source/purpose code or term key). */
  key: string;
  label: string;
  sublabel?: string;
  records: number;
  /** Whether this category is currently included by the filter. */
  active: boolean;
  /** Tailwind classes for the bar fill. */
  barClass: string;
  /** Optional tooltip override (defaults to "label (sublabel) — N records"). */
  title?: string;
}

/** Rows shown per page in the paginated bar charts and country lists. */
const PAGE_SIZE = 5;

/** Prev / "x–y of N" / Next pager, shown only when there is more than one page. */
function Pager({
  page,
  total,
  onPage,
  pageSize = PAGE_SIZE,
}: {
  page: number;
  total: number;
  onPage: (p: number) => void;
  pageSize?: number;
}) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center mt-1">
      <ChartPager
        label={`${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} of ${total}`}
        canPrev={page > 0}
        canNext={page < totalPages - 1}
        onPrev={() => onPage(Math.max(0, page - 1))}
        onNext={() => onPage(Math.min(totalPages - 1, page + 1))}
      />
    </div>
  );
}

/**
 * A paginated horizontal bar chart that doubles as a cross-filter: clicking a
 * bar calls onToggle(key) to add/remove that category, and de-selected bars are
 * dimmed but stay visible so they can be toggled back on. Shows PAGE_SIZE rows
 * at a time with Prev/Next, and an optional search box (used by Commodity).
 */
function FilterBarChart({
  title,
  bars,
  onToggle,
  search,
  onSearchChange,
  searchPlaceholder,
  emptyHint,
}: {
  title: string;
  bars: FilterBar[];
  onToggle?: (key: string) => void;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyHint?: string;
}) {
  const [page, setPage] = useState(0);
  // Reset to the first page whenever the search term changes the result set
  // (adjusting state during render, per the React docs, rather than in an effect).
  const [prevSearch, setPrevSearch] = useState(search);
  if (search !== prevSearch) {
    setPrevSearch(search);
    setPage(0);
  }

  // Scale bars against the global max so widths stay comparable across pages.
  const max = bars.reduce((m, b) => Math.max(m, b.records), 0);
  const totalPages = Math.max(1, Math.ceil(bars.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageBars = bars.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="min-w-0">
      {/* Fixed-height header row so the bar lists in adjacent charts line up,
          whether or not a chart has an inline search box. */}
      <div className="flex items-center gap-2 mb-1.5 h-7">
        <h5 className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider shrink-0">
          {title}
        </h5>
        {onSearchChange && (
          <input
            type="text"
            value={search ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className={`ml-auto w-32 ${CHART_INPUT_CLASS}`}
          />
        )}
      </div>
      <div className="space-y-1">
        {pageBars.map((b) => {
          const pct = max > 0 ? (b.records / max) * 100 : 0;
          return (
            <div
              key={b.key}
              onClick={onToggle ? () => onToggle(b.key) : undefined}
              title={
                b.title ??
                `${b.label}${b.sublabel ? ` (${b.sublabel})` : ""} — ${b.records.toLocaleString()} records`
              }
              className={`flex items-center gap-2 text-xs select-none transition-opacity ${
                onToggle ? "cursor-pointer" : ""
              } ${b.active ? "" : "opacity-40"}`}
            >
              <span className="w-24 shrink-0 truncate capitalize text-zinc-700 dark:text-zinc-300">
                {b.label}
                {b.sublabel && (
                  <span className="text-zinc-400 dark:text-zinc-500 ml-1 normal-case">
                    {b.sublabel}
                  </span>
                )}
              </span>
              <div className="flex-1 h-3.5 bg-zinc-100 dark:bg-zinc-800 rounded overflow-hidden">
                <div
                  className={`h-full rounded ${b.barClass}`}
                  style={{ width: `${Math.max(pct, 1)}%` }}
                />
              </div>
              <span className="w-12 text-right text-zinc-500 dark:text-zinc-400 tabular-nums shrink-0">
                {b.records.toLocaleString()}
              </span>
            </div>
          );
        })}
        {bars.length === 0 && emptyHint && (
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
            {emptyHint}
          </span>
        )}
      </div>
      <Pager page={safePage} total={bars.length} onPage={setPage} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Trend line chart with draggable year-range trim handles            */
/* ------------------------------------------------------------------ */

interface ChartPoint {
  year: number;
  solid: number | null;
  prov: number | null;
}

function ChartTooltip({
  active,
  payload,
  label,
  metric,
  provisionalFromYear,
}: {
  active?: boolean;
  payload?: { value: number | null; dataKey: string }[];
  label?: number;
  metric: "records" | "quantity";
  provisionalFromYear: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload.find((p) => p.value != null);
  if (!point) return null;
  const isProvisional = label != null && label >= provisionalFromYear;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg text-xs px-2.5 py-1.5">
      <div className="text-zinc-400">{label}</div>
      <div className="text-white tabular-nums">
        {(point.value ?? 0).toLocaleString()}{" "}
        {metric === "records" ? "records" : "items"}
      </div>
      {isProvisional && (
        <div className="text-amber-400 text-[10px] mt-0.5">
          provisional
        </div>
      )}
    </div>
  );
}

function TrendLineChart({
  data,
  metric,
  minYear,
  maxYear,
  brush,
  onBrushChange,
  provisionalFromYear,
}: {
  data: YearData[];
  metric: "records" | "quantity";
  minYear: number;
  maxYear: number;
  brush: [number, number] | null;
  onBrushChange: (range: [number, number] | null) => void;
  provisionalFromYear: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<null | "start" | "end">(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Chart geometry must mirror the recharts margins + YAxis width below.
  const HEIGHT = 160;
  const PLOT_LEFT = 45; // YAxis width
  const PLOT_RIGHT_PAD = 10; // margin.right
  const TRACK_TOP = 4;
  const TRACK_BOTTOM = 132; // leave room for x-axis labels
  const plotRight = Math.max(PLOT_LEFT + 1, width - PLOT_RIGHT_PAD);
  const plotW = plotRight - PLOT_LEFT;
  const span = Math.max(1, maxYear - minYear);

  const xOf = useCallback(
    (year: number) => PLOT_LEFT + ((year - minYear) / span) * plotW,
    [minYear, span, plotW]
  );
  const yearOf = useCallback(
    (px: number) => {
      const clamped = Math.min(plotRight, Math.max(PLOT_LEFT, px));
      return Math.round(minYear + ((clamped - PLOT_LEFT) / plotW) * span);
    },
    [minYear, span, plotW, plotRight]
  );

  const start = brush ? brush[0] : minYear;
  const end = brush ? brush[1] : maxYear;

  // Build chart series: solid up to the last complete year, dashed beyond.
  const lastComplete = provisionalFromYear - 1;
  const lookup = new Map(data.map((d) => [d.year, d[metric]]));
  const chartData: ChartPoint[] = [];
  for (let y = minYear; y <= maxYear; y++) {
    const v = lookup.get(y) ?? 0;
    chartData.push({
      year: y,
      solid: y <= lastComplete ? v : null,
      // include the junction year so the dashed segment connects to the solid one
      prov: y >= lastComplete ? v : null,
    });
  }
  const hasProvisional = maxYear >= provisionalFromYear;

  function onHandleDown(which: "start" | "end") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = which;
      (e.target as Element).setPointerCapture(e.pointerId);
    };
  }
  function onHandleMove(e: React.PointerEvent) {
    if (!dragging.current || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const year = yearOf(e.clientX - rect.left);
    let nextStart = start;
    let nextEnd = end;
    if (dragging.current === "start") nextStart = Math.min(year, end);
    else nextEnd = Math.max(year, start);
    if (nextStart <= minYear && nextEnd >= maxYear) onBrushChange(null);
    else onBrushChange([nextStart, nextEnd]);
  }
  function onHandleUp() {
    dragging.current = null;
  }

  const startX = xOf(start);
  const endX = xOf(end);
  const active = brush !== null;

  return (
    <div ref={wrapRef} className="relative" style={{ touchAction: "none" }}>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <LineChart
          data={chartData}
          margin={{ top: 5, right: PLOT_RIGHT_PAD, left: 0, bottom: 5 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="currentColor"
            className="text-zinc-200 dark:text-zinc-700"
          />
          <XAxis
            dataKey="year"
            type="number"
            domain={[minYear, maxYear]}
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            width={PLOT_LEFT}
            tickFormatter={(v: number) => fmtQty(v)}
          />
          <Tooltip
            content={
              <ChartTooltip
                metric={metric}
                provisionalFromYear={provisionalFromYear}
              />
            }
          />
          <Line
            type="monotone"
            dataKey="solid"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#3b82f6", strokeWidth: 2, stroke: "#fff" }}
            connectNulls={false}
            isAnimationActive={false}
          />
          {hasProvisional && (
            <Line
              type="monotone"
              dataKey="prov"
              stroke="#3b82f6"
              strokeWidth={2}
              strokeDasharray="4 3"
              strokeOpacity={0.55}
              dot={false}
              activeDot={{ r: 4, fill: "#3b82f6", strokeWidth: 2, stroke: "#fff" }}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>

      {/* Trim overlay: dimmed regions outside the selected range + drag handles */}
      {width > 0 && (
        <svg
          ref={svgRef}
          className="absolute inset-0"
          width={width}
          height={HEIGHT}
          style={{ pointerEvents: "none" }}
        >
          {active && startX > PLOT_LEFT && (
            <rect
              x={PLOT_LEFT}
              y={TRACK_TOP}
              width={Math.max(0, startX - PLOT_LEFT)}
              height={TRACK_BOTTOM - TRACK_TOP}
              className="fill-zinc-400/15 dark:fill-zinc-900/40"
            />
          )}
          {active && endX < plotRight && (
            <rect
              x={endX}
              y={TRACK_TOP}
              width={Math.max(0, plotRight - endX)}
              height={TRACK_BOTTOM - TRACK_TOP}
              className="fill-zinc-400/15 dark:fill-zinc-900/40"
            />
          )}
          {/* Handles */}
          {[
            { which: "start" as const, x: startX },
            { which: "end" as const, x: endX },
          ].map(({ which, x }) => (
            <g
              key={which}
              transform={`translate(${x},0)`}
              style={{ cursor: "ew-resize", pointerEvents: "all" }}
              onPointerDown={onHandleDown(which)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
            >
              {/* wide invisible hit target */}
              <rect
                x={-7}
                y={TRACK_TOP}
                width={14}
                height={TRACK_BOTTOM - TRACK_TOP}
                fill="transparent"
              />
              <line
                x1={0}
                y1={TRACK_TOP}
                x2={0}
                y2={TRACK_BOTTOM}
                stroke="#3b82f6"
                strokeWidth={active ? 2 : 1.5}
                strokeOpacity={active ? 0.9 : 0.5}
              />
              <rect
                x={-3}
                y={TRACK_TOP}
                width={6}
                height={16}
                rx={2}
                fill="#3b82f6"
                fillOpacity={active ? 1 : 0.6}
              />
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Country table                                                      */
/* ------------------------------------------------------------------ */

function CountryTable({
  data,
  label,
  selected,
  onSelect,
  barClass,
}: {
  data: CountryData[];
  label: string;
  selected?: string | null;
  onSelect?: (code: string | null) => void;
  /** Tailwind classes for the (unselected) bar fill. */
  barClass: string;
}) {
  const [page, setPage] = useState(0);
  if (data.length === 0) return null;
  const sorted = [...data].sort((a, b) => b.records - a.records);
  // Scale bars against the global max so widths stay comparable across pages.
  const max = sorted.reduce((m, c) => Math.max(m, c.records), 0);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="min-w-0">
      <h5 className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-1">
        {label}
      </h5>
      <div className="space-y-1">
        {pageRows.map((c) => {
          const isSel = selected === c.code;
          const pct = max > 0 ? (c.records / max) * 100 : 0;
          return (
            <div
              key={c.code}
              onClick={onSelect ? () => onSelect(isSel ? null : c.code) : undefined}
              title={`${countryName(c.code)} — ${c.records.toLocaleString()} records`}
              className={`flex items-center gap-1.5 text-[11px] select-none ${
                onSelect ? "cursor-pointer" : ""
              }`}
            >
              <span
                className={`w-16 shrink-0 truncate ${
                  isSel
                    ? "text-amber-600 dark:text-amber-400 font-medium"
                    : "text-zinc-700 dark:text-zinc-300"
                }`}
              >
                {countryName(c.code)}
              </span>
              <div className="flex-1 h-3 bg-zinc-100 dark:bg-zinc-800 rounded overflow-hidden">
                <div
                  className={`h-full rounded ${
                    isSel ? "bg-amber-400 dark:bg-amber-500" : barClass
                  }`}
                  style={{ width: `${Math.max(pct, 1)}%` }}
                />
              </div>
              <span className="w-9 text-right text-zinc-500 dark:text-zinc-400 tabular-nums shrink-0">
                {c.records.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
      <Pager page={safePage} total={sorted.length} onPage={setPage} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Individual shipment records table                                  */
/* ------------------------------------------------------------------ */

/** Default rows shown per page in the individual-records table. */
const RECORDS_PAGE_SIZE = 5;

/** Page-size options offered in the individual-records table. */
const RECORDS_PAGE_SIZE_OPTIONS = [5, 10, 25, 50];

/**
 * A paginated table of the individual shipment records behind the summary,
 * reflecting every active filter. Sorted most-recent-first so the latest trade
 * is on top. Quantities follow the CITES guide (exporter-reported preferred);
 * a re-export origin, when present, is shown ahead of the exporter.
 */
function RecordsTable({ rows }: { rows: CompactRecord[] }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(RECORDS_PAGE_SIZE);
  if (rows.length === 0) return null;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = rows.slice(
    safePage * pageSize,
    safePage * pageSize + pageSize
  );

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <h5 className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
          Records{" "}
          <span className="text-zinc-400 dark:text-zinc-500 normal-case tabular-nums">
            ({rows.length.toLocaleString()})
          </span>
        </h5>
        <label className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
          <span>Rows</span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
            className={CHART_SELECT_CLASS}
          >
            {RECORDS_PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-x-auto">
        <table className="w-full text-[11px] whitespace-nowrap">
          <thead>
            <tr className="text-left text-zinc-400 dark:text-zinc-500 border-b border-zinc-100 dark:border-zinc-800">
              <th className="px-2.5 py-1 font-medium">Year</th>
              <th className="px-2.5 py-1 font-medium">Commodity</th>
              <th className="px-2.5 py-1 font-medium text-right">Qty</th>
              <th className="px-2.5 py-1 font-medium">Exporter &rarr; Importer</th>
              <th className="px-2.5 py-1 font-medium">Source</th>
              <th className="px-2.5 py-1 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr
                key={i}
                className="border-t first:border-t-0 border-zinc-100 dark:border-zinc-800"
              >
                <td className="px-2.5 py-1 tabular-nums text-zinc-600 dark:text-zinc-300">
                  {r.y}
                </td>
                <td className="px-2.5 py-1 text-zinc-700 dark:text-zinc-300 capitalize">
                  {r.t}
                  {r.u && (
                    <span className="text-zinc-400 dark:text-zinc-500 ml-1 normal-case">
                      {r.u}
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-1 text-right tabular-nums text-zinc-600 dark:text-zinc-300">
                  {r.q > 0 ? fmtQty(r.q) : "—"}
                </td>
                <td className="px-2.5 py-1 text-zinc-700 dark:text-zinc-300">
                  {r.o && (
                    <span title={`Origin ${countryName(r.o)}`}>
                      {countryName(r.o)}{" "}
                      <span className="text-zinc-400 dark:text-zinc-500">&rarr;</span>{" "}
                    </span>
                  )}
                  {r.e ? countryName(r.e) : "—"}{" "}
                  <span className="text-zinc-400 dark:text-zinc-500">&rarr;</span>{" "}
                  {r.i ? countryName(r.i) : "—"}
                </td>
                <td
                  className="px-2.5 py-1 text-zinc-500 dark:text-zinc-400"
                  title={r.s ? `${SOURCE_LABELS[r.s] || r.s} (${r.s})` : undefined}
                >
                  {r.s ? SOURCE_LABELS[r.s] || r.s : "—"}
                </td>
                <td
                  className="px-2.5 py-1 text-zinc-500 dark:text-zinc-400"
                  title={r.p ? `${PURPOSE_LABELS[r.p] || r.p} (${r.p})` : undefined}
                >
                  {r.p ? PURPOSE_LABELS[r.p] || r.p : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager
        page={safePage}
        total={rows.length}
        onPage={setPage}
        pageSize={pageSize}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export default function CitesTradeSummary({
  citesId,
  prefetchedData,
  prefetchedLoading,
  suspensionCountries,
  countryAnnotations,
}: {
  citesId: number;
  prefetchedData?: Record<string, unknown> | null;
  prefetchedLoading?: boolean;
  suspensionCountries?: Set<string>;
  countryAnnotations?: Record<string, CountryAnnotation>;
}) {
  const [ownData, setOwnData] = useState<TradeData | null>(null);
  const [ownLoading, setOwnLoading] = useState(
    !prefetchedData && prefetchedLoading === undefined
  );
  const [error, setError] = useState<string | null>(null);

  // Trend is always measured in shipment records. Quantities are NEVER plotted
  // as a single line because the CITES guide warns they cannot be aggregated
  // across incompatible units (kg, m, pieces, unit-less) — per-unit quantities
  // live in the Commodities table instead.
  const metric = "records" as const;

  // Filter state — all checked by default
  const [checkedSources, setCheckedSources] = useState<Record<string, boolean>>({});
  const [checkedPurposes, setCheckedPurposes] = useState<Record<string, boolean>>({});
  const [checkedTerms, setCheckedTerms] = useState<Record<string, boolean>>({});
  const [filtersInitialized, setFiltersInitialized] = useState(false);
  const [termSearch, setTermSearch] = useState("");

  // Year-range trim (null = full range)
  const [brush, setBrush] = useState<[number, number] | null>(null);

  // Country highlighted on the map (also set by clicking a Top exporters /
  // importers row). Filters the map's flows to that country.
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);

  // Use prefetched data from parent when available; fall back to own fetch
  const data = (prefetchedData as TradeData | null) ?? ownData;
  const loading = prefetchedLoading ?? ownLoading;

  useEffect(() => {
    if (prefetchedData !== undefined || prefetchedLoading !== undefined) return;

    let cancelled = false;

    async function fetchTrade() {
      setOwnLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/cites/trade?taxon_id=${citesId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        if (!cancelled) setOwnData(result);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled) setOwnLoading(false);
      }
    }

    fetchTrade();
    return () => {
      cancelled = true;
    };
  }, [citesId, prefetchedData, prefetchedLoading]);

  // Source / purpose category universes derived from the records, INCLUDING the
  // blank "" ("Unspecified") category, so it gets initialised and is isolatable.
  const allSourceCodes = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.shipments ?? []) set.add(r.s);
    return Array.from(set);
  }, [data]);
  const allPurposeCodes = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.shipments ?? []) set.add(r.p);
    return Array.from(set);
  }, [data]);

  // Initialize filter checkboxes when data arrives
  useEffect(() => {
    if (!data || !data.found || filtersInitialized) return;

    if (allSourceCodes.length > 0) {
      const init: Record<string, boolean> = {};
      for (const c of allSourceCodes) init[c] = true;
      setCheckedSources(init);
    }
    if (allPurposeCodes.length > 0) {
      const init: Record<string, boolean> = {};
      for (const c of allPurposeCodes) init[c] = true;
      setCheckedPurposes(init);
    }
    if (data.allTermsByUnit) {
      const init: Record<string, boolean> = {};
      for (const t of data.allTermsByUnit) init[termUnitKey(t.term, t.unit)] = true;
      setCheckedTerms(init);
    }
    setFiltersInitialized(true);
  }, [data, filtersInitialized, allSourceCodes, allPurposeCodes]);

  // Clicking a bar isolates that category (selects only it); clicking the
  // already-isolated one resets the dimension to all.
  const isolateSource = useCallback(
    (code: string) => {
      setCheckedSources((prev) => isolateState(prev, allSourceCodes, code));
    },
    [allSourceCodes]
  );
  const isolatePurpose = useCallback(
    (code: string) => {
      setCheckedPurposes((prev) => isolateState(prev, allPurposeCodes, code));
    },
    [allPurposeCodes]
  );
  const isolateTerm = useCallback(
    (key: string) => {
      const keys = (data?.allTermsByUnit ?? []).map((t) =>
        termUnitKey(t.term, t.unit)
      );
      setCheckedTerms((prev) => isolateState(prev, keys, key));
    },
    [data]
  );

  // Whether a dimension is actively filtered (some category de-selected). When
  // it is, rows with a *blank* value for that dimension are excluded too —
  // otherwise isolating e.g. "Hunting trophy" would also keep the ~10.9k
  // blank-purpose elephant records (source/purpose can be blank; term can't).
  const anySourceOff = useMemo(
    () => Object.values(checkedSources).some((v) => v === false),
    [checkedSources]
  );
  const anyPurposeOff = useMemo(
    () => Object.values(checkedPurposes).some((v) => v === false),
    [checkedPurposes]
  );

  // Are any filters active (something unchecked, or a year range trimmed)?
  const hasActiveFilters = useMemo(() => {
    const anyTermOff = Object.values(checkedTerms).some((v) => v === false);
    return (
      anySourceOff ||
      anyPurposeOff ||
      anyTermOff ||
      brush !== null ||
      selectedCountry !== null
    );
  }, [anySourceOff, anyPurposeOff, checkedTerms, brush, selectedCountry]);

  // Clear all filters (re-check everything, reset the year trim)
  const clearFilters = useCallback(() => {
    setCheckedSources((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) next[k] = true;
      return next;
    });
    setCheckedPurposes((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) next[k] = true;
      return next;
    });
    setCheckedTerms((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) next[k] = true;
      return next;
    });
    setBrush(null);
    setTermSearch("");
    setSelectedCountry(null);
  }, []);

  // Records passing the active filters (all years) — drives the chart line.
  // A selected country acts as an extra cross-filter: keep only its trade
  // (as exporter or importer).
  const checkboxRows = useMemo(() => {
    if (!data?.found || !data.shipments) return [];
    return data.shipments.filter((r) => {
      if (checkedSources[r.s] === false) return false;
      if (checkedPurposes[r.p] === false) return false;
      if (checkedTerms[termUnitKey(r.t, r.u)] === false) return false;
      if (selectedCountry && r.e !== selectedCountry && r.i !== selectedCountry)
        return false;
      return true;
    });
  }, [data, checkedSources, checkedPurposes, checkedTerms, selectedCountry]);

  // Chart series (all years, checkbox-filtered)
  const chartAgg = useMemo(() => aggregateShipments(checkboxRows), [checkboxRows]);

  // The individual records behind the summary: every active filter applied
  // (checkboxes, country, and the year-range trim), sorted most-recent-first
  // (largest quantity breaks ties) so the records table leads with recent trade.
  const displayRows = useMemo(() => {
    const rows = brush
      ? checkboxRows.filter((r) => r.y >= brush[0] && r.y <= brush[1])
      : checkboxRows;
    return [...rows].sort((a, b) => b.y - a.y || b.q - a.q);
  }, [checkboxRows, brush]);

  // Everything else also respects the year-range trim
  const display = useMemo(() => aggregateShipments(displayRows), [displayRows]);

  // Cross-filter views: each interactive chart aggregates rows passing every
  // active filter EXCEPT its own dimension, so its categories stay visible and
  // a click can toggle them back on (rather than vanishing once de-selected).
  const commodityChart = useMemo(() => {
    if (!data?.found || !data.shipments) return [];
    const rows = data.shipments.filter((r) => {
      if (checkedSources[r.s] === false) return false;
      if (checkedPurposes[r.p] === false) return false;
      if (brush && (r.y < brush[0] || r.y > brush[1])) return false;
      if (selectedCountry && r.e !== selectedCountry && r.i !== selectedCountry)
        return false;
      return true;
    });
    return aggregateShipments(rows).termsByUnit;
  }, [data, checkedSources, checkedPurposes, brush, selectedCountry]);

  const sourceChart = useMemo(() => {
    if (!data?.found || !data.shipments) return [];
    const rows = data.shipments.filter((r) => {
      if (checkedPurposes[r.p] === false) return false;
      if (checkedTerms[termUnitKey(r.t, r.u)] === false) return false;
      if (brush && (r.y < brush[0] || r.y > brush[1])) return false;
      if (selectedCountry && r.e !== selectedCountry && r.i !== selectedCountry)
        return false;
      return true;
    });
    return aggregateShipments(rows).topSources;
  }, [data, checkedPurposes, checkedTerms, brush, selectedCountry]);

  const purposeChart = useMemo(() => {
    if (!data?.found || !data.shipments) return [];
    const rows = data.shipments.filter((r) => {
      if (checkedSources[r.s] === false) return false;
      if (checkedTerms[termUnitKey(r.t, r.u)] === false) return false;
      if (brush && (r.y < brush[0] || r.y > brush[1])) return false;
      if (selectedCountry && r.e !== selectedCountry && r.i !== selectedCountry)
        return false;
      return true;
    });
    return aggregateShipments(rows).topPurposes;
  }, [data, checkedSources, checkedTerms, brush, selectedCountry]);

  // Exporter / importer aggregates that DON'T apply the country cross-filter, so
  // the Top exporters / importers lists stay populated and let you switch
  // country (the same "exclude your own dimension" rule the bar charts use).
  const countryAgg = useMemo(() => {
    if (!data?.found || !data.shipments) return null;
    const rows = data.shipments.filter((r) => {
      if (checkedSources[r.s] === false) return false;
      if (checkedPurposes[r.p] === false) return false;
      if (checkedTerms[termUnitKey(r.t, r.u)] === false) return false;
      if (brush && (r.y < brush[0] || r.y > brush[1])) return false;
      return true;
    });
    return aggregateShipments(rows);
  }, [data, checkedSources, checkedPurposes, checkedTerms, brush]);

  const hasShipments = !!data?.shipments && data.shipments.length > 0;

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500 py-3">
        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Loading trade data...
      </div>
    );
  }

  if (error || !data || !data.found) {
    return null;
  }

  const [minYear, maxYear] = data.yearRange;
  const currentYear = new Date().getFullYear();
  const provisionalFromYear = currentYear - PROVISIONAL_YEARS + 1;
  const effectiveRange: [number, number] = brush ?? data.yearRange;

  // Fall back to server-provided byYear when no shipments for client filtering
  const chartByYear =
    hasShipments && chartAgg.byYear.length > 0 ? chartAgg.byYear : data.byYear;
  // Full country lists (and the map's colour-by-role) use the country-excluded
  // aggregate so they stay global while a country is selected. The map colours
  // every trading country; the Top exporters/importers lists show the leaders.
  const displayExporters =
    hasShipments && countryAgg && countryAgg.topExporters.length > 0
      ? countryAgg.topExporters
      : data.topExporters;
  const displayImporters =
    hasShipments && countryAgg && countryAgg.topImporters.length > 0
      ? countryAgg.topImporters
      : data.topImporters;
  const tableExporters = displayExporters.slice(0, 15);
  const tableImporters = displayImporters.slice(0, 15);
  const displayFlows =
    hasShipments && display.topFlows.length > 0 ? display.topFlows : data.topFlows ?? [];

  // Build the three interactive filter charts. Source bars keep the
  // wild (amber) vs captive (emerald) distinction by colour.
  const sourceBars: FilterBar[] = sourceChart.map((s) => ({
    key: s.code,
    label: s.label,
    sublabel: s.code,
    records: s.records,
    active: checkedSources[s.code] !== false,
    barClass:
      s.code === ""
        ? "bg-zinc-400 dark:bg-zinc-500"
        : WILD_SOURCE_CODES.has(s.code)
          ? "bg-amber-400 dark:bg-amber-500"
          : "bg-emerald-300 dark:bg-emerald-600",
  }));

  const purposeBars: FilterBar[] = purposeChart.map((p) => ({
    key: p.code,
    label: p.label,
    sublabel: p.code,
    records: p.records,
    active: checkedPurposes[p.code] !== false,
    barClass: p.code === "" ? "bg-zinc-400 dark:bg-zinc-500" : "bg-blue-400 dark:bg-blue-500",
  }));

  const commoditySearch = termSearch.trim().toLowerCase();
  const commodityBars: FilterBar[] = commodityChart
    .filter((t) =>
      commoditySearch
        ? `${t.term} ${t.unit}`.toLowerCase().includes(commoditySearch)
        : true
    )
    .map((t) => {
      const key = termUnitKey(t.term, t.unit);
      return {
        key,
        label: t.term,
        sublabel: t.unit || undefined,
        records: t.records,
        active: checkedTerms[key] !== false,
        barClass: "bg-violet-400 dark:bg-violet-500",
        title: `${t.term}${t.unit ? ` (${t.unit})` : ""} — ${t.records.toLocaleString()} records / ${fmtQty(t.quantity)} ${t.unit || "items"}`,
      };
    });

  const hasFilterCharts =
    sourceBars.length > 0 || purposeBars.length > 0 || commodityChart.length > 0;

  // Trade-over-time chart, placed in the map's side column (or full width when
  // there is no map).
  const trendInfo =
    "Drag the handles to trim the year range." +
    (maxYear >= provisionalFromYear
      ? ` Recent years (dashed, ${provisionalFromYear}+) are provisional — CITES reporting lags by a few years, so they are usually incomplete rather than showing a real drop.`
      : "");
  const tradeOverTimeChart = (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
          Trade over time
        </span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 normal-case">
          (records)
        </span>
        <span className="relative group inline-flex">
          <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-zinc-400 dark:border-zinc-500 text-[9px] font-semibold text-zinc-400 dark:text-zinc-500 cursor-help">
            i
          </span>
          <span className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 hidden group-hover:block z-20 w-56 bg-zinc-800 dark:bg-zinc-700 text-white text-[10px] leading-snug rounded-md p-2 shadow-lg normal-case font-normal tracking-normal">
            {trendInfo}
          </span>
        </span>
        {brush && (
          <span className="text-[11px] text-blue-600 dark:text-blue-400 tabular-nums ml-auto">
            {brush[0]}–{brush[1]}
          </span>
        )}
      </div>
      <TrendLineChart
        data={chartByYear}
        metric={metric}
        minYear={minYear}
        maxYear={maxYear}
        brush={brush}
        onBrushChange={setBrush}
        provisionalFromYear={provisionalFromYear}
      />
    </div>
  );

  // Record count + year range + clear button. Overlaid on the map (or shown as
  // a row when there is no map) so it doesn't take a whole dead row of its own.
  const headline = (
    <div className="flex items-baseline gap-2">
      <span className="text-sm text-zinc-700 dark:text-zinc-200">
        <span className="font-semibold tabular-nums">
          {display.totalRecords.toLocaleString()}
        </span>{" "}
        records
        <span className="text-zinc-400 dark:text-zinc-500 ml-1 tabular-nums">
          {effectiveRange[0]}–{effectiveRange[1]}
        </span>
        {brush && (
          <span className="text-zinc-400 dark:text-zinc-500 ml-1 tabular-nums">
            (of {minYear}–{maxYear})
          </span>
        )}
      </span>
      {hasActiveFilters && (
        <button
          type="button"
          className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline decoration-dotted"
          onClick={clearFilters}
        >
          Clear filters
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Trade flow map (with the record count overlaid), and Top exporters /
          importers + the trade-over-time chart in the side column. */}
      {displayFlows.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 relative border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden bg-zinc-50 dark:bg-zinc-800/30">
            <div className="absolute top-2 left-3 z-10 bg-zinc-50/70 dark:bg-zinc-900/40 backdrop-blur-sm rounded-md px-2 py-1">
              {headline}
            </div>
            <TradeFlowMap
              flows={displayFlows}
              reExportFlows={display.reExportFlows}
              exporters={displayExporters}
              importers={displayImporters}
              suspensionCountries={suspensionCountries}
              countryAnnotations={countryAnnotations}
              selectedCountry={selectedCountry}
              onSelectCountry={setSelectedCountry}
            />
          </div>
          {/* Side column stretches to the map's height; the trade-over-time
              chart is pushed to the bottom so it lines up with the map base. */}
          <div className="lg:col-span-2 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <CountryTable
                data={tableExporters}
                label="Top exporters"
                selected={selectedCountry}
                onSelect={setSelectedCountry}
                barClass="bg-red-400 dark:bg-red-500"
              />
              <CountryTable
                data={tableImporters}
                label="Top importers"
                selected={selectedCountry}
                onSelect={setSelectedCountry}
                barClass="bg-blue-400 dark:bg-blue-500"
              />
            </div>
            <div className="mt-auto">{tradeOverTimeChart}</div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {headline}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CountryTable
              data={tableExporters}
              label="Top exporters"
              selected={selectedCountry}
              onSelect={setSelectedCountry}
              barClass="bg-red-400 dark:bg-red-500"
            />
            <CountryTable
              data={tableImporters}
              label="Top importers"
              selected={selectedCountry}
              onSelect={setSelectedCountry}
              barClass="bg-blue-400 dark:bg-blue-500"
            />
          </div>
          {tradeOverTimeChart}
        </div>
      )}

      {/* Filter charts below the map — click a bar to cross-filter the whole
          summary. Source bars are coloured wild (amber) vs captive (emerald). */}
      {hasFilterCharts && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FilterBarChart
            title="Commodity"
            bars={commodityBars}
            onToggle={hasShipments ? isolateTerm : undefined}
            search={termSearch}
            onSearchChange={setTermSearch}
            searchPlaceholder="Search…"
            emptyHint={
              commoditySearch
                ? `No commodities match “${termSearch}”.`
                : undefined
            }
          />
          <FilterBarChart
            title="Purpose"
            bars={purposeBars}
            onToggle={hasShipments ? isolatePurpose : undefined}
          />
          <FilterBarChart
            title="Source"
            bars={sourceBars}
            onToggle={hasShipments ? isolateSource : undefined}
          />
        </div>
      )}

      {/* The individual shipment records behind everything above, paginated and
          reflecting all active filters. */}
      {hasShipments && <RecordsTable rows={displayRows} />}
    </div>
  );
}
