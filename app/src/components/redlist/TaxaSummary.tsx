"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { FaInfoCircle, FaChevronRight, FaFlag } from "react-icons/fa";

import { HiOutlineAdjustmentsHorizontal } from "react-icons/hi2";
import TaxaIcon from "@/components/TaxaIcon";
import { CATEGORY_COLORS, CATEGORY_NAMES, CATEGORY_ORDER } from "@/config/taxa";
import {
  hasChildren, findNode, getAncestors, stripNodePrefix, taxaUrlToken, OFFICIAL_IUCN_DESCRIBED_NODE_IDS,
  describeFilter, COL_RELEASE_LABEL, COL_RELEASE_URL, primaryFilterRank, breakdownDisplayName, breakdownHref,
  matchesBreakdownName, speciesMatchesNode,
  type FilterRank, type DescribeFilterSegment,
} from "@/lib/taxonomy-utils";
import { TAXONOMY_VIEWS } from "@/config/taxonomy-views";
import { IUCN_SOURCE_URL } from "@/config/taxonomy-tree";
import { isLiveDrilldownNode, nextDynamicRank, isDynamicNodeId, dynamicNodeDisplayName, dynamicNodeFilter, dynamicNodeRankInfo, parseDynamicNodeId } from "@/lib/dynamic-taxon";
import type { RedListSpecies } from "@/hooks/useRedListSpeciesQuery";
import { prettifyQs } from "@/lib/query-string";
import { sisRowKey } from "@/lib/species-row-key";
// Reason labels are shared with the main dashboard's taxonomic-revision flag —
// see lib/col-revision.ts (both surfaces must explain a reason the same way).
import { neSplitSentence, neSynonymSentence, reasonComposition, displayReason, NE_SPLIT_EVIDENCE } from "@/lib/col-revision";
import { NoMatchLine } from "@/components/redlist/revision-links";

// See scripts/build-taxa-summary.ts's classifyNoMatch for what each reason means.
// Modular/additive on top of colBreakdown[].noMatchIds — safe to drop independently
// of the count-only CoL Match / No CoL Match mechanism it rides alongside.
type NoMatchDetail = { id: number; name: string; reason: string; detail?: string; detailId?: number; detailColId?: string; colId?: string; colName?: string; colGroup?: string };

// See scripts/build-taxa-summary.ts's SPLIT_CANDIDATES_SQL for the mechanism and its
// caveats — a name-pattern heuristic (former-subspecies synonym → promoted species),
// not a confirmed taxonomic changelog, so it's worded as "likely" rather than stated
// as fact. Modular/additive on top of colBreakdown[].splitDetails — keyed by col_id
// since Not Evaluated species have no sis_taxon_id.
type SplitDetail = { colId: string; parentId: number; parentName: string; parentCategory: string };

// The second Not-Evaluated explanation: CoL files an IUCN-ASSESSED name among
// this species' synonyms, so the taxon IS assessed — under a name CoL doesn't
// accept. See col-breakdown.ts's SYNONYM_ASSESSED_SQL. Keyed by col_id and
// droppable, exactly like SplitDetail.
type NeSynonymDetail = { colId: string; assessedId: number; assessedName: string; assessedCategory: string };

interface Table1aRowData {
  group: string;
  name: string;
  estimatedDescribed: number;
  totalAssessed: number;
  percentAssessed: number;
  outdated: number;
  percentOutdated: number;
  byCategory: Record<string, number>;
  gbifSpeciesCount?: number;
  gbifNeSpeciesCount?: number;
  totalGbifObservations?: number;
  meanGbifObsPerSpecies?: number;
  medianGbifObsPerSpecies?: number;
  colDescribed?: number;
  colNe?: number;
  colBreakdown?: { name: string; count: number; neCount: number; trueAssessed: number; noMatchIds: number[]; noMatchDetails?: NoMatchDetail[]; splitDetails?: SplitDetail[]; neSynonymDetails?: NeSynonymDetail[] }[];
  /** SSC groups mode only: which real view-root taxon this row's group is a
   * sub-population of (e.g. "mammals", "reptiles") — used to navigate to the
   * right root on click, since SSC group nodes span multiple taxa. */
  parentTaxon?: string;
}

interface Table1aSectionData {
  title: string;
  rows: Table1aRowData[];
  /** SSC mode only — the section's catch-all row id (e.g. "ssc-other-mammals"),
   * so the collapse-to-5 UI can always keep it visible regardless of collapse
   * state. Undefined in Table 1a mode, which has no catch-all concept. */
  catchAllId?: string;
}

// SSC groups mode — one section per taxon that has an SSC pilot built out.
// Add an entry here (nodeId, parentTaxon, title, catch-all id) when a new
// taxon's SSC groups are added.
const SSC_SECTIONS: { nodeId: string; parentTaxon: string; title: string; catchAllId: string }[] = [
  { nodeId: "ssc-groups", parentTaxon: "mammals", title: "MAMMAL SPECIALIST GROUPS", catchAllId: "ssc-other-mammals" },
  { nodeId: "ssc-reptile-groups", parentTaxon: "reptiles", title: "REPTILE SPECIALIST GROUPS", catchAllId: "ssc-snake-lizard-rla" },
  { nodeId: "ssc-fish-groups", parentTaxon: "fishes", title: "FISH SPECIALIST GROUPS", catchAllId: "ssc-other-fish" },
  { nodeId: "ssc-invertebrate-groups", parentTaxon: "invertebrates", title: "INVERTEBRATE SPECIALIST GROUPS", catchAllId: "ssc-other-invertebrates" },
  { nodeId: "ssc-plant-groups", parentTaxon: "plantae", title: "PLANT SPECIALIST GROUPS", catchAllId: "ssc-other-plants" },
  { nodeId: "ssc-fungi-groups", parentTaxon: "fungi", title: "FUNGI SPECIALIST GROUPS", catchAllId: "ssc-other-fungi" },
];

// Ordered categories for the breakdown bar (most threatened first)
const BAR_CATEGORIES = Object.keys(CATEGORY_ORDER).sort(
  (a, b) => CATEGORY_ORDER[a] - CATEGORY_ORDER[b]
);

interface TaxonSummary {
  id: string;
  name: string;
  color: string;
  estimatedDescribed: number;
  available: boolean;
  totalAssessed: number;
  percentAssessed: number;
  outdated: number;
  percentOutdated: number;
  lastUpdated: string | null;
  byCategory: Record<string, number>;
  totalGbifObservations?: number;
  meanGbifObsPerSpecies?: number;
  medianGbifObsPerSpecies?: number;
  gbifSpeciesCount?: number;
  gbifNeSpeciesCount?: number;
  gbifObsDistribution?: Record<string, number>;
  colDescribed?: number;
  colNe?: number;
}

interface SubGroupSummary {
  id: string;
  name: string;
  estimatedDescribed: number;
  totalAssessed: number;
  outdated: number;
  gbifNeSpeciesCount: number;
  byCategory: Record<string, number>;
  colDescribed?: number;
  colNe?: number;
  colBreakdown?: { name: string; count: number; neCount: number; trueAssessed: number; noMatchIds: number[]; noMatchDetails?: NoMatchDetail[]; splitDetails?: SplitDetail[]; neSynonymDetails?: NeSynonymDetail[] }[];
}

interface Props {
  onToggleTaxon: (taxonId: string, event: React.MouseEvent) => void;
  selectedTaxa: Set<string>;
  selectedSubgroups: Set<string>;
  onToggleSubgroup: (subgroupId: string) => void;
  /** Navigate directly to a taxon + subgroup (used by Table 1a click-through) */
  onNavigateToSubgroup?: (taxonId: string, subgroupId: string) => void;
  disableAllSpecies?: boolean;
  viewMode?: "reassessments" | "new-assessments";
  /** Table 1a mode / SSC groups mode / country-view landing page — URL-synced
   * (see useFilterParams) so it survives reload/share and the browser back
   * button can return to it. */
  layoutMode: "table1a" | "ssc" | "country" | null;
  onLayoutModeChange: (mode: "table1a" | "ssc" | "country" | null) => void;
  /** Rendered full width, always visible, when layoutMode === "country" — a
   * promoted WorldMap/CountryStatsList panel built by RedListView (which already
   * owns the country-stats data and click-through wiring), kept out of this
   * component so it doesn't need its own dynamic WorldMap import. */
  countryModeContent?: React.ReactNode;
  /** Rendered above the taxa table in Country View, once at least one country
   * is selected — the current selection as removable name chips (built by
   * RedListView, which owns the selection state). */
  countryPillsContent?: React.ReactNode;
  /** Set whenever at least one country is selected — independent of layoutMode,
   * so selecting countries anywhere (not just via the Country view landing page)
   * scopes this table's own fetches too. One country, a whole region, or an
   * arbitrary multi-select are all just "the current set of codes" here. */
  countryScope?: string[] | null;
}

// Any static tree node with children is expandable — plus any node under a live
// taxonomic-drilldown root (see dynamic-taxon.ts) that isn't already at genus
// rank (a leaf; further drilling happens via the existing species-list view).
const isExpandable = (id: string) => hasChildren(id) || (isLiveDrilldownNode(id) && nextDynamicRank(id) !== null);

// Expand affordance for tree rows: a chevron that points right when collapsed and rotates
// down when expanded, so it's obvious a row drills into sub-groups. Leaf rows get a
// same-width spacer to keep names aligned with their expandable siblings.
const expandToggle = (expandable: boolean, expanded: boolean) =>
  expandable ? (
    <FaChevronRight
      aria-hidden
      className={`flex-shrink-0 w-2.5 h-2.5 text-zinc-400 dark:text-zinc-500 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
    />
  ) : (
    <span aria-hidden className="flex-shrink-0 w-2.5" />
  );

// Bar color helpers
// Why a row can read over 100% assessed. The numerator is IUCN's count of what
// it has assessed; the denominator is how many species this Catalogue of Life
// release describes in the same group — two organisations' answers to "which
// species exist", not one number divided by itself. Said in the row rather than
// left to the reader, since a percentage above 100 reads as a bug on sight.
// Deliberately no direction: IUCN has the newer treatment about as often as CoL
// does (see col-revision.ts's "differs, never moved").
const OVER_100_ASSESSED_NOTE =
  "More species assessed than Catalogue of Life describes here, due to taxonomic mismatches between the Red List and CoL — often genus transfers, splits or lumps accepted by one source but not yet the other.";

const getAssessedBarColor = (percent: number) =>
  percent >= 50 ? "#22c55e" : percent >= 20 ? "#eab308" : "#ef4444";

const getOutdatedBarColor = (percent: number) =>
  percent < 20 ? "#22c55e" : percent <= 50 ? "#f97316" : "#ef4444";

// Info icon for the "# Needs Updating" header. This column's counts come from the
// static data/taxa-summary.json build artifact (see README § Data Sync
// Pipeline), computed as of the last data sync — not live, unlike the rest
// of the dashboard — so the tooltip states that sync date directly rather
// than a cutoff derived from "today", which would drift from the date
// actually used to compute the count next to it the longer it's been since
// the last rebuild.
function OutdatedInfoIcon() {
  const [dataAsOf, setDataAsOf] = useState<Date | null>(null);
  useEffect(() => {
    fetch("/api/data-sync-date")
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.dataAsOf) setDataAsOf(new Date(data.dataAsOf)); })
      .catch(() => {});
  }, []);
  const dateFormat = { day: "numeric", month: "short", year: "numeric" } as const;
  return (
    <span className="relative group normal-case font-normal">
      <FaInfoCircle size={11} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300" />
      {/* Opens downward, right-aligned to the icon — opening sideways either blocks
          the neighboring column header (left) or clips against the viewport edge
          (right), since this header sits at the right edge of the table. */}
      <span className="absolute top-full right-0 mt-2 px-2 py-1 text-xs text-white bg-zinc-800 dark:bg-zinc-700 rounded whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible z-50 shadow-lg">
        {dataAsOf
          ? <>As of last sync date: {dataAsOf.toLocaleDateString("en-GB", dateFormat)}</>
          : <>As of last sync date</>}
      </span>
    </span>
  );
}

// Spinner shown in place of a count/bar the drill-down is still fetching. Same
// markup as the one beside a row's name while its children load, so a row waiting
// on a live-drilldown fetch spins the same way wherever the waiting shows up.
function PendingSpinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className} text-zinc-400`} viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// Sticky cell classes for the pinned taxon column
const stickyClasses = "sticky left-0 z-10";
// Compact cell classes for tighter table spacing
const cellPad = "px-2 sm:px-3 py-2 md:px-4 md:py-2.5";
const colDivider = "border-l border-zinc-200 dark:border-zinc-700";
const numericTdNoDividerClasses = `${cellPad} text-right whitespace-nowrap w-0`;
const numericThNoDividerClasses = `${cellPad} text-right text-sm font-bold text-zinc-600 dark:text-zinc-300 whitespace-nowrap w-0`;
const numericTdClasses = `${numericTdNoDividerClasses} ${colDivider}`;
const numericThClasses = `${numericThNoDividerClasses} ${colDivider}`;
const flexTdClasses = `${cellPad} ${colDivider} whitespace-nowrap w-0`;
const flexThClasses = `${cellPad} ${colDivider} text-left text-sm font-bold text-zinc-600 dark:text-zinc-300 whitespace-nowrap w-0`;
// Bar-column headers (Assessed / Outdated / Unassessed / Not Evaluated) are allowed
// to wrap: their cells already carry a bar min-width, so a long single-line header
// (e.g. "# Needs Updating (10+ yrs old)") would otherwise force the column wider than
// it needs to be and push the table into horizontal overflow.
const centeredThClasses = `${cellPad} ${colDivider} text-center text-sm font-bold text-zinc-600 dark:text-zinc-300 w-0`;
// "# Described Species" is the widest single-line header after the taxon name
// column; letting it wrap (like the bar-column headers above) keeps the column
// from being wider than its numeric content actually needs.
const numericThWrapClasses = `${cellPad} text-right text-sm font-bold text-zinc-600 dark:text-zinc-300 w-0 max-w-[110px]`;

// Toggleable column IDs (Taxon is always visible)
type ColumnId = "described" | "colDescribed" | "assessed" | "outdated" | "breakdown" | "gbifUnassessed" | "colNe" | "totalGbifObs" | "meanGbifObs" | "medianGbifObs" | "gbifDistribution";

// Columns with no valid per-country value — neither GBIF nor Catalogue of Life
// data has a country dimension, and estimatedDescribed/percentAssessed ("described"
// column) is a global figure (see country-taxa-summary-duckdb.ts's doc comment).
// Force-hidden whenever countryStyleColumns is set (a country is scoped, or
// we're in Country View at all — see its definition below), on top of whatever
// hiddenColumns already has — total_assessed/outdated/by_category ("assessed"/
// "outdated"/"breakdown") ARE real per-country numbers and stay visible.
const COUNTRY_SCOPED_HIDDEN_COLUMNS: ColumnId[] = [
  "described", "colDescribed", "colNe", "gbifUnassessed", "totalGbifObs", "meanGbifObs", "medianGbifObs", "gbifDistribution",
];

const COLUMN_LABELS: Record<ColumnId, string> = {
  described: "# Described Species",
  colDescribed: "# Described Species (CoL)",
  assessed: "# Red List Assessed",
  outdated: "# Needs Updating (10+ yrs old)",
  breakdown: "Conservation Status Breakdown",
  gbifUnassessed: "# Unassessed, 1+ GBIF Obs",
  colNe: "# Not Evaluated",
  totalGbifObs: "Total Obs",
  meanGbifObs: "Mean Obs",
  medianGbifObs: "Median Obs",
  gbifDistribution: "Obs Distribution",
};

const DISTRIBUTION_BIN_LABELS = ["1", "2–10", "11–100", "101–1K", "1K–10K", "10K–100K", "100K–1M", ">1M"];

type FocusMode = "redlist" | "gbif" | "new-assessments";

// "# Described (CoL)" is hidden by default in every focus — the IUCN/CoL toggle on
// the "# Described" header flips the primary column's source instead. Enable this
// column via the cog menu to see IUCN and CoL described counts side by side.
const FOCUS_HIDDEN: Record<FocusMode, Set<ColumnId>> = {
  redlist: new Set(["colDescribed", "colNe", "gbifUnassessed", "totalGbifObs", "meanGbifObs", "medianGbifObs", "gbifDistribution", "breakdown"]),
  gbif: new Set(["colDescribed", "outdated", "breakdown"]),
  "new-assessments": new Set(["colDescribed", "outdated", "breakdown", "gbifUnassessed", "totalGbifObs", "meanGbifObs", "medianGbifObs", "gbifDistribution"]),
};

function DisabledAllTooltip() {
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (hovered && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.right + 8 });
    }
  }, [hovered]);

  return (
    <span
      ref={ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="ml-1 text-zinc-400 dark:text-zinc-500 cursor-help"
    >
      <svg className="w-3.5 h-3.5 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      {hovered && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[99999] px-2 py-1 text-xs bg-zinc-800 text-zinc-200 rounded shadow-lg whitespace-nowrap"
          style={{ top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
        >
          Unassessed species must be loaded per taxon group. Loading all species at once would require very high memory usage and data transfer.
        </div>,
        document.body
      )}
    </span>
  );
}

// Builds the URL for a node's full, filterable species list in RedListView (the same
// destination a table-row click gives) — an escape hatch from SpeciesListPanel's
// lighter-weight view to the full experience (sorting, charts, map, exact filters).
// Opened with target="_blank" like every other popover link, so it doesn't replace
// the caller's place in the current tab.
function nodeSpeciesListHref(
  nodeId: string,
  view: "reassessments" | "new-assessments",
  breakdown?: { rank: FilterRank; name: string; only?: number[]; excl?: number[] },
): string {
  const params = new URLSearchParams();
  params.set("taxa", taxaUrlToken(nodeId));
  if (view === "new-assessments") params.set("view", "new-assessments");
  // Narrows to just this breakdown row (e.g. Rodentia within Small Mammal SG), and
  // optionally to/away-from a small explicit id list (CoL Match / No CoL Match — see
  // parseBreakdownParam/RedListView's taxaFilteredSpecies for how `bd=` is consumed).
  if (breakdown) {
    let bd = `${nodeId}:${breakdown.rank}:${breakdown.name}`;
    if (breakdown.only?.length) bd += `:only:${breakdown.only.join(",")}`;
    else if (breakdown.excl?.length) bd += `:excl:${breakdown.excl.join(",")}`;
    params.set("bd", bd);
  }
  return `/?${prettifyQs(params.toString())}`;
}

