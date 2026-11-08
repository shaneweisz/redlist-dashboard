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
 * Quiet grey bars along the bottom and left edges are the dots' distribution
 * along each axis, in even bins lined up with the ticks: 5 years across, one
 * power of ten (or 10%) up. With a box drawn, each bar's share inside it is
 * shaded darker. Clicking a bar selects that band, the same box filter as a
 * drag, so there is one way to select here. A dot outside another filter that
 * this chart ignores (an age or GBIF range, 10+ yrs old) is faded, not dropped.
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
  /** Outside an edge-bar selection: drawn faded, not selectable by a box. */
  dim?: boolean;
}

/** One edge bar: a band of its axis, [lo, hi) in data units (years, or the raw GBIF value). */
interface Bin { key: string; lo: number; hi: number; label: string; count: number; inBox: number }

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
  /** Countries of occurrence (names, sorted). */
  countries: string[];
  redListUrl: string | null;
  gbifUrl: string | null;
}

export interface PriorityBox {
  x0: number; x1: number; y0: number; y1: number; keys: ReadonlySet<string>;
  /** Set when the box is an edge bar's band (clicking that bar again clears it). */
  band?: string;
}

export type YScale = "log" | "pct";
/** Plot units up the y axis: log10(count + 1), or the percentage itself. */
export const toPlotY = (value: number, scale: YScale) => (scale === "pct" ? value : Math.log10(value + 1));

// Draw order: least concerning first, so threatened dots sit on top.
const DRAW_RANK: Record<string, number> = { LC: 0, NT: 1, DD: 2, VU: 3, EN: 4, CR: 5, EW: 6, EX: 7 };
// The edge bars' depth. Outward from the plot on the left: tick labels, the
// bars (growing leftward), the y title. Below it: tick labels, the bars
// (growing down), the x title.
const BOTTOM_HIST = 28;
const LEFT_HIST = 36;
const Y_TICKS = 38, X_TICKS = 16, Y_TITLE = 16, X_TITLE = 18;
const M = { left: Y_TITLE + LEFT_HIST + 4 + Y_TICKS, right: 12, top: 10, bottom: X_TICKS + 4 + BOTTOM_HIST + X_TITLE };
/** The chart fills its card's height (beside Status and Country), but never less than this. */
const MIN_HEIGHT = 380;
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
 * Where a floating box of size w×h goes so it never covers its dot at (px, py):
 * right of the dot where it fits, else left of it, level with the dot and
 * nudged to stay within the chart's height (a box taller than the chart
 * starts at its top and runs on below). Where neither side fits (a narrow
 * chart), it goes below the dot, or above it if there is room only there.
 *
 * Grown (expanded under the cursor), it keeps its place and grows away from
 * the dot: down, or up when it sits above. Re-placing it could move it out
 * from under the cursor, which closes it. Null until measured.
 */
type Placement = { left: number; top: number; side: "right" | "left" | "below" | "above" };
function usePlacement(ref: React.RefObject<HTMLDivElement | null>, anchor: { px: number; py: number } | null, width: number, height: number, gap: number, grown: boolean) {
  const [pos, setPos] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) { setPos(null); return; }
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos((prev) => {
      let next: Placement;
      if (grown && prev) {
        next = prev.side === "above" ? { ...prev, top: anchor.py - gap - h } : prev;
      } else if (anchor.px + gap + w <= width || anchor.px - gap - w >= 0) {
        const right = anchor.px + gap + w <= width;
        next = {
          side: right ? "right" : "left",
          left: right ? anchor.px + gap : anchor.px - gap - w,
          top: Math.max(0, Math.min(anchor.py - h / 2, height - h)),
        };
      } else {
        const left = Math.max(0, Math.min(anchor.px - w / 2, width - w));
        const above = anchor.py + gap + h > height && anchor.py - gap - h >= 0;
        next = { side: above ? "above" : "below", left, top: above ? anchor.py - gap - h : anchor.py + gap };
      }
      return prev && prev.left === next.left && prev.top === next.top && prev.side === next.side ? prev : next;
    });
  }, [ref, anchor, width, height, gap, grown]);
  return pos;
}
const placedStyle = (pos: { left: number; top: number } | null): React.CSSProperties =>
  pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" };

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

