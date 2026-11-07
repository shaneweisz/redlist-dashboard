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
} from "recharts";
import { ChartTooltip, CHART_HOVER_CURSOR, CHART_TOOLTIP_WRAPPER } from "./chart-tooltip";

// Plot-area insets, mirroring the margins and axis sizes set on the chart
// below. Kept in sync by hand so the drag band can be positioned in CSS
// without measuring the SVG.
const CHART_MARGIN = { top: 8, right: 8, left: 4, bottom: 4 };
const Y_AXIS_WIDTH = 40;
const X_AXIS_HEIGHT = 40;
const PLOT_LEFT = CHART_MARGIN.left + Y_AXIS_WIDTH;
const PLOT_RIGHT = CHART_MARGIN.right;
const PLOT_TOP = CHART_MARGIN.top;
const PLOT_BOTTOM = CHART_MARGIN.bottom + X_AXIS_HEIGHT;

interface YearBarChartProps {
  /** Data sorted ascending by year (chronological left-to-right) */
  data: Array<{
    code: string; // e.g. "2024"
    count: number;
    label: string; // e.g. "123 (4.5%)"
  }>;
  selectedItems: Set<string>;
  onBarClick: (data: { payload?: { code?: string } }, event: React.MouseEvent) => void;
  barColor?: string;
  /** Fixed Y-axis max so the scale stays stable across pagination */
  yMax?: number;
  /**
   * Shift+drag across the chart to select every year swept over, in chart
   * order. Omit to leave the chart click-only.
   */
  onRangeSelect?: (codes: string[], event: MouseEvent | React.MouseEvent) => void;
}

// Recharts' BarChart onClick handler state carries the hovered category + payload
interface BarChartClickState {
  activeLabel?: string | number;
  activePayload?: Array<{ payload?: { code?: string; count?: number; label?: string } }>;
}

export default function YearBarChart({
  data,
  selectedItems,
  onBarClick,
  barColor = "#3b82f6",
  yMax,
  onRangeSelect,
}: YearBarChartProps) {
  // Capture the mouse event alongside recharts' synthetic state so multi-select
  // (Cmd/Ctrl+click) still works when clicks are handled at the chart level.
  const lastEventRef = useRef<React.MouseEvent | null>(null);
  // Compact number formatter for Y-axis ticks (e.g. 12000 → "12k")
  const formatTick = (value: number): string => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
    return String(value);
  };
  // Shift+drag range selection: `drag` holds the anchor year and the year under
  // the cursor. The band between them is previewed as a ReferenceArea and
  // committed on mouse-up (bound to the window, so releasing outside the chart
  // still lands).
  const [drag, setDrag] = useState<{ start: string; end: string } | null>(null);
  // A drag also ends in a click — suppress it so the release year doesn't get
  // single-selected on top of the range.
  const justDragged = useRef(false);
  const codeFrom = (state: BarChartClickState): string | undefined =>
    state?.activePayload?.[0]?.payload?.code ?? (state?.activeLabel != null ? String(state.activeLabel) : undefined);

  const handleChartClick = (nextState: unknown) => {
    if (justDragged.current) return;
    const state = nextState as BarChartClickState;
    const event = lastEventRef.current;
    if (!event) return;
    // Shift is the range-drag modifier, not a select-this-bar click
    if (onRangeSelect && event.shiftKey) return;
    const code = codeFrom(state);
    if (!code) return;
    onBarClick({ payload: { code } }, event);
  };
  const handleChartMouseDown = (nextState: unknown, event: React.SyntheticEvent) => {
    const mouseEvent = event as React.MouseEvent;
    lastEventRef.current = mouseEvent;
    if (!onRangeSelect || !mouseEvent.shiftKey) return;
    const code = codeFrom(nextState as BarChartClickState);
    if (!code) return;
    // Shift+drag otherwise starts a text selection, which fights the drag
    mouseEvent.preventDefault();
    setDrag({ start: code, end: code });
  };
  const handleChartMouseMove = (nextState: unknown) => {
    if (!drag) return;
    const code = codeFrom(nextState as BarChartClickState);
    if (!code || code === drag.end) return;
    setDrag({ start: drag.start, end: code });
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
      const a = data.findIndex(d => d.code === drag.start);
      const b = data.findIndex(d => d.code === drag.end);
      if (a < 0 || b < 0) return;
      const codes = data.slice(Math.min(a, b), Math.max(a, b) + 1).map(d => d.code);
      if (codes.length > 0) onRangeSelect?.(codes, event);
    };
    window.addEventListener("mouseup", commit);
    return () => window.removeEventListener("mouseup", commit);
  }, [drag, data, onRangeSelect]);
  // The band is drawn as an overlay rather than a <ReferenceArea>, which can
  // only anchor to category centres — it would cut the first and last bar of
  // the drag in half. Categories divide the plot area evenly, so plain
  // percentages land on the band edges exactly.
  const dragBand = (() => {
    if (!drag || data.length === 0) return null;
    const a = data.findIndex(d => d.code === drag.start);
    const b = data.findIndex(d => d.code === drag.end);
    if (a < 0 || b < 0) return null;
    return { from: Math.min(a, b), span: Math.abs(b - a) + 1 };
  })();
  const insetX = PLOT_LEFT + PLOT_RIGHT;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {dragBand && (
        <div
          style={{
            position: "absolute",
            top: PLOT_TOP,
            bottom: PLOT_BOTTOM,
            left: `calc(${PLOT_LEFT}px + (100% - ${insetX}px) * ${dragBand.from / data.length})`,
            width: `calc((100% - ${insetX}px) * ${dragBand.span / data.length})`,
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
          margin={CHART_MARGIN}
          barCategoryGap={2}
          onClick={handleChartClick}
          onMouseDown={handleChartMouseDown}
          onMouseMove={handleChartMouseMove}
          style={{ cursor: "pointer", userSelect: drag ? "none" : undefined }}
        >
          <XAxis
            dataKey="code"
            type="category"
            tick={{ fontSize: 10, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={{ stroke: "#3f3f46" }}
            interval={0}
            angle={-45}
            textAnchor="end"
            height={X_AXIS_HEIGHT}
          />
          <YAxis
            type="number"
            tick={{ fontSize: 10, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            width={Y_AXIS_WIDTH}
            allowDecimals={false}
            domain={yMax != null ? [0, yMax] : undefined}
            tickFormatter={formatTick}
          />
          <Tooltip
            // Held off during a drag — it otherwise sits on top of the band
            // being dragged out, hiding exactly what the drag is selecting
            active={drag ? false : undefined}
            content={<ChartTooltip title={(year) => `Assessed ${year}`} />}
            cursor={CHART_HOVER_CURSOR}
            wrapperStyle={CHART_TOOLTIP_WRAPPER}
          />
          <Bar
            dataKey="count"
            radius={[3, 3, 0, 0]}
            minPointSize={2}
          >
            {data.map((entry, index) => {
              const isDimmed = selectedItems.size > 0 && !selectedItems.has(entry.code);
              return (
                <Cell
                  key={`cell-${index}`}
                  fill={barColor}
                  opacity={isDimmed ? 0.3 : 1}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