// Builds a real URL (not a pushState-only path) for a single species' detail view —
// used with target="_blank" so opening a species from the popover doesn't lose the
// caller's place in the current tab.
function speciesHref(nodeId: string, speciesKey: string, view: "reassessments" | "new-assessments"): string {
  const params = new URLSearchParams();
  params.set("taxa", taxaUrlToken(nodeId));
  if (view === "new-assessments") params.set("view", "new-assessments");
  params.set("species", speciesKey);
  return `/?${prettifyQs(params.toString())}`;
}

// What SpeciesListPanel is currently showing — captured at click time from the
// specific breakdown row/bucket clicked, so the panel doesn't need to re-derive it.
type PanelBucket = "assessed" | "ne" | "noColMatch";
interface PanelRequest {
  rank: FilterRank;
  name: string;
  bucket: PanelBucket;
  label: string;
  noMatchIds?: number[];
  noMatchDetails?: NoMatchDetail[];
  splitDetails?: SplitDetail[];
  neSynonymDetails?: NeSynonymDetail[];
}

const PANEL_PAGE_SIZE = 10;
// Widened from 300 — the panel now renders a Name/Explanation/Year table
// (see SpeciesListPanel) instead of a single-column list, and 300px crammed
// the Explanation column's reason text (e.g. "Lumped Ctenomys mendocinus").
const PANEL_WIDTH = 440;
const PANEL_GAP = 8;

// Positions the species-list panel beside the popup it was opened from: to the
// right if there's room, else to the left, else (narrow viewports) directly under
// it — same "best effort, not perfect" approach as the popup's own positioning.
// Takes the popup's ACTUAL rendered rect (not just its {top,left} origin) — the
// popup's width varies with its content (it's max-w-[600px], not a fixed width), so
// assuming the max width left a visible gap for any popup narrower than that.
// Also clamps maxHeight so the panel's own bottom never runs off the viewport the
// way the popup itself used to (see computePopoverPos below) — long species lists
// scroll internally instead of extending past the visible area. `top` is never
// adjusted to fit — same "never flip/reposition, just clamp height" rule as the
// popup, so the panel's position relative to the popup is always predictable.
function computePanelPos(popupRect: { top: number; left: number; right: number }): { top: number; left: number; maxHeight: number } {
  const margin = 8;
  if (typeof window === "undefined") return { top: popupRect.top, left: popupRect.right, maxHeight: 400 };
  let top: number;
  let left: number;
  if (window.innerWidth - popupRect.right - PANEL_GAP >= PANEL_WIDTH) {
    top = popupRect.top;
    left = popupRect.right + PANEL_GAP;
  } else if (popupRect.left - PANEL_GAP >= PANEL_WIDTH) {
    top = popupRect.top;
    left = popupRect.left - PANEL_WIDTH - PANEL_GAP;
  } else {
    top = popupRect.top + 220;
    left = Math.max(8, Math.min(popupRect.left, window.innerWidth - PANEL_WIDTH - 8));
  }
  const maxHeight = Math.max(100, Math.min(window.innerHeight * 0.7, window.innerHeight - top - margin));
  return { top, left, maxHeight };
}

// Positions the "# Described Species" popup itself. Previously this only clamped
// `left`, leaving `top` (and the fixed max-h-[70vh]) free to push the popup's
// bottom edge below the viewport whenever the info icon was near the bottom of the
// screen — the content below the fold was there but unreachable (no scroll target
// visible, no way to see there was more). Now the max-height is derived from actual
// space below the button, so the popup's own internal scroll (not the viewport)
// handles anything that doesn't fit. Always opens downward from the button — never
// flips above it, so its position relative to the row that triggered it is always
// predictable.
// Widened from 340px to fit the breakdown table's 5 columns (name + 4 stat
// columns) legibly — see BreakdownList. A popover with no breakdown (plain
// source text) stays as narrow as its own content; max-w-[Npx] only caps how
// wide it's ALLOWED to grow, so this doesn't force short popovers to widen.
const POPOVER_MAX_WIDTH = 600;

// Anchored by its RIGHT edge (opens leftward from the button), not its left —
// the button sits partway across the taxa table, so opening rightward (the old
// behavior) routinely left too little room to the right for the species-list
// panel (computePanelPos below), pushing it below the popup instead of beside
// it. maxWidth (not a fixed left position) is derived from the actual space
// available to the left of the button, so the popup never runs off the left
// edge of the viewport regardless of how wide its content wants to be.
function computePopoverPos(rect: { top: number; bottom: number; left: number }): { top: number; right: number; maxWidth: number; maxHeight: number } {
  const margin = 8;
  const gap = 4;
  const spaceLeft = rect.left - gap - margin;
  const maxWidth = Math.max(120, Math.min(POPOVER_MAX_WIDTH, spaceLeft));
  const preferredMaxHeight = window.innerHeight * 0.7;
  const spaceBelow = window.innerHeight - rect.bottom - 4 - margin;
  return {
    top: rect.bottom + 4,
    right: window.innerWidth - rect.left + gap,
    maxWidth,
    maxHeight: Math.max(100, Math.min(preferredMaxHeight, spaceBelow)),
  };
}

/**
 * An explanatory note that appears the moment you hover, not a second later.
 *
 * A `title` attribute cannot do this: the delay before the browser shows one is
 * the browser's, not ours, and it is about a second. On a note that explains a
 * number the reader is already looking at ("why does this say 105.9%?"), a
 * second is long enough to give up and assume it is a bug.
 *
 * Portalled and position: fixed, for the same reason the popovers above are: the
 * taxa table scrolls horizontally and has sticky columns, so a tooltip rendered
 * in place is clipped by one ancestor or another. Shown on focus as well as
 * hover, since the trigger is reachable by keyboard.
 */
function HoverNote({ note, className, children }: { note: string; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const noteId = useId();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 260;
    const margin = 8;
    // Clamped so a flag near either edge doesn't hang off it.
    const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - margin));
    // Below by default, above when there isn't room — a row near the fold is
    // exactly where an over-100% flag tends to be.
    const below = window.innerHeight - rect.bottom > 90;
    setPos({ top: below ? rect.bottom + 6 : rect.top - 6, left });
  };
  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={() => setPos(null)}
        onFocus={show}
        onBlur={() => setPos(null)}
        aria-describedby={noteId}
        className={className}
      >
        {children}
        {/* describedby, not aria-label: on the split line the visible sentence is
            the content and this is the caveat about it, and a label would replace
            the sentence rather than follow it. */}
        <span id={noteId} className="sr-only">{note}</span>
      </span>
      {pos && typeof document !== "undefined" && createPortal(
        <div
          role="tooltip"
          className="fixed z-[9999] px-3 py-2 text-xs text-white bg-zinc-800 dark:bg-zinc-700 rounded-lg shadow-lg normal-case text-left pointer-events-none"
          style={{
            top: pos.top,
            left: pos.left,
            width: 260,
            transform: window.innerHeight - pos.top < 90 ? "translateY(-100%)" : undefined,
          }}
        >
          {note}
        </div>,
        document.body,
      )}
    </>
  );
}

// Same idea as computePopoverPos, but opens ABOVE the trigger instead of below —
// for a column HEADER icon (DescribedSourceInfoIcon), where opening below would
// drop the popover straight onto the table's own first data row instead of into
// the open space above the header.
function computePopoverPosAbove(rect: { top: number; bottom: number; left: number }): { bottom: number; right: number; maxWidth: number; maxHeight: number } {
  const margin = 8;
  const gap = 4;
  const spaceLeft = rect.left - gap - margin;
  const maxWidth = Math.max(120, Math.min(POPOVER_MAX_WIDTH, spaceLeft));
  const preferredMaxHeight = window.innerHeight * 0.7;
  const spaceAbove = rect.top - 4 - margin;
  return {
    bottom: window.innerHeight - rect.top + 4,
    right: window.innerWidth - rect.left + gap,
    maxWidth,
    maxHeight: Math.max(100, Math.min(preferredMaxHeight, spaceAbove)),
  };
}

