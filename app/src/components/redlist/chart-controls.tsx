import type { IconType } from "react-icons";
import { LuChevronLeft, LuChevronRight } from "react-icons/lu";

/**
 * The one look for every control in a filter chart's header, so the charts
 * match each other: dropdowns (native selects and the buttons that open a
 * chart's own menu), on/off toggles, search boxes and segmented switches all
 * share one box: 11px text, rounded-md, a thin border, 20px tall. Each control
 * has the same two states. Idle is white with a grey border, like a select. On
 * (narrowing the data) is a fill in the chart's own colour, so a filter that's
 * on says so on its card. Also the chips and the pager below. Kept out of
 * FilterBarChart.tsx, which is lazy-loaded for recharts.
 */
const BOX = "text-[11px] leading-[14px] rounded-md border py-0.5 transition-colors";
const IDLE = "border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300";
const IDLE_HOVER = "hover:bg-zinc-50 dark:hover:bg-zinc-800";

/** A native <select>. Less side padding: the platform's arrow brings its own. */
export const CHART_SELECT_CLASS = `${BOX} ${IDLE} px-1 cursor-pointer`;

/**
 * A toggle, or a button that opens the chart's own dropdown menu (a native
 * select can't hold checkboxes or hints; those end in ▾). `activeColors` is the
 * fill, text and border classes for when it's on, e.g.
 * "bg-red-600 text-white border-red-600".
 */
export function chartControlClass(active: boolean, activeColors: string): string {
  return `${BOX} px-1.5 cursor-pointer ${active ? activeColors : `${IDLE} ${IDLE_HOVER}`}`;
}

/** The focus ring every text field uses, compact or not: neutral, not an accent colour. */
export const FOCUS_RING = "focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500";

/** A plain compact text/number field, no icon (an inline filter or editor). Add a width. */
export const CHART_INPUT_CLASS = `${BOX} ${IDLE} px-1.5 placeholder-zinc-400 ${FOCUS_RING}`;

/** The panel a compact dropdown menu opens: position it yourself (absolute/fixed, top-full, z-index). */
export const CHART_MENU_PANEL_CLASS = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg";

/**
 * A search box. Put it on a wrapper that holds the search icon and a borderless
 * <input> (CHART_SEARCH_INPUT_CLASS), so the icon sits inside the border.
 */
export const CHART_SEARCH_CLASS = `${BOX} ${IDLE} flex items-center gap-1 px-1.5 focus-within:ring-1 focus-within:ring-zinc-400 dark:focus-within:ring-zinc-500`;
export const CHART_SEARCH_INPUT_CLASS = "min-w-0 bg-transparent outline-none text-zinc-700 dark:text-zinc-300 placeholder-zinc-400";

/** A segmented switch (Map/List, All records/Georeferenced): the wrapper, then each option. */
export const CHART_SEGMENTED_CLASS = "inline-flex rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden text-[11px] leading-[14px]";
export function chartSegmentClass(selected: boolean): string {
  return `px-1.5 py-0.5 transition-colors ${selected
    ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
    : `text-zinc-600 dark:text-zinc-400 ${IDLE_HOVER}`}`;
}

/**
 * A filter chip with an icon and a count: Realm/Movement/Trend's options. The
 * same box as the other controls, with the count a step quieter than the label.
 */
export function ChartChip({ icon: Icon, label, count, active, activeColors, onClick, title }: {
  icon: IconType; label: string; count: number; active: boolean; activeColors: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; title?: string;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} title={title}
      className={`inline-flex items-center gap-1 ${chartControlClass(active, activeColors)}`}>
      <Icon aria-hidden className="w-3 h-3 shrink-0" />
      <span>{label}</span>
      <span className={`tabular-nums ${active ? "text-white/80" : "text-zinc-400 dark:text-zinc-500"}`}>{count.toLocaleString()}</span>
    </button>
  );
}

const PAGER_DISABLED = "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-white dark:disabled:hover:bg-zinc-900";
const PAGER_BUTTON = {
  compact: `${BOX} ${IDLE} ${IDLE_HOVER} w-5 h-5 p-0 inline-flex items-center justify-center cursor-pointer ${PAGER_DISABLED}`,
  // The page-level scale: the main species table and narrative search, beside text-sm toolbars.
  toolbar: `rounded-lg border transition-colors ${IDLE} ${IDLE_HOVER} w-8 h-8 inline-flex items-center justify-center cursor-pointer ${PAGER_DISABLED}`,
};

/**
 * Previous/next paging for a chart or list: two chevron buttons either side of
 * a label ("1–10 of 2,478", "2010–2019"). The caller places it; it takes no
 * row of its own. `size="toolbar"` is the page-level scale (text-sm, 32px).
 */
export function ChartPager({ label, canPrev, canNext, onPrev, onNext, noun = "page", prevLabel, nextLabel, minLabelWidth, size = "compact" }: {
  label: React.ReactNode; canPrev: boolean; canNext: boolean; onPrev: () => void; onNext: () => void;
  /** What a step moves through, for the buttons' labels: "Previous years". */
  noun?: string;
  /** Whole button labels, where "previous"/"next" would mislead (a timeline's "Newer"/"Older"). Also shown as a tooltip. */
  prevLabel?: string; nextLabel?: string;
  minLabelWidth?: number; size?: "compact" | "toolbar";
}) {
  const button = PAGER_BUTTON[size];
  const icon = size === "toolbar" ? "w-4 h-4" : "w-3 h-3";
  return (
    <div className={`inline-flex items-center text-zinc-500 dark:text-zinc-400 ${size === "toolbar" ? "gap-2 text-sm" : "gap-1.5 text-[11px] leading-[14px]"}`}>
      <button type="button" onClick={onPrev} disabled={!canPrev} aria-label={prevLabel ?? `Previous ${noun}`} title={prevLabel} className={button}>
        <LuChevronLeft aria-hidden className={icon} />
      </button>
      <span className="tabular-nums text-center" style={minLabelWidth ? { minWidth: minLabelWidth } : undefined} aria-live="polite" aria-atomic="true">{label}</span>
      <button type="button" onClick={onNext} disabled={!canNext} aria-label={nextLabel ?? `Next ${noun}`} title={nextLabel} className={button}>
        <LuChevronRight aria-hidden className={icon} />
      </button>
    </div>
  );
}
