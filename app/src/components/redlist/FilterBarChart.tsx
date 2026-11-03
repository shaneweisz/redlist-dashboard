"use client";

import { useEffect, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts";

const CHART_TOP_MARGIN = 5;
const CHART_BOTTOM_MARGIN = 5;

interface FilterBarChartProps {
  data: Array<{
    code?: string;
    shortRange?: string;
    count: number;
    label: string;
    color?: string;
    range?: string;
  }>;
  dataKey: "code" | "shortRange";
  selectedItems: Set<string>;
  onBarClick: (data: { payload?: { code?: string; range?: string } }, event: React.MouseEvent) => void;
  barColor?: string;
  yAxisWidth?: number;
  leftMargin?: number;
  rightMargin?: number;
  labelFormatter?: (label: string) => string;
  /** Fix the X axis max so bar lengths stay comparable across pages */
  xAxisMax?: number;
  /** Items to highlight with a ring/glow (e.g. search matches) */
  highlightedItems?: Set<string>;
  /** Truncate Y axis labels to this many characters */
  yAxisTickMaxLength?: number;
  /**
   * Shift+drag across the chart to select every bar swept over. Receives the
   * bars' keys (code, falling back to range — the same key `selectedItems`
   * holds) in chart order. Omit to leave the chart click-only.
   */
  onRangeSelect?: (keys: string[], event: MouseEvent | React.MouseEvent) => void;
}

export default function FilterBarChart({
  data,
  dataKey,
  selectedItems,
  onBarClick,
  barColor,
  yAxisWidth = 36,
  leftMargin = 5,
  rightMargin = 85,
  labelFormatter,
  xAxisMax,
  highlightedItems,
  yAxisTickMaxLength,
  onRangeSelect,
}: FilterBarChartProps) {
  // Which bar row the cursor is over, from its Y position within the plot area
  // (rows are evenly spaced, so this is pure arithmetic — no recharts state).
  const rowIndexAt = (event: React.MouseEvent<HTMLDivElement>, clamp = false): number | null => {
    if (data.length === 0) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const plotHeight = rect.height - CHART_TOP_MARGIN - CHART_BOTTOM_MARGIN;
    if (plotHeight <= 0) return null;
    const relativeY = event.clientY - rect.top - CHART_TOP_MARGIN;
    const index = Math.floor((relativeY / plotHeight) * data.length);
    if (clamp) return Math.min(data.length - 1, Math.max(0, index));
    if (index < 0 || index >= data.length) return null;
    return index;
  };

  // Shift+drag range selection. `drag` holds the anchor row and the row under
  // the cursor; the band between them is previewed as an overlay and committed
  // on mouse-up (on window, so releasing outside the chart still lands).
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  // A drag ends with a click event on the wrapper — suppress it so the release
  // row doesn't also get single-selected on top of the range.
  const justDragged = useRef(false);

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onRangeSelect || !event.shiftKey) return;
    const index = rowIndexAt(event);
    if (index == null) return;
    // Shift+drag otherwise starts a text selection, which fights the drag
    event.preventDefault();
    setDrag({ start: index, end: index });
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!drag) return;
    const index = rowIndexAt(event, true);
    if (index == null || index === drag.end) return;
    setDrag({ start: drag.start, end: index });
  };

  useEffect(() => {
    if (!drag) return;
    const commit = (event: MouseEvent) => {
      setDrag(null);
      // The click that closes the drag fires synchronously after this mouseup,
      // so clearing on the next tick both suppresses it and guarantees the flag
      // can't leak into a later click (a mouseup outside the chart fires no
      // click here at all, and would otherwise leave the flag stuck on).
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
      const from = Math.min(drag.start, drag.end);
      const to = Math.max(drag.start, drag.end);
      const keys = data.slice(from, to + 1).map(d => d.code || d.range || "").filter(Boolean);
      if (keys.length > 0) onRangeSelect?.(keys, event);
    };
    window.addEventListener("mouseup", commit);
    return () => window.removeEventListener("mouseup", commit);
  }, [drag, data, onRangeSelect]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (justDragged.current) return;
    // Shift is the range-drag modifier, not a select-this-bar click
    if (onRangeSelect && event.shiftKey) return;
    const index = rowIndexAt(event);
    if (index == null) return;
    const entry = data[index];
    onBarClick({ payload: { code: entry.code, range: entry.range } }, event);
  };

  // Percentage-based band geometry mirrors how rowIndexAt splits the plot area,
  // so the preview lines up with the rows without measuring the DOM.
  const dragBand = drag && data.length > 0 ? {
    from: Math.min(drag.start, drag.end),
    span: Math.abs(drag.end - drag.start) + 1,
  } : null;
  const insetPx = CHART_TOP_MARGIN + CHART_BOTTOM_MARGIN;


  // Wrap in a div with a single click handler so the whole row is a hit target
  // (bar, y-axis label, count label, empty space) — not just the visible bar,
  // which is hard to click when counts are small.
  return (
    <div
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      style={{ width: "100%", height: "100%", cursor: "pointer", position: "relative", userSelect: drag ? "none" : undefined }}
    >
      {dragBand && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `calc(${CHART_TOP_MARGIN}px + (100% - ${insetPx}px) * ${dragBand.from / data.length})`,
            height: `calc((100% - ${insetPx}px) * ${dragBand.span / data.length})`,
            backgroundColor: "rgba(59, 130, 246, 0.18)",
            border: "1px solid rgba(59, 130, 246, 0.6)",
            borderRadius: 4,
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
      )}
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: CHART_TOP_MARGIN, right: rightMargin, left: leftMargin, bottom: CHART_BOTTOM_MARGIN }}
          barCategoryGap={4}
        >
          <XAxis type="number" hide domain={xAxisMax ? [0, xAxisMax] : undefined} />
          <YAxis
            type="category"
            dataKey={dataKey}
            tick={{ fontSize: 11, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            width={yAxisWidth}
            interval={0}
            tickFormatter={yAxisTickMaxLength ? (value: string) =>
              value.length > yAxisTickMaxLength ? value.slice(0, yAxisTickMaxLength) + "…" : value
            : undefined}
          />
          <Tooltip
            // Held off during a drag — it otherwise sits on top of the band
            // being dragged out, hiding exactly what the drag is selecting
            active={drag ? false : undefined}
            formatter={(value) => [Number(value ?? 0).toLocaleString(), "Species"]}
            labelFormatter={labelFormatter && ((label) => labelFormatter(String(label)))}
            contentStyle={{
              backgroundColor: "#18181b",
              border: "1px solid #3f3f46",
              borderRadius: "8px",
              // Recharts lays the label out on ONE line, so a chart whose
              // labelFormatter returns a sentence gets a tooltip wider than the
              // card it sits in — 635px inside a 506px card for the CoL
              // differences chart, covering every bar and clipping its own text.
              // Hovering to find out what a bar is then hides which bar you are
              // about to click. Wrapping costs a few lines of height and gives
              // the width back. Short labels never reach the cap.
              maxWidth: 280,
              whiteSpace: "normal",
            }}
            // Belt and braces with the width cap: the box must never swallow a
            // click aimed at the bar underneath it.
            wrapperStyle={{ pointerEvents: "none" }}

            itemStyle={{ color: "#fff" }}
            labelStyle={{ color: "#a1a1aa" }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
            {data.map((entry, index) => {
              const itemKey = entry.code || entry.range || "";
              const isHighlighted = highlightedItems?.has(itemKey);
              const isDimmed = selectedItems.size > 0 && !selectedItems.has(itemKey);
              return (
                <Cell
                  key={`cell-${index}`}
                  fill={entry.color || barColor || "#3b82f6"}
                  opacity={isDimmed && !isHighlighted ? 0.3 : 1}
                  stroke={isHighlighted ? "#fff" : "none"}
                  strokeWidth={isHighlighted ? 1.5 : 0}
                />
              );
            })}
            <LabelList
              dataKey="label"
              position="right"
              style={{ fontSize: 11, fill: "#a1a1aa" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
