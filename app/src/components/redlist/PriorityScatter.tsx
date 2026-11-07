"use client";

/**
 * Reassessment triage: one dot per assessed species, years since its latest
 * assessment across, a GBIF value up (records in total or since the
 * assessment, log scale; or % new, linear), coloured by Red List category: the
 * top right is outdated with plenty of data since. Drag a box to filter the
 * page to the species inside it. Hovering a dot shows a short summary;
 * clicking it pins a details card (the assessment, the GBIF split, links).
 *
 * The axes' extents come from the caller (the whole taxon, not the filtered
 * points), so applying a filter never rescales the chart.
 *
 * Canvas rather than SVG: "All species" is ~175k dots. Hover and the drag box
 * are DOM overlays, so the canvas only redraws when the data or box changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { yearsMonthsSince } from "@/lib/outdated";

export interface PriorityPoint {
  key: string;
  name: string;
  commonName?: string | null;
  category: string;
  /** Years since the latest assessment. */
  years: number;
  /** The plotted GBIF value: a record count, or a percentage for "pct". */
  value: number;
  /** GBIF records in total and since the assessment (the plotted record mode), for the tooltip. */
  total: number | null;
  newRecords: number | null;
  assessmentDate: string;
}

/**
 * A selection: the box in plot units (years; log10(value + 1), or %), for
 * drawing, and the species whose dots were inside it as drawn. Filtering by
 * the keys rather than re-testing the box keeps it exactly what you see: dots
 * are jittered a few pixels, so a tight box around one dot could miss its
 * unjittered position and select nothing.
 */
/** What the pinned card adds to the hover summary, looked up only for the one clicked species. */
export interface PriorityDetails {
  criteria: string | null;
  populationTrend: string | null;
  assessmentCount: number | null;
  assessors: string | null;
  /** "All records" / "Georeferenced": which GBIF records the counts are. */
  recordsLabel: string;
  redListUrl: string | null;
  gbifUrl: string | null;
}

export interface PriorityBox { x0: number; x1: number; y0: number; y1: number; keys: ReadonlySet<string> }

export type YScale = "log" | "pct";
/** Plot units up the y axis: log10(count + 1), or the percentage itself. */
export const toPlotY = (value: number, scale: YScale) => (scale === "pct" ? value : Math.log10(value + 1));

// Draw order: least concerning first, so threatened dots sit on top.
const DRAW_RANK: Record<string, number> = { LC: 0, NT: 1, DD: 2, VU: 3, EN: 4, CR: 5, EW: 6, EX: 7 };
// Left and bottom leave room for the tick labels and the axis titles.
const M = { left: 56, right: 12, top: 10, bottom: 40 };
const HEIGHT = 292;
const HIT_RADIUS = 6;

