"use client";

/**
 * Reassessment priority: one dot per assessed species, years since its latest
 * assessment across, GBIF records dated after that assessment up (log scale),
 * coloured by Red List category. The top-right corner is "outdated, and new
 * evidence has arrived since". Drag a box to filter the page to the species
 * inside it; click a dot to open that species.
 *
 * Canvas rather than SVG: "All species" is ~175k dots. Hover and the drag box
 * are DOM overlays, so the canvas only redraws when the data or box changes.
 */
import { useEffect, useMemo, useRef, useState } from "react";

export interface PriorityPoint {
  key: string;
  name: string;
  commonName?: string | null;
  category: string;
  /** Years since the latest assessment. */
  years: number;
  /** GBIF records dated after the assessment (current record mode). */
  newRecords: number;
}

/** A selection in data units: years, and log10(newRecords + 1). */
export interface PriorityBox { x0: number; x1: number; y0: number; y1: number }

export const pointY = (newRecords: number) => Math.log10(newRecords + 1);
export const inBox = (box: PriorityBox, years: number, newRecords: number) => {
  const y = pointY(newRecords);
  return years >= box.x0 && years <= box.x1 && y >= box.y0 && y <= box.y1;
};

/** The corner the chart highlights: assessed 10+ years ago, 100+ new records since. */
export const OUTDATED_YEARS = 10;
export const NEW_EVIDENCE_RECORDS = 100;

