"use client";

/**
 * Reassessment triage: one dot per assessed species, years since its latest
 * assessment across, a GBIF value up (records in total or since the
 * assessment, log scale; or % new, linear), coloured by Red List category: the
 * top right is outdated with plenty of data since. Drag a box to filter the
 * page to the species inside it; click a dot to show that species in the
 * table. The hover tooltip can be moused into and expanded for the assessment's
 * details (criteria, trend, the credits) without leaving the chart.
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
/** What the expanded tooltip adds, looked up only for the one species expanded. */
export interface PriorityDetails {
  criteria: string | null;
  populationTrend: string | null;
  possiblyExtinct: boolean;
  assessmentCount: number | null;
  assessors: string | null;
  reviewers: string | null;
  facilitators: string | null;
  contributors: string | null;
  institutions: string | null;
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

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Where a floating box of size w×h goes beside an anchor at (px, py): right of
 * and level with it where it fits, else left of it, and nudged up or down to
 * stay inside the chart (an unclamped box near the bottom ran off it). A box
 * taller than the chart starts at its top and runs on below it. Null until
 * measured, so it never flashes misplaced.
 */
function usePlacement(ref: React.RefObject<HTMLDivElement | null>, anchor: { px: number; py: number } | null, width: number, gap: number, grown: boolean) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) { setPos(null); return; }
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos((prev) => {
      let left: number, top: number;
      if (grown && prev) {
        // Grown in place (expanded under the cursor): keep its top and only
        // shift left as far as it must to fit. Re-placing it could flip it to
        // the dot's other side, out from under the cursor, which closes it.
        left = Math.max(0, Math.min(prev.left, width - w));
        top = prev.top;
      } else {
        left = anchor.px + gap + w <= width ? anchor.px + gap : Math.max(0, anchor.px - gap - w);
        top = Math.max(0, Math.min(anchor.py - h / 2, HEIGHT - h));
      }
      return prev && prev.left === left && prev.top === top ? prev : { left, top };
    });
  }, [ref, anchor, width, gap, grown]);
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
  /** Clicking a dot: page and scroll the species table to this species. */
  onPointClick: (key: string) => void;
  details: (key: string) => PriorityDetails | null;
  selectedKey?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ p: PriorityPoint; px: number; py: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** The tooltip shows the assessment's details too (its "More details" was clicked). */
  const [expanded, setExpanded] = useState(false);

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
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLeave = () => { if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; } };
  useEffect(() => cancelLeave, []);
  const onMouseMove = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    const start = dragStart.current;
    if (start) { setDrag({ ...start, x1: x, y1: y }); setHover(null); return; }
    const i = hitTest(x, y);
    if (i != null) {
      cancelLeave();
      if (hover?.p.key !== layout.ordered[i].key) setExpanded(false);
      setHover({ p: layout.ordered[i], px: layout.xy[i * 2], py: layout.xy[i * 2 + 1] });
    } else if (hover && !leaveTimer.current) {
      // Off the dot: keep the tooltip a moment, so the mouse can cross the gap into it.
      leaveTimer.current = setTimeout(() => { leaveTimer.current = null; setHover(null); setExpanded(false); }, 300);
    }
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
    const i = hitTest(x, y);
    if (i != null) onPointClick(layout.ordered[i].key);
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
  const hoverDetails = useMemo(() => (hover && expanded ? details(hover.p.key) : null), [hover, expanded, details]);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipPos = usePlacement(tipRef, hover, width, 10, expanded);
  // Events inside the tooltip are its own: no drags, hit tests or dot clicks.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      ref={wrapRef}
      // Not overflow-hidden: the drag box and selection are clamped to the plot
      // themselves, and the expanded tooltip may run past the chart's bottom.
      className="relative select-none cursor-crosshair"
      style={{ height: HEIGHT }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { cancelLeave(); setHover(null); setExpanded(false); setDrag(null); dragStart.current = null; }}
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
      {hover && (
        <>
          <div className="pointer-events-none absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full ring-1 ring-zinc-900 dark:ring-white"
            style={{ left: hover.px, top: hover.py }} />
          <div
            ref={tipRef}
            role="tooltip"
            className={`absolute z-30 ${expanded ? "w-[280px]" : "max-w-[260px]"} max-w-full cursor-default select-text rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1 text-[11px] leading-[14px]`}
            style={placedStyle(tipPos)}
            onMouseEnter={cancelLeave}
            onMouseLeave={() => { setHover(null); setExpanded(false); }}
            onMouseDown={stop} onMouseUp={stop} onMouseMove={stop}
          >
            <div className="italic text-zinc-900 dark:text-zinc-100">{hover.p.name}</div>
            {hover.p.commonName && <div className="text-zinc-500 dark:text-zinc-400">{hover.p.commonName}</div>}
            <div className="mt-0.5 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
              <span className="font-semibold" style={{ color: colors[hover.p.category] }}>{hover.p.category}</span>
              {" · "}assessed {ageText(hover.p.assessmentDate)}
            </div>
            <table className="mt-1 tabular-nums text-zinc-700 dark:text-zinc-300">
              <tbody>
                <tr><td className="pr-3">GBIF records</td><td className="text-right font-semibold text-zinc-900 dark:text-zinc-100">{hover.p.total?.toLocaleString() ?? "—"}</td></tr>
                <tr><td className="pr-3">At assessment</td><td className="text-right">{hover.p.total != null && hover.p.newRecords != null ? Math.max(0, hover.p.total - hover.p.newRecords).toLocaleString() : "—"}</td></tr>
                <tr><td className="pr-3">Since</td><td className="text-right">{hover.p.newRecords?.toLocaleString() ?? "—"}</td></tr>
              </tbody>
            </table>
            {expanded && hoverDetails && <TooltipDetails p={hover.p} d={hoverDetails} categoryNames={categoryNames} />}
            <div className="mt-1 flex items-center justify-between gap-3 text-zinc-400">
              <span>Click the dot to show in table</span>
              <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
                className="shrink-0 text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 font-medium">
                {expanded ? "Less ▴" : "More ▾"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The expanded tooltip's Red List details, grouped: the assessment itself,
 * then who made it, then links out. Rows with no value are left out.
 */
function TooltipDetails({ p, d, categoryNames }: { p: PriorityPoint; d: PriorityDetails; categoryNames: Record<string, string> }) {
  const assessment: [string, React.ReactNode][] = [
    ["Category", `${categoryNames[p.category] ?? p.category}${d.possiblyExtinct ? " (possibly extinct)" : ""}`],
    ["Criteria", d.criteria],
    ["Assessed", formatDate(p.assessmentDate)],
    ["Population", d.populationTrend],
    ["Assessments", d.assessmentCount ? `${d.assessmentCount} on record` : null],
  ];
  const credits: [string, React.ReactNode][] = [
    ["Assessors", d.assessors],
    ["Reviewers", d.reviewers],
    ["Facilitators", d.facilitators],
    ["Contributors", d.contributors],
    ["Institutions", d.institutions],
  ];
  const linkClass = "text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 hover:underline";
  return (
    <>
      <DetailGroup title="Assessment" rows={assessment} />
      <DetailGroup title="Credits" rows={credits} />
      {(d.redListUrl || d.gbifUrl) && (
        <div className="mt-1.5 pt-1.5 border-t border-zinc-100 dark:border-zinc-800 flex gap-3">
          {d.redListUrl && <a href={d.redListUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>Red List ↗</a>}
          {d.gbifUrl && <a href={d.gbifUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>GBIF ↗</a>}
        </div>
      )}
    </>
  );
}

function DetailGroup({ title, rows }: { title: string; rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v != null && v !== "");
  if (!shown.length) return null;
  return (
    <div className="mt-1.5 pt-1.5 border-t border-zinc-100 dark:border-zinc-800">
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{title}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {shown.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
            <dd className="text-zinc-900 dark:text-zinc-100 min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
