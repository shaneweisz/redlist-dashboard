"use client";

/**
 * Reassessment priority: one dot per assessed species, years since its latest
 * assessment across, its GBIF value up (the GBIF chart's metric: records in
 * total or since the assessment on a log scale, or % new on a linear one),
 * coloured by Red List category. Histograms along the top and right are the
 * two distributions it replaces, the Years Since Assessed and GBIF Records
 * charts, drawn on the scatter's own axes: click a bar to filter by it, as
 * before. Drag a box to filter the page to the dots inside it; click a dot to
 * open that species.
 *
 * Canvas rather than SVG for the dots: "All species" is ~175k of them. The
 * histograms, hover and drag box are DOM/SVG overlays, so the canvas only
 * redraws when the data or the box changes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { yearsMonthsSince } from "@/lib/outdated";
import { formatCountLabel } from "./chart-tooltip";

export interface PriorityPoint {
  key: string;
  name: string;
  commonName?: string | null;
  category: string;
  /** Years since the latest assessment. */
  years: number;
  /** The plotted GBIF value: a record count, or a percentage for "pct". */
  value: number;
  /** GBIF records in total and since the assessment (current record mode), for the tooltip. */
  total: number | null;
  newRecords: number | null;
  assessmentDate: string;
  /** Outside another histogram's selection: drawn faded, not dropped. */
  dim?: boolean;
}

/**
 * A selection: the box in plot units, for drawing, and the species whose dots
 * were inside it as drawn. Filtering by the keys rather than re-testing the box
 * keeps it exactly what you see: dots are jittered a few pixels, so a tight box
 * around one dot could miss its unjittered position and select nothing.
 */
export interface PriorityBox { x0: number; x1: number; y0: number; y1: number; keys: ReadonlySet<string> }

/** One histogram bar, spanning [from, to] on its axis (years, or raw GBIF values). */
export interface HistBin {
  key: string;
  from: number;
  to: number;
  count: number;
  /** The bar's name ("10-20 years", "2016", "1K-10K"). */
  title: string;
  /** "3,871 (64%)", as the old charts labelled their bars. */
  label: string;
  selected: boolean;
}

export type YScale = "log" | "pct";

// Draw order: least concerning first, so threatened dots sit on top.
const DRAW_RANK: Record<string, number> = { LC: 0, NT: 1, DD: 2, VU: 3, EN: 4, CR: 5, EW: 6, EX: 7 };
const TOP_HIST = 46;
const RIGHT_HIST = 64;
const M = { left: 44, right: 8 + RIGHT_HIST + 6, top: 6 + TOP_HIST + 6, bottom: 30 };
const HIT_RADIUS = 6;
const X_COLOR = "#3b82f6";
const Y_COLOR = "#10b981";

