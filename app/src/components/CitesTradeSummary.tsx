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
import { CHART_INPUT_CLASS, CHART_SELECT_CLASS, CHART_SEGMENTED_CLASS, ChartPager, chartSegmentClass } from "@/components/redlist/chart-controls";
import type { CountryAnnotation } from "./TradeFlowMap";
import {
  aggregate,
  commodities,
  commodityKey,
  commodityLabel,
  reportedQty,
  type CompactRecord,
  type Reporter,
  type Total,
} from "@/lib/cites-trade";

const TradeFlowMap = dynamic(() => import("./TradeFlowMap"), { ssr: false });

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TradeData {
  found: boolean;
  taxonId: string;
  yearRange: [number, number];
  shipments?: CompactRecord[];
}

/** A quantity in full, e.g. "5,852" or "12.5". */
function fmtFull(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const REPORTER_LABEL: Record<Reporter, string> = {
  exporter: "Exporter-reported",
  importer: "Importer-reported",
};

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
/*  Interactive filter bar chart                                        */
/* ------------------------------------------------------------------ */

interface FilterBar {
  /** Stable key passed back to onToggle (source/purpose code or term key). */
  key: string;
  label: string;
  sublabel?: string;
  /** Bar length (a quantity in the selected commodity's unit). */
  value: number;
  /** Text shown at the end of the row. */
  valueLabel: string;
  /** Whether this category is currently included by the filter. */
  active: boolean;
  /** Tailwind classes for the bar fill; omitted for a plain list (no bars). */
  barClass?: string;
  /** Tooltip. */
  title: string;
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
  const max = bars.reduce((m, b) => Math.max(m, b.value), 0);
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
          const pct = max > 0 ? (b.value / max) * 100 : 0;
          return (
            <div
              key={b.key}
              onClick={onToggle ? () => onToggle(b.key) : undefined}
              title={b.title}
              className={`flex items-center gap-2 text-xs select-none transition-opacity ${
                onToggle ? "cursor-pointer" : ""
              } ${
                // Bars: de-selected categories dim. A plain pick-one list
                // (no bars): the picked row is marked, the rest stay readable.
                b.barClass
                  ? b.active ? "" : "opacity-40"
                  : b.active
                    ? "font-semibold rounded bg-violet-50 dark:bg-violet-500/15 -mx-1 px-1"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60 rounded -mx-1 px-1"
              }`}
            >
              <span className={`${b.barClass ? "w-24 shrink-0" : "flex-1 min-w-0"} truncate capitalize text-zinc-700 dark:text-zinc-300`}>
                {b.label}
                {b.sublabel && (
                  <span className="text-zinc-400 dark:text-zinc-500 ml-1 normal-case">
                    {b.sublabel}
                  </span>
                )}
              </span>
              {b.barClass && (
                <div className="flex-1 h-3.5 bg-zinc-100 dark:bg-zinc-800 rounded overflow-hidden">
                  <div
                    className={`h-full rounded ${b.barClass}`}
                    style={{ width: `${Math.max(pct, 1)}%` }}
                  />
                </div>
              )}
              <span className="w-12 text-right text-zinc-500 dark:text-zinc-400 tabular-nums shrink-0">
                {b.valueLabel}
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
  unitLabel,
  provisionalFromYear,
}: {
  active?: boolean;
  payload?: { value: number | null; dataKey: string }[];
  label?: number;
  unitLabel: string;
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
        {fmtFull(point.value ?? 0)} {unitLabel}
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
  unitLabel,
  minYear,
  maxYear,
  brush,
  onBrushChange,
  provisionalFromYear,
}: {
  data: { year: number; quantity: number }[];
  unitLabel: string;
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
  const lookup = new Map(data.map((d) => [d.year, d.quantity]));
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
                unitLabel={unitLabel}
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
  unitLabel,
  selected,
  onSelect,
  barClass,
}: {
  data: Total[];
  label: string;
  unitLabel: string;
  selected?: string | null;
  onSelect?: (code: string | null) => void;
  /** Tailwind classes for the (unselected) bar fill. */
  barClass: string;
}) {
  const [page, setPage] = useState(0);
  if (data.length === 0) return null;
  const sorted = [...data].sort((a, b) => b.quantity - a.quantity);
  // Scale bars against the global max so widths stay comparable across pages.
  const max = sorted.reduce((m, c) => Math.max(m, c.quantity), 0);
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
          const pct = max > 0 ? (c.quantity / max) * 100 : 0;
          return (
            <div
              key={c.code}
              onClick={onSelect ? () => onSelect(isSel ? null : c.code) : undefined}
              title={`${countryName(c.code)}: ${fmtFull(c.quantity)} ${unitLabel}`}
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
                {fmtQty(c.quantity)}
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
/*  Comparative-tabulation rows table                                  */
/* ------------------------------------------------------------------ */

/** Default rows shown per page in the rows table. */
const RECORDS_PAGE_SIZE = 5;

/** Page-size options offered in the rows table. */
const RECORDS_PAGE_SIZE_OPTIONS = [5, 10, 25, 50];

const ROWS_INFO =
  "Rows of the CITES comparative tabulation. A row can cover any number of shipments. " +
  "The exporter's and importer's quantities are separate reports of the same trade, so they are shown side by side and never added. " +
  "When the two countries described a trade differently, it appears as two rows, each with one country's figure.";

/** Small "i" with a hover explanation. */
function InfoTip({ text, align = "center" }: { text: string; align?: "center" | "left" }) {
  return (
    <span className="relative group inline-flex">
      <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-zinc-400 dark:border-zinc-500 text-[9px] font-semibold text-zinc-400 dark:text-zinc-500 cursor-help normal-case">
        i
      </span>
      <span
        className={`pointer-events-none absolute top-full mt-1 hidden group-hover:block z-20 w-64 bg-zinc-800 dark:bg-zinc-700 text-white text-[10px] leading-snug rounded-md p-2 shadow-lg normal-case font-normal tracking-normal ${
          align === "left" ? "left-0" : "left-1/2 -translate-x-1/2"
        }`}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * The comparative-tabulation rows behind the summary, reflecting every active
 * filter, most recent first. Both parties' quantities are shown, the one the
 * summary reads in bold; a re-export origin is shown ahead of the exporter.
 */
function RecordsTable({ rows, reporter }: { rows: CompactRecord[]; reporter: Reporter }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(RECORDS_PAGE_SIZE);
  if (rows.length === 0) return null;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const qtyCell = (q: number | undefined, read: boolean) => (
    <td
      className={`px-2.5 py-1 text-right tabular-nums ${
        read ? "text-zinc-800 dark:text-zinc-100 font-medium" : "text-zinc-400 dark:text-zinc-500"
      }`}
    >
      {q !== undefined ? fmtFull(q) : "—"}
    </td>
  );

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <h5 className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
          Rows{" "}
          <span className="text-zinc-400 dark:text-zinc-500 normal-case tabular-nums">
            ({rows.length.toLocaleString()})
          </span>
          <InfoTip text={ROWS_INFO} align="left" />
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
              <th className={`px-2.5 py-1 font-medium text-right ${reporter === "exporter" ? "text-zinc-600 dark:text-zinc-300" : ""}`}>
                Exporter qty
              </th>
              <th className={`px-2.5 py-1 font-medium text-right ${reporter === "importer" ? "text-zinc-600 dark:text-zinc-300" : ""}`}>
                Importer qty
              </th>
              <th className="px-2.5 py-1 font-medium">Exporter &rarr; Importer</th>
              <th className="px-2.5 py-1 font-medium">Source</th>
              <th className="px-2.5 py-1 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr key={i} className="border-t first:border-t-0 border-zinc-100 dark:border-zinc-800">
                <td className="px-2.5 py-1 tabular-nums text-zinc-600 dark:text-zinc-300">{r.y}</td>
                <td className="px-2.5 py-1 text-zinc-700 dark:text-zinc-300 capitalize">
                  {r.t}
                  {r.u && (
                    <span className="text-zinc-400 dark:text-zinc-500 ml-1 normal-case">{r.u}</span>
                  )}
                </td>
                {qtyCell(r.qe, reporter === "exporter")}
                {qtyCell(r.qi, reporter === "importer")}
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
      <Pager page={safePage} total={rows.length} onPage={setPage} pageSize={pageSize} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

/** Which filters a view ignores (each chart ignores its own dimension). */
interface Skip {
  source?: boolean;
  purpose?: boolean;
  commodity?: boolean;
  country?: boolean;
  years?: boolean;
}

/**
 * Trade in a CITES species, following the CITES Trade Database guide
 * (lib/cites-trade.ts): every figure is ONE reporter's quantity (exporter- or
 * importer-reported, never a mix) of ONE commodity (term + unit).
 */
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

  // Exporter-reported by default: the guide's "often more complete" side.
  const [reporter, setReporter] = useState<Reporter>("exporter");
  // The commodity every figure is in; null = the reporter's most-reported one.
  const [chosenCommodity, setChosenCommodity] = useState<string | null>(null);

  // Source / purpose filters: all checked by default
  const [checkedSources, setCheckedSources] = useState<Record<string, boolean>>({});
  const [checkedPurposes, setCheckedPurposes] = useState<Record<string, boolean>>({});
  const [termSearch, setTermSearch] = useState("");

  // Year-range trim (null = full range)
  const [brush, setBrush] = useState<[number, number] | null>(null);

  // Country highlighted on the map (also set by clicking a Top exporters /
  // importers row). Filters everything to that country's trade.
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

  const shipments = useMemo(() => (data?.found ? data.shipments ?? [] : []), [data]);

  // Source / purpose category universes, INCLUDING the blank "" ("Unspecified")
  // category so it is isolatable. Unchecked state is tracked as `false`;
  // a missing key means checked.
  const allSourceCodes = useMemo(() => Array.from(new Set(shipments.map((r) => r.s))), [shipments]);
  const allPurposeCodes = useMemo(() => Array.from(new Set(shipments.map((r) => r.p))), [shipments]);

  // Every commodity the reporter reported, and the one in force.
  const allCommodities = useMemo(() => commodities(shipments, reporter), [shipments, reporter]);
  const commodity =
    allCommodities.find((c) => c.key === chosenCommodity) ?? allCommodities[0] ?? null;
  const unitLabel = commodity ? commodityLabel(commodity.term, commodity.unit) : "";

  // Clicking a bar isolates that category (selects only it); clicking the
  // already-isolated one resets the dimension to all.
  const isolateSource = useCallback(
    (code: string) => setCheckedSources((prev) => isolateState(prev, allSourceCodes, code)),
    [allSourceCodes]
  );
  const isolatePurpose = useCallback(
    (code: string) => setCheckedPurposes((prev) => isolateState(prev, allPurposeCodes, code)),
    [allPurposeCodes]
  );

  const anySourceOff = Object.values(checkedSources).some((v) => v === false);
  const anyPurposeOff = Object.values(checkedPurposes).some((v) => v === false);
  const hasActiveFilters =
    anySourceOff || anyPurposeOff || brush !== null || selectedCountry !== null;

  const clearFilters = useCallback(() => {
    setCheckedSources({});
    setCheckedPurposes({});
    setBrush(null);
    setTermSearch("");
    setSelectedCountry(null);
  }, []);

  /** Rows passing every active filter except the skipped ones. */
  const filterRows = useCallback(
    (skip: Skip) =>
      shipments.filter((r) => {
        if (!skip.source && checkedSources[r.s] === false) return false;
        if (!skip.purpose && checkedPurposes[r.p] === false) return false;
        if (!skip.commodity && commodity && commodityKey(r.t, r.u) !== commodity.key) return false;
        if (!skip.years && brush && (r.y < brush[0] || r.y > brush[1])) return false;
        if (!skip.country && selectedCountry && r.e !== selectedCountry && r.i !== selectedCountry)
          return false;
        return true;
      }),
    [shipments, checkedSources, checkedPurposes, commodity, brush, selectedCountry]
  );

  // The trend shows every year (the trim is drawn on it, not applied to it).
  const chartAgg = useMemo(() => aggregate(filterRows({ years: true }), reporter), [filterRows, reporter]);

  // Every filter applied: the headline, map flows and the rows table. The
  // table keeps rows only the other party reported (shown with "—" in the
  // column being read), so both sides of the comparison stay visible.
  const displayRows = useMemo(() => {
    const rows = filterRows({});
    const q = (r: CompactRecord) => reportedQty(r, reporter) ?? -1;
    return rows.sort((a, b) => b.y - a.y || q(b) - q(a));
  }, [filterRows, reporter]);
  const display = useMemo(() => aggregate(displayRows, reporter), [displayRows, reporter]);

  // Cross-filter views: each chart ignores its own dimension so its categories
  // stay visible and clickable.
  const commodityList = useMemo(() => commodities(filterRows({ commodity: true }), reporter), [filterRows, reporter]);
  const sourceChart = useMemo(() => aggregate(filterRows({ source: true }), reporter).bySource, [filterRows, reporter]);
  const purposeChart = useMemo(() => aggregate(filterRows({ purpose: true }), reporter).byPurpose, [filterRows, reporter]);
  const countryAgg = useMemo(() => aggregate(filterRows({ country: true }), reporter), [filterRows, reporter]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500 py-3">
        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading trade data...
      </div>
    );
  }

  if (error || !data || !data.found || shipments.length === 0) {
    return null;
  }

  const [minYear, maxYear] = data.yearRange;
  const currentYear = new Date().getFullYear();
  const provisionalFromYear = currentYear - PROVISIONAL_YEARS + 1;
  const effectiveRange: [number, number] = brush ?? data.yearRange;
  const qtyTitle = (label: string, q: number) => `${label}: ${fmtFull(q)} ${unitLabel}`;

  const tableExporters = countryAgg.exporters.slice(0, 15);
  const tableImporters = countryAgg.importers.slice(0, 15);

  // Source bars keep the wild (amber) vs captive (emerald) distinction.
  const sourceBars: FilterBar[] = sourceChart.map((s) => {
    const label = s.code === "" ? "Unspecified" : SOURCE_LABELS[s.code] || s.code;
    return {
      key: s.code,
      label,
      sublabel: s.code,
      value: s.quantity,
      valueLabel: fmtQty(s.quantity),
      active: checkedSources[s.code] !== false,
      barClass:
        s.code === ""
          ? "bg-zinc-400 dark:bg-zinc-500"
          : WILD_SOURCE_CODES.has(s.code)
            ? "bg-amber-400 dark:bg-amber-500"
            : "bg-emerald-300 dark:bg-emerald-600",
      title: qtyTitle(label, s.quantity),
    };
  });

  const purposeBars: FilterBar[] = purposeChart.map((p) => {
    const label = p.code === "" ? "Unspecified" : PURPOSE_LABELS[p.code] || p.code;
    return {
      key: p.code,
      label,
      sublabel: p.code,
      value: p.quantity,
      valueLabel: fmtQty(p.quantity),
      active: checkedPurposes[p.code] !== false,
      barClass: p.code === "" ? "bg-zinc-400 dark:bg-zinc-500" : "bg-blue-400 dark:bg-blue-500",
      title: qtyTitle(label, p.quantity),
    };
  });

  // Commodities are a pick-one list, not bars: quantities in different terms
  // and units can't be compared on one scale.
  const commoditySearch = termSearch.trim().toLowerCase();
  const commodityBars: FilterBar[] = commodityList
    .filter((c) => (commoditySearch ? `${c.term} ${c.unit}`.toLowerCase().includes(commoditySearch) : true))
    .map((c) => ({
      key: c.key,
      label: c.term,
      sublabel: c.unit || undefined,
      value: c.quantity,
      valueLabel: fmtQty(c.quantity),
      active: c.key === commodity?.key,
      title: `${fmtFull(c.quantity)} ${commodityLabel(c.term, c.unit)} (${REPORTER_LABEL[reporter].toLowerCase()}). Click to show this commodity.`,
    }));

  const trendInfo =
    `${REPORTER_LABEL[reporter]} quantity of ${unitLabel} per year. Drag the handles to trim the year range.` +
    (maxYear >= provisionalFromYear
      ? ` Recent years (dashed, ${provisionalFromYear}+) are provisional: CITES annual reports are due 31 October of the following year and often arrive later, so a drop there is usually missing reports rather than less trade.`
      : "");
  const tradeOverTimeChart = (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
          Trade over time
        </span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 normal-case truncate">({unitLabel})</span>
        <InfoTip text={trendInfo} />
        {brush && (
          <span className="text-[11px] text-blue-600 dark:text-blue-400 tabular-nums ml-auto">
            {brush[0]}–{brush[1]}
          </span>
        )}
      </div>
      <TrendLineChart
        data={chartAgg.byYear}
        unitLabel={unitLabel}
        minYear={minYear}
        maxYear={maxYear}
        brush={brush}
        onBrushChange={setBrush}
        provisionalFromYear={provisionalFromYear}
      />
    </div>
  );

  // Quantity + year range + clear button, overlaid on the map.
  const headline = (
    <div className="flex items-baseline gap-2">
      <span className="text-sm text-zinc-700 dark:text-zinc-200">
        <span className="font-semibold tabular-nums">{fmtFull(display.quantity)}</span> {unitLabel}
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

  const reporterInfo =
    "Each trade can be reported twice, by the exporting and the importing country, and the two reports often differ. " +
    "Following the CITES Trade Database guide, the figures here use one side's reports throughout and never add or mix the two. " +
    "Exporter-reported data are often more complete; importer-reported data can be better where an exporter's annual reports are missing.";

  // What every figure below is: one reporter's quantity of one commodity.
  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-zinc-500 dark:text-zinc-400">
      <label className="flex items-center gap-1.5">
        <span>Commodity</span>
        <select
          value={commodity?.key ?? ""}
          onChange={(e) => setChosenCommodity(e.target.value)}
          className={`${CHART_SELECT_CLASS} max-w-[16rem]`}
        >
          {allCommodities.map((c) => (
            <option key={c.key} value={c.key}>
              {commodityLabel(c.term, c.unit)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-1.5">
        <span>Quantities</span>
        <div className={CHART_SEGMENTED_CLASS} role="group" aria-label="Whose reports to read">
          {(["exporter", "importer"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reporter === r}
              onClick={() => setReporter(r)}
              className={chartSegmentClass(reporter === r)}
            >
              {REPORTER_LABEL[r]}
            </button>
          ))}
        </div>
        <InfoTip text={reporterInfo} />
      </div>
    </div>
  );

  const countryTables = (
    <>
      <CountryTable
        data={tableExporters}
        label="Top exporters"
        unitLabel={unitLabel}
        selected={selectedCountry}
        onSelect={setSelectedCountry}
        barClass="bg-red-400 dark:bg-red-500"
      />
      <CountryTable
        data={tableImporters}
        label="Top importers"
        unitLabel={unitLabel}
        selected={selectedCountry}
        onSelect={setSelectedCountry}
        barClass="bg-blue-400 dark:bg-blue-500"
      />
    </>
  );

  return (
    <div className="space-y-4">
      {toolbar}
      {/* Trade flow map (headline overlaid), and Top exporters / importers +
          the trade-over-time chart in the side column. */}
      {display.flows.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 relative border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden bg-zinc-50 dark:bg-zinc-800/30">
            <div className="absolute top-2 left-3 z-10 bg-zinc-50/70 dark:bg-zinc-900/40 backdrop-blur-sm rounded-md px-2 py-1">
              {headline}
            </div>
            <TradeFlowMap
              flows={display.flows}
              reExportFlows={display.reExports}
              exporters={countryAgg.exporters}
              importers={countryAgg.importers}
              unitLabel={unitLabel}
              suspensionCountries={suspensionCountries}
              countryAnnotations={countryAnnotations}
              selectedCountry={selectedCountry}
              onSelectCountry={setSelectedCountry}
            />
          </div>
          {/* Side column stretches to the map's height; the trade-over-time
              chart is pushed to the bottom so it lines up with the map base. */}
          <div className="lg:col-span-2 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">{countryTables}</div>
            <div className="mt-auto">{tradeOverTimeChart}</div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {headline}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{countryTables}</div>
          {tradeOverTimeChart}
        </div>
      )}

      {/* Below the map: pick a commodity, or click a purpose / source bar to
          cross-filter everything. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FilterBarChart
          title="Commodity"
          bars={commodityBars}
          onToggle={setChosenCommodity}
          search={termSearch}
          onSearchChange={setTermSearch}
          searchPlaceholder="Search…"
          emptyHint={commoditySearch ? `No commodities match “${termSearch}”.` : undefined}
        />
        <FilterBarChart title="Purpose" bars={purposeBars} onToggle={isolatePurpose} />
        <FilterBarChart title="Source" bars={sourceBars} onToggle={isolateSource} />
      </div>

      <RecordsTable rows={displayRows} reporter={reporter} />
    </div>
  );
}
