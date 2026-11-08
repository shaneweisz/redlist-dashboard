"use client";

/**
 * Reassessment triage: one dot per assessed species, years since its latest
 * assessment across, a GBIF value up (records in total or since the
 * assessment, log scale; or % new, linear), coloured by Red List category: the
 * top right is outdated with plenty of data since. Drag a box to filter the
 * page to the species inside it; click a dot to show that species in the table.
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
export interface PriorityBox { x0: number; x1: number; y0: number; y1: number; keys: ReadonlySet<string> }

export type YScale = "log" | "pct";
/** Plot units up the y axis: log10(count + 1), or the percentage itself. */
export const toPlotY = (value: number, scale: YScale) => (scale === "pct" ? value : Math.log10(value + 1));

// Draw order: least concerning first, so threatened dots sit on top.
const DRAW_RANK: Record<string, number> = { LC: 0, NT: 1, DD: 2, VU: 3, EN: 4, CR: 5, EW: 6, EX: 7 };
// Left: the y title (room for its 20px-tall selects, rotated), then the tick
// labels. Below: the tick labels, then the x title.
const Y_TICKS = 38, X_TICKS = 16, Y_TITLE = 26, X_TITLE = 18;
const M = { left: Y_TITLE + Y_TICKS, right: 12, top: 10, bottom: X_TICKS + X_TITLE };
const HEIGHT = 300;
const HIT_RADIUS = 6;