/** "10 years, 3 months ago", "4 months ago", "this month". */
function ageText(date: string): string {
  const { years, months } = yearsMonthsSince(date);
  const parts = [years ? `${years} year${years === 1 ? "" : "s"}` : "", months ? `${months} month${months === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(", ")} ago` : "this month";
}

/** "11y 8m ago": the card's compact form of ageText, so the date row stays one line. */
function shortAge(date: string): string {
  const { years, months } = yearsMonthsSince(date);
  const parts = [years ? `${years}y` : "", months ? `${months}m` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" ")} ago` : "this month";
}

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Where a floating box of size w×h goes beside an anchor at (px, py): right of
 * and level with it where it fits, else left of it, and nudged up or down to
 * stay inside the chart (the wrapper clips, so an unclamped box near the
 * bottom was cut off). Null until measured, so it never flashes misplaced.
 */
function usePlacement(ref: React.RefObject<HTMLDivElement | null>, anchor: { px: number; py: number } | null, width: number, gap: number) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) { setPos(null); return; }
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = anchor.px + gap + w <= width ? anchor.px + gap : Math.max(0, anchor.px - gap - w);
    const top = Math.max(0, Math.min(anchor.py - h / 2, HEIGHT - h));
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [ref, anchor, width, gap]);
  return pos;
}
const placedStyle = (pos: { left: number; top: number } | null): React.CSSProperties =>
  pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" };

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export default function PriorityScatter({ points, colors, categoryNames, box, onBoxChange, onPointClick, details, selectedKey, yScale, yLabel, maxYears, maxValue }: {
  points: PriorityPoint[];
  yScale: YScale;
  /** The y axis title, e.g. "GBIF records since assessment". */
  yLabel: string;
  /** The axes' extents: the oldest assessment and largest value in the whole taxon. */
  maxYears: number;
  maxValue: number;
  colors: Record<string, string>;
  categoryNames: Record<string, string>;
  box: PriorityBox | null;
  onBoxChange: (box: PriorityBox | null) => void;
  /** "Show in table": page and scroll the species table to this species. */
  onPointClick: (key: string) => void;
  details: (key: string) => PriorityDetails | null;
  selectedKey?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ p: PriorityPoint; px: number; py: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** The clicked species whose details card is open. */
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scales. X runs to the taxon's oldest assessment (rounded up to 5 years); Y
  // to its largest count's power of ten, or 100%.
  const scales = useMemo(() => {
    const xMax = Math.max(10, Math.ceil(maxYears / 5) * 5);
    const yMax = yScale === "pct" ? 100 : Math.max(1, Math.ceil(toPlotY(maxValue, "log")));
    const plotW = Math.max(0, width - M.left - M.right);
    const plotH = HEIGHT - M.top - M.bottom;
    return {
      xMax, yMax, plotW, plotH,
      sx: (years: number) => M.left + (years / xMax) * plotW,
      sy: (y: number) => M.top + plotH - (y / yMax) * plotH,
      ix: (px: number) => ((px - M.left) / plotW) * xMax,
      iy: (py: number) => ((M.top + plotH - py) / plotH) * yMax,
    };
  }, [width, maxYears, maxValue, yScale]);

  // Screen positions (with a little deterministic vertical jitter, so the many
  // species on the same count, above all 0, show as a band rather than a line),
  // plus a coarse grid for hover hit-testing.
  const layout = useMemo(() => {
    const ordered = [...points].sort((a, b) => (DRAW_RANK[a.category] ?? 0) - (DRAW_RANK[b.category] ?? 0));
    const xy = new Float32Array(ordered.length * 2);
    const grid = new Map<number, number[]>();
    const cell = 12;
    ordered.forEach((p, i) => {
      let h = 0;
      for (let c = 0; c < p.key.length; c++) h = (h * 31 + p.key.charCodeAt(c)) | 0;
      const jitter = ((h & 1023) / 1023 - 0.5) * 6;
      const x = scales.sx(Math.min(p.years, scales.xMax)), y = scales.sy(Math.min(toPlotY(p.value, yScale), scales.yMax)) + jitter;
      xy[i * 2] = x; xy[i * 2 + 1] = y;
      const k = Math.floor(x / cell) * 10007 + Math.floor(y / cell);
      const bucket = grid.get(k);
      if (bucket) bucket.push(i); else grid.set(k, [i]);
    });
    return { ordered, xy, grid, cell };
  }, [points, scales, yScale]);

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    const { sx, sy, xMax, yMax, plotW, plotH } = scales;

    // Grid and ticks.
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#a1a1aa";
    ctx.strokeStyle = "rgba(161, 161, 170, 0.18)";
    ctx.lineWidth = 1;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const yTicks = yScale === "pct" ? [0, 25, 50, 75, 100] : Array.from({ length: yMax + 1 }, (_, e) => e);
    for (const t of yTicks) {
      const y = Math.round(sy(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(M.left + plotW, y); ctx.stroke();
      ctx.fillText(yScale === "pct" ? `${t}%` : t === 0 ? "0" : formatCount(10 ** t), M.left - 6, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let yr = 0; yr <= xMax; yr += 5) {
      const x = Math.round(sx(yr)) + 0.5;
      ctx.fillText(`${yr}`, x, M.top + plotH + 6);
    }

    // Axis titles.
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#71717a";
    ctx.fillText("Years since latest assessment", M.left + plotW / 2, HEIGHT - 14);
    ctx.save();
    ctx.translate(12, M.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    // Dots.
    const { ordered, xy } = layout;
    const big = ordered.length > 20000;
    const r = big ? 1.2 : 2.4;
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      const dim = box ? !box.keys.has(p.key) : false;
      ctx.globalAlpha = dim ? 0.12 : big ? 0.5 : 0.75;
      ctx.fillStyle = colors[p.category] || "#a1a1aa";
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (big) ctx.fillRect(x - r, y - r, r * 2, r * 2);
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }, [layout, scales, width, box, colors, yScale, yLabel]);

  const localXY = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitTest = (x: number, y: number): number | null => {
    const { grid, cell, xy } = layout;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    let best: number | null = null, bestD = HIT_RADIUS * HIT_RADIUS;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get((gx + dx) * 10007 + gy + dy) ?? []) {
        const d = (xy[i * 2] - x) ** 2 + (xy[i * 2 + 1] - y) ** 2;
        // >= so the last-drawn (most threatened) dot under the cursor wins.
        if (d <= bestD) { bestD = d; best = i; }
      }
    }
    return best;
  };

  // The drag's origin is also kept in a ref: a tap sends mousedown and mouseup
  // back to back, before React re-renders, and mouseup reading the state alone
  // would see no drag and drop the click.
  const dragStart = useRef<{ x0: number; y0: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    dragStart.current = { x0: x, y0: y };
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    const start = dragStart.current;
    if (start) { setDrag({ ...start, x1: x, y1: y }); setHover(null); return; }
    const i = hitTest(x, y);
    setHover(i == null ? null : { p: layout.ordered[i], px: layout.xy[i * 2], py: layout.xy[i * 2 + 1] });
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const drag = dragStart.current;
    if (!drag) return;
    const { x, y } = localXY(e);
    dragStart.current = null;
    setDrag(null);
    const moved = Math.abs(x - drag.x0) > 4 || Math.abs(y - drag.y0) > 4;
    if (moved) {
      const { ix, iy } = scales;
      const left = Math.min(drag.x0, x), right = Math.max(drag.x0, x);
      const top = Math.min(drag.y0, y), bottom = Math.max(drag.y0, y);
      const keys = new Set<string>();
      const { ordered, xy } = layout;
      for (let i = 0; i < ordered.length; i++) {
        const px = xy[i * 2], py = xy[i * 2 + 1];
        if (px >= left && px <= right && py >= top && py <= bottom) keys.add(ordered[i].key);
      }
      onBoxChange({ x0: ix(left), x1: ix(right), y0: iy(bottom), y1: iy(top), keys });
      return;
    }
    // A click on a dot opens its card; on empty space it closes the card
    // first, and only then (a second click) clears the box.
    const i = hitTest(x, y);
    if (i != null) setPinnedKey(layout.ordered[i].key);
    else if (pinnedKey) setPinnedKey(null);
    else if (box) onBoxChange(null);
  };

  // Clamped to the plot, so a box dragged past an axis stays inside the chart
  const boxPx = box && width > 0 ? (() => {
    const cx = (v: number) => Math.min(Math.max(v, 0), scales.xMax);
    const cy = (v: number) => Math.min(Math.max(v, 0), scales.yMax);
    const left = scales.sx(cx(box.x0)), right = scales.sx(cx(box.x1));
    const top = scales.sy(cy(box.y1)), bottom = scales.sy(cy(box.y0));
    return { left, top, width: right - left, height: bottom - top };
  })() : null;
  const dragPx = drag ? {
    left: Math.max(0, Math.min(drag.x0, drag.x1)), top: Math.max(0, Math.min(drag.y0, drag.y1)),
    width: Math.min(width, Math.max(drag.x0, drag.x1)) - Math.max(0, Math.min(drag.x0, drag.x1)),
    height: Math.min(HEIGHT, Math.max(drag.y0, drag.y1)) - Math.max(0, Math.min(drag.y0, drag.y1)),
  } : null;

  const selected = selectedKey ? layout.ordered.findIndex((p) => p.key === selectedKey) : -1;
  const pinnedIndex = pinnedKey ? layout.ordered.findIndex((p) => p.key === pinnedKey) : -1;
  const pinned = pinnedIndex >= 0 ? { p: layout.ordered[pinnedIndex], px: layout.xy[pinnedIndex * 2], py: layout.xy[pinnedIndex * 2 + 1] } : null;
  const pinnedDetails = useMemo(() => (pinnedKey ? details(pinnedKey) : null), [pinnedKey, details]);

  // A filter that drops the pinned species closes its card; so does Escape.
  useEffect(() => { if (pinnedKey && pinnedIndex < 0) setPinnedKey(null); }, [pinnedKey, pinnedIndex]);
  useEffect(() => {
    if (!pinnedKey) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPinnedKey(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinnedKey]);

  // While a card is open, hovering other dots only rings them: two floating boxes at once is noise.
  const showTip = hover && !pinned;
  const tipRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const tipPos = usePlacement(tipRef, showTip ? hover : null, width, 10);
  const cardPos = usePlacement(cardRef, pinned, width, 12);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden select-none cursor-crosshair"
      style={{ height: HEIGHT }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { setHover(null); setDrag(null); dragStart.current = null; }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: HEIGHT, display: "block" }} />
      {(dragPx ?? boxPx) && (
        <div className="pointer-events-none absolute rounded-sm border border-zinc-500/70 bg-zinc-500/10 dark:border-zinc-300/70 dark:bg-zinc-300/10"
          style={dragPx ?? boxPx ?? undefined} />
      )}
      {selected >= 0 && (
        <div className="pointer-events-none absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full ring-2 ring-zinc-900 dark:ring-white"
          style={{ left: layout.xy[selected * 2], top: layout.xy[selected * 2 + 1] }} />
      )}
      {pinned && (
        <div className="pointer-events-none absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full ring-2 ring-zinc-900 dark:ring-white"
          style={{ left: pinned.px, top: pinned.py }} />
      )}
      {hover && (
        <div className="pointer-events-none absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full ring-1 ring-zinc-900 dark:ring-white"
          style={{ left: hover.px, top: hover.py }} />
      )}
      {showTip && (
        <div ref={tipRef} role="tooltip"
          className="pointer-events-none absolute z-10 max-w-[240px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1.5 text-[11px] leading-[15px]"
          style={placedStyle(tipPos)}>
          <div className="italic font-medium text-zinc-900 dark:text-zinc-100 truncate">{hover.p.name}</div>
          <CategoryLine p={hover.p} colors={colors} className="mt-0.5">assessed {ageText(hover.p.assessmentDate)}</CategoryLine>
          <div className="tabular-nums text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
            {hover.p.newRecords != null ? <><span className="text-zinc-900 dark:text-zinc-100">{hover.p.newRecords.toLocaleString()}</span> records since</> : "No records window"}
            {hover.p.total != null && <> · {hover.p.total.toLocaleString()} total</>}
          </div>
          <div className="mt-1 text-zinc-400 dark:text-zinc-500">Click for details</div>
        </div>
      )}
      {pinned && (
        <div ref={cardRef} role="dialog" aria-label={`${pinned.p.name} details`}
          className="absolute z-20 w-[264px] max-w-full cursor-default select-text rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg text-[11px] leading-[15px]"
          style={placedStyle(cardPos)}
          onMouseDown={stop} onMouseUp={stop} onMouseMove={stop}>
          <PinnedCard p={pinned.p} d={pinnedDetails} colors={colors} categoryNames={categoryNames}
            onClose={() => setPinnedKey(null)}
            onShowInTable={() => { setPinnedKey(null); onPointClick(pinned.p.key); }} />
        </div>
      )}
    </div>
  );
}

/** A category swatch and code, then whatever follows it: "● VU · assessed 3 years ago". */
function CategoryLine({ p, colors, label, className = "", children }: { p: PriorityPoint; colors: Record<string, string>; label?: string; className?: string; children?: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-1.5 min-w-0 text-zinc-700 dark:text-zinc-300 ${className}`}>
      <span aria-hidden className="w-2 h-2 shrink-0 rounded-full" style={{ background: colors[p.category] || "#a1a1aa" }} />
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">{label ?? p.category}</span>
      {children && <span className="truncate">· {children}</span>}
    </div>
  );
}