// Paginated species-level list rendered beside the main popup when a count row
// (Assessed / Not Evaluated / CoL Match / No CoL Match) is clicked — lets a
// specialist scroll through every species in that bucket without leaving the page.
// Fetches the SAME broad per-node species list RedListView itself fetches
// (/api/redlist/species?taxon=...), then narrows client-side with the same
// speciesMatchesNode/matchesBreakdownName functions RedListView uses — no new API
// surface. Cached per (nodeId, assessed|NE) for the component's lifetime, so
// switching between Assessed/CoL Match/No CoL Match (all drawn from the same
// assessed fetch) never re-fetches.
function SpeciesListPanel({
  nodeId,
  request,
  pos,
  onClose,
  panelRef,
}: {
  nodeId: string;
  request: PanelRequest;
  pos: { top: number; left: number; maxHeight: number };
  onClose: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  const isNe = request.bucket === "ne";
  const cacheRef = useRef<Map<string, RedListSpecies[]>>(new Map());
  const [rows, setRows] = useState<RedListSpecies[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  // Newest first by default — assessment year for the assessed buckets, CoL
  // description year for Not Evaluated. Alphabetical put Abrahamia and Acer at
  // the top of every plant list, which is an accident of the alphabet; the
  // recent end is the part anyone opening this is looking at.
  const [sortBy, setSortBy] = useState<"name" | "date">("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Set by clicking one of the composition entries above the table: shows only
  // that reason's species. Same code the entry is labelled with (displayReason).
  const [reasonFilter, setReasonFilter] = useState<string | null>(null);

  useEffect(() => {
    const cacheKey = isNe ? "ne" : "assessed";
    const cached = cacheRef.current.get(cacheKey);
    if (cached) { setRows(cached); return; }
    setRows(null);
    setError(null);
    const controller = new AbortController();
    const qs = new URLSearchParams({ taxon: nodeId });
    if (isNe) qs.set("category", "NE");
    fetch(`/api/redlist/species?${qs.toString()}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Species fetch failed (${res.status})`))))
      .then((data: { species: RedListSpecies[] }) => {
        cacheRef.current.set(cacheKey, data.species);
        setRows(data.species);
      })
      .catch((err) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Failed to load species"); });
    return () => controller.abort();
  }, [nodeId, isNe]);

  // Reset pagination/search/sort whenever the *view* changes — keyed on the full
  // bucket/name/rank identity, not just nodeId/isNe, so switching between (say)
  // "1:1 CoL Match" and "No 1:1 CoL Match" (both non-NE, so isNe alone wouldn't
  // change) still resets a stale page number or search term from the last view.
  useEffect(() => {
    setPage(1); // eslint-disable-line react-hooks/set-state-in-effect -- reset when switching bucket/name
    setSearch("");
    setSortBy("date");
    setSortDir("desc");
    setReasonFilter(null);
  }, [nodeId, request.bucket, request.name, request.rank]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    let matched = rows.filter((s) => speciesMatchesNode(s, nodeId) && matchesBreakdownName(s, request.rank, request.name, nodeId));
    if (request.bucket === "noColMatch" && request.noMatchIds?.length) {
      const only = new Set(
        reasonFilter
          ? (request.noMatchDetails ?? []).filter((d) => displayReason(d) === reasonFilter).map((d) => d.id)
          : request.noMatchIds,
      );
      matched = matched.filter((s) => s.sis_taxon_id != null && only.has(s.sis_taxon_id));
    }
    return matched;
  }, [rows, nodeId, request, reasonFilter]);

  const searched = useMemo(() => {
    if (!filtered) return null;
    const q = search.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((s) => s.scientific_name.toLowerCase().includes(q) || (s.common_name?.toLowerCase().includes(q) ?? false));
  }, [filtered, search]);

  // "date" sorts by assessment year for the assessed/CoL-match buckets, or by CoL
  // description year for the NE bucket (assessment_date is always null there — NE
  // species haven't been assessed). Undated rows sort to the bottom regardless of
  // direction.
  const sorted = useMemo(() => {
    if (!searched) return null;
    const arr = [...searched];
    if (sortBy === "name") {
      arr.sort((a, b) => a.scientific_name.localeCompare(b.scientific_name));
    } else {
      const value = (s: RedListSpecies) => (isNe ? s.described_year : s.assessment_date ? Date.parse(s.assessment_date) : null);
      arr.sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return sortDir === "desc" ? vb - va : va - vb;
      });
    }
    return arr;
  }, [searched, sortBy, sortDir, isNe]);

  const reasonBySisId = useMemo(() => {
    const m = new Map<number, NoMatchDetail>();
    request.noMatchDetails?.forEach((d) => m.set(d.id, d));
    return m;
  }, [request.noMatchDetails]);

  const splitByColId = useMemo(() => {
    const m = new Map<string, SplitDetail>();
    request.splitDetails?.forEach((d) => m.set(d.colId, d));
    return m;
  }, [request.splitDetails]);

  const composition = useMemo(
    () => (request.bucket === "noColMatch" ? reasonComposition(request.noMatchDetails ?? []) : []),
    [request.bucket, request.noMatchDetails],
  );

  const neSynonymByColId = useMemo(() => {
    const m = new Map<string, NeSynonymDetail>();
    request.neSynonymDetails?.forEach((d) => m.set(d.colId, d));
    return m;
  }, [request.neSynonymDetails]);

  const total = sorted?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PANEL_PAGE_SIZE));
  const pageRows = sorted ? sorted.slice((page - 1) * PANEL_PAGE_SIZE, page * PANEL_PAGE_SIZE) : [];
  const fullListHref = nodeSpeciesListHref(
    nodeId,
    isNe ? "new-assessments" : "reassessments",
    request.bucket === "noColMatch"
      ? { rank: request.rank, name: request.name, only: request.noMatchIds }
      : { rank: request.rank, name: request.name },
  );

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[9999] overflow-y-auto px-3 py-2 text-xs text-white bg-zinc-800 dark:bg-zinc-700 rounded-lg shadow-lg normal-case text-left"
      style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
      onClick={(e) => e.stopPropagation()}
      // Not inside popoverRef (a portal sibling, not a DOM descendant) — the outside-
      // click listener in DescribedInfoIcon only checks popoverRef/btnRef, so stop the
      // mousedown here too (onClick's stopPropagation alone doesn't cover the
      // mousedown phase that listener runs on) or every click inside the panel would
      // close the whole popup+panel before it registers.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className="font-medium">{request.label}</p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <a href={fullListHref} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200 underline">
            Open full list ↗
          </a>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>
      </div>
      {!error && filtered && filtered.length > 0 && (
        <div className="flex items-center gap-1.5 mb-1.5 text-[11px]">
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search…"
            aria-label="Search species"
            className="flex-1 min-w-0 px-1.5 py-0.5 rounded bg-zinc-900/40 dark:bg-zinc-950/40 text-white placeholder-zinc-500 outline-none focus:ring-1 focus:ring-zinc-500"
          />
          <button
            type="button"
            onClick={() => setSortBy("name")}
            className={`flex-shrink-0 ${sortBy === "name" ? "text-white underline" : "text-zinc-400 hover:text-white"}`}
          >
            Name
          </button>
          <button
            type="button"
            onClick={() => (sortBy === "date" ? setSortDir((d) => (d === "desc" ? "asc" : "desc")) : setSortBy("date"))}
            className={`flex-shrink-0 ${sortBy === "date" ? "text-white underline" : "text-zinc-400 hover:text-white"}`}
            title={isNe ? "Sort by CoL description year" : "Sort by assessment year"}
          >
            {isNe ? "Described Yr" : "Assess. Yr"}
            {sortBy === "date" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
          </button>
        </div>
      )}
      {error && <p className="text-red-300">{error}</p>}
      {!error && rows === null && (
        <div className="flex justify-center py-3">
          <svg className="animate-spin h-4 w-4 text-zinc-400" viewBox="0 0 24 24" fill="none" aria-label="Loading">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}
      {/* What the one number is made of, in the dashboard chart's own words.
          Nine findings sit under "No 1:1 CoL Match" and they are not the same
          kind of thing: "Lumped on CoL" is a taxonomic disagreement, "In XR,
          not Base" is CoL holding the record outside its curated checklist,
          and a bare count tells a specialist neither. Describes the whole
          bucket, not the filtered page — it explains the column's number. */}
      {!error && request.bucket === "noColMatch" && composition.length > 0 && (() => {
        const chip = (c: { reason: string; label: string; count: number }, i: number) => (
          <span key={c.reason}>
            {i > 0 && <span className="text-zinc-600"> · </span>}
            <button
              type="button"
              aria-pressed={reasonFilter === c.reason}
              onClick={() => { setReasonFilter((r) => (r === c.reason ? null : c.reason)); setPage(1); }}
              className={
                reasonFilter === c.reason
                  ? "text-white underline underline-offset-2"
                  : "underline decoration-dotted underline-offset-2 hover:text-white"
              }
            >
              {c.count} {c.label}
            </button>
          </span>
        );
        return (
          <p className="mb-1.5 text-zinc-400">
            {composition.map(chip)}
            {reasonFilter && (
              <button
                type="button"
                onClick={() => { setReasonFilter(null); setPage(1); }}
                className="ml-1.5 text-zinc-500 hover:text-zinc-300"
              >
                ✕ clear
              </button>
            )}
          </p>
        );
      })()}
      {!error && filtered && filtered.length === 0 && <p className="text-zinc-400">No species.</p>}
      {!error && filtered && filtered.length > 0 && sorted && sorted.length === 0 && (
        <p className="text-zinc-400">No species match your search.</p>
      )}
      {!error && sorted && sorted.length > 0 && (
        <>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-zinc-400">
                <th className="pb-1 pr-2 font-normal text-left">Name</th>
                <th className="pb-1 pr-2 font-normal text-left">Explanation</th>
                <th className="pb-1 font-normal text-right whitespace-nowrap">{isNe ? "Described" : "Assessed"}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((s) => {
                const detail = s.sis_taxon_id != null ? reasonBySisId.get(s.sis_taxon_id) : undefined;
                const split = s.col_id != null ? splitByColId.get(s.col_id) : undefined;
                const neSyn = s.col_id != null ? neSynonymByColId.get(s.col_id) : undefined;
                const year = isNe ? s.described_year : (s.assessment_date ? s.assessment_date.slice(0, 4) : null);
                return (
                  <tr key={s.species_key} className="border-t border-zinc-700/60 align-top">
                    <td className="py-1 pr-2">
                      <a
                        href={speciesHref(nodeId, s.species_key, isNe ? "new-assessments" : "reassessments")}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-300 hover:text-blue-200 underline"
                      >
                        {s.scientific_name}
                      </a>
                      {s.category && s.category !== "NE" && (
                        <span
                          className="ml-1 px-1 rounded text-[10px] font-medium"
                          style={{ backgroundColor: `${CATEGORY_COLORS[s.category] || "#999"}33`, color: CATEGORY_COLORS[s.category] || "#999" }}
                        >
                          {s.category}
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-zinc-300">
                      {/* The dashboard flag's own renderer, subject-free: same
                          sentence, same links. It used to link a named species to
                          its page in this app instead of to CoL, which is the one
                          link a row of evidence about CoL's records should have —
                          the species page is a click away in the Name column. */}
                      {detail && <NoMatchLine flag={detail} subject={null} />}
                      {/* Not Evaluated, but IUCN has assessed the taxon under another
                          name — the checkable one first, since the split line is a
                          heuristic and this is CoL's own synonymy. A species can
                          carry both; they are different relationships, so both show. */}
                      {neSyn && (() => {
                        const sentence = neSynonymSentence(neSyn.assessedName);
                        return (
                          <span className="block">
                            {sentence.before}
                            <a
                              href={speciesHref(nodeId, sisRowKey(neSyn.assessedId), "reassessments")}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-300 hover:text-blue-200 underline"
                            >
                              {sentence.detail}
                            </a>
                            {sentence.after}
                          </span>
                        );
                      })()}
                      {split && (() => {
                        const sentence = neSplitSentence(split.parentName);
                        return (
                          <HoverNote note={NE_SPLIT_EVIDENCE} className="block">
                            {sentence.before}
                            <a
                              href={speciesHref(nodeId, sisRowKey(split.parentId), "reassessments")}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-300 hover:text-blue-200 underline"
                            >
                              {sentence.detail}
                            </a>
                            {sentence.after}
                          </HoverNote>
                        );
                      })()}
                    </td>
                    <td className="py-1 text-right text-zinc-400 whitespace-nowrap">{year ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-zinc-700">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-30 hover:text-white">
              ‹ Prev
            </button>
            <span className="text-zinc-400">
              {(page - 1) * PANEL_PAGE_SIZE + 1}-{Math.min(page * PANEL_PAGE_SIZE, total)} of {total}
            </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-30 hover:text-white">
              Next ›
            </button>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}

// Renders a describeFilter() result: plain text, or a link where we resolved a CoL id.
function renderFilterSegs(segs: DescribeFilterSegment[]): React.ReactNode {
  return segs.map((seg, i) =>
    seg.href ? (
      <a
        key={i}
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-300 hover:text-blue-200 underline"
      >
        {seg.text}
      </a>
    ) : (
      <span key={i}>{seg.text}</span>
    )
  );
}

// Per-name breakdown table for the "# Described Species" popover — one row per
// name in the node's primary filter dimension (e.g. each order in Small Mammal
// SG), columns for the whole colDescribed -> Assessed -> {1:1 CoL Match, No 1:1
// CoL Match} -> Not Evaluated split, all visible at once instead of needing to
// expand each name to compare them (a real cost for a multi-name breakdown —
// spotting which family has the most unmatched species used to mean opening
// every row one at a time). Clicking # Assessed / No 1:1 CoL Match / # Not
// Evaluated opens the species-level panel (onOpenPanel) narrowed to that exact
// slice; # Described has no drill-down (it's CoL's own count, not a species
// list this dashboard can independently show).
function BreakdownList({
  rank,
  label,
  breakdown,
  onOpenPanel,
  liveColIds,
}: {
  rank: FilterRank;
  label: string;
  breakdown: { name: string; count: number; neCount: number; trueAssessed: number; noMatchIds: number[]; noMatchDetails?: NoMatchDetail[]; splitDetails?: SplitDetail[]; neSynonymDetails?: NeSynonymDetail[] }[];
  onOpenPanel: (request: PanelRequest) => void;
  liveColIds?: Record<string, string>;
}) {
  return (
    <div className="mt-1">
      <table className="border-collapse">
        <thead>
          {/* Two-row header: "No 1:1 CoL Match" sits UNDER a shared "Assessed"
              group header (colSpan 2, underlined) alongside "Total" — a
              standard grouped-column convention that shows it's a SUBSET of
              Assessed, not a sibling stat, without needing to cram both
              numbers into one cell (each still needs its own click target).
              The first column header is deliberately blank, not "Name" or the
              rank ("Family"/"Order"/...) — each row already states its own
              rank inline ("Family: Muridae"), which reads better than a single
              rank word doing that job once for the whole table, especially
              for a single-row breakdown (every dynamic taxonomic-drilldown
              node) where a lone header word above one row felt disconnected
              from it. */}
          <tr className="text-zinc-400">
            <th rowSpan={2} className="pr-3 pb-1 font-normal text-left align-bottom" />
            <th rowSpan={2} className="px-2 pb-1 font-normal text-right align-bottom"># Described</th>
            <th colSpan={2} className="px-2 pb-0.5 font-normal text-center border-b border-zinc-600">
              Assessed
            </th>
            <th rowSpan={2} className="pl-2 pb-1 font-normal text-right align-bottom"># Not Evaluated</th>
          </tr>
          <tr className="text-zinc-400">
            <th className="px-2 pb-1 pt-0.5 font-normal text-right">Total</th>
            <th
              className="px-2 pb-1 pt-0.5 font-normal text-right"
              title="Assessed by IUCN, with no clean 1:1 link to one of the species counted under # Described. Not one finding but several — a lump, a demotion below species, a name CoL doesn't accept, a record CoL holds only in its extended release or only provisionally, or nothing in CoL at all. Click the number for the breakdown by reason, and for the species behind each."
            >
              No 1:1 CoL Match
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((b) => {
            const rowLabel = breakdownDisplayName(rank, b.name);
            const href = breakdownHref(rank, b.name, liveColIds);
            return (
              <tr key={b.name} className="border-t border-zinc-700/60">
                <td className="pr-3 py-1 whitespace-nowrap">
                  {label}:{" "}
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-300 hover:text-blue-200 underline"
                      title={`View ${rowLabel} on Catalogue of Life`}
                    >
                      {rowLabel}
                    </a>
                  ) : (
                    rowLabel
                  )}
                </td>
                <td className="px-2 py-1 text-right text-zinc-300">{b.count}</td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-white"
                    onClick={() => onOpenPanel({ rank, name: b.name, bucket: "assessed", label: `${rowLabel} — Assessed` })}
                  >
                    {b.trueAssessed}
                  </button>
                </td>
                <td className="px-2 py-1 text-right">
                  {b.noMatchIds.length > 0 ? (
                    <button
                      type="button"
                      className="underline decoration-dotted underline-offset-2 hover:text-white"
                      onClick={() => onOpenPanel({ rank, name: b.name, bucket: "noColMatch", label: `${rowLabel} — No 1:1 CoL Match`, noMatchIds: b.noMatchIds, noMatchDetails: b.noMatchDetails })}
                    >
                      {b.noMatchIds.length}
                    </button>
                  ) : (
                    <span className="text-zinc-300">0</span>
                  )}
                </td>
                <td className="pl-2 py-1 text-right">
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-white"
                    onClick={() => onOpenPanel({ rank, name: b.name, bucket: "ne", label: `${rowLabel} — Not Evaluated`, splitDetails: b.splitDetails, neSynonymDetails: b.neSynonymDetails })}
                  >
                    {b.neCount}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// "# Described Species" COLUMN HEADER info icon — explains what the number means
// (IUCN Table 1a estimate vs. CoL backbone count) and, since #272/#274's IUCN↔CoL
// toggle used to live as its own persistent row below the whole table, now also
// carries that toggle instead — one info icon doing both jobs rather than a
// tooltip AND a separate always-visible control. Click-to-open (not hover), same
// reasoning as DescribedInfoIcon below: a hover-only tooltip vanishes the instant
// the cursor leaves the tiny icon, before it reaches the toggle buttons inside.
function DescribedSourceInfoIcon({ describedSource, setDescribedSource }: { describedSource: "iucn" | "col"; setDescribedSource: (s: "iucn" | "col") => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ bottom: 0, right: 0, maxWidth: 0, maxHeight: 0 });

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "mousedown") {
        const target = e.target as Node;
        if (popoverRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          if (!open && btnRef.current) setPos(computePopoverPosAbove(btnRef.current.getBoundingClientRect()));
          setOpen((v) => !v);
        }}
        className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
      >
        <FaInfoCircle size={12} />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-[9999] px-3 py-2 text-xs text-white bg-zinc-800 dark:bg-zinc-700 rounded-lg shadow-lg normal-case overflow-y-auto text-left"
          style={{ bottom: pos.bottom, right: pos.right, maxWidth: pos.maxWidth, maxHeight: pos.maxHeight }}
        >
          <p>
            {describedSource === "col"
              ? `Described species from the ${COL_RELEASE_LABEL} backbone`
              : "Estimates from IUCN Red List Table 1a (2026-1)"}
          </p>
          <p className="mt-1">
            <a
              href={describedSource === "col" ? COL_RELEASE_URL : IUCN_SOURCE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-300 hover:text-blue-200 underline"
            >
              View source
            </a>
          </p>
          <p className="mt-1.5 flex items-center gap-1.5 text-zinc-300">
            Source:
            <span className="inline-flex rounded-md overflow-hidden border border-zinc-600 text-[10px] font-semibold">
              {(["iucn", "col"] as const).map((src) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setDescribedSource(src)}
                  className={`px-1.5 py-0.5 transition-colors ${
                    describedSource === src
                      ? "bg-zinc-200 text-zinc-900"
                      : "text-zinc-300 hover:bg-zinc-600"
                  }`}
                >
                  {src === "iucn" ? "IUCN" : "CoL"}
                </button>
              ))}
            </span>
          </p>
        </div>,
        document.body
      )}
    </span>
  );
}

// "# Described Species" info icon — click-to-open (not hover), so the popover stays
// put while the user moves the mouse onto it to read/click a link. An earlier
// hover-only version (CSS :hover + an offset tooltip) made the tooltip vanish the
// instant the cursor left the tiny icon, before it reached the tooltip — any gap
// between a hover trigger and its target does this, there's no CSS-only fix that
// survives a real mouse gap. Portal-rendered (mirrors the column-visibility menu
// pattern above) so it isn't clipped by the table's scroll/sticky ancestors.
function DescribedInfoIcon({ nodeId, source, breakdown }: { nodeId: string; source: "iucn" | "col"; breakdown?: { name: string; count: number; neCount: number; trueAssessed: number; noMatchIds: number[]; noMatchDetails?: NoMatchDetail[]; splitDetails?: SplitDetail[]; neSynonymDetails?: NeSynonymDetail[] }[] }) {
  const node = findNode(nodeId);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0, maxWidth: 0, maxHeight: 0 });
  // Species-level panel opened by clicking a count row (Assessed/Not Evaluated/CoL
  // Match/No CoL Match) — a sibling of the popup, not nested inside it, so it can
  // sit beside rather than replace the counts view. Closes whenever the popup does.
  const [activePanel, setActivePanel] = useState<PanelRequest | null>(null);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0, maxHeight: 0 });
  // Live, on-demand breakdown for a dynamic (taxonomic-drilldown) node — see
  // live-breakdown.ts. A dynamic node's colBreakdown prop is always undefined
  // (never precomputed, unlike an official/SSC node's), so this fetches the
  // one-bucket equivalent when the popover opens, not eagerly for a whole
  // level. Skipped entirely for real nodes (breakdown is already provided, or
  // there's genuinely none). Loading state is surfaced explicitly (a spinner
  // + "may take a moment" note) rather than hidden, since the underlying
  // backbone-dependent query can be slow on a cold server start.
  const [liveBreakdown, setLiveBreakdown] = useState<typeof breakdown>(undefined);
  const [liveBreakdownLoading, setLiveBreakdownLoading] = useState(false);
  const [liveBreakdownError, setLiveBreakdownError] = useState(false);
  useEffect(() => {
    // liveBreakdownError is a guard, not just a display flag: without it a failed
    // request re-armed this effect the moment `finally` cleared the loading flag
    // (both are dependencies), which refetched, failed, and refetched again —
    // hammering the endpoint while the popover showed a spinner that never
    // resolved, since loading was true again before the error line could be read.
    // Cleared on each open below, so a reopen retries once rather than never.
    if (!open || !isDynamicNodeId(nodeId) || breakdown?.length || liveBreakdown || liveBreakdownLoading || liveBreakdownError) return;
    setLiveBreakdownLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- kick off the fetch's loading state
    fetch(`/api/redlist/taxa-breakdown-live?nodeId=${encodeURIComponent(nodeId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Live breakdown failed (${res.status})`))))
      .then((data) => setLiveBreakdown([data.breakdown]))
      .catch(() => setLiveBreakdownError(true))
      .finally(() => setLiveBreakdownLoading(false));
  }, [open, nodeId, breakdown, liveBreakdown, liveBreakdownLoading, liveBreakdownError]);
  const effectiveBreakdown = breakdown?.length ? breakdown : liveBreakdown;
  // CoL taxon ids for this dynamic node's own ancestor chain (e.g.
  // "rodentia"/"heteromyidae"/"chaetodipus"), used as a fallback wherever the
  // precomputed static-tree COL_TAXON_IDS snapshot doesn't cover a name (which
  // is always, for a name reached purely through live drilldown). Fetched via
  // its own separate, much faster endpoint (see the API route's doc comment) —
  // NOT bundled into the liveBreakdown fetch above — so the rank/name header
  // (visible only while that slower breakdown is still loading, below) can
  // show every ancestor as a working link well before the table itself
  // finishes, rather than both arriving together only once the slow query
  // does.
  const [liveColIds, setLiveColIds] = useState<Record<string, string> | undefined>(undefined);
  const [liveColIdsLoading, setLiveColIdsLoading] = useState(false);
  useEffect(() => {
    if (!open || !isDynamicNodeId(nodeId) || liveColIds || liveColIdsLoading) return;
    setLiveColIdsLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- kick off the fetch's loading state
    fetch(`/api/redlist/col-taxon-ids-live?nodeId=${encodeURIComponent(nodeId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Live CoL taxon id lookup failed (${res.status})`))))
      .then((data) => setLiveColIds(data.colIds))
      .catch(() => setLiveColIds({})) // degrade to unlinked plain text, don't retry forever
      .finally(() => setLiveColIdsLoading(false));
  }, [open, nodeId, liveColIds, liveColIdsLoading]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      // Outside click only — deliberately NOT closed by scroll (page or table-body)
      // anymore. It used to close on any scroll to avoid a stale-positioned
      // popover, but position: fixed keeps it correctly anchored to the viewport
      // regardless of what scrolls underneath it, and closing on scroll made it
      // impossible to scroll the rest of the page while consulting the popover.
      if (e.type === "mousedown") {
        const target = e.target as Node;
        if (
          popoverRef.current?.contains(target) ||
          panelRef.current?.contains(target) ||
          btnRef.current?.contains(target)
        ) return;
      }
      setOpen(false);
      setActivePanel(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // Keeps the popup pinned to its trigger button (and, via the effect below, the
  // panel pinned to the popup) while the page scrolls underneath — so it stays
  // next to the SSC row it was opened from instead of drifting away as a
  // viewport-fixed element normally would. Ignores scroll events whose target is
  // inside the popover/panel's own overflow-y-auto content (still reachable here
  // since this listens on the capture phase, even though such scrolls don't
  // bubble) — scrolling a long species list shouldn't relocate the whole popup.
  // rAF-throttled since scroll fires far more often than a repaint needs.
  useEffect(() => {
    if (!open) return;
    let rafId: number | null = null;
    const reposition = (e: Event) => {
      if (e.type === "scroll") {
        const target = e.target as Node;
        if (popoverRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      }
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (btnRef.current) setPos(computePopoverPos(btnRef.current.getBoundingClientRect()));
      });
    };
    document.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("scroll", reposition, true);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [open]);

  // Keeps the species panel pinned to the popup's current rect — re-runs whenever
  // the popup moves (pos changes, e.g. from the scroll-reposition effect above) or
  // a different bucket is opened, so it never lags behind the popup it's beside.
  useEffect(() => {
    if (!open || !activePanel) return;
    const rect = popoverRef.current?.getBoundingClientRect();
    if (rect) setPanelPos(computePanelPos(rect)); // eslint-disable-line react-hooks/set-state-in-effect -- track the popup's DOM position, not React state
  }, [open, activePanel, pos]);

  // A dynamic (live taxonomic-drilldown) node isn't in NODE_INDEX, but is a real,
  // describable filter (see dynamic-taxon.ts) — build one on the fly instead of
  // requiring findNode to succeed. Its `source` is always "col" in practice
  // (resolveDescribed forces useCol for every non-official node, and dynamic
  // nodes are never official), so the "iucn" branch below — which needs real
  // node.estimatedSource/estimatedSourceUrl — is never reached for one; the
  // early return just below handles that safely either way.
  const dynFilter = !node ? dynamicNodeFilter(nodeId) : null;
  if (!node && !dynFilter) return null;
  if (source === "iucn" && !node?.estimatedSource) return null;
  const filter = node?.filter ?? dynFilter!;

  // A dynamic node's full ancestor chain (e.g. "Order: Rodentia; Family:
  // Heteromyidae; Genus: Chaetodipus"), each part linked to CoL — liveColIds
  // fills in a link for names the precomputed static-tree snapshot can't cover
  // (see its own fetch above for why it's a separate, faster request than the
  // breakdown itself: this line is only ever rendered BELOW while
  // effectiveBreakdown hasn't loaded yet, so every ancestor needs to already be
  // linked by then, not whenever the slower breakdown eventually finishes).
  // Once the breakdown table loads, this line is hidden — the table's own
  // per-name rows (also using liveColIds) take over as the click-through.
  const filterSegs = source === "col" ? describeFilter(filter, node ? nodeId : undefined, liveColIds) : [];

  // True for an "Unclassified <Rank>" bucket (dynamicNodeDisplayName's blank-
  // segment case) — most visible for Molluscs' Gastropoda, where ~44% of
  // species have no order recorded in Catalogue of Life's data at all (e.g.
  // Stylommatophora, 3,338+ assessed land snail species, has zero CoL
  // order-level records). Called out explicitly here rather than left for a
  // reader to infer from an otherwise-unremarkable row — a real, sizeable
  // bucket that looks exactly like any other order/family/genus bucket
  // without this note.
  const dynSegments = isDynamicNodeId(nodeId) ? parseDynamicNodeId(nodeId)?.segments : undefined;
  const isUnclassifiedBucket = Boolean(dynSegments?.length && dynSegments[dynSegments.length - 1].value === "");
  const unclassifiedRankLabel = isUnclassifiedBucket ? dynamicNodeRankInfo(nodeId)!.label.toLowerCase() : "";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!open && btnRef.current) {
            setPos(computePopoverPos(btnRef.current.getBoundingClientRect()));
            setLiveBreakdownError(false); // one fresh attempt per open — see the fetch effect's guard
          }
          setOpen((v) => !v);
        }}
        className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
      >
        <FaInfoCircle size={10} />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-[9999] px-3 py-2 text-xs text-white bg-zinc-800 dark:bg-zinc-700 rounded-lg shadow-lg normal-case overflow-y-auto text-left"
          style={{ top: pos.top, right: pos.right, maxWidth: pos.maxWidth, maxHeight: pos.maxHeight }}
        >
          {source === "iucn" ? (
            // Only ever reached for a real (non-dynamic) node — see the early
            // return above, which bails out for "iucn" whenever node is absent.
            // estimatedSource often names a specific citation ALONGSIDE IUCN
            // ("IUCN 2026-1 (MolluscaBase 2025)") but estimatedSourceUrl only
            // ever links that specific citation — the IUCN Table 1a PDF itself
            // (where this figure is actually published) had no link at all.
            // Show both whenever they genuinely differ; nodes that cite IUCN
            // alone (estimatedSourceUrl === IUCN_SOURCE_URL) still get just one.
            <>
              <p>{node!.estimatedSource}</p>
              <p className="mt-1 flex flex-col items-start gap-0.5">
                <a
                  href={IUCN_SOURCE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-300 hover:text-blue-200 underline"
                >
                  View IUCN Red List Table 1a
                </a>
                {node!.estimatedSourceUrl && node!.estimatedSourceUrl !== IUCN_SOURCE_URL && (
                  <a
                    href={node!.estimatedSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-300 hover:text-blue-200 underline"
                  >
                    View source
                  </a>
                )}
              </p>
            </>
          ) : (
            <>
              {isUnclassifiedBucket && (
                <p className="text-zinc-300 mb-1">
                  These are real, counted species — they just have no {unclassifiedRankLabel} recorded in Catalogue of Life&apos;s data, so they land here rather than under a named {unclassifiedRankLabel}.
                </p>
              )}
              {!effectiveBreakdown?.length && filterSegs.length > 0 && (
                <p>{renderFilterSegs(filterSegs)}</p>
              )}
              {liveBreakdownLoading && (
                <p className="flex items-center gap-1.5 text-zinc-300">
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Enumerating described species from CoL and assessed species from Red List – may take several seconds...
                </p>
              )}
              {liveBreakdownError && (
                <p className="text-zinc-300">Species-level detail unavailable right now.</p>
              )}
              {effectiveBreakdown?.length ? (() => {
                // A dynamic node's rank is its own deepest segment (e.g. "Family"
                // for a family-level node), not primaryFilterRank's "first set
                // dimension" pick — wrong for a multi-dimension dynamic filter
                // (order+family both set) since that always picks "order" first.
                const dim = isDynamicNodeId(nodeId) ? dynamicNodeRankInfo(nodeId) : primaryFilterRank(filter);
                return dim ? (
                  <BreakdownList
                    rank={dim.rank}
                    label={dim.label}
                    breakdown={effectiveBreakdown}
                    onOpenPanel={setActivePanel}
                    liveColIds={liveColIds}
                  />
                ) : null;
              })() : null}
              <p className="mt-1.5 text-zinc-300">
                Source:{" "}
                <a href={COL_RELEASE_URL} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200 underline">
                  {COL_RELEASE_LABEL}
                </a>
                .
              </p>
            </>
          )}
        </div>,
        document.body
      )}
      {open && activePanel && typeof document !== "undefined" && (
        <SpeciesListPanel
          nodeId={nodeId}
          request={activePanel}
          pos={panelPos}
          onClose={() => setActivePanel(null)}
          panelRef={panelRef}
        />
      )}
    </>
  );
}