export default function PriorityScatter({ points, colors, categoryNames, box, onBoxChange, onPointClick, details, selectedKey, yScale, yLabel, maxYears, maxValue }: {
  points: PriorityPoint[];
  yScale: YScale;
  /** The y axis title, e.g. "New GBIF records". */
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
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [hover, setHover] = useState<{ p: PriorityPoint; px: number; py: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The hovered edge bar, by key: its counts are read live, so the tooltip follows a box drawn meanwhile.
  const [hoverBin, setHoverBin] = useState<{ key: string; px: number; py: number } | null>(null);
  /** The tooltip shows the assessment's details too (its "More details" was clicked). */
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setWidth(Math.floor(e.contentRect.width));
      setHeight(Math.max(MIN_HEIGHT, Math.floor(e.contentRect.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scales. X runs to the taxon's oldest assessment (rounded up to 5 years); Y
  // to its largest count's power of ten, or 100%.
  const scales = useMemo(() => {
    const xMax = Math.max(10, Math.ceil(maxYears / 5) * 5);
    const yMax = yScale === "pct" ? 100 : Math.max(1, Math.ceil(toPlotY(maxValue, "log")));
    const plotW = Math.max(0, width - M.left - M.right);
    const plotH = height - M.top - M.bottom;
    return {
      xMax, yMax, plotW, plotH,
      sx: (years: number) => M.left + (years / xMax) * plotW,
      sy: (y: number) => M.top + plotH - (y / yMax) * plotH,
      ix: (px: number) => ((px - M.left) / plotW) * xMax,
      iy: (py: number) => ((M.top + plotH - py) / plotH) * yMax,
    };
  }, [width, height, maxYears, maxValue, yScale]);

  // Screen positions (with a little deterministic vertical jitter, so the many
  // species on the same count, above all 0, show as a band rather than a line),
  // plus a coarse grid for hover hit-testing.
  const layout = useMemo(() => {
    // Faded dots first, then least concerning, so selected and threatened dots sit on top.
    const ordered = [...points].sort((a, b) =>
      (a.dim === b.dim ? 0 : a.dim ? -1 : 1) || (DRAW_RANK[a.category] ?? 0) - (DRAW_RANK[b.category] ?? 0));
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
      const x = Math.round(sx(yr)) + 0.5;
      ctx.fillText(`${yr}`, x, M.top + plotH + 5);
    }

    // Axis titles, outside the edge bars.
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#71717a";
    ctx.textBaseline = "bottom";
    ctx.fillText("Years since latest assessment", M.left + plotW / 2, height - 2);
    ctx.save();
    ctx.translate(Y_TITLE / 2 + 1, M.top + plotH / 2);
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
      const dim = p.dim || (box ? !box.keys.has(p.key) : false);
      ctx.globalAlpha = dim ? 0.1 : big ? 0.5 : 0.75;
      ctx.fillStyle = colors[p.category] || "#a1a1aa";
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (big) ctx.fillRect(x - r, y - r, r * 2, r * 2);
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }, [layout, scales, width, height, box, colors, yScale, yLabel]);

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
  const inPlot = (x: number, y: number) =>
    x >= M.left - 4 && x <= M.left + scales.plotW + 4 && y >= M.top - 4 && y <= M.top + scales.plotH + 4;
  // The drag is followed on the window, in the capture phase: the 0-record dots
  // sit on the x axis, so taking them in means releasing below the plot, over
  // the bars or off the chart, where the chart's own handlers never saw the
  // mouseup (a bar swallowed it, or leaving the chart cancelled the drag).
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
      if (finishDrag(p.x, p.y)) {
        // A drag that ends over a bar must not also click it.
        const swallow = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      }
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  };
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLeave = () => { if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; } };
  useEffect(() => cancelLeave, []);
  const onMouseMove = (e: React.MouseEvent) => {
    const { x, y } = localXY(e);
    if (dragStart.current) return; // followed on the window (onMouseDown)
    const i = inPlot(x, y) ? hitTest(x, y) : null;
    if (i != null) {
      cancelLeave();
      if (hover?.p.key !== layout.ordered[i].key) setExpanded(false);
      setHover({ p: layout.ordered[i], px: layout.xy[i * 2], py: layout.xy[i * 2 + 1] });
    } else if (hover && !leaveTimer.current) {
      // Off the dot: keep the tooltip a moment, so the mouse can cross the gap into it.
      leaveTimer.current = setTimeout(() => { leaveTimer.current = null; setHover(null); setExpanded(false); }, 300);
    }
  };
  /** Ends a drag at (x, y): a box if it moved, else a click. Returns whether it moved. */
  const finishDrag = (x: number, y: number): boolean => {
    const drag = dragStart.current;
    if (!drag) return false;
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
        if (!ordered[i].dim && px >= left && px <= right && py >= top && py <= bottom) keys.add(ordered[i].key);
      }
      onBoxChange({ x0: ix(left), x1: ix(right), y0: iy(bottom), y1: iy(top), keys });
      return true;
    }
    const i = inPlot(x, y) ? hitTest(x, y) : null;
    if (i != null) onPointClick(layout.ordered[i].key);
    else if (box) onBoxChange(null);
    return false;
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

  // The edge bars: even bins lined up with the ticks (5 years; a power of ten,
  // or 10%), counting the dots in view and, with a box drawn, those inside it.
  const bins = useMemo(() => {
    const x: Bin[] = [];
    for (let lo = 0; lo < scales.xMax; lo += 5) x.push({ key: `x${lo}`, lo, hi: lo + 5, label: `${lo}–${lo + 5} years since assessed`, count: 0, inBox: 0 });
    const y: Bin[] = yScale === "pct"
      ? Array.from({ length: 10 }, (_, i) => ({ key: `y${i}`, lo: i * 10, hi: (i + 1) * 10, label: `${i * 10}–${(i + 1) * 10}% new records`, count: 0, inBox: 0 }))
      : [{ key: "y0", lo: 0, hi: 1, label: "No records", count: 0, inBox: 0 },
        ...Array.from({ length: scales.yMax }, (_, k) => ({
          key: `y${k + 1}`, lo: 10 ** k, hi: 10 ** (k + 1),
          label: `${(10 ** k).toLocaleString()}–${(10 ** (k + 1) - 1).toLocaleString()} records`, count: 0, inBox: 0,
        }))];
    const xIndex = (p: PriorityPoint) => Math.min(Math.floor(p.years / 5), x.length - 1);
    const yIndex = (p: PriorityPoint) => Math.min(y.length - 1, yScale === "pct"
      ? Math.floor(p.value / 10)
      : p.value < 1 ? 0 : Math.floor(Math.log10(p.value) + 1e-9) + 1);
    for (const p of points) {
      if (p.dim) continue;
      const inBox = box?.keys.has(p.key) ? 1 : 0;
      const bx = x[xIndex(p)], by = y[yIndex(p)];
      bx.count++; by.count++; bx.inBox += inBox; by.inBox += inBox;
    }
    return { x, y, xIndex, yIndex };
  }, [points, box, scales.xMax, scales.yMax, yScale]);

  /** An edge bar's click: select its band (the same box filter as a drag), or clear it if it is the box. */
  const selectBand = (axis: "x" | "y", bin: Bin) => {
    if (box?.band === bin.key) { onBoxChange(null); return; }
    const index = axis === "x" ? bins.xIndex : bins.yIndex;
    const list = axis === "x" ? bins.x : bins.y;
    const keys = new Set<string>();
    for (const p of points) if (!p.dim && list[index(p)] === bin) keys.add(p.key);
    const { xMax, yMax } = scales;
    onBoxChange(axis === "x"
      ? { x0: bin.lo, x1: bin.hi, y0: -1, y1: yMax + 1, keys, band: bin.key }
      : { x0: -1, x1: xMax + 1, y0: bin.lo === 0 ? -1 : toPlotY(bin.lo, yScale), y1: toPlotY(bin.hi, yScale), keys, band: bin.key });
  };

  const share = (bin: Bin, length: number) => (bin.inBox ? Math.max(2, (bin.inBox / Math.max(1, bin.count)) * length) : 0);
  const xMaxCount = Math.max(1, ...bins.x.map((b) => b.count));
  const yMaxCount = Math.max(1, ...bins.y.map((b) => b.count));
  const bars = width > 0 ? [
    ...bins.x.map((bin) => {
      const left = scales.sx(bin.lo), right = scales.sx(Math.min(bin.hi, scales.xMax));
      const h = bin.count ? Math.max(1, (bin.count / xMaxCount) * BOTTOM_HIST) : 0;
      return { bin, axis: "x" as const, rect: { left: left + 1, width: right - left - 2, top: M.top + scales.plotH + X_TICKS + 4, height: h },
        // The in-box share, from the bar's base (its top edge, the axis side);
        // at least 2px, so a small selection still shows where it falls.
        inner: { left: 0, top: 0, width: "100%", height: share(bin, h) } };
    }),
    ...bins.y.map((bin) => {
      const top = scales.sy(Math.min(toPlotY(bin.hi, yScale), scales.yMax)), bottom = scales.sy(toPlotY(bin.lo, yScale));
      const w = bin.count ? Math.max(1, (bin.count / yMaxCount) * LEFT_HIST) : 0;
      return { bin, axis: "y" as const, rect: { top: top + 1, height: bottom - top - 2, left: M.left - Y_TICKS - 4 - w, width: w },
        inner: { right: 0, top: 0, height: "100%", width: share(bin, w) } };
    }),
  ].filter((b) => b.rect.width > 0 && b.rect.height > 0) : [];
  const hoverBinLive = hoverBin ? [...bins.x, ...bins.y].find((b) => b.key === hoverBin.key) ?? null : null;
  const binTipRef = useRef<HTMLDivElement>(null);
  const binTipPos = usePlacement(binTipRef, hoverBinLive ? hoverBin : null, width, height, 8, false);

  const selected = selectedKey ? layout.ordered.findIndex((p) => p.key === selectedKey) : -1;
  const hoverDetails = useMemo(() => (hover && expanded ? details(hover.p.key) : null), [hover, expanded, details]);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipPos = usePlacement(tipRef, hover, width, height, 10, expanded);
  // Events inside the tooltip are its own: no drags, hit tests or dot clicks.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      ref={wrapRef}
      // Not overflow-hidden: the drag box and selection are clamped to the plot
      // themselves, and the expanded tooltip may run past the chart's bottom.
      className={`relative select-none ${hover && !drag ? "cursor-pointer" : "cursor-crosshair"}`}
      style={{ flex: 1, minHeight: MIN_HEIGHT }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => { cancelLeave(); setHover(null); setExpanded(false); }}
    >
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height, display: "block" }} />
      {/* The edge bars: grey, with the in-box share darker; a click selects the band. */}
      {bars.map(({ bin, axis, rect, inner }) => {
        const isBand = box?.band === bin.key;
        return (
          <button
            key={bin.key}
            type="button"
            aria-pressed={isBand}
            aria-label={`${bin.label}: ${bin.count.toLocaleString()} species. Select this band`}
            className="group absolute z-10 cursor-pointer overflow-hidden rounded-[2px] bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600"
            style={rect}
            onMouseDown={stop}
            onMouseUp={stop}
            onMouseMove={(e) => { stop(e); setHover(null); setHoverBin({ key: bin.key, px: rect.left + rect.width / 2, py: rect.top + rect.height / 2 }); }}
            onMouseLeave={() => setHoverBin(null)}
            onClick={() => selectBand(axis, bin)}
          >
            {box && bin.inBox > 0 && (
              <span className="absolute bg-zinc-500 dark:bg-zinc-400" style={isBand ? { inset: 0 } : inner} />
            )}
          </button>
        );
      })}
      {hoverBinLive && (
        <div ref={binTipRef} role="tooltip"
          className="pointer-events-none absolute z-30 whitespace-nowrap rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1 text-[11px] leading-[14px]"
          style={placedStyle(binTipPos)}>
          <div className="text-zinc-900 dark:text-zinc-100 font-medium">{hoverBinLive.label}</div>
          <div className="tabular-nums text-zinc-600 dark:text-zinc-400">
            {hoverBinLive.count.toLocaleString()} species{box && box.band !== hoverBinLive.key ? ` · ${hoverBinLive.inBox.toLocaleString()} selected` : ""}
          </div>
          <div className="text-zinc-400">{box?.band === hoverBinLive.key ? "Click to clear" : "Click to select this band"}</div>
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
            ref={tipRef}
            role="tooltip"
            className={`absolute z-30 w-[260px] max-w-full ${expanded ? "max-h-[480px] overflow-y-auto overscroll-contain" : ""} cursor-default select-text rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1 text-[11px] leading-[14px]`}
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
            {/* GBIF records in the app's own terms (the table's Total / New / % New, New being since the assessment). */}
            <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">GBIF records</div>
            <table className="tabular-nums text-zinc-700 dark:text-zinc-300">
              <tbody>
                <tr><td className="pr-3">Total</td><td className="text-right font-semibold text-zinc-900 dark:text-zinc-100">{hover.p.total?.toLocaleString() ?? "—"}</td></tr>
                <tr><td className="pr-3">New</td><td className="text-right">{hover.p.newRecords?.toLocaleString() ?? "—"}</td></tr>
                <tr><td className="pr-3">% New</td><td className="text-right">{pctNewText(hover.p)}</td></tr>
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
      {d.countries.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-zinc-100 dark:border-zinc-800">
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Countries of occurrence · {d.countries.length}</div>
          {/* Scrolls on its own (some species occur in 100+ countries) without scrolling the page. */}
          <div className="max-h-[58px] overflow-y-auto overscroll-contain pr-1 text-zinc-900 dark:text-zinc-100">{d.countries.join(", ")}</div>
        </div>
      )}
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