/** "10y 3m ago", "4m ago", "this month": short, so the tooltip stays narrow (the table says "10y ago"). */
function ageText(date: string): string {
  const { years, months } = yearsMonthsSince(date);
  const parts = [years ? `${years}y` : "", months ? `${months}m` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" ")} ago` : "this month";
}

/** % New as the species table shows it: "<1%" for a sliver, "—" with no records or no window. */
function pctNewText(p: PriorityPoint): string {
  if (!p.total || p.newRecords == null) return "—";
  const pct = (p.newRecords / p.total) * 100;
  return `${pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export default function PriorityScatter({ points, colors, box, onBoxChange, onPointClick, selectedKey, yScale, yAxis, maxYears, maxValue }: {
  points: PriorityPoint[];
  yScale: YScale;
  /** The y axis title, rotated beside the axis; it holds the y metric's controls. */
  yAxis: React.ReactNode;
  /** The axes' extents: the oldest assessment and largest value in the whole taxon. */
  maxYears: number;
  maxValue: number;
  colors: Record<string, string>;
  box: PriorityBox | null;
  onBoxChange: (box: PriorityBox | null) => void;
  /** Clicking a dot: page and scroll the species table to this species. */
  onPointClick: (key: string) => void;
  selectedKey?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ p: PriorityPoint; px: number; py: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

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
      ctx.fillText(`${yr}`, Math.round(sx(yr)) + 0.5, M.top + plotH + 5);
    }

    // The x axis title (the y one is an HTML overlay: it holds the y metric's selects).
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#71717a";
    ctx.textBaseline = "bottom";
    ctx.fillText("Years since latest assessment", M.left + plotW / 2, HEIGHT - 2);

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
  }, [layout, scales, width, box, colors, yScale]);

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
        // <= so the last-drawn (most threatened) dot under the cursor wins.
        if (d <= bestD) { bestD = d; best = i; }
      }
    }
    return best;
  };

  const inPlot = (x: number, y: number) =>
    x >= M.left - 4 && x <= M.left + scales.plotW + 4 && y >= M.top - 4 && y <= M.top + scales.plotH + 4;

  // The drag's origin is kept in a ref (a tap sends mousedown and mouseup back
  // to back, before React re-renders), and the drag is followed on the window:
  // the 0-record dots sit on the x axis, so a box around them is released
  // below the plot, often off the chart, where leaving used to cancel it.
  const dragStart = useRef<{ x0: number; y0: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    if (!inPlot(x, y)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const at = (ev: MouseEvent) => ({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    dragStart.current = { x0: x, y0: y };
    setDrag({ x0: x, y0: y, x1: x, y1: y });
    const move = (ev: MouseEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const p = at(ev);
      setDrag({ ...start, x1: p.x, y1: p.y });
      setHover(null);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      const p = at(ev);
      finishDrag(p.x, p.y);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (dragStart.current) return; // followed on the window (onMouseDown)
    const { x, y } = localXY(e);
    const i = inPlot(x, y) ? hitTest(x, y) : null;
    setHover(i == null ? null : { p: layout.ordered[i], px: layout.xy[i * 2], py: layout.xy[i * 2 + 1] });
  };
  /** Ends a drag at (x, y): a box if it moved, else a click. */
  const finishDrag = (x: number, y: number) => {
    const drag = dragStart.current;
    if (!drag) return;
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
    const i = inPlot(x, y) ? hitTest(x, y) : null;
    if (i != null) onPointClick(layout.ordered[i].key);
    else if (box) onBoxChange(null);
  };

  // Boxes are clamped to the plot plus EDGE px: dots on an axis (the 0-record
  // row, jittered a few px either side of it) are inside a box dragged past it.
  const EDGE = 5;
  const toRect = (l: number, t: number, r: number, b: number) => {
    const { plotW, plotH } = scales;
    const cx = (v: number) => Math.min(Math.max(v, M.left - EDGE), M.left + plotW + EDGE);
    const cy = (v: number) => Math.min(Math.max(v, M.top - EDGE), M.top + plotH + EDGE);
    return { left: cx(l), top: cy(t), width: cx(r) - cx(l), height: cy(b) - cy(t) };
  };
  const boxPx = box && width > 0
    ? toRect(scales.sx(box.x0), scales.sy(box.y1), scales.sx(box.x1), scales.sy(box.y0)) : null;
  const dragPx = drag
    ? toRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1)) : null;

  // The tooltip, measured so it never covers its dot: right of it where it
  // fits, else left, level with it and kept within the chart's height. On a
  // chart too narrow for either side, below the dot (above near the bottom).
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!hover || !el) { setTipPos(null); return; }
    const w = el.offsetWidth, h = el.offsetHeight, gap = 10;
    let left: number, top: number;
    if (hover.px + gap + w <= width || hover.px - gap - w >= 0) {
      left = hover.px + gap + w <= width ? hover.px + gap : hover.px - gap - w;
      top = Math.max(0, Math.min(hover.py - h / 2, HEIGHT - h));
    } else {
      left = Math.max(0, Math.min(hover.px - w / 2, width - w));
      top = hover.py + gap + h <= HEIGHT || hover.py - gap - h < 0 ? hover.py + gap : hover.py - gap - h;
    }
    setTipPos({ left, top });
  }, [hover, width]);
  const selected = selectedKey ? layout.ordered.findIndex((p) => p.key === selectedKey) : -1;

  return (
    <div
      ref={wrapRef}
      // Not overflow-hidden: the boxes are clamped to the plot themselves, and
      // the tooltip may sit just past the chart's edge on a narrow screen.
      className={`relative select-none ${hover && !drag ? "cursor-pointer" : "cursor-crosshair"}`}
      style={{ height: HEIGHT }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setHover(null)}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: HEIGHT, display: "block" }} />
      {/* The y axis title, rotated and centred on the plot's height. Its own
          events: picking an option must not start a drag or hover a dot. */}
      <div className="absolute z-20 whitespace-nowrap cursor-default"
        style={{ left: Y_TITLE / 2, top: M.top + scales.plotH / 2, transform: "translate(-50%, -50%) rotate(-90deg)" }}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseMove={(e) => { e.stopPropagation(); setHover(null); }}>
        {yAxis}
      </div>
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
            className="pointer-events-none absolute z-30 max-w-[240px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1 text-[11px] leading-[14px]"
            // Hidden for the one frame before it is measured, so it never flashes in the wrong place.
            style={tipPos ? { left: tipPos.left, top: tipPos.top } : { left: 0, top: 0, visibility: "hidden" }}
          >
            <div className="italic text-zinc-900 dark:text-zinc-100">{hover.p.name}</div>
            {hover.p.commonName && <div className="text-zinc-500 dark:text-zinc-400">{hover.p.commonName}</div>}
            <div className="mt-0.5 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
              <span className="font-semibold" style={{ color: colors[hover.p.category] }}>{hover.p.category}</span>
              {" · "}assessed {ageText(hover.p.assessmentDate)}
            </div>
            {/* GBIF records in the species table's terms, spelt out: Total / New (since the assessment) / % new records. */}
            <table className="mt-1 tabular-nums text-zinc-700 dark:text-zinc-300">
              <tbody>
                <tr><td className="pr-3">Total records</td><td className="text-right font-semibold text-zinc-900 dark:text-zinc-100">{hover.p.total?.toLocaleString() ?? "—"}</td></tr>
                <tr><td className="pr-3">New records</td><td className="text-right">{hover.p.newRecords?.toLocaleString() ?? "—"}</td></tr>
                <tr><td className="pr-3">% new records</td><td className="text-right">{pctNewText(hover.p)}</td></tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