export default function TaxaSummary({ onToggleTaxon, selectedTaxa, selectedSubgroups, onToggleSubgroup, onNavigateToSubgroup, disableAllSpecies, viewMode = "reassessments", layoutMode, onLayoutModeChange, countryModeContent, countryPillsContent, countryScope }: Props) {
  const isNewAssessments = viewMode === "new-assessments";
  const router = useRouter();
  const [taxa, setTaxa] = useState<TaxonSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks whether the taxa table is expanded for multi-select.
  // Set to true only when the user Cmd/Ctrl+clicks a taxon row;
  // cleared when the modifier key is released.
  const [taxaExpanded, setTaxaExpanded] = useState(false);
  // Which taxa are expanded to show subgroups (e.g., "reptiles", "fishes")
  const [expandedTaxa, setExpandedTaxa] = useState<Set<string>>(new Set());
  // Fetched subgroup data keyed by taxonId
  const [subgroupData, setSubgroupData] = useState<Record<string, SubGroupSummary[]>>({});
  const [loadingSubgroups, setLoadingSubgroups] = useState<Set<string>>(new Set());
  // Refs to avoid stale closures in toggleExpand
  const subgroupDataRef = useRef(subgroupData);
  subgroupDataRef.current = subgroupData;
  const loadingSubgroupsRef = useRef(loadingSubgroups);
  loadingSubgroupsRef.current = loadingSubgroups;
  const initialFocus: FocusMode = isNewAssessments ? "new-assessments" : "redlist";
  const [focusMode, setFocusMode] = useState<FocusMode>(initialFocus);
  const [hiddenColumns, setHiddenColumns] = useState<Set<ColumnId>>(new Set(FOCUS_HIDDEN[initialFocus]));

  // Sync focus mode when viewMode changes
  useEffect(() => {
    const mode: FocusMode = isNewAssessments ? "new-assessments" : "redlist";
    setFocusMode(mode);
    setHiddenColumns(new Set(FOCUS_HIDDEN[mode]));
  }, [isNewAssessments]);
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Only actually scope this table's own data to a country while in Country
  // View (layoutMode === "country") — countryScope itself is set from ANY
  // country click/hover anywhere on the page (e.g. the small map widget in
  // an ordinary taxon view's own charts row), but this table's numbers
  // (fetchTaxa, ensureSubgroupData, Table 1a/SSC fetches, and the cache-
  // buster reset below) should stay global outside Country View — clicking
  // DRC while browsing Mammals shouldn't silently re-scope the breadcrumb
  // tree to DRC's numbers. countryKey derives from this, so gating here
  // covers every one of those effects at once.
  const countryScoped = layoutMode === "country" && !!countryScope?.length;
  // Stable, order-independent key for the current country selection — used in
  // place of the countryScope array itself in effect dependency arrays and
  // fetch query strings. countryScope is a fresh array every render (built via
  // `[...selectedCountries]` in RedListView), so depending on the array
  // reference directly would refetch on every unrelated parent re-render, not
  // just when the actual selection changes; sorting also means toggling two
  // countries on in either order produces the same key (and cache-friendly
  // URL), not one per click order.
  const countryKey = countryScoped ? [...countryScope!].sort().join(",") : "";
  // Kept in sync every render (plain assignment, not an effect — refs don't
  // need one) so the promise-chained fetches below (toggleExpand, Table 1a,
  // SSC groups — unlike the main fetchTaxa effect above, these aren't
  // effect-cleanup-cancellable) can tell, once their response finally
  // resolves, whether countryKey has already moved on to a different
  // country and skip applying a now-stale result.
  const countryKeyRef = useRef(countryKey);
  countryKeyRef.current = countryKey;
  // Same layoutMode === "country" gate as countryScoped above — Country
  // View's own landing page always uses the plain 3-column style (even
  // before a country is picked, showing global data) since Described/GBIF/
  // CoL columns have no country dimension there either.
  const countryStyleColumns = layoutMode === "country";
  // Tighter, non-responsive padding for the sticky Taxonomic Group column in
  // Country View — cellPad's px-4 growth at the md breakpoint is more than the
  // taxon name + icon need just to avoid wrapping, and that column is the
  // biggest lever for giving the Outdated/% Outdated bars more room in the
  // narrower 3/5-width table.
  const taxonCellPad = countryStyleColumns ? "px-2 py-2 md:py-2.5" : cellPad;
  const isVisible = (col: ColumnId) => !hiddenColumns.has(col) && !(countryStyleColumns && COUNTRY_SCOPED_HIDDEN_COLUMNS.includes(col));
  const toggleColumn = (col: ColumnId) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const switchFocus = (mode: FocusMode) => {
    setFocusMode(mode);
    setHiddenColumns(new Set(FOCUS_HIDDEN[mode]));
  };

  const visibleColCount = 1 + (Object.keys(COLUMN_LABELS) as ColumnId[]).filter(isVisible).length + (countryStyleColumns ? 1 : 0);

  // Close column menu on outside click
  useEffect(() => {
    if (!showColumnMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowColumnMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showColumnMenu]);

  // Collapse taxa table when Cmd/Ctrl is released after a multi-select click
  useEffect(() => {
    if (!taxaExpanded) return;
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) setTaxaExpanded(false);
    };
    const onBlur = () => setTaxaExpanded(false);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [taxaExpanded]);

  // Auto-scroll to show Assessed column on mobile (skip past # Described)
  const autoScroll = useCallback((el: HTMLDivElement) => {
    if (window.innerWidth < 768) {
      const firstDataTh = el.querySelector('thead th:nth-child(2)') as HTMLElement;
      if (firstDataTh) {
        el.scrollLeft = firstDataTh.offsetWidth;
      }
    }
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && taxa.length > 0) {
      // rAF so the scroll is applied after layout settles (otherwise it can
      // land before column widths are known and fail to reveal Assessed).
      requestAnimationFrame(() => autoScroll(el));
    }
  }, [taxa, autoScroll]);

  // Fetch a node's subgroup data if not already loaded/loading (read from refs to
  // avoid stale closures) — factored out of toggleExpand so the ancestor-breadcrumb
  // effect below can ensure an intermediate ancestor's data is fetched WITHOUT also
  // toggling it into expandedTaxa (that Set drives renderTaxonWithSubgroups' "show
  // this node's own children inline" rendering, which the breadcrumb branch doesn't
  // use — see its own separate rendering, further down).
  const ensureSubgroupData = useCallback(async (taxonId: string) => {
    if (subgroupDataRef.current[taxonId] || loadingSubgroupsRef.current.has(taxonId)) return;
    setLoadingSubgroups((prev) => new Set(prev).add(taxonId));
    const requestCountryKey = countryKey;
    try {
      const countryQs = countryKey ? `&country=${encodeURIComponent(countryKey)}` : "";
      const res = await fetch(`/api/redlist/taxa-subgroups?nodeId=${taxonId}${countryQs}`);
      // Bail if the country changed while this was in flight — countryKey
      // changing already clears subgroupData wholesale (see the effect
      // above), and applying this now-stale response would silently
      // re-add wrongly-scoped numbers for taxonId right after that clear.
      if (res.ok && countryKeyRef.current === requestCountryKey) {
        const data = await res.json();
        setSubgroupData((prev) => ({ ...prev, [taxonId]: data.subgroups }));
      }
    } finally {
      setLoadingSubgroups((prev) => {
        const next = new Set(prev);
        next.delete(taxonId);
        return next;
      });
    }
  }, [countryKey]);

  // A node's own summary comes from its PARENT's subgroupData bucket (that's what
  // ensureSubgroupData(parentId) fetches — the parent's children, one of which is
  // this node). So "has this node's real data arrived yet" is exactly "does the
  // parent's bucket exist in subgroupData" — not yet present means either the fetch
  // is still in flight or hasn't been dispatched yet, both of which read the same to
  // the user (show a loading state, not a misleading zero). The immediate parent
  // (getAncestors(id)[0]) is the right bucket regardless of static or dynamic id —
  // both delegate through the same getAncestors contract.
  const isSummaryPending = useCallback((id: string): boolean => {
    const parentId = getAncestors(id)[0];
    return parentId != null && !(parentId in subgroupData);
  }, [subgroupData]);

  // Fetch subgroup data when a taxon is expanded
  const toggleExpand = useCallback(async (taxonId: string) => {
    setExpandedTaxa((prev) => {
      const next = new Set(prev);
      if (next.has(taxonId)) {
        next.delete(taxonId);
      } else {
        next.add(taxonId);
      }
      return next;
    });
    await ensureSubgroupData(taxonId);
  }, [ensureSubgroupData]);

  // Table 1a mode / SSC groups mode — derived from the URL-synced layoutMode
  // prop (see useFilterParams) rather than local state, so a page load or
  // browser back/forward that lands on ?layout=table1a|ssc restores the mode
  // automatically. table1aData/sscData stay local — just a fetch-once cache.
  const table1aMode = layoutMode === "table1a";
  const sscMode = layoutMode === "ssc";
  const countryMode = layoutMode === "country";

  // Single 4-way view selector — replaces the old Table 1a/SSC Groups button pair
  // (+ their "Exit ... View" states). "Country view" needs real per-country
  // location data, which Not Evaluated species don't have (no assessment means no
  // assessment_locations row), so it's disabled under New Assessments.
  const layoutModeSelect = (
    <span className="inline-flex items-center gap-2">
      <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300">View</span>
      <select
        value={layoutMode ?? "taxonomic"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "compare") {
            router.push("/compare");
            return;
          }
          onLayoutModeChange(v === "taxonomic" ? null : (v as "table1a" | "ssc" | "country"));
        }}
        className="text-sm bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="taxonomic">By Taxonomic Group</option>
        <option value="country" disabled={isNewAssessments} title={isNewAssessments ? "Not available for New Assessments — Not Evaluated species have no location data" : undefined}>
          By Country
        </option>
        <option value="ssc">By SSC Specialist Group (WIP)</option>
        <option value="compare">Comparison Mode</option>
        <option value="table1a">Table 1a</option>
      </select>
    </span>
  );
  const [table1aData, setTable1aData] = useState<Table1aSectionData[] | null>(null);
  const [table1aLoading, setTable1aLoading] = useState(false);

  // "# Described" source toggle (#272/#274): IUCN Table 1a estimates vs the CoL
  // backbone described count. For the 8 summary taxa + Table 1a's own rows — the
  // only nodes with a genuinely IUCN-sourced number — this toggle picks between the
  // two, defaulting to IUCN. Every other row (sub-groups, all 36 SSC groups) always
  // shows the CoL-derived count regardless of the toggle: their old "estimated"
  // number was a static third-party citation (MDD, Reptile Database, …) or a
  // hand-typed approximation that never gets re-verified, whereas colDescribed is
  // recomputed from the current CoL backbone on every data sync. See
  // resolveDescribed and OFFICIAL_IUCN_DESCRIBED_NODE_IDS.
  const [describedSource, setDescribedSource] = useState<"iucn" | "col">("iucn");
  const resolveDescribed = useCallback(
    (nodeId: string, estimatedDescribed: number, colDescribed: number | undefined): { value: number; source: "iucn" | "col" } => {
      const isOfficial = OFFICIAL_IUCN_DESCRIBED_NODE_IDS.has(stripNodePrefix(nodeId));
      const useCol = isOfficial ? describedSource === "col" : true;
      // No fallback when colDescribed < totalAssessed: an apparent >100%-assessed row
      // (renderBar clamps the bar itself but still prints the real percentage) is a
      // more honest signal than silently reverting to a static, never-re-verified
      // citation — it means this specific CoL release is missing species IUCN's own
      // assessors already recognize (e.g. the pygmy hippo, or a handful of recent
      // Artiodactyla splits), and that's worth surfacing, not hiding. For the same
      // reason, non-official nodes have no estimatedDescribed fallback at all (the
      // field no longer exists on them, see taxonomy-tree.ts) — colDescribed ?? 0 is
      // the only number they ever show.
      if (useCol) return { value: colDescribed ?? 0, source: "col" };
      return { value: estimatedDescribed, source: "iucn" };
    },
    [describedSource]
  );
  const applySource = useCallback(
    <T extends { estimatedDescribed: number; colDescribed?: number; totalAssessed: number; percentAssessed: number }>(row: T, nodeId: string): T => {
      const { value: described } = resolveDescribed(nodeId, row.estimatedDescribed, row.colDescribed);
      if (described === row.estimatedDescribed) return row;
      return {
        ...row,
        estimatedDescribed: described,
        percentAssessed: described > 0 ? (row.totalAssessed / described) * 100 : 0,
      };
    },
    [resolveDescribed]
  );

  // Separate "all" row from per-taxon rows (needed before early returns for hooks)
  const allTaxon = useMemo(() => {
    const raw = taxa.find((t) => t.id === "all");
    return raw ? applySource(raw, raw.id) : undefined;
  }, [taxa, applySource]);
  const perTaxa = useMemo(() => taxa.filter((t) => t.id !== "all").map(t => applySource(t, t.id)), [taxa, applySource]);

  // Fetch-if-needed, driven by table1aMode rather than a click handler, so it
  // also runs when the mode is entered via URL load or browser back/forward.
  // Uses a ref (not the loading state) to gate the fetch — including the
  // loading state itself in the deps would re-run this effect the instant
  // setTable1aLoading(true) commits, cancelling the very fetch it just started.
  const table1aFetchStartedRef = useRef(false);
  useEffect(() => {
    if (!table1aMode || table1aData || table1aFetchStartedRef.current) return;
    table1aFetchStartedRef.current = true;
    setTable1aLoading(true);
    const requestCountryKey = countryKey;
    const countryQs = countryKey ? `&country=${encodeURIComponent(countryKey)}` : "";
    fetch(`/api/redlist/taxa-summary?table1a=true${countryQs}`)
      .then(res => res.ok ? res.json() : null)
      // countryKey changing already resets table1aData/table1aFetchStartedRef
      // (see the effect above) so a fresh fetch can start — but doesn't cancel
      // THIS one, so skip applying it if it resolves after that happened.
      .then(data => { if (data && countryKeyRef.current === requestCountryKey) setTable1aData(data.sections); })
      .finally(() => setTable1aLoading(false));
  }, [table1aMode, table1aData, countryKey]);

  // SSC groups mode — same flat-table layout as Table 1a mode, sourced from
  // the precomputed SSC wrapper nodes' children instead of the top-level
  // Table 1a taxon groups (see SSC_SECTIONS above).
  const [sscData, setSscData] = useState<Table1aSectionData[] | null>(null);
  const [sscLoading, setSscLoading] = useState(false);
  const sscFetchStartedRef = useRef(false);

  useEffect(() => {
    if (!sscMode || sscData || sscFetchStartedRef.current) return;
    sscFetchStartedRef.current = true;
    setSscLoading(true);
    const requestCountryKey = countryKey;
    const countryQs = countryKey ? `&country=${encodeURIComponent(countryKey)}` : "";
    Promise.all(
      SSC_SECTIONS.map((section) =>
        fetch(`/api/redlist/taxa-subgroups?nodeId=${section.nodeId}${countryQs}`)
          .then(res => (res.ok ? res.json() : null))
          .then((data): Table1aSectionData | null => {
            if (!data) return null;
            const rows: Table1aRowData[] = (data.subgroups ?? []).map((sg: SubGroupSummary) => ({
              group: sg.id,
              name: sg.name,
              estimatedDescribed: sg.estimatedDescribed,
              totalAssessed: sg.totalAssessed,
              percentAssessed: sg.estimatedDescribed > 0 ? (sg.totalAssessed / sg.estimatedDescribed) * 100 : 0,
              outdated: sg.outdated,
              percentOutdated: sg.totalAssessed > 0 ? (sg.outdated / sg.totalAssessed) * 100 : 0,
              byCategory: sg.byCategory,
              gbifNeSpeciesCount: sg.gbifNeSpeciesCount,
              colDescribed: sg.colDescribed,
              colNe: sg.colNe,
              colBreakdown: sg.colBreakdown,
              parentTaxon: section.parentTaxon,
            }));
            // Sort by # assessed descending, but pin the remainder/catch-all row
            // to the bottom regardless of its own count — it reads as an appendix,
            // not one of the named specialist groups.
            rows.sort((a, b) => {
              if (a.group === section.catchAllId) return 1;
              if (b.group === section.catchAllId) return -1;
              return b.totalAssessed - a.totalAssessed;
            });
            return { title: section.title, rows, catchAllId: section.catchAllId };
          })
      )
    )
      // Same staleness guard as the Table 1a fetch above — countryKey
      // changing already reset sscData/sscFetchStartedRef, but didn't cancel
      // this in-flight request.
      .then((sections) => { if (countryKeyRef.current === requestCountryKey) setSscData(sections.filter((s): s is Table1aSectionData => s != null)); })
      .finally(() => setSscLoading(false));
  }, [sscMode, sscData, countryKey]);

  // Shared flat-table data source for whichever mode (Table 1a / SSC groups) is active
  const flatMode = table1aMode || sscMode;
  const flatData = table1aMode ? table1aData : sscData;
  const flatLoading = table1aMode ? table1aLoading : sscLoading;

  // table1aData/sscData/subgroupData are fetch-once caches keyed only by mode/nodeId,
  // not by country — without this, switching countries while table1a/ssc data (or an
  // expanded node's subgroups) is already cached would keep showing the stale,
  // un-scoped numbers instead of re-fetching for the new country.
  const prevCountryKeyRef = useRef(countryKey);
  useEffect(() => {
    if (prevCountryKeyRef.current === countryKey) return;
    prevCountryKeyRef.current = countryKey;
    setTable1aData(null);
    table1aFetchStartedRef.current = false;
    setSscData(null);
    sscFetchStartedRef.current = false;
    setSubgroupData({});
  }, [countryKey]);

  // Collapse all when returning to landing page (no taxa selected)
  useEffect(() => {
    if (selectedTaxa.size === 0 && selectedSubgroups.size === 0) {
      setExpandedTaxa(new Set());
    }
  }, [selectedTaxa, selectedSubgroups]);

  // Auto-expand ancestor chain when subgroups are selected (e.g. from URL)
  useEffect(() => {
    if (selectedSubgroups.size === 0) return;
    const toExpand = new Set<string>();
    for (const sgId of selectedSubgroups) {
      // Expand all ancestors up to the view root (which is in selectedTaxa)
      for (const ancestorId of getAncestors(sgId)) {
        if (selectedTaxa.has(ancestorId)) {
          // The view root itself isn't toggled into expandedTaxa — it drives a
          // different, always-shown rendering path while selectedSubgroups is
          // non-empty (the ancestor-breadcrumb branch below, not
          // renderTaxonWithSubgroups' isExpanded-gated one) — but its
          // subgroupData must still be fetched: the breadcrumb rendering looks
          // up each INTERMEDIATE ancestor's own summary there (e.g. Rodentia's
          // row, one level below the root), and nothing else would ever fetch
          // it for a dynamic ancestor that isn't itself a toggle-expand target.
          void ensureSubgroupData(ancestorId);
          break;
        }
        if (!expandedTaxa.has(ancestorId)) toExpand.add(ancestorId);
      }
      // Deliberately NOT auto-expanding sgId itself here (unlike ancestors
      // above) — selecting a node should show its own collapsed row first,
      // requiring an explicit second click to expand into children, matching
      // renderTaxonWithSubgroups'/renderSubgroupRow's click pattern. Auto-
      // expanding here would silently undo that on every selection change.
    }
    for (const id of toExpand) toggleExpand(id);
    // Deps intentionally limited to selectedSubgroups only:
    // - toggleExpand/ensureSubgroupData: stable identity (useCallback, only
    //   countryKey as a real dep — a country change already resets subgroupData
    //   entirely elsewhere, so refetching here isn't needed on that change)
    // - selectedTaxa: would cause re-runs when taxa selection changes, but this
    //   effect only needs to react to subgroup URL changes
    // - expandedTaxa: including it would create an infinite loop since this effect
    //   expands taxa (mutates expandedTaxa), which would re-trigger the effect
  }, [selectedSubgroups]); // eslint-disable-line react-hooks/exhaustive-deps

  // Aborts the in-flight request whenever countryKey changes again before it
  // resolves — without this, rapid country hovering could fire many quick
  // requests whose responses race each other, and whichever happened to
  // resolve LAST (not necessarily the one for the currently-hovered/
  // selected country) would win and overwrite `taxa` with stale, wrongly-
  // scoped numbers — visibly "stuck" even after the hover preview and its
  // pill had already cleared back to no selection.
  useEffect(() => {
    const controller = new AbortController();
    async function fetchTaxa() {
      setLoading(true);
      try {
        const countryQs = countryKey ? `?country=${encodeURIComponent(countryKey)}` : "";
        const res = await fetch(`/api/redlist/taxa-summary${countryQs}`, { signal: controller.signal });
        if (!res.ok) throw new Error("Failed to load taxa");
        const data = await res.json();
        setTaxa(data.taxa);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load taxa");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    fetchTaxa();
    return () => controller.abort();
  }, [countryKey]);

  // Only the very first load (no data at all yet, in any mode) blanks the
  // WHOLE component out to this — in country mode the table itself is still
  // `hidden` at that point anyway (nothing's scoped), so there's nothing else
  // on the page yet for this to disrupt. min-h matches a typical table's
  // rendered height so this doesn't read as a collapsed/half-height box that
  // then snaps taller once real rows arrive. A country-switch refetch
  // (countryScope changing with taxa already populated, from a previous
  // country or the global landing fetch) is handled separately, right in the
  // table body below — see the `loading` branch alongside flatLoading —
  // so the map/pills/hint row stay put instead of blanking away too.
  if (loading && taxa.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[420px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl py-24">
        <svg
          className="animate-spin h-8 w-8 text-zinc-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 rounded-lg">
        {error}
      </div>
    );
  }

  // Calculate totals
  const totalAssessed = perTaxa.reduce((sum, t) => sum + t.totalAssessed, 0);
  const totalOutdated = perTaxa.reduce((sum, t) => sum + t.outdated, 0);
  const totalDescribed = allTaxon?.estimatedDescribed ?? perTaxa.reduce((sum, t) => sum + t.estimatedDescribed, 0);
  const totalPercentAssessed = (totalAssessed / totalDescribed) * 100;
  const totalPercentOutdated = (totalOutdated / totalAssessed) * 100;
  const totalByCategory: Record<string, number> = {};
  for (const t of perTaxa) {
    for (const [cat, count] of Object.entries(t.byCategory || {})) {
      totalByCategory[cat] = (totalByCategory[cat] || 0) + count;
    }
  }
  const totalGbifObs = perTaxa.reduce((sum, t) => sum + (t.totalGbifObservations || 0), 0);
  const totalGbifSpecies = perTaxa.reduce((sum, t) => sum + (t.gbifSpeciesCount || 0), 0);
  const totalGbifNeSpecies = perTaxa.reduce((sum, t) => sum + (t.gbifNeSpeciesCount || 0), 0);
  const totalMeanGbifObs = totalGbifSpecies > 0 ? Math.round(totalGbifObs / totalGbifSpecies) : 0;
  const totalColDescribed = allTaxon?.colDescribed ?? perTaxa.reduce((sum, t) => sum + (t.colDescribed || 0), 0);
  const totalColNe = allTaxon?.colNe ?? perTaxa.reduce((sum, t) => sum + (t.colNe || 0), 0);


  // Column order: Taxon (sticky) | # Described | Assessed | Outdated | Category Breakdown

  // Compact colored bar for Country View's % Outdated column — separate from
  // # Outdated's own plain-count column (reverted back to two columns per
  // feedback, now that the 2/5-map-3/5-table split leaves more room). Widened
  // (w-10 -> w-20) now that taxonCellPad reclaims space from the Taxonomic
  // Group column specifically to make room for this.
  const renderCompactPercentBar = (percent: number) => {
    const clampedPercent = Math.min(100, Math.max(0, percent));
    return (
      <div className="flex items-center justify-end gap-1.5">
        <div className="w-20 h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden flex-shrink-0">
          <div
            className="h-full rounded-full"
            style={{ width: `${clampedPercent}%`, backgroundColor: getOutdatedBarColor(percent) }}
          />
        </div>
        <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums w-12 text-right flex-shrink-0">
          {percent.toFixed(1)}%
        </span>
      </div>
    );
  };

  // Render a percentage bar (optionally with a count label above).
  //
  // `flagOver100` opts a column into the over-100% note. Only # Red List Assessed
  // can exceed 100% — its numerator is IUCN's count and its denominator is CoL's,
  // and 5 SSC groups are over today (Wild Pig SG: 18 assessed, 17 described) —
  // so only that column asks for it, and its explanation is written for it.
  // Every row in an opted-in column reserves the icon's slot whether or not it
  // shows one, so the percentages stay aligned down the column.
  const renderBar = (percent: number, barColor: string, isAll: boolean, count?: number, fontWeight?: string, flagOver100?: boolean) => {
    const clampedPercent = Math.min(100, Math.max(0, percent));
    const fillColor = isAll ? "rgba(255,255,255,0.25)" : barColor;
    const fw = fontWeight || "font-medium";
    return (
      <div className="flex items-center gap-1.5 sm:gap-3 min-w-[150px] sm:min-w-[230px] md:min-w-[250px]">
        {count != null && (
          <span className={`text-sm md:text-base ${fw} tabular-nums text-zinc-700 dark:text-zinc-300 w-[48px] sm:w-[60px] text-right flex-shrink-0`}>
            {count.toLocaleString()}
          </span>
        )}
        <div className="flex-1 min-w-[40px] h-3.5 sm:h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${clampedPercent}%`, backgroundColor: fillColor }}
          />
        </div>
        <span className="text-xs md:text-sm tabular-nums text-zinc-500 dark:text-zinc-400 w-[44px] sm:w-[52px] text-right flex-shrink-0">
          {percent.toFixed(1)}%
        </span>
        {flagOver100 && (
          <span className="w-3 flex-shrink-0 flex justify-end">
            {percent > 100 && (
              <HoverNote note={OVER_100_ASSESSED_NOTE}>
                <span className="text-amber-500 dark:text-amber-400">
                  <FaFlag size={8} />
                </span>
              </HoverNote>
            )}
          </span>
        )}
      </div>
    );
  };

  // Every # Red List Assessed bar goes through this, never renderBar directly.
  // It is the one metric whose numerator (IUCN's count) and denominator (this
  // CoL release's) come from different organisations, so it is the only one that
  // can exceed 100% — and the over-100 note was wired into three of its seven
  // call sites and missed the four that draw drilldown rows, which is where the
  // over-100 rows actually are (genus Sorbus: 251 assessed, 171 described).
  // One entry point, so the next bar added cannot be inconsistent either.
  const renderAssessedBar = (percent: number, count: number, opts?: { isAll?: boolean; fontWeight?: string }) =>
    renderBar(percent, getAssessedBarColor(percent), opts?.isAll ?? false, count, opts?.fontWeight, true);

  // Keeps renderBar's footprint (so the column doesn't resize when the numbers
  // land) but spins in the count's own slot instead of drawing the bar — used in
  // place of renderBar for a breadcrumb/collapsed row whose summary hasn't streamed
  // in yet (see isSummaryPending), so a still-loading Assessed/Outdated/
  // Not-Evaluated cell doesn't flash a misleading "0" for the several seconds a
  // live-drilldown fetch can take. Nothing is drawn in the bar track: an empty
  // track reads as a real 0%, which is the misreading this exists to avoid.
  const renderPendingBar = () => (
    <div className="flex items-center gap-1.5 sm:gap-3 min-w-[150px] sm:min-w-[230px] md:min-w-[250px]">
      <span className="w-[48px] sm:w-[60px] flex-shrink-0 flex justify-end">
        <PendingSpinner />
      </span>
    </div>
  );

  // Render a stacked category breakdown bar
  const renderBreakdownBar = (byCategory: Record<string, number>) => {
    const total = Object.values(byCategory).reduce((sum, n) => sum + n, 0);
    if (total === 0) return <span className="text-sm md:text-base text-zinc-400">—</span>;

    const segments = BAR_CATEGORIES
      .filter((cat) => (byCategory[cat] || 0) > 0)
      .map((cat) => ({
        cat,
        count: byCategory[cat],
        pct: (byCategory[cat] / total) * 100,
        color: CATEGORY_COLORS[cat] || "#a3a3a3",
        name: CATEGORY_NAMES[cat] || cat,
      }));

    return (
      <div className="min-w-[80px] md:min-w-[100px] relative">
        {/* Visible bar (clipped for rounded corners) */}
        <div className="flex h-4 sm:h-3 rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-700">
          {segments.map((seg) => (
            <div
              key={seg.cat}
              className="h-full"
              style={{
                width: `${seg.pct}%`,
                backgroundColor: seg.color,
                minWidth: seg.pct > 0 ? "2px" : 0,
              }}
            />
          ))}
        </div>
        {/* Hover zones + tooltips (outside overflow-hidden so tooltips aren't clipped) */}
        <div className="absolute inset-0 flex">
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1;
            const isFirst = i === 0;
            const posClass = isLast && !isFirst
              ? "right-0"
              : isFirst && !isLast
                ? "left-0"
                : "left-1/2 -translate-x-1/2";
            return (
              <div
                key={seg.cat}
                className="group/seg relative h-full"
                style={{ width: `${seg.pct}%`, minWidth: seg.pct > 0 ? "2px" : 0 }}
              >
                <div className={`absolute ${posClass} bottom-full mb-2 px-2 py-1 text-xs bg-zinc-800 dark:bg-zinc-700 text-white rounded-lg shadow-lg opacity-0 invisible group-hover/seg:opacity-100 group-hover/seg:visible z-50 whitespace-nowrap pointer-events-none`}>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ backgroundColor: seg.color }}
                    />
                    <span className="text-zinc-300">{seg.name}</span>
                    <span className="font-medium pl-1">{seg.count.toLocaleString()}</span>
                    <span className="text-zinc-400">({seg.pct.toFixed(1)}%)</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render a mini histogram for GBIF observation distribution
  const renderDistributionBar = (distribution: Record<string, number>) => {
    const entries = DISTRIBUTION_BIN_LABELS.map((label) => ({ label, count: distribution[label] || 0 }));
    const max = Math.max(...entries.map((e) => e.count));
    if (max === 0) return <span className="text-sm text-zinc-400">—</span>;

    return (
      <div className="min-w-[100px] md:min-w-[120px] relative">
        <div className="flex items-end h-5">
          {entries.map(({ label, count }, i) => {
            const heightPct = (count / max) * 100;
            return (
              <div key={label} className="group/bar relative flex-1 flex items-end h-full">
                <div
                  className={`w-full bg-emerald-500/70 dark:bg-emerald-400/60 transition-colors group-hover/bar:bg-emerald-500 dark:group-hover/bar:bg-emerald-400 ${i === 0 ? "rounded-l-sm" : ""} ${i === entries.length - 1 ? "rounded-r-sm" : ""}`}
                  style={{ height: `${Math.max(heightPct, count > 0 ? 6 : 0)}%` }}
                />
                <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 px-2 py-1 text-xs bg-zinc-800 dark:bg-zinc-700 text-white rounded-lg shadow-lg opacity-0 invisible group-hover/bar:opacity-100 group-hover/bar:visible z-50 whitespace-nowrap pointer-events-none">
                  <span className="text-zinc-300">{label} obs:</span>{" "}
                  <span className="font-medium">{count.toLocaleString()}</span> species
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // CoL backbone cells (#272): "# Described (CoL)" and "# Not Evaluated". Rendered
  // wherever a row has CoL data; sub-group rows pass undefined → "—" (the node-children
  // endpoint doesn't carry CoL counts). bold matches subtotal/total row weight.
  const colDescribedCell = (value: number | undefined, bold = false) =>
    isVisible("colDescribed") ? (
      <td className={numericTdClasses}>
        <span className={`text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums ${bold ? "font-semibold" : ""}`}>
          {value != null ? value.toLocaleString() : "—"}
        </span>
      </td>
    ) : null;
  // "# Not Evaluated" renders as a progress bar (ne / col_described) with the count,
  // mirroring the assessed column. Falls back to a plain count if there's no
  // denominator, and "—" when the row has no CoL data (sub-groups).
  // `pending` spins instead of dashing: a row still waiting on its counts has no
  // colNe either, and "—" there reads as "this row has none", which is the wrong
  // thing to say about a number that's on its way (it's the headline column in the
  // new-assessments view). Only the two callers that know about isSummaryPending
  // pass it; everywhere else "—" still means what it always did.
  const colNeCell = (ne: number | undefined, described: number | undefined, opts?: { bold?: boolean; isAllRow?: boolean; pending?: boolean }) =>
    isVisible("colNe") ? (
      <td className={flexTdClasses}>
        {opts?.pending ? (
          renderPendingBar()
        ) : ne == null ? (
          <span className="text-sm text-zinc-400">—</span>
        ) : (
          // Mirror the Assessed column: a bar over the same (toggled) described
          // denominator + the count, so flipping IUCN↔CoL moves both bars together.
          renderBar(described && described > 0 ? (ne / described) * 100 : 0, "#f59e0b", opts?.isAllRow ?? false, ne, opts?.bold ? "font-semibold" : undefined)
        )}
      </td>
    ) : null;

  // Render a data row
  const renderRow = (
    id: string,
    name: string,
    color: string,
    estimatedDescribed: number,
    assessed: number,
    percentAssessed: number,
    outdated: number,
    percentOutdated: number,
    byCategory: Record<string, number>,
    isSelected?: boolean,
    available = true,
    isAllRow = false,
    gbifObs?: { total?: number; mean?: number; median?: number; speciesCount?: number; gbifNeCount?: number; distribution?: Record<string, number>; colDescribed?: number; colNe?: number }
  ) => {
    const isAllSelected = isAllRow && selectedTaxa.has("all");
    const rowBg = isAllRow
      ? isAllSelected ? "bg-zinc-100 dark:bg-zinc-800" : "bg-zinc-50/80 dark:bg-zinc-800/60"
      : isSelected
        ? "bg-zinc-100 dark:bg-zinc-800"
        : "";
    const isOnLandingPage = selectedTaxa.size === 0 && selectedSubgroups.size === 0;
    const allDisabled = isAllRow && disableAllSpecies && isOnLandingPage;
    const hoverClass = allDisabled
      ? "cursor-not-allowed"
      : isAllRow
        ? "hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
        : available
          ? "hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
          : "opacity-50 cursor-not-allowed";

    const stickyBg = isAllRow
      ? isAllSelected ? "bg-zinc-100 dark:bg-zinc-800" : "bg-zinc-50 dark:bg-zinc-800/60"
      : isSelected
        ? "bg-zinc-100 dark:bg-zinc-800"
        : "bg-white dark:bg-zinc-900";

    return (
      <tr
        key={id}
        onClick={(e) => {
          if (allDisabled) return;
          if (!isAllRow && !available) return;
          // Expand taxa table when Cmd/Ctrl+clicking a taxon row (not "all")
          if (!isAllRow && (e.metaKey || e.ctrlKey)) {
            setTaxaExpanded(true);
          }
          onToggleTaxon(id, e);
        }}
        className={`transition-colors ${rowBg} ${hoverClass}`}
      >
        <td className={`${stickyClasses} ${taxonCellPad} whitespace-nowrap w-0 ${stickyBg}`}>
          <div className="flex items-center gap-2">
            {expandToggle(false, false)}
            <TaxaIcon taxonId={id} size={22} className="flex-shrink-0" style={{ color }} />
            <span className="font-medium text-sm md:text-base text-zinc-900 dark:text-zinc-100">{name}</span>
            {allDisabled && <DisabledAllTooltip />}
          </div>
        </td>
        {isVisible("described") && (
          <td className={numericTdNoDividerClasses}>
            <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
              {estimatedDescribed.toLocaleString()}
            </span>
          </td>
        )}
        {colDescribedCell(gbifObs?.colDescribed)}
        {isVisible("assessed") && (
          <td className={countryStyleColumns ? numericTdNoDividerClasses : flexTdClasses}>
            {!available ? (
              <span className="text-sm md:text-base text-zinc-400">—</span>
            ) : countryStyleColumns ? (
              // % assessed (vs. the *global* described-species estimate) has no
              // per-country meaning — see COUNTRY_SCOPED_HIDDEN_COLUMNS's doc
              // comment — so this is a plain count, not renderBar's bar+percent.
              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">{assessed.toLocaleString()}</span>
            ) : (
              renderAssessedBar(percentAssessed, assessed, { isAll: isAllRow })
            )}
          </td>
        )}
        {isVisible("outdated") && (
          <td className={countryStyleColumns ? numericTdNoDividerClasses : flexTdClasses}>
            {!available ? (
              <span className="text-sm md:text-base text-zinc-400">—</span>
            ) : countryStyleColumns ? (
              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">{outdated.toLocaleString()}</span>
            ) : (
              renderBar(percentOutdated, getOutdatedBarColor(percentOutdated), isAllRow, outdated)
            )}
          </td>
        )}
        {countryStyleColumns && (
          <td className={numericTdNoDividerClasses}>
            {available ? (
              renderCompactPercentBar(percentOutdated)
            ) : (
              <span className="text-sm md:text-base text-zinc-400">—</span>
            )}
          </td>
        )}
        {isVisible("gbifUnassessed") && (
          <td className={flexTdClasses}>
            {(() => {
              const ne = gbifObs?.gbifNeCount;
              if (ne == null || estimatedDescribed <= 0) return <span className="text-sm md:text-base text-zinc-400">—</span>;
              const pct = (ne / estimatedDescribed) * 100;
              return renderBar(pct, "#3b82f6", isAllRow, ne);
            })()}
          </td>
        )}
        {colNeCell(gbifObs?.colNe, estimatedDescribed, { isAllRow })}
        {isVisible("totalGbifObs") && (
          <td className={numericTdClasses}>
            <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
              {gbifObs?.total != null ? gbifObs.total.toLocaleString() : "—"}
            </span>
          </td>
        )}
        {isVisible("gbifDistribution") && (
          <td className={flexTdClasses}>
            {gbifObs?.distribution ? renderDistributionBar(gbifObs.distribution) : <span className="text-sm text-zinc-400">—</span>}
          </td>
        )}
        {isVisible("meanGbifObs") && (
          <td className={numericTdClasses}>
            <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
              {gbifObs?.mean != null ? gbifObs.mean.toLocaleString() : "—"}
            </span>
          </td>
        )}
        {isVisible("medianGbifObs") && (
          <td className={numericTdClasses}>
            <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
              {gbifObs?.median != null ? gbifObs.median.toLocaleString() : "—"}
            </span>
          </td>
        )}
        {isVisible("breakdown") && (
          <td className={flexTdClasses}>
            {available ? (
              renderBreakdownBar(byCategory)
            ) : (
              <span className="text-sm md:text-base text-zinc-400">—</span>
            )}
          </td>
        )}
      </tr>
    );
  };

  // Render an ancestor context row with full data — clicking navigates to that level.
  const renderAncestorRow = (sg: SubGroupSummary, color: string, depth: number, topTaxonId: string, isViewRoot: boolean, isPending = false) => {
    const { value: sgDescribed, source: sgDescribedSource } = resolveDescribed(sg.id, sg.estimatedDescribed, sg.colDescribed);
    const sgPctAssessed = sgDescribed > 0 ? (sg.totalAssessed / sgDescribed) * 100 : 0;
    const sgPctOutdated = sg.totalAssessed > 0 ? (sg.outdated / sg.totalAssessed) * 100 : 0;
    return (
      <tr
        key={`ancestor-${sg.id}`}
        className="transition-colors cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        onClick={() => {
          // Navigating up to this ancestor: collapse anything expanded BELOW
          // it (a previously-drilled-into deeper branch) so it doesn't show
          // pre-expanded if the user drills back into it later — only prune
          // descendants of sg.id, leaving its own state, ancestors, and
          // unrelated branches (e.g. an independently-expanded sibling taxon)
          // untouched.
          setExpandedTaxa((prev) => {
            const next = new Set([...prev].filter((id) => id === sg.id || !getAncestors(id).includes(sg.id)));
            return next.size === prev.size ? prev : next;
          });
          onToggleSubgroup(sg.id);
        }}
      >
        <td className={`${stickyClasses} ${taxonCellPad} whitespace-nowrap w-0 bg-white dark:bg-zinc-900`}>
          {/* 20px/level, not 12 — each level's icon also shrinks a few px
              (e.g. 22 → 18 → 14), which eats into the padding and nets a
              visibly-too-subtle ~8px shift at 12px/level (confirmed by
              measuring rendered positions: a single indent step was easy to
              miss). 20px/level keeps the net shift clearly perceptible even
              after that dilution. Kept in sync with the same constant in
              renderSubgroupRow/renderCollapsedSubgroupRow below. */}
          <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * 20}px` }}>
            {/* The view root row (depth 0) is the SAME conceptual taxon row as
                renderRow's/renderTaxonWithSubgroups' top-level display (e.g.
                "Mammals") — match their icon size (22) and text styling
                exactly, or it visibly shifts left (a smaller icon leaves less
                width before the text, at the same left edge) every time the
                view switches between the normal tree and this ancestor-
                breadcrumb mode. Intermediate ancestors stay smaller (16) since
                they're a level down, same as elsewhere in this file.
                expandToggle(false, false) reserves the same chevron-width
                spacer every other row type (renderRow, renderSubgroupRow)
                puts before its icon — omitting it here was a second,
                independent cause of the same left-shift, since ancestor rows
                navigate on click rather than expand and so never render a
                real chevron. */}
            {expandToggle(false, false)}
            <TaxaIcon taxonId={sg.id} size={isViewRoot ? 22 : 16} className="flex-shrink-0" style={{ color }} />
            <span className={isViewRoot ? "font-medium text-sm md:text-base text-zinc-900 dark:text-zinc-100" : "text-sm text-zinc-700 dark:text-zinc-300"}>{sg.name}</span>
          </div>
        </td>
        {isVisible("described") && (
          <td className={numericTdNoDividerClasses}>
            {isPending && sgDescribed === 0 ? (
              <span className="inline-flex w-12 justify-end"><PendingSpinner /></span>
            ) : (
              <span className="text-sm text-zinc-700 dark:text-zinc-300 tabular-nums inline-flex items-center gap-1">
                {sgDescribed.toLocaleString()}
                <DescribedInfoIcon nodeId={sg.id} source={sgDescribedSource} breakdown={sg.colBreakdown} />
              </span>
            )}
          </td>
        )}
        {colDescribedCell(sg.colDescribed)}
        {isVisible("assessed") && (
          <td className={flexTdClasses}>
            {isPending ? renderPendingBar() : renderAssessedBar(sgPctAssessed, sg.totalAssessed)}
          </td>
        )}
        {isVisible("outdated") && (
          <td className={flexTdClasses}>
            {isPending
              ? renderPendingBar()
              : sg.totalAssessed > 0
                ? renderBar(sgPctOutdated, getOutdatedBarColor(sgPctOutdated), false, sg.outdated)
                : <span className="text-sm text-zinc-400">—</span>}
          </td>
        )}
        {isVisible("gbifUnassessed") && (
          <td className={flexTdClasses}>
            {isPending
              ? renderPendingBar()
              : sg.gbifNeSpeciesCount > 0 && sgDescribed > 0
                ? renderBar((sg.gbifNeSpeciesCount / sgDescribed) * 100, "#3b82f6", false, sg.gbifNeSpeciesCount)
                : <span className="text-sm text-zinc-400">—</span>}
          </td>
        )}
        {colNeCell(sg.colNe, sgDescribed, { pending: isPending })}
        {isVisible("totalGbifObs") && (
          <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
        )}
        {isVisible("gbifDistribution") && (
          <td className={flexTdClasses}><span className="text-sm text-zinc-400">—</span></td>
        )}
        {isVisible("meanGbifObs") && (
          <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
        )}
        {isVisible("medianGbifObs") && (
          <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
        )}
        {isVisible("breakdown") && (
          <td className={flexTdClasses}>
            {renderBreakdownBar(sg.byCategory)}
          </td>
        )}
      </tr>
    );
  };

  // Render a standalone subgroup row (used when table is collapsed to a selected subgroup)
  const renderCollapsedSubgroupRow = (taxon: TaxonSummary, sg: SubGroupSummary, depth: number, isPending = false) => {
    const { value: sgDescribed, source: sgDescribedSource } = resolveDescribed(sg.id, sg.estimatedDescribed, sg.colDescribed);
    const sgPctAssessed = sgDescribed > 0 ? (sg.totalAssessed / sgDescribed) * 100 : 0;
    const sgPctOutdated = sg.totalAssessed > 0 ? (sg.outdated / sg.totalAssessed) * 100 : 0;
    const isLoadingSgSubs = loadingSubgroups.has(sg.id);
    return (
      <tr
        key={`collapsed-${sg.id}`}
        className={`transition-colors bg-zinc-100 dark:bg-zinc-800 ${isExpandable(sg.id) ? "cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-700" : ""}`}
        onClick={() => {
          if (isExpandable(sg.id)) {
            toggleExpand(sg.id);
          }
        }}
      >
        <td className={`${stickyClasses} ${taxonCellPad} whitespace-nowrap w-0 bg-zinc-100 dark:bg-zinc-800`}>
          {/* paddingLeft continues the same depth*12 staircase renderAncestorRow
              uses above this row — without it, the selected node snapped back
              to flush-left regardless of how many ancestor rows preceded it,
              breaking the indentation right at the "current" row (e.g. Muridae
              indented correctly as an ancestor, then its own selected child
              Gerbillus resetting to 0 instead of continuing one step further). */}
          <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * 20}px` }}>
            {expandToggle(isExpandable(sg.id), expandedTaxa.has(sg.id))}
            <TaxaIcon taxonId={sg.id} size={18} className="flex-shrink-0" style={{ color: taxon.color }} />
            <span className="font-medium text-sm md:text-base text-zinc-900 dark:text-zinc-100">{sg.name}</span>
            {isLoadingSgSubs && (
              <svg className="animate-spin h-3 w-3 text-zinc-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
          </div>
        </td>
        {isVisible("described") && (
          <td className={numericTdNoDividerClasses}>
            {isPending && sgDescribed === 0 ? (
              <span className="inline-flex w-12 justify-end"><PendingSpinner /></span>
            ) : (
              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums inline-flex items-center gap-1">
                {sgDescribed.toLocaleString()}
                <DescribedInfoIcon nodeId={sg.id} source={sgDescribedSource} breakdown={sg.colBreakdown} />
              </span>
            )}
          </td>
        )}
        {colDescribedCell(sg.colDescribed)}
        {isVisible("assessed") && (
          <td className={flexTdClasses}>
            {isPending ? renderPendingBar() : renderAssessedBar(sgPctAssessed, sg.totalAssessed)}
          </td>
        )}
        {isVisible("outdated") && (
          <td className={flexTdClasses}>
            {isPending
              ? renderPendingBar()
              : sg.totalAssessed > 0
                ? renderBar(sgPctOutdated, getOutdatedBarColor(sgPctOutdated), false, sg.outdated)
                : <span className="text-sm text-zinc-400">—</span>}
          </td>
        )}
        {isVisible("gbifUnassessed") && (
          <td className={flexTdClasses}>
            {isPending
              ? renderPendingBar()
              : sg.gbifNeSpeciesCount > 0 && sgDescribed > 0
                ? renderBar((sg.gbifNeSpeciesCount / sgDescribed) * 100, "#3b82f6", false, sg.gbifNeSpeciesCount)
                : <span className="text-sm text-zinc-400">—</span>}
          </td>
        )}
        {colNeCell(sg.colNe, sgDescribed, { pending: isPending })}
        {isVisible("totalGbifObs") && (
          <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
        )}
        {isVisible("gbifDistribution") && (
          <td className={flexTdClasses}><span className="text-sm text-zinc-400">—</span></td>
        )}
        {isVisible("meanGbifObs") && (
          <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
        )}
        {isVisible("medianGbifObs") && (
          <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
        )}
        {isVisible("breakdown") && (
          <td className={flexTdClasses}>
            {renderBreakdownBar(sg.byCategory)}
          </td>
        )}
      </tr>
    );
  };

  // Render a subgroup row, recursively expandable if it has children
  const renderSubgroupRow = (sg: SubGroupSummary, parentColor: string, depth: number, topTaxonId: string): React.ReactNode => {
    const { value: sgDescribed, source: sgDescribedSource } = resolveDescribed(sg.id, sg.estimatedDescribed, sg.colDescribed);
    const sgPctAssessed = sgDescribed > 0 ? (sg.totalAssessed / sgDescribed) * 100 : 0;
    const sgPctOutdated = sg.totalAssessed > 0 ? (sg.outdated / sg.totalAssessed) * 100 : 0;
    const isSgSelected = selectedSubgroups.has(sg.id);
    const sgHasChildren = isExpandable(sg.id);
    const isSgExpanded = expandedTaxa.has(sg.id);
    const sgSubs = subgroupData[sg.id] ?? [];
    const isLoadingSgSubs = loadingSubgroups.has(sg.id);
    return (
      <React.Fragment key={sg.id}>
        <tr
          className={`transition-colors cursor-pointer ${
            isSgSelected
              ? "bg-violet-50 dark:bg-violet-900/20"
              : "hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30"
          }`}
          onClick={() => {
            if (sgHasChildren && isSgSelected) {
              // Already selected → toggle expand/collapse
              toggleExpand(sg.id);
            } else {
              onToggleSubgroup(sg.id);
              // Selecting → show collapsed view first (don't auto-expand),
              // matching renderTaxonWithSubgroups' top-level pattern — a
              // second click is needed to expand into children.
              setExpandedTaxa(new Set());
            }
          }}
        >
          <td className={`${stickyClasses} ${taxonCellPad} whitespace-nowrap w-0 ${isSgSelected ? "bg-violet-50 dark:bg-violet-900/20" : "bg-white dark:bg-zinc-900"}`}>
            <div className="flex items-center gap-2" style={{ paddingLeft: `${(depth - 1) * 20}px` }}>
              {expandToggle(sgHasChildren, isSgExpanded)}
              <TaxaIcon taxonId={sg.id} size={depth === 1 ? 16 : 14} className="flex-shrink-0" style={{ color: parentColor, opacity: isSgSelected ? 1 : 0.6 }} />
              <span className={`text-sm ${isSgSelected ? "font-medium text-violet-700 dark:text-violet-300" : "text-zinc-700 dark:text-zinc-300"}`}>{sg.name}</span>
              {isLoadingSgSubs && (
                <svg className="animate-spin h-3 w-3 text-zinc-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
            </div>
          </td>
          {isVisible("described") && (
            <td className={numericTdNoDividerClasses}>
              <span className="text-sm text-zinc-600 dark:text-zinc-400 tabular-nums inline-flex items-center gap-1">
                {sgDescribed.toLocaleString()}
                <DescribedInfoIcon nodeId={sg.id} source={sgDescribedSource} breakdown={sg.colBreakdown} />
              </span>
            </td>
          )}
          {colDescribedCell(sg.colDescribed)}
          {isVisible("assessed") && (
            <td className={countryStyleColumns ? numericTdNoDividerClasses : flexTdClasses}>
              {countryStyleColumns ? (
                <span className="text-sm text-zinc-600 dark:text-zinc-400 tabular-nums">{sg.totalAssessed.toLocaleString()}</span>
              ) : (
                renderAssessedBar(sgPctAssessed, sg.totalAssessed)
              )}
            </td>
          )}
          {isVisible("outdated") && (
            <td className={countryStyleColumns ? numericTdNoDividerClasses : flexTdClasses}>
              {sg.totalAssessed === 0 ? (
                <span className="text-sm text-zinc-400">—</span>
              ) : countryStyleColumns ? (
                <span className="text-sm text-zinc-600 dark:text-zinc-400 tabular-nums">{sg.outdated.toLocaleString()}</span>
              ) : (
                renderBar(sgPctOutdated, getOutdatedBarColor(sgPctOutdated), false, sg.outdated)
              )}
            </td>
          )}
          {countryStyleColumns && (
            <td className={numericTdNoDividerClasses}>
              {sg.totalAssessed > 0 ? (
                renderCompactPercentBar(sgPctOutdated)
              ) : (
                <span className="text-sm text-zinc-400">—</span>
              )}
            </td>
          )}
          {isVisible("gbifUnassessed") && (
            <td className={flexTdClasses}>
              {sg.gbifNeSpeciesCount > 0 && sgDescribed > 0
                ? renderBar((sg.gbifNeSpeciesCount / sgDescribed) * 100, "#3b82f6", false, sg.gbifNeSpeciesCount)
                : <span className="text-sm text-zinc-400">—</span>}
            </td>
          )}
          {colNeCell(sg.colNe, sgDescribed)}
          {isVisible("totalGbifObs") && (
            <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
          )}
          {isVisible("gbifDistribution") && (
            <td className={flexTdClasses}><span className="text-sm text-zinc-400">—</span></td>
          )}
          {isVisible("meanGbifObs") && (
            <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
          )}
          {isVisible("medianGbifObs") && (
            <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>
          )}
          {isVisible("breakdown") && (
            <td className={flexTdClasses}>
              {renderBreakdownBar(sg.byCategory)}
            </td>
          )}
        </tr>
        {/* Recursively render children if expanded */}
        {isSgExpanded && sgSubs.map((child) => renderSubgroupRow(child, parentColor, depth + 1, topTaxonId))}
      </React.Fragment>
    );
  };

  // Render a taxon row with optional expandable subgroups
  const renderTaxonWithSubgroups = (taxon: TaxonSummary, isSelected: boolean) => {
    const hasSubgroups = isExpandable(taxon.id);
    const isExpanded = expandedTaxa.has(taxon.id);
    const subs = subgroupData[taxon.id] ?? [];
    const isLoadingSubs = loadingSubgroups.has(taxon.id);

    return (
      <React.Fragment key={taxon.id}>
        <tr
          className={`transition-colors ${
            isSelected ? "bg-zinc-100 dark:bg-zinc-800" : ""
          } ${taxon.available ? "hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer" : "opacity-50 cursor-not-allowed"}`}
          onClick={(e) => {
            if (!taxon.available) return;
            if (e.metaKey || e.ctrlKey) setTaxaExpanded(true);
            onToggleTaxon(taxon.id, e);
            if (hasSubgroups) {
              if (isSelected) {
                // Already selected → toggle expand/collapse
                toggleExpand(taxon.id);
              } else {
                // Selecting → show collapsed table view first (don't auto-expand)
                setExpandedTaxa(new Set());
              }
            } else {
              // Non-expandable taxon selected → collapse all expanded
              setExpandedTaxa(new Set());
            }
          }}
        >
          <td className={`${stickyClasses} ${taxonCellPad} whitespace-nowrap w-0 ${isSelected ? "bg-zinc-100 dark:bg-zinc-800" : "bg-white dark:bg-zinc-900"}`}>
            <div className="flex items-center gap-2">
              {/* Only show the expand chevron once the taxon is selected — on the landing
                  page a click selects (doesn't expand yet), so a chevron there misleads. */}
              {expandToggle(hasSubgroups && isSelected, isExpanded)}
              <TaxaIcon taxonId={taxon.id} size={22} className="flex-shrink-0" style={{ color: taxon.color }} />
              <span className="font-medium text-sm md:text-base text-zinc-900 dark:text-zinc-100">{taxon.name}</span>
              {isLoadingSubs && (
                <svg className="animate-spin h-3 w-3 text-zinc-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
            </div>
          </td>
          {isVisible("described") && (
            <td className={numericTdNoDividerClasses}>
              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
                {taxon.estimatedDescribed.toLocaleString()}
              </span>
            </td>
          )}
          {colDescribedCell(taxon.available ? taxon.colDescribed : undefined)}
          {isVisible("assessed") && (
            <td className={countryStyleColumns ? numericTdNoDividerClasses : flexTdClasses}>
              {!taxon.available ? (
                <span className="text-sm text-zinc-400">—</span>
              ) : countryStyleColumns ? (
                <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">{taxon.totalAssessed.toLocaleString()}</span>
              ) : (
                renderAssessedBar(taxon.percentAssessed, taxon.totalAssessed)
              )}
            </td>
          )}
          {isVisible("outdated") && (
            <td className={countryStyleColumns ? numericTdNoDividerClasses : flexTdClasses}>
              {!taxon.available ? (
                <span className="text-sm text-zinc-400">—</span>
              ) : countryStyleColumns ? (
                <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">{taxon.outdated.toLocaleString()}</span>
              ) : (
                renderBar(taxon.percentOutdated, getOutdatedBarColor(taxon.percentOutdated), false, taxon.outdated)
              )}
            </td>
          )}
          {countryStyleColumns && (
            <td className={numericTdNoDividerClasses}>
              {taxon.available ? (
                renderCompactPercentBar(taxon.percentOutdated)
              ) : (
                <span className="text-sm text-zinc-400">—</span>
              )}
            </td>
          )}
          {isVisible("gbifUnassessed") && (
            <td className={flexTdClasses}>
              {taxon.gbifNeSpeciesCount != null && taxon.estimatedDescribed > 0
                ? renderBar((taxon.gbifNeSpeciesCount / taxon.estimatedDescribed) * 100, "#3b82f6", false, taxon.gbifNeSpeciesCount)
                : <span className="text-sm text-zinc-400">—</span>}
            </td>
          )}
          {colNeCell(taxon.available ? taxon.colNe : undefined, taxon.estimatedDescribed)}
          {isVisible("totalGbifObs") && (
            <td className={numericTdClasses}>
              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
                {taxon.totalGbifObservations != null ? taxon.totalGbifObservations.toLocaleString() : "—"}
              </span>
            </td>
          )}
          {isVisible("gbifDistribution") && (
            <td className={flexTdClasses}>
              {taxon.gbifObsDistribution
                ? renderDistributionBar(taxon.gbifObsDistribution)
                : <span className="text-sm text-zinc-400">—</span>}
            </td>
          )}
          {isVisible("meanGbifObs") && (
            <td className={numericTdClasses}>
              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
                {taxon.meanGbifObsPerSpecies != null ? taxon.meanGbifObsPerSpecies.toLocaleString() : "—"}
              </span>
            </td>
          )}
          {isVisible("medianGbifObs") && (
            <td className={numericTdClasses}>
              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
                {taxon.medianGbifObsPerSpecies != null ? taxon.medianGbifObsPerSpecies.toLocaleString() : "—"}
              </span>
            </td>
          )}
          {isVisible("breakdown") && (
            <td className={flexTdClasses}>
              {taxon.available
                ? renderBreakdownBar(taxon.byCategory || {})
                : <span className="text-sm text-zinc-400">—</span>}
            </td>
          )}
        </tr>

        {/* Expanded subgroup rows (recursive) */}
        {isExpanded && subs.map((sg) => renderSubgroupRow(sg, taxon.color, 1, taxon.id))}
      </React.Fragment>
    );
  };

  // Table header
  const renderHead = () => (
    <thead>
      <tr className="bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
        <th className={`${stickyClasses} bg-zinc-50 dark:bg-zinc-800 ${taxonCellPad} ${flatMode ? "text-left" : "text-center"} text-sm font-bold text-zinc-600 dark:text-zinc-300 whitespace-nowrap w-0 ${flatMode ? "max-w-[160px] sm:max-w-[240px] lg:max-w-[300px]" : ""}`}>
          <div className={`flex items-center gap-1.5 ${flatMode ? "justify-start" : "justify-center"}`}>
            Taxonomic Group
            {/* Country View always shows the same fixed 3 columns — nothing to
                toggle, so the columns menu button doesn't apply there. */}
            {!countryMode && (
              <button
                ref={menuButtonRef}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showColumnMenu && menuButtonRef.current) {
                    const rect = menuButtonRef.current.getBoundingClientRect();
                    setMenuPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setShowColumnMenu((v) => !v);
                }}
                className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                title="Toggle columns"
              >
                <HiOutlineAdjustmentsHorizontal size={14} />
              </button>
            )}
          </div>
        </th>
        {isVisible("described") && (
          <th className={flatMode ? numericThWrapClasses : numericThNoDividerClasses}>
            <span className="inline-flex items-center gap-1">
              # Described Species
              <DescribedSourceInfoIcon describedSource={describedSource} setDescribedSource={setDescribedSource} />
            </span>
          </th>
        )}
        {isVisible("colDescribed") && (
          <th className={numericThClasses}># Described Species (CoL)</th>
        )}
        {isVisible("assessed") && (
          <th className={countryStyleColumns ? `${centeredThClasses} whitespace-nowrap min-w-[80px]` : centeredThClasses}>
            {countryStyleColumns ? "# Assessed" : "# Red List Assessed"}
          </th>
        )}
        {isVisible("outdated") && (
          <th className={countryStyleColumns ? numericThNoDividerClasses : centeredThClasses}>
            {/* Country View's half-width column has no room for the full
                "(10+ yrs old)" qualifier + info icon on one non-wrapping line
                (inline-flex forces it to stay unwrapped) — shortened here,
                same info still available via the plain-mode header. */}
            {countryStyleColumns ? (
              "# Needs Updating"
            ) : (
              <span className="inline-flex items-center gap-1"># Needs Updating (10+ yrs old) <OutdatedInfoIcon /></span>
            )}
          </th>
        )}
        {countryStyleColumns && (
          <th className={numericThNoDividerClasses}>% Needs Updating</th>
        )}
        {isVisible("gbifUnassessed") && (
          <th className={centeredThClasses}># Unassessed, 1+ GBIF Obs</th>
        )}
        {isVisible("colNe") && (
          <th className={centeredThClasses}># Not Evaluated</th>
        )}
        {isVisible("totalGbifObs") && (
          <th className={numericThClasses}>Total Obs</th>
        )}
        {isVisible("gbifDistribution") && (
          <th className={flexThClasses}>Obs Distribution</th>
        )}
        {isVisible("meanGbifObs") && (
          <th className={numericThClasses}>Mean Obs</th>
        )}
        {isVisible("medianGbifObs") && (
          <th className={numericThClasses}>Median Obs</th>
        )}
        {isVisible("breakdown") && (
          <th className={flexThClasses}>
            <span className="uppercase">Conservation Status Breakdown</span>
            <div className="flex items-center gap-1.5 mt-1 font-normal normal-case">
              {BAR_CATEGORIES.map((cat) => (
                <span key={cat} className="inline-flex items-center gap-0.5">
                  <span
                    className="inline-block w-2 h-2 rounded-sm"
                    style={{ backgroundColor: CATEGORY_COLORS[cat] || "#a3a3a3" }}
                  />
                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{cat}</span>
                </span>
              ))}
            </div>
          </th>
        )}
      </tr>
    </thead>
  );

  return (
    <>
    {/* Country view: map and taxa table render side by side (see the grid
        wrapper below) rather than the map replacing the whole component —
        clicking a country narrows the map/table together; only clicking a
        taxon row (handleToggleTaxon, in RedListView) exits layoutMode to
        reveal the full charts view. The view-mode select itself stays in the
        landing-only toolbar below (selectedTaxa is empty throughout country
        browsing, same as it is on the plain landing page), not duplicated
        here. */}
    {!countryMode && showColumnMenu && createPortal(
      <div
        ref={menuRef}
        className="fixed bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg z-[9999] py-1 min-w-[180px]"
        style={{ top: menuPos.top, left: menuPos.left }}
      >
        {!isNewAssessments && (
          <>
            <div className="px-3 pt-2 pb-1.5 text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Focus</div>
            <div className="mx-3 mb-1.5 flex rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-600">
              <button
                onClick={() => switchFocus("redlist")}
                className={`flex-1 text-xs py-1 font-medium transition-colors ${focusMode === "redlist" ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900" : "bg-white text-zinc-500 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"}`}
              >
                Red List
              </button>
              <button
                onClick={() => switchFocus("gbif")}
                className={`flex-1 text-xs py-1 font-medium transition-colors ${focusMode === "gbif" ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900" : "bg-white text-zinc-500 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"}`}
              >
                GBIF
              </button>
            </div>
            <div className="border-t border-zinc-100 dark:border-zinc-700" />
          </>
        )}
        <div className="px-3 pt-1.5 pb-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Columns</div>
        {(Object.keys(COLUMN_LABELS) as ColumnId[]).map((col) => (
          <label
            key={col}
            className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={isVisible(col)}
              onChange={() => toggleColumn(col)}
              className="rounded border-zinc-300 dark:border-zinc-600 text-green-600 focus:ring-green-500"
            />
            {COLUMN_LABELS[col]}
          </label>
        ))}
      </div>,
      document.body
    )}
    {/* Country view: map-only landing until a country's actually picked (no
        hover preview — see RedListView's handleCountryDrilldown/countryScope),
        THEN side-by-side map/table, same half-half layout this had before
        the map-first rework. Uses `contents` to no-op the table wrapper
        entirely outside country mode, rather than branching (and
        duplicating) the huge table JSX below per mode.
        Landing (not countryScoped): the map is full width AND grows to fill
        the rest of the viewport (flex-1 min-h-0, via the flex chain from
        page.tsx's <main> through RedListView's root down to here) so it
        reads as a full-height landing map rather than a small box sitting
        above empty space — on a 13" laptop screen that leaves just the
        footer's first line visible without scrolling. WorldMap's own root
        is already `h-full flex flex-col` for exactly this.
        Scoped: map moves into the left half of a 2-col grid, table into the
        right half — grid's default align-items: stretch matches the map's
        height to the table's own natural content height (no flex-1 needed
        here), same as before this rework. The table's own scrollRef box
        below is zoomed down (zoom-[.75]) to compensate for the narrower
        (1/2, was 2/3) column. */}
    {countryMode && !countryScoped && (
      <div className="flex flex-col flex-1 min-h-0 mb-4">{countryModeContent}</div>
    )}
    {countryMode && countryScoped && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-1.5">
        <div aria-hidden="true" />
        <div>{countryPillsContent}</div>
      </div>
    )}
    <div className={countryMode ? (countryScoped ? "grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4" : "hidden") : "contents"}>
      {countryMode && countryScoped && <div>{countryModeContent}</div>}
      <div className={countryMode ? "min-w-0 flex flex-col h-full" : "contents"}>
        {/* No "country name atop the table" heading here anymore — a country
            scoped outside Country View now shows only as the normal removable
            pill in RedListView's applied-filters row, like every other filter,
            instead of duplicating the selection as a bespoke heading too. */}
        {/* mb-4 here (not left to the parent's space-y-4) because this whole
            subtree's outer wrappers (lines above) render as `display: contents`
            outside country mode — a contents element's own margin is dropped
            per spec, so space-y-4's margin-bottom on it silently no-ops,
            leaving zero visible gap before the charts/species-table block
            below. Country mode already gets its gap from the real grid box's
            own mb-4 (see the ternary a few lines up), so skip it here to avoid
            doubling up. */}
        <div ref={scrollRef} className={`relative bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-x-auto ${countryMode ? "flex-1 [zoom:.75]" : "mb-4"}`}>
          <table className="w-full">
            {renderHead()}
        <tbody className="transition-opacity duration-200">
          {flatMode ? (
            /* Table 1a / SSC groups view: sections with headers, individual rows, subtotals */
            flatLoading ? (
              <tr>
                <td colSpan={visibleColCount} className={`${cellPad} text-center text-sm text-zinc-400`}>
                  <div className="flex items-center justify-center gap-2 py-4">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    {table1aMode ? "Loading Table 1a data…" : "Loading SSC groups data…"}
                  </div>
                </td>
              </tr>
            ) : flatData ? (
              <>
                {flatData.map((section, si) => {
                  // Resolve each row's effective described source first (IUCN toggle for
                  // Table 1a's own rows; always CoL for SSC groups — see resolveDescribed),
                  // so the per-row cells and the subtotals below all agree. Keep the
                  // per-row source (describedSource) around too, for the tooltip.
                  const rows = section.rows.map(r => {
                    const { value: described, source } = resolveDescribed(r.group, r.estimatedDescribed, r.colDescribed);
                    return {
                      ...r,
                      estimatedDescribed: described,
                      percentAssessed: described > 0 ? (r.totalAssessed / described) * 100 : 0,
                      describedSource: source,
                    };
                  });
                  // Compute section subtotals
                  const subDescribed = rows.reduce((s, r) => s + r.estimatedDescribed, 0);
                  const subAssessed = rows.reduce((s, r) => s + r.totalAssessed, 0);
                  const subOutdated = rows.reduce((s, r) => s + r.outdated, 0);
                  const subPctAssessed = subDescribed > 0 ? (subAssessed / subDescribed) * 100 : 0;
                  const subPctOutdated = subAssessed > 0 ? (subOutdated / subAssessed) * 100 : 0;
                  const subByCategory: Record<string, number> = {};
                  for (const r of rows) {
                    for (const [cat, count] of Object.entries(r.byCategory || {})) {
                      subByCategory[cat] = (subByCategory[cat] || 0) + count;
                    }
                  }
                  const subGbifSpecies = rows.reduce((s, r) => s + (r.gbifSpeciesCount ?? 0), 0);
                  const subGbifNe = rows.reduce((s, r) => s + (r.gbifNeSpeciesCount ?? 0), 0);
                  const subColDescribed = rows.reduce((s, r) => s + (r.colDescribed ?? 0), 0);
                  const subColNe = rows.reduce((s, r) => s + (r.colNe ?? 0), 0);
                  const subGbifObs = rows.reduce((s, r) => s + (r.totalGbifObservations ?? 0), 0);
                  const subMeanGbif = subGbifSpecies > 0 ? Math.round(subGbifObs / subGbifSpecies) : undefined;

                  return (
                    <React.Fragment key={section.title}>
                      {/* Section header — shows the section's subtotals directly, so they're
                          visible without scrolling past every row to reach the bottom. */}
                      <tr className="bg-zinc-100 dark:bg-zinc-800/80 border-b border-zinc-200 dark:border-zinc-700">
                        <td className={`${stickyClasses} ${taxonCellPad} whitespace-nowrap w-0 bg-zinc-100 dark:bg-zinc-800/80`}>
                          <span className="text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wider">
                            {section.title}
                          </span>
                        </td>
                        {isVisible("described") && (
                          <td className={numericTdNoDividerClasses}>
                            <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 tabular-nums">{subDescribed.toLocaleString()}</span>
                          </td>
                        )}
                        {colDescribedCell(subColDescribed, true)}
                        {isVisible("assessed") && (
                          <td className={flexTdClasses}>
                            {renderAssessedBar(subPctAssessed, subAssessed, { fontWeight: "font-semibold" })}
                          </td>
                        )}
                        {isVisible("outdated") && (
                          <td className={flexTdClasses}>
                            {subAssessed > 0 ? renderBar(subPctOutdated, getOutdatedBarColor(subPctOutdated), false, subOutdated, "font-semibold") : <span className="text-sm text-zinc-400">—</span>}
                          </td>
                        )}
                        {isVisible("gbifUnassessed") && (
                          <td className={flexTdClasses}>
                            {subGbifNe > 0 && subDescribed > 0
                              ? renderBar((subGbifNe / subDescribed) * 100, "#3b82f6", false, subGbifNe, "font-semibold")
                              : <span className="text-sm text-zinc-400">—</span>}
                          </td>
                        )}
                        {colNeCell(subColNe, subDescribed, { bold: true })}
                        {isVisible("totalGbifObs") && (
                          <td className={numericTdClasses}>
                            <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 tabular-nums">{subGbifObs.toLocaleString()}</span>
                          </td>
                        )}
                        {isVisible("gbifDistribution") && <td className={flexTdClasses}><span className="text-sm text-zinc-400">—</span></td>}
                        {isVisible("meanGbifObs") && (
                          <td className={numericTdClasses}>
                            <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 tabular-nums">{subMeanGbif != null ? subMeanGbif.toLocaleString() : "—"}</span>
                          </td>
                        )}
                        {isVisible("medianGbifObs") && <td className={numericTdClasses}><span className="text-sm text-zinc-400">—</span></td>}
                        {isVisible("breakdown") && (
                          <td className={flexTdClasses}>{renderBreakdownBar(subByCategory)}</td>
                        )}
                      </tr>
                      {/* Section rows — all named groups always shown; the catch-all
                          row is pulled out and rendered last, since it's usually the
                          largest, most load-bearing row. Table 1a mode has no
                          catch-all concept (section.catchAllId is undefined there),
                          so it always renders every row too. */}
                      {(() => {
                        const isSscSection = sscMode && section.catchAllId != null;
                        const catchAllRow = isSscSection ? rows.find(r => r.group === section.catchAllId) : undefined;
                        const namedRows = catchAllRow ? rows.filter(r => r.group !== section.catchAllId) : rows;
                        const renderGroupRow = (row: (typeof rows)[number]) => (
                        <tr
                          key={row.group}
                          className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
                          onClick={(e) => {
                            if (sscMode) {
                              // SSC groups are pre-filtered sub-populations of a real view-root
                              // taxon (mammals, reptiles, ...), not display-root taxa themselves —
                              // navigate straight to that root + this group's filter.
                              // onNavigateToSubgroup clears layoutMode atomically as part of the
                              // same history push — don't also clear it here, or the navigation
                              // splits into two separate back-button steps.
                              onNavigateToSubgroup?.(row.parentTaxon ?? "mammals", row.group);
                              return;
                            }
                            const defaultRoots = new Set(TAXONOMY_VIEWS.default.roots);
                            if (defaultRoots.has(row.group)) {
                              // Direct view root (e.g. mammals, birds) — select it. This path
                              // doesn't go through onNavigateToSubgroup, so exit the mode here.
                              onLayoutModeChange(null);
                              onToggleTaxon(row.group, e);
                            } else if (onNavigateToSubgroup) {
                              // Table 1a group under a virtual root (e.g. molluscs → invertebrates).
                              // row.group is a tree node id. Aggregating parent rows (e.g. "insecta",
                              // which spans 8 order taxon groups) match a child by node id; single-group
                              // rows match by taxon group.
                              const stripPrefix = (id: string) => id.replace(/^(inv-|pl-|fu-)/, "");
                              for (const rootId of defaultRoots) {
                                const rootNode = findNode(rootId);
                                const matchingChild =
                                  rootNode?.children?.find(c => stripPrefix(c.id) === row.group)
                                  ?? rootNode?.children?.find(c =>
                                    c.filter.taxonGroups.length === 1 && c.filter.taxonGroups[0] === row.group
                                  )
                                  ?? rootNode?.children?.find(c =>
                                    c.filter.taxonGroups.includes(row.group)
                                  );
                                if (matchingChild) {
                                  onNavigateToSubgroup(rootId, matchingChild.id);
                                  break;
                                }
                              }
                            }
                          }}
                        >
                          <td className={`${stickyClasses} ${taxonCellPad} whitespace-nowrap w-0 max-w-[160px] sm:max-w-[240px] lg:max-w-[300px] bg-white dark:bg-zinc-900`}>
                            <span className="flex items-center gap-1.5 pl-4 min-w-0">
                              <span className="text-sm md:text-base text-zinc-900 dark:text-zinc-100 truncate" title={row.name}>
                                {row.name}
                              </span>
                              {(() => {
                                const sourceUrl = findNode(row.group)?.sourceUrl;
                                if (!sourceUrl) return null;
                                return (
                                  <span className="relative group/row-src flex-shrink-0">
                                    <a
                                      href={sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <FaInfoCircle size={10} />
                                    </a>
                                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-white bg-zinc-800 dark:bg-zinc-700 rounded whitespace-nowrap opacity-0 invisible group-hover/row-src:opacity-100 group-hover/row-src:visible z-50 shadow-lg pointer-events-none">
                                      View official IUCN page
                                    </span>
                                  </span>
                                );
                              })()}
                            </span>
                          </td>
                          {isVisible("described") && (
                            <td className={numericTdNoDividerClasses}>
                              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums inline-flex items-center gap-1">
                                {row.estimatedDescribed.toLocaleString()}
                                <DescribedInfoIcon nodeId={row.group} source={row.describedSource} breakdown={row.colBreakdown} />
                              </span>
                            </td>
                          )}
                          {colDescribedCell(row.colDescribed)}
                          {isVisible("assessed") && (
                            <td className={flexTdClasses}>
                              {renderAssessedBar(row.percentAssessed, row.totalAssessed)}
                            </td>
                          )}
                          {isVisible("outdated") && (
                            <td className={flexTdClasses}>
                              {row.totalAssessed > 0
                                ? renderBar(row.percentOutdated, getOutdatedBarColor(row.percentOutdated), false, row.outdated)
                                : <span className="text-sm text-zinc-400">—</span>}
                            </td>
                          )}
                          {isVisible("gbifUnassessed") && (
                            <td className={flexTdClasses}>
                              {row.gbifNeSpeciesCount != null && row.estimatedDescribed > 0
                                ? renderBar((row.gbifNeSpeciesCount / row.estimatedDescribed) * 100, "#3b82f6", false, row.gbifNeSpeciesCount)
                                : <span className="text-sm text-zinc-400">—</span>}
                            </td>
                          )}
                          {colNeCell(row.colNe, row.estimatedDescribed)}
                          {isVisible("totalGbifObs") && (
                            <td className={numericTdClasses}>
                              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
                                {row.totalGbifObservations != null ? row.totalGbifObservations.toLocaleString() : "—"}
                              </span>
                            </td>
                          )}
                          {isVisible("gbifDistribution") && (
                            <td className={flexTdClasses}><span className="text-sm text-zinc-400">—</span></td>
                          )}
                          {isVisible("meanGbifObs") && (
                            <td className={numericTdClasses}>
                              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
                                {row.meanGbifObsPerSpecies != null ? Math.round(row.meanGbifObsPerSpecies).toLocaleString() : "—"}
                              </span>
                            </td>
                          )}
                          {isVisible("medianGbifObs") && (
                            <td className={numericTdClasses}>
                              <span className="text-sm md:text-base text-zinc-700 dark:text-zinc-300 tabular-nums">
                                {row.medianGbifObsPerSpecies != null ? row.medianGbifObsPerSpecies.toLocaleString() : "—"}
                              </span>
                            </td>
                          )}
                          {isVisible("breakdown") && (
                            <td className={flexTdClasses}>
                              {renderBreakdownBar(row.byCategory || {})}
                            </td>
                          )}
                        </tr>
                        );
                        return (
                          <>
                            {namedRows.map(renderGroupRow)}
                            {catchAllRow && renderGroupRow(catchAllRow)}
                          </>
                        );
                      })()}
                      {/* Gap between sections */}
                      {si < flatData.length - 1 && (
                        <tr><td colSpan={visibleColCount} className="p-0"><div className="h-1" /></td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {/* Grand TOTAL row */}
                {renderRow(
                  "total",
                  "TOTAL",
                  "#22c55e",
                  totalDescribed,
                  totalAssessed,
                  totalPercentAssessed,
                  totalOutdated,
                  totalPercentOutdated,
                  totalByCategory,
                  false,
                  true,
                  true,
                  { total: totalGbifObs, mean: totalMeanGbifObs, speciesCount: totalGbifSpecies, gbifNeCount: totalGbifNeSpecies, colDescribed: totalColDescribed, colNe: totalColNe }
                )}
              </>
            ) : null
          ) : loading ? (
            // A country-switch refetch (countryScope changed, taxa still
            // holds the previous country's — or the global landing fetch's —
            // rows). Blanks the body to just this single centered spinner
            // rather than leaving stale rows up dimmed underneath a corner
            // spinner: the table's own frame (thead, card chrome) stays put
            // so there's no size jump, only the rows swap out.
            <tr>
              <td colSpan={visibleColCount} className={cellPad}>
                <div className="flex items-center justify-center py-24">
                  <svg className="animate-spin h-6 w-6 text-zinc-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
              </td>
            </tr>
          ) : (
            <>
              {/* All Species totals row (always visible) */}
              {renderRow(
                "all",
                "All Species",
                "#22c55e",
                totalDescribed,
                totalAssessed,
                totalPercentAssessed,
                totalOutdated,
                totalPercentOutdated,
                totalByCategory,
                false,
                true,
                true,
                { total: totalGbifObs, mean: totalMeanGbifObs, speciesCount: totalGbifSpecies, gbifNeCount: totalGbifNeSpecies, colDescribed: totalColDescribed, colNe: totalColNe }
              )}

              {/* Separator - hide when only "All Species" is selected */}
              {!selectedTaxa.has("all") && (
                <tr>
                  <td colSpan={visibleColCount} className="p-0">
                    <div className="border-b-2 border-zinc-200 dark:border-zinc-700" />
                  </td>
                </tr>
              )}

              {/* Per-taxon rows with expandable subgroups */}
              {selectedTaxa.has("all")
                ? null
                : selectedSubgroups.size > 0 && selectedTaxa.size > 0 && !taxaExpanded
                  ? /* When subgroups are selected, show ancestor breadcrumbs + selected subgroup */
                    (() => {
                      const rows: React.ReactNode[] = [];
                      for (const sgId of selectedSubgroups) {
                        const parentTaxon = perTaxa.find(t => selectedTaxa.has(t.id));
                        if (!parentTaxon) continue;

                        // Render ancestor context rows (view root → intermediate ancestors)
                        // getAncestors returns [immediate parent, ..., root] so we reverse and
                        // skip ancestors at or above the view root (which is in selectedTaxa)
                        const ancestors = getAncestors(sgId);
                        const intermediateAncestorIds: string[] = [];
                        for (const aId of ancestors) {
                          if (selectedTaxa.has(aId)) break; // Stop at view root
                          // SSC wrapper nodes (SSC groups mode) are display-only, kept
                          // outside the real tree so they don't show up as a breadcrumb —
                          // their children navigate as if parented by their real taxon
                          // (mammals, reptiles, ...) instead — see SSC_SECTIONS.
                          if (SSC_SECTIONS.some((s) => s.nodeId === aId)) break;
                          // The true tree root — reached without ever hitting the view
                          // root above for a node whose root is one of "invertebrates"/
                          // "plantae"/"fungi"'s CSV-group children (e.g. "mushrooms",
                          // "insects"): their real PARENT_INDEX parent is "all" directly,
                          // never the virtual view-root grouping (see
                          // VIEW_ROOT_OVERRIDES in taxonomy-utils.ts) — so `selectedTaxa.
                          // has(aId)` above never matches and this loop would otherwise
                          // keep going all the way to "all", rendering a spurious
                          // "All Species" breadcrumb row.
                          if (aId === "all") break;
                          intermediateAncestorIds.push(aId);
                        }

                        // View root data from perTaxa
                        const viewRootSummary: SubGroupSummary = {
                          id: parentTaxon.id, name: parentTaxon.name,
                          estimatedDescribed: parentTaxon.estimatedDescribed,
                          totalAssessed: parentTaxon.totalAssessed, outdated: parentTaxon.outdated,
                          gbifNeSpeciesCount: parentTaxon.gbifNeSpeciesCount ?? 0,
                          byCategory: parentTaxon.byCategory,
                          colDescribed: parentTaxon.colDescribed, colNe: parentTaxon.colNe,
                        };
                        rows.push(renderAncestorRow(viewRootSummary, parentTaxon.color, 0, parentTaxon.id, true));

                        // Intermediate ancestors from subgroupData
                        intermediateAncestorIds.reverse().forEach((aId, i) => {
                          let ancestorData: SubGroupSummary | undefined;
                          for (const subs of Object.values(subgroupData)) {
                            ancestorData = subs.find(s => s.id === aId);
                            if (ancestorData) break;
                          }
                          if (!ancestorData) {
                            const node = findNode(aId);
                            if (node) {
                              ancestorData = { id: node.id, name: node.name, estimatedDescribed: node.estimatedDescribed ?? 0,
                                               totalAssessed: 0, outdated: 0, gbifNeSpeciesCount: 0, byCategory: {} };
                            } else if (isDynamicNodeId(aId)) {
                              // A dynamic ancestor whose real data hasn't streamed in yet
                              // (ensureSubgroupData, triggered by the auto-expand effect, is
                              // still in flight) — show its real name now rather than
                              // vanishing the row entirely; counts fill in once it resolves.
                              ancestorData = { id: aId, name: dynamicNodeDisplayName(aId), estimatedDescribed: 0,
                                               totalAssessed: 0, outdated: 0, gbifNeSpeciesCount: 0, byCategory: {} };
                            } else {
                              return;
                            }
                          }
                          rows.push(renderAncestorRow(ancestorData, parentTaxon.color, i + 1, parentTaxon.id, false, isSummaryPending(aId)));
                        });

                        // Search ALL fetched subgroup data for this node (any depth)
                        let sgData: SubGroupSummary | undefined;
                        for (const subs of Object.values(subgroupData)) {
                          sgData = subs.find(s => s.id === sgId);
                          if (sgData) break;
                        }
                        // Fallback: construct from taxonomy node while data loads
                        if (!sgData) {
                          const node = findNode(sgId);
                          if (node) {
                            sgData = { id: node.id, name: node.name, estimatedDescribed: node.estimatedDescribed ?? 0,
                                       totalAssessed: 0, outdated: 0, gbifNeSpeciesCount: 0, byCategory: {} };
                          } else if (isDynamicNodeId(sgId)) {
                            sgData = { id: sgId, name: dynamicNodeDisplayName(sgId), estimatedDescribed: 0,
                                       totalAssessed: 0, outdated: 0, gbifNeSpeciesCount: 0, byCategory: {} };
                          } else {
                            continue;
                          }
                        }

                        // The collapsed/selected row continues the same
                        // depth*12 staircase as the ancestor rows above it —
                        // one step past the last intermediate ancestor (0 if
                        // there are none, i.e. sgId is a direct child of the
                        // view root, e.g. Rodentia under Mammals).
                        const selectedDepth = intermediateAncestorIds.length + 1;
                        rows.push(renderCollapsedSubgroupRow(parentTaxon, sgData, selectedDepth, isSummaryPending(sgId)));
                        // Render children if expanded — one step further still.
                        // renderSubgroupRow's own paddingLeft formula is
                        // `(depth-1)*12`, so to land one indent past
                        // selectedDepth we pass selectedDepth+2 here (not +1):
                        // e.g. selectedDepth=1 (Rodentia selected, 0 ancestors)
                        // → depth=3 → (3-1)*12 = 24px, one step past Rodentia's
                        // own 12px. Also keeps the icon-size step (16 → 14)
                        // aligned with the normal recursive tree mode's order →
                        // family sizing.
                        const sgChildren = subgroupData[sgId] ?? [];
                        if (expandedTaxa.has(sgId)) {
                          rows.push(...sgChildren.map(child =>
                            renderSubgroupRow(child, parentTaxon.color, selectedDepth + 2, parentTaxon.id)));
                        }
                      }
                      return rows;
                    })()
                  : (selectedTaxa.size > 0 && !taxaExpanded
                    ? perTaxa
                        .filter((taxon) => selectedTaxa.has(taxon.id))
                        .map((taxon) => renderTaxonWithSubgroups(taxon, true))
                    : perTaxa.map((taxon) =>
                        renderTaxonWithSubgroups(taxon, selectedTaxa.has(taxon.id))
                      )
                  )
              }
            </>
          )}
        </tbody>
      </table>
        </div>
      </div>
    </div>
    {/* Bottom-right-of-table controls row: usage hint (left) + View selector
        (right) — both landing-only, hidden once a taxon row has been clicked.
        Gated on perTaxa.length alone (not also !loading) — perTaxa already
        implies data is present, and also gating on loading made this row
        flicker away and back on every country switch (loading briefly flips
        true again for the background refetch even though perTaxa/taxa still
        hold the previous country's data). */}
    {perTaxa.length > 0 && selectedTaxa.size === 0 && (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 mt-1.5">
        <span className="hidden sm:inline pl-3 md:pl-4 text-sm text-zinc-400 dark:text-zinc-500">
          {countryMode ? "Click a country to view its species, Cmd/Ctrl+click to multi-select." : "Click to filter, use charts and search to explore species. Cmd/Ctrl+click to multi-select, Shift+drag across a chart to select a range."}
        </span>
        <span className="inline-flex items-center gap-1.5 ml-auto pr-3 sm:pr-0">
          {/* Assessed/Not Evaluated toggle used to be paired here too, but it's
              a scope control that matters just as much (more, really) once
              you've drilled into a specific taxon as it does on this landing
              page — pairing its visibility with the View selector's landing-
              only rule broke that. It now lives as the "Assessed Species"
              stat card's own header instead (RedListView), which is shown at
              both states. */}
          {layoutModeSelect}
          {(table1aMode || sscMode) && (
            <span className="relative group/lm">
              <a
                href={table1aMode ? IUCN_SOURCE_URL : "https://iucn.org/our-union/commissions/group/1445"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <FaInfoCircle size={10} />
              </a>
              <span className="absolute bottom-full right-0 mb-1 px-2 py-1 text-xs text-white bg-zinc-800 dark:bg-zinc-700 rounded whitespace-nowrap opacity-0 invisible group-hover/lm:opacity-100 group-hover/lm:visible z-50 shadow-lg pointer-events-none">
                {table1aMode ? "View IUCN Red List Table 1a (PDF)" : "View IUCN SSC Specialist Groups (mammals, reptiles, fishes, invertebrates, plants & fungi)"}
              </span>
            </span>
          )}
        </span>
      </div>
    )}
    </>
  );
}