/**
 * The details card: who and what (name, category, criteria), when (the date
 * and how long ago), the GBIF split as numbers and one bar (before the
 * assessment vs since), and where to go next. Fields with no value are left
 * out rather than shown as dashes.
 */
function PinnedCard({ p, d, colors, categoryNames, onClose, onShowInTable }: {
  p: PriorityPoint; d: PriorityDetails | null; colors: Record<string, string>; categoryNames: Record<string, string>;
  onClose: () => void; onShowInTable: () => void;
}) {
  const before = p.total != null && p.newRecords != null ? Math.max(0, p.total - p.newRecords) : null;
  const sincePct = p.total && p.newRecords != null ? Math.round((p.newRecords / p.total) * 100) : null;
  const facts: [string, React.ReactNode][] = [
    ["Assessed", <span key="assessed" className="whitespace-nowrap">{formatDate(p.assessmentDate)} <span className="text-zinc-500 dark:text-zinc-400">· {shortAge(p.assessmentDate)}</span></span>],
  ];
  if (d?.populationTrend) facts.push(["Population", d.populationTrend]);
  if (d?.assessmentCount) facts.push(["Assessments", d.assessmentCount === 1 ? "First assessment" : `${d.assessmentCount} on record`]);
  if (d?.assessors) facts.push(["Assessors", <span key="assessors" className="block truncate" title={d.assessors}>{d.assessors}</span>]);
  const linkClass = "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:underline";

  return (
    <>
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <div className="min-w-0 flex-1">
          <div className="italic font-semibold text-[12px] leading-[16px] text-zinc-900 dark:text-zinc-100 break-words">{p.name}</div>
          {p.commonName && <div className="text-zinc-500 dark:text-zinc-400 truncate">{p.commonName}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close details"
          className="-mr-1 -mt-0.5 shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-800">×</button>
      </div>
      <CategoryLine p={p} colors={colors} label={categoryNames[p.category] ?? p.category} className="px-3 mt-1.5">
        {d?.criteria || null}
      </CategoryLine>

      <dl className="px-3 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
            <dd className="text-zinc-900 dark:text-zinc-100 min-w-0">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mx-3 mt-2.5 pt-2 border-t border-zinc-100 dark:border-zinc-800">
        <div className="flex items-baseline justify-between text-zinc-500 dark:text-zinc-400">
          <span>GBIF records{d ? ` · ${d.recordsLabel.toLowerCase()}` : ""}</span>
          <span className="tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{p.total?.toLocaleString() ?? "—"}</span>
        </div>
        {before != null && p.newRecords != null && p.total ? (
          <>
            {/* One bar: the share recorded before the assessment vs since. */}
            <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden>
              <div className="bg-zinc-300 dark:bg-zinc-600" style={{ width: `${(before / p.total) * 100}%` }} />
              <div className="bg-emerald-500" style={{ width: `${(p.newRecords / p.total) * 100}%` }} />
            </div>
            <div className="mt-1 flex justify-between tabular-nums text-zinc-600 dark:text-zinc-400">
              <span><span aria-hidden className="inline-block w-1.5 h-1.5 mr-1 rounded-full bg-zinc-300 dark:bg-zinc-600" />{before.toLocaleString()} before</span>
              <span><span aria-hidden className="inline-block w-1.5 h-1.5 mr-1 rounded-full bg-emerald-500" />{p.newRecords.toLocaleString()} since{sincePct != null ? ` (${sincePct}%)` : ""}</span>
            </div>
          </>
        ) : p.total === 0 ? <div className="mt-0.5 text-zinc-500 dark:text-zinc-400">None on GBIF</div> : null}
      </div>

      <div className="flex items-center gap-3 px-3 py-2 mt-2.5 border-t border-zinc-100 dark:border-zinc-800">
        <button type="button" onClick={onShowInTable}
          className="h-5 px-2 rounded-md bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 font-medium">
          Show in table
        </button>
        {d?.redListUrl && <a href={d.redListUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>Red List ↗</a>}
        {d?.gbifUrl && <a href={d.gbifUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>GBIF ↗</a>}
      </div>
    </>
  );
}