// Draw order: least concerning first, so threatened dots sit on top.
const DRAW_RANK: Record<string, number> = { LC: 0, NT: 1, DD: 2, VU: 3, EN: 4, CR: 5, EW: 6, EX: 7 };
const M = { left: 44, right: 12, top: 10, bottom: 28 };
const HEIGHT = 280;
const HIT_RADIUS = 6;

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export default function PriorityScatter({ points, colors, box, onBoxChange, onPointClick, selectedKey }: {
  points: PriorityPoint[];
  colors: Record<string, string>;
  box: PriorityBox | null;
  onBoxChange: (box: PriorityBox | null) => void;
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

  // Scales. X runs to the oldest assessment (rounded up to 5 years); Y to the
  // largest count's power of ten.
  const scales = useMemo(() => {
    let maxYears = OUTDATED_YEARS * 2, maxY = 3;
    for (const p of points) {
      if (p.years > maxYears) maxYears = p.years;
      const y = pointY(p.newRecords);
      if (y > maxY) maxY = y;
    }
    const xMax = Math.ceil(maxYears / 5) * 5;
    const yMax = Math.ceil(maxY);
    const plotW = Math.max(0, width - M.left - M.right);
    const plotH = HEIGHT - M.top - M.bottom;
    return {
      xMax, yMax, plotW, plotH,
      sx: (years: number) => M.left + (years / xMax) * plotW,
      sy: (y: number) => M.top + plotH - (y / yMax) * plotH,
      ix: (px: number) => ((px - M.left) / plotW) * xMax,
      iy: (py: number) => ((M.top + plotH - py) / plotH) * yMax,
    };
  }, [points, width]);

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
      const x = scales.sx(p.years), y = scales.sy(pointY(p.newRecords)) + jitter;
      xy[i * 2] = x; xy[i * 2 + 1] = y;
      const k = Math.floor(x / cell) * 10007 + Math.floor(y / cell);
      const bucket = grid.get(k);
      if (bucket) bucket.push(i); else grid.set(k, [i]);
    });
    return { ordered, xy, grid, cell };
  }, [points, scales]);

  const corner = useMemo(() => {
    let n = 0;
    for (const p of points) if (p.years >= OUTDATED_YEARS && p.newRecords >= NEW_EVIDENCE_RECORDS) n++;
    return n;
  }, [points]);

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

    // The highlighted corner.
    const cx = sx(OUTDATED_YEARS), cy = sy(pointY(NEW_EVIDENCE_RECORDS));
    ctx.fillStyle = "rgba(239, 68, 68, 0.06)";
    ctx.fillRect(cx, M.top, M.left + plotW - cx, cy - M.top);

    // Grid and ticks.
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#a1a1aa";
    ctx.strokeStyle = "rgba(161, 161, 170, 0.18)";
    ctx.lineWidth = 1;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let e = 0; e <= yMax; e++) {
      const y = Math.round(sy(e)) + 0.5;
      ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(M.left + plotW, y); ctx.stroke();
      ctx.fillText(e === 0 ? "0" : formatCount(10 ** e), M.left - 6, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let yr = 0; yr <= xMax; yr += 5) {
      const x = Math.round(sx(yr)) + 0.5;
      ctx.fillText(`${yr}y`, x, M.top + plotH + 6);
    }

    // Threshold lines.
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(161, 161, 170, 0.6)";
    ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, M.top); ctx.lineTo(Math.round(cx) + 0.5, M.top + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(M.left, Math.round(cy) + 0.5); ctx.lineTo(M.left + plotW, Math.round(cy) + 0.5); ctx.stroke();
    ctx.setLineDash([]);

    // Dots.
    const { ordered, xy } = layout;
    const big = ordered.length > 20000;
    const r = big ? 1.2 : 2.4;
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      const dim = box ? !inBox(box, p.years, p.newRecords) : false;
      ctx.globalAlpha = dim ? 0.12 : big ? 0.5 : 0.75;
      ctx.fillStyle = colors[p.category] || "#a1a1aa";
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (big) ctx.fillRect(x - r, y - r, r * 2, r * 2);
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }, [layout, scales, width, box, colors]);

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

  const onMouseDown = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    if (drag) { setDrag({ ...drag, x1: x, y1: y }); setHover(null); return; }
    const i = hitTest(x, y);
    setHover(i == null ? null : { p: layout.ordered[i], px: layout.xy[i * 2], py: layout.xy[i * 2 + 1] });
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (!drag) return;
    const { x, y } = localXY(e);
    setDrag(null);
    const moved = Math.abs(x - drag.x0) > 4 || Math.abs(y - drag.y0) > 4;
    if (moved) {
      const { ix, iy } = scales;
      onBoxChange({
        x0: Math.max(0, ix(Math.min(drag.x0, x))), x1: ix(Math.max(drag.x0, x)),
        y0: Math.max(0, iy(Math.max(drag.y0, y))), y1: iy(Math.min(drag.y0, y)),
      });
      return;
    }
    const i = hitTest(x, y);
    if (i != null) onPointClick(layout.ordered[i].key);
    else if (box) onBoxChange(null);
  };

  const boxPx = box && width > 0 ? {
    left: scales.sx(box.x0), top: scales.sy(box.y1),
    width: scales.sx(box.x1) - scales.sx(box.x0), height: scales.sy(box.y0) - scales.sy(box.y1),
  } : null;
  const dragPx = drag ? {
    left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1),
    width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0),
  } : null;
  const selected = selectedKey ? layout.ordered.findIndex((p) => p.key === selectedKey) : -1;

  return (
    <div
      ref={wrapRef}
      className="relative select-none cursor-crosshair"
      style={{ height: HEIGHT }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { setHover(null); setDrag(null); }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: HEIGHT, display: "block" }} />
      {width > 0 && (
        <div className="pointer-events-none absolute text-[10px] leading-[13px] text-right text-red-600/80 dark:text-red-400/80"
          style={{ right: M.right + 6, top: M.top + 4 }}>
          <div className="font-semibold">Outdated, with new evidence</div>
          <div>{OUTDATED_YEARS}+ yrs since assessed · {NEW_EVIDENCE_RECORDS}+ new records · {corner.toLocaleString()} species</div>
        </div>
      )}
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
            className="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1 text-[11px] leading-[14px]"
            style={{
              left: hover.px > width - 200 ? undefined : hover.px + 10,
              right: hover.px > width - 200 ? width - hover.px + 10 : undefined,
              top: Math.max(0, hover.py - 40),
            }}
          >
            <div className="italic text-zinc-900 dark:text-zinc-100">{hover.p.name}</div>
            {hover.p.commonName && <div className="text-zinc-500 dark:text-zinc-400">{hover.p.commonName}</div>}
            <div className="mt-0.5 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
              <span className="font-semibold" style={{ color: colors[hover.p.category] }}>{hover.p.category}</span>
              {" · "}assessed {hover.p.years.toFixed(1)} yrs ago
            </div>
            <div className="text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">{hover.p.newRecords.toLocaleString()}</span> GBIF records since
            </div>
            <div className="mt-0.5 text-zinc-400">Click to open · drag to select an area</div>
          </div>
        </>
      )}
    </div>
  );
}
