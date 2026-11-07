/**
 * The hover tooltip and the bar value label every bar chart shares.
 *
 * Tooltip: a small light card (dark in dark mode) with the bar's name and its
 * count in bold, e.g. "Forest / 4,410 species · 73%", in place of Recharts'
 * default: a 16px dark box that covered the bars beside the one hovered.
 *
 * Value label: one line, "3,871 · 64%". Recharts' default label word-wraps to
 * the bar's width, so long bars broke their label onto two lines.
 */
import type { CSSProperties } from "react";

/** "3,871 (64%)" → "3,871 · 64%". Anything else passes through unchanged. */
export function formatCountLabel(label: string): string {
  return label.replace(/\s*\((\d+%)\)\s*$/, " · $1");
}

/** The faint highlight behind the hovered bar (Recharts' `cursor`). */
export const CHART_HOVER_CURSOR = { fill: "rgba(161, 161, 170, 0.12)" };

/** Keeps the tooltip from ever swallowing a click aimed at the bar under it. */
export const CHART_TOOLTIP_WRAPPER: CSSProperties = { pointerEvents: "none", outline: "none" };

interface TooltipPayloadItem {
  value?: number | string | readonly (number | string)[];
  payload?: { label?: string };
}

/** Pass as `<Tooltip content={<ChartTooltip … />} />`; Recharts fills in active/payload/label. */
export function ChartTooltip({ active, payload, label, title, noun = "species", value }: {
  active?: boolean;
  payload?: readonly TooltipPayloadItem[];
  label?: string | number;
  /** The tooltip's heading from the bar's key, e.g. a code to its full name. */
  title?: (label: string) => string;
  /** What the count counts: "species", "observations". */
  noun?: string;
  /** Override the bold line entirely. */
  value?: (item: TooltipPayloadItem) => string;
}) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  const heading = label == null ? "" : title ? title(String(label)) : String(label);
  const count = Number(Array.isArray(item.value) ? item.value[0] : item.value ?? 0);
  const pct = item.payload?.label?.match(/\((\d+%)\)\s*$/)?.[1];
  return (
    <div className="max-w-[280px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-2 py-1 text-[11px] leading-[14px]">
      {heading && <div className="text-zinc-500 dark:text-zinc-400">{heading}</div>}
      <div className="text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
        {value ? value(item) : (
          <>
            <span className="font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">{count.toLocaleString()}</span> {noun}
            {pct && <span className="text-zinc-500 dark:text-zinc-400"> · {pct}</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** Pass as `<LabelList content={ChartValueLabel} />` on a horizontal bar chart. */
export function ChartValueLabel(props: {
  x?: number | string; y?: number | string; width?: number | string; height?: number | string;
  value?: number | string | boolean | null;
}) {
  const x = Number(props.x ?? 0), y = Number(props.y ?? 0), w = Number(props.width ?? 0), h = Number(props.height ?? 0);
  if (props.value == null || props.value === "") return null;
  return (
    <text x={x + w + 4} y={y + h / 2} dy="0.35em" fontSize={11} fill="#a1a1aa" style={{ fontVariantNumeric: "tabular-nums" }}>
      {formatCountLabel(String(props.value))}
    </text>
  );
}