/** "10 years, 3 months ago", "4 months ago", "this month". */
function ageText(date: string): string {
  const { years, months } = yearsMonthsSince(date);
  const parts = [years ? `${years} year${years === 1 ? "" : "s"}` : "", months ? `${months} month${months === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(", ")} ago` : "this month";
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export default function PriorityScatter({
  points, colors, box, onBoxChange, onPointClick, selectedKey,
  yScale, yTitle, xBins, yBins, onXBin, onYBin, height: fixedHeight,
}: {
  points: PriorityPoint[];
  colors: Record<string, string>;
  box: PriorityBox | null;
  onBoxChange: (box: PriorityBox | null) => void;
  onPointClick: (key: string) => void;
  selectedKey?: string | null;
  yScale: YScale;
  yTitle: string;
  xBins: HistBin[];
  yBins: HistBin[];
  onXBin: (key: string, e: React.MouseEvent) => void;
  onYBin: (key: string, e: React.MouseEvent) => void;
  /** Fixed height in px; omit to fill the parent (a flex column), at least 380px. */
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const height = fixedHeight ?? Math.max(380, measuredHeight);
  const [hover, setHover] = useState<{ p: PriorityPoint; px: number; py: number } | null>(null);
  const [hoverBin, setHoverBin] = useState<{ bin: HistBin; px: number; py: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setWidth(Math.floor(e.contentRect.width));
      setMeasuredHeight(Math.floor(e.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Plot units: years across; up, log10(value + 1) for counts, the value itself for %.
  const toY = useMemo(() => (yScale === "pct" ? (v: number) => v : (v: number) => Math.log10(v + 1)), [yScale]);

  // Scales. X runs to the oldest assessment (rounded up to 5 years); Y to the
  // largest count's power of ten, or 100%.
  const scales = useMemo(() => {
    let maxYears = 10, maxY = yScale === "pct" ? 100 : 3;
    for (const p of points) {
      if (p.years > maxYears) maxYears = p.years;
      if (yScale === "log") { const y = toY(p.value); if (y > maxY) maxY = y; }
    }
    const xMax = Math.ceil(maxYears / 5) * 5;
    const yMax = yScale === "pct" ? 100 : Math.ceil(maxY);
    const plotW = Math.max(0, width - M.left - M.right);
    const plotH = height - M.top - M.bottom;
    const clampX = (v: number) => Math.min(Math.max(v, 0), xMax);
    const clampY = (v: number) => Math.min(Math.max(v, 0), yMax);
    return {
      xMax, yMax, plotW, plotH, clampX, clampY,
      sx: (years: number) => M.left + (years / xMax) * plotW,
      sy: (y: number) => M.top + plotH - (y / yMax) * plotH,
      ix: (px: number) => ((px - M.left) / plotW) * xMax,
      iy: (py: number) => ((M.top + plotH - py) / plotH) * yMax,
    };
  }, [points, width, height, yScale, toY]);

  // Screen positions (with a little deterministic vertical jitter, so the many
  // species on the same value, above all 0, show as a band rather than a line),
  // plus a coarse grid for hover hit-testing.
  const layout = useMemo(() => {
    const ordered = [...points].sort((a, b) =>
      (a.dim === b.dim ? 0 : a.dim ? -1 : 1) || (DRAW_RANK[a.category] ?? 0) - (DRAW_RANK[b.category] ?? 0));
    const xy = new Float32Array(ordered.length * 2);
    const grid = new Map<number, number[]>();
    const cell = 12;
    ordered.forEach((p, i) => {
      let h = 0;
      for (let c = 0; c < p.key.length; c++) h = (h * 31 + p.key.charCodeAt(c)) | 0;
      const jitter = ((h & 1023) / 1023 - 0.5) * 6;
      const x = scales.sx(p.years), y = scales.sy(scales.clampY(toY(p.value))) + jitter;
      xy[i * 2] = x; xy[i * 2 + 1] = y;
      const k = Math.floor(x / cell) * 10007 + Math.floor(y / cell);
      const bucket = grid.get(k);
      if (bucket) bucket.push(i); else grid.set(k, [i]);
    });
    return { ordered, xy, grid, cell };
  }, [points, scales, toY]);

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
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
      ctx.fillText(`${yr}y`, Math.round(sx(yr)) + 0.5, M.top + plotH + 5);
    }

    // Dots.
    const { ordered, xy } = layout;
    const big = ordered.length > 20000;
    const r = big ? 1.2 : 2.4;
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      const dim = p.dim || (box ? !box.keys.has(p.key) : false);
      ctx.globalAlpha = dim ? 0.1 : big ? 0.5 : 0.75;
      ctx.fillStyle = colors[p.category] || "#a1a1aa";
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (big) ctx.fillRect(x - r, y - r, r * 2, r * 2);
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }, [layout, scales, width, height, box, colors, yScale]);

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

  const onMouseDown = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    if (!inPlot(x, y)) return;
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    if (drag) { setDrag({ ...drag, x1: x, y1: y }); setHover(null); return; }
    const i = inPlot(x, y) ? hitTest(x, y) : null;
    setHover(i == null ? null : { p: layout.ordered[i], px: layout.xy[i * 2], py: layout.xy[i * 2 + 1] });
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (!drag) return;
    const { x, y } = localXY(e);
    setDrag(null);
    const moved = Math.abs(x - drag.x0) > 4 || Math.abs(y - drag.y0) > 4;
    if (moved) {
      const { ix, iy } = scales;
      const left = Math.min(drag.x0, x), right = Math.max(drag.x0, x);
      const top = Math.min(drag.y0, y), bottom = Math.max(drag.y0, y);
      const keys = new Set<string>();
      const { ordered, xy } = layout;
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].dim) continue;
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

  // Clamped to the plot, so a box dragged past an axis stays inside the chart.
  const boxPx = box && width > 0 ? (() => {
    const { sx, sy, clampX, clampY } = scales;
    const left = sx(clampX(box.x0)), right = sx(clampX(box.x1));
    const top = sy(clampY(box.y1)), bottom = sy(clampY(box.y0));
    return { left, top, width: right - left, height: bottom - top };
  })() : null;
  const dragPx = drag ? (() => {
    const { plotW, plotH } = scales;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const x0 = clamp(Math.min(drag.x0, drag.x1), M.left, M.left + plotW), x1 = clamp(Math.max(drag.x0, drag.x1), M.left, M.left + plotW);
    const y0 = clamp(Math.min(drag.y0, drag.y1), M.top, M.top + plotH), y1 = clamp(Math.max(drag.y0, drag.y1), M.top, M.top + plotH);
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  })() : null;
  const selected = selectedKey ? layout.ordered.findIndex((p) => p.key === selectedKey) : -1;

  // Histogram geometry, on the scatter's own axes.
  const xAny = xBins.some((b) => b.selected), yAny = yBins.some((b) => b.selected);
  const xMaxCount = Math.max(1, ...xBins.map((b) => b.count));
  const yMaxCount = Math.max(1, ...yBins.map((b) => b.count));
  const xBars = width > 0 ? xBins.map((bin) => {
    const left = scales.sx(scales.clampX(bin.from)), right = scales.sx(scales.clampX(bin.to));
    const h = (bin.count / xMaxCount) * (TOP_HIST - 12);
    return { bin, left: left + 0.5, width: Math.max(1, right - left - 1), top: 6 + TOP_HIST - h, height: h };
  }).filter((b) => b.width > 0) : [];
  const yBars = width > 0 ? yBins.map((bin) => {
    const top = scales.sy(scales.clampY(toY(bin.to))), bottom = scales.sy(scales.clampY(toY(bin.from)));
    const w = (bin.count / yMaxCount) * (RIGHT_HIST - 26);
    return { bin, top: top + 0.5, height: Math.max(1, bottom - top - 1), left: M.left + scales.plotW + 8, width: w };
  }).filter((b) => b.height > 0) : [];
  const barOpacity = (bin: HistBin, any: boolean) => (any && !bin.selected ? 0.3 : 1);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden select-none"
      style={fixedHeight ? { height: fixedHeight } : { flex: 1, minHeight: 380 }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { setHover(null); setHoverBin(null); setDrag(null); }}
    >
      <canvas ref={canvasRef} role="img" aria-label={`Scatter of years since assessed against ${yTitle}`} style={{ position: "absolute", inset: 0, width: "100%", height, display: "block", cursor: "crosshair" }} />

      {/* The x axis's title; the y axis is named by the GBIF controls in the card header. */}
      <div className="pointer-events-none absolute text-[10px] text-zinc-400" style={{ right: M.right, bottom: 2 }}>
        Years since assessed →
      </div>

      {/* Histograms: the old Years Since Assessed and GBIF Records charts. */}
      {[...xBars.map((b) => ({ ...b, axis: "x" as const })), ...yBars.map((b) => ({ ...b, axis: "y" as const }))].map(({ bin, axis, ...r }) => (
        <button
          key={`${axis}-${bin.key}`}
          type="button"
          aria-pressed={bin.selected}
          aria-label={`${bin.title}: ${formatCountLabel(bin.label)}`}
          className="absolute rounded-[2px] cursor-pointer transition-opacity hover:brightness-110"
          style={{ ...r, backgroundColor: axis === "x" ? X_COLOR : Y_COLOR, opacity: barOpacity(bin, axis === "x" ? xAny : yAny) }}
          onMouseDown={stop}
          onMouseUp={stop}
          onMouseMove={(e) => { e.stopPropagation(); setHover(null); setHoverBin({ bin, px: r.left + r.width / 2, py: r.top + r.height / 2 }); }}
          onMouseLeave={() => setHoverBin(null)}
          onClick={(e) => (axis === "x" ? onXBin : onYBin)(bin.key, e)}
        />
      ))}
      {/* Counts beside the bars, where they fit. */}
      {xBars.filter((b) => b.width >= 30).map(({ bin, left, width: w, top }) => (
        <div key={`xl-${bin.key}`} className="pointer-events-none absolute text-[10px] leading-[12px] text-center text-zinc-500 dark:text-zinc-400 tabular-nums"
          style={{ left, width: w, top: top - 12 }}>{formatCount(bin.count)}</div>
      ))}
      {yBars.filter((b) => b.height >= 11).map(({ bin, left, width: w, top, height: h }) => (
        <div key={`yl-${bin.key}`} className="pointer-events-none absolute text-[10px] leading-[12px] text-zinc-500 dark:text-zinc-400 tabular-nums"
          style={{ left: left + w + 3, top: top + h / 2 - 6 }}>{formatCount(bin.count)}</div>
      ))}

      {(dragPx ?? boxPx) && (
        <div className="pointer-events-none absolute rounded-sm border border-zinc-500/70 bg-zinc-500/10 dark:border-zinc-300/70 dark:bg-zinc-300/10"
          style={dragPx ?? boxPx ?? undefined} />
      )}
      {selected >= 0 && (
        <div className="pointer-events-none absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full ring-2 ring-zinc-900 dark:ring-white"
          style={{ left: layout.xy[selected * 2], top: layout.xy[selected * 2 + 1] }} />
      )}

      {hoverBin && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1 text-[11px] leading-[14px] whitespace-nowrap"
          style={{
            left: hoverBin.px > width - 180 ? undefined : hoverBin.px + 10,
            right: hoverBin.px > width - 180 ? width - hoverBin.px + 10 : undefined,
            top: Math.max(0, hoverBin.py - 14),
          }}
        >
          <div className="text-zinc-500 dark:text-zinc-400">{hoverBin.bin.title}</div>
          <div className="text-zinc-700 dark:text-zinc-300">
            <span className="font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">{hoverBin.bin.count.toLocaleString()}</span> species
            {hoverBin.bin.label.match(/\((\d+%)\)/) && <span className="text-zinc-500 dark:text-zinc-400"> · {hoverBin.bin.label.match(/\((\d+%)\)/)![1]}</span>}
          </div>
          <div className="mt-0.5 text-zinc-400">Click to filter · ⌘/Ctrl-click to add</div>
        </div>
      )}

      {hover && (
        <>
          <div className="pointer-events-none absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full ring-1 ring-zinc-900 dark:ring-white"
            style={{ left: hover.px, top: hover.py }} />
          <div
            className="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1 text-[11px] leading-[14px]"
            style={{
              left: hover.px > width - 200 ? undefined : hover.px + 10,
              right: hover.px > width - 200 ? width - hover.px + 10 : undefined,
              top: Math.min(Math.max(0, hover.py - 40), height - 130),
            }}
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
            <div className="mt-0.5 text-zinc-400">Click to open · drag to select an area</div>
          </div>
        </>
      )}
    </div>
  );
}
