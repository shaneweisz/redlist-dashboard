"use client";

import {
  ASSESSMENT_NARRATIVES,
  loadAssessment,
  type LoadedAssessment,
  type NarrativeField,
  type RedListAssessment,
} from "@/lib/redlist/assessment";
import { useState, useEffect, useCallback, useMemo } from "react";
import { CATEGORY_COLORS, CATEGORY_NAMES, normalizeCategory } from "@/config/taxa";
import { stripHtml, truncateSections } from "@/lib/html-text";

interface PreviousAssessment {
  year: string;
  assessment_id: number;
  category: string;
  assessors?: string | null;
  reviewers?: string | null;
  /**
   * The individuals behind an organisational assessor — every bird assessment
   * credits "BirdLife International", so the assessor line names no person and
   * the facilitator line is the only one that does. Optional because it is
   * absent from history written before the field existed, not just unset.
   */
  facilitators?: string | null;
  /** Credited for data or expertise without being assessor or reviewer. */
  contributors?: string | null;
  /** The organisation(s) behind the assessment. */
  institutions?: string | null;
}

interface RedListAssessmentsProps {
  sisTaxonId?: number;
  currentAssessmentId: number;
  currentCategory: string;
  currentAssessmentDate: string | null;
  previousAssessments: PreviousAssessment[];
  speciesUrl: string;
}

// Format ISO date string to human-readable form (e.g. "25 July 2022")
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return iso;
  }
}

// Safely extract category code from red_list_category (can be string or object)
function getCategoryCode(cat: RedListAssessment["red_list_category"]): string {
  if (!cat) return "?";
  if (typeof cat === "string") return cat;
  return cat.code || "?";
}

// Safely extract population trend text (can be string or object)
function getTrendText(trend: RedListAssessment["population_trend"]): string {
  if (!trend) return "";
  if (typeof trend === "string") return trend;
  return trend.description || trend.code || "";
}

function CategoryBadge({ code, small }: { code: string; small?: boolean }) {
  const normalized = normalizeCategory(code);
  const color = CATEGORY_COLORS[normalized] || "#6b7280";
  const name = CATEGORY_NAMES[normalized] || code;
  const isLegacy = code !== normalized && !CATEGORY_NAMES[code];
  return (
    <span
      className={`inline-flex items-center gap-1 font-semibold rounded ${small ? "text-xs px-1.5 py-0.5" : "text-sm px-2 py-1"}`}
      style={{ backgroundColor: color + "20", color }}
      title={isLegacy ? `${code} (legacy) -> ${name}` : name}
    >
      {code}
      {!small && <span className="font-normal opacity-75">{name}</span>}
    </span>
  );
}

// How much assessment narrative is shown inline, as one budget spent across
// all seven sections in order — not per section. The assessments run long; past
// this the IUCN Red List page has the full text, one click away.
const NARRATIVE_WORD_LIMIT = 200;

// The assessment's narrative fields, in display order.
/**
 * The narratives, in the order this tab reads them, with the long titles.
 *
 * Both the field list and the titles come from the shared module: the
 * nearby-species panel reads the same assessments in its own order and with
 * shorter labels, and a field the route starts returning should not be able to
 * appear in one of them and not the other.
 */
const NARRATIVE_FIELDS = ([
  "rationale",
  "population",
  "habitat",
  "threats",
  "conservation_actions",
  "use_trade",
  "range",
] as const satisfies readonly NarrativeField[]).map((field) => ({
  field,
  title: ASSESSMENT_NARRATIVES.find((n) => n.field === field)!.title,
}));

// Collapsible section for narrative text. The text arrives already capped;
// `fullTextUrl` is passed only to the last section shown, where the narrative
// stops, so the "read the full assessment" link appears once.
function NarrativeSection({
  title,
  text,
  fullTextUrl,
}: {
  title: string;
  text: string;
  fullTextUrl?: string;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <button
        className="flex items-center gap-2 w-full py-2 text-left text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100"
        onClick={() => setExpanded(!expanded)}
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 text-zinc-400 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
        </svg>
        {title}
      </button>
      {expanded && (
        <div className="pb-3 pl-5 text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-line leading-relaxed">
          {text}
          {fullTextUrl && "\u2026"}
          {fullTextUrl && (
            <>
              {" "}
              <a
                href={fullTextUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline whitespace-nowrap"
              >
                read the full assessment on the IUCN Red List ↗
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Comparison view showing diff between two assessments
function AssessmentComparison({
  older,
  newer,
}: {
  older: RedListAssessment;
  newer: RedListAssessment;
}) {
  const olderCat = getCategoryCode(older.red_list_category);
  const newerCat = getCategoryCode(newer.red_list_category);
  const olderNorm = normalizeCategory(olderCat);
  const newerNorm = normalizeCategory(newerCat);

  const categoryChanged = olderNorm !== newerNorm;
  const olderOrder = getCategoryThreatLevel(olderNorm);
  const newerOrder = getCategoryThreatLevel(newerNorm);
  const improved = newerOrder > olderOrder; // higher order = less threatened
  const worsened = newerOrder < olderOrder;

  const sections: { key: string; title: string; field: keyof RedListAssessment }[] = [
    { key: "rationale", title: "Rationale", field: "rationale" },
    { key: "population", title: "Population", field: "population" },
    { key: "habitat", title: "Habitat & Ecology", field: "habitat" },
    { key: "threats", title: "Threats", field: "threats" },
    { key: "conservation", title: "Conservation Actions", field: "conservation_actions" },
    { key: "range", title: "Geographic Range", field: "range" },
  ];

  return (
    <div className="space-y-4">
      {/* Category change header */}
      {categoryChanged && (
        <div
          className={`flex items-center gap-3 p-3 rounded-lg text-sm ${
            improved
              ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
              : worsened
              ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400"
              : "bg-zinc-50 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400"
          }`}
        >
          <CategoryBadge code={olderCat} small />
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
          <CategoryBadge code={newerCat} small />
          <span className="ml-1">
            {improved ? "Status improved" : worsened ? "Status worsened" : "Category changed"}
          </span>
        </div>
      )}
      {!categoryChanged && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 text-sm text-zinc-500">
          <CategoryBadge code={newerCat} small />
          <span>Category unchanged between assessments</span>
        </div>
      )}

      {/* Criteria change */}
      {older.criteria !== newer.criteria && (older.criteria || newer.criteria) && (
        <div className="text-sm space-y-1">
          <div className="font-medium text-zinc-700 dark:text-zinc-300">Criteria</div>
          <div className="flex gap-4 text-xs">
            {older.criteria && (
              <span className="text-zinc-400 line-through">{older.criteria}</span>
            )}
            {newer.criteria && (
              <span className="text-zinc-600 dark:text-zinc-300">{newer.criteria}</span>
            )}
          </div>
        </div>
      )}

      {/* Narrative sections - show only where content differs */}
      {sections.map(({ key, title, field }) => {
        const olderText = older[field] ? stripHtml(older[field] as string) : null;
        const newerText = newer[field] ? stripHtml(newer[field] as string) : null;
        if (!olderText && !newerText) return null;
        if (olderText === newerText) return null;

        return (
          <ComparisonSection
            key={key}
            title={title}
            olderText={olderText}
            newerText={newerText}
            olderYear={older.year_published || older.assessment_date?.split("-")[0] || "?"}
            newerYear={newer.year_published || newer.assessment_date?.split("-")[0] || "?"}
          />
        );
      })}

      {/* If all narrative sections are the same, show a note */}
      {sections.every(({ field }) => {
        const ot = older[field] ? stripHtml(older[field] as string) : null;
        const nt = newer[field] ? stripHtml(newer[field] as string) : null;
        return ot === nt;
      }) && (
        <div className="text-sm text-zinc-400 italic py-2">
          No changes in narrative text between these assessments.
        </div>
      )}
    </div>
  );
}

function ComparisonSection({
  title,
  olderText,
  newerText,
  olderYear,
  newerYear,
}: {
  title: string;
  olderText: string | null;
  newerText: string | null;
  olderYear: string;
  newerYear: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-zinc-100 dark:border-zinc-800 rounded-lg overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        onClick={() => setExpanded(!expanded)}
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 text-zinc-400 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
        </svg>
        {title}
        <span className="text-xs text-zinc-400 font-normal">
          (changed)
        </span>
      </button>
      {expanded && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-zinc-100 dark:divide-zinc-800">
          <div className="p-3">
            <div className="text-xs font-medium text-zinc-400 mb-1">{olderYear} assessment</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-line leading-relaxed max-h-60 overflow-y-auto">
              {olderText || <span className="italic">Not available</span>}
            </div>
          </div>
          <div className="p-3">
            <div className="text-xs font-medium text-zinc-400 mb-1">{newerYear} assessment</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-line leading-relaxed max-h-60 overflow-y-auto">
              {newerText || <span className="italic">Not available</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getCategoryThreatLevel(code: string): number {
  const order: Record<string, number> = {
    EX: 0, EW: 1, CR: 2, EN: 3, VU: 4, NT: 5, LC: 6, DD: 7, NE: 8,
  };
  return order[code] ?? 5;
}

// Loading spinner
function Spinner({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-400 py-4">
      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
      {text}
    </div>
  );
}

export default function RedListAssessments({
  currentAssessmentId,
  currentCategory,
  currentAssessmentDate,
  previousAssessments,
  speciesUrl,
}: RedListAssessmentsProps) {
  // All assessments timeline, sorted oldest-first (left to right).
  // If previousAssessments includes the current one, use it directly;
  // otherwise fall back to constructing from current* props.
  const hasCurrentInHistory = previousAssessments.some((a) => a.assessment_id === currentAssessmentId);
  const allAssessments = hasCurrentInHistory
    ? [...previousAssessments].sort((a, b) => (a.year || "0").localeCompare(b.year || "0"))
    : [
        {
          year: currentAssessmentDate?.split("-")[0] || "Current",
          assessment_id: currentAssessmentId,
          category: currentCategory,
        },
        ...previousAssessments,
      ].sort((a, b) => (a.year || "0").localeCompare(b.year || "0"));

  /**
   * Which assessment is being read: the newest, or the one clicked.
   *
   * History is fetched lazily, so allAssessments grows from 1 → N after mount
   * and changes again when the species does. The selection is therefore derived
   * rather than corrected afterwards — a click is remembered along with the
   * size of the set it was made in, and stops counting when that set changes.
   * As an effect that reset it, this raced the render that had already drawn
   * the old index.
   */
  const [picked, setPicked] = useState<{ size: number; index: number } | null>(null);
  const selectedIndex =
    picked && picked.size === allAssessments.length ? picked.index : allAssessments.length - 1;
  const setSelectedIndex = useCallback(
    (index: number) => setPicked({ size: allAssessments.length, index }),
    [allAssessments.length]
  );
  const [compareMode, setCompareMode] = useState(false);
  /**
   * What has been read, keyed by assessment id.
   *
   * One map rather than a map plus a loading set plus an error set plus a ref
   * mirroring each: whether an assessment is loading is not state of its own,
   * it is "what I hold does not include the one being asked for". The three
   * sets had to be kept in step with each other by hand, and were written to
   * from inside an effect, which is what made a stale render show a spinner
   * over an assessment it already had.
   */
  const [held, setHeld] = useState<Record<number, LoadedAssessment>>({});

  /** The assessments this view needs: the selected one, and its predecessor
      when the two are being compared. */
  const wanted = useMemo(() => {
    const ids: number[] = [];
    const selected = allAssessments[selectedIndex];
    if (selected) ids.push(selected.assessment_id);
    if (compareMode && selectedIndex > 0) ids.push(allAssessments[selectedIndex - 1].assessment_id);
    return ids;
  }, [allAssessments, selectedIndex, compareMode]);
  const wantedKey = wanted.join(",");

  /**
   * Fetch what is wanted and not yet held.
   *
   * Keyed on the ids rather than on what is held, so arriving results don't
   * restart it; the shared loader caches and de-dupes, so a re-run of this
   * effect costs a map lookup rather than a request.
   */
  useEffect(() => {
    let live = true;
    for (const id of wantedKey ? wantedKey.split(",").map(Number) : []) {
      loadAssessment(id).then((next) => {
        if (live) setHeld((prev) => (prev[id] ? prev : { ...prev, [id]: next }));
      });
    }
    return () => {
      live = false;
    };
  }, [wantedKey]);

  /** Ask again for one that failed — a failure is usually the network. */
  const retry = useCallback((assessmentId: number) => {
    setHeld((prev) => {
      const next = { ...prev };
      delete next[assessmentId];
      return next;
    });
    loadAssessment(assessmentId).then((next) => setHeld((prev) => ({ ...prev, [assessmentId]: next })));
  }, []);

  const selectedAssessment = allAssessments[selectedIndex];
  const selectedDetail = selectedAssessment ? held[selectedAssessment.assessment_id]?.assessment ?? null : null;
  const olderAssessment = selectedIndex > 0 ? allAssessments[selectedIndex - 1] : null;
  const olderDetail = olderAssessment ? held[olderAssessment.assessment_id]?.assessment ?? null : null;

  // Loading is what is wanted and not yet held; an error is what came back
  // instead of an assessment.
  const isLoading = !!selectedAssessment && !held[selectedAssessment.assessment_id];
  const hasError = !!selectedAssessment && !!held[selectedAssessment.assessment_id]?.error;
  const isCompareLoading = !!olderAssessment && !held[olderAssessment.assessment_id];

  return (
    <div className="p-4 space-y-4">
      {/* Header with timeline and controls */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Red List Assessments
          </h3>
          <span className="text-xs text-zinc-400">
            {allAssessments.length} assessment{allAssessments.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center gap-2 sm:ml-auto">
          {/* Compare toggle */}
          {allAssessments.length >= 2 && (
            <button
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                compareMode
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400"
                  : "border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
              onClick={() => setCompareMode(!compareMode)}
            >
              {compareMode ? "Exit comparison" : "Compare"}
            </button>
          )}

          {/* IUCN link */}
          <a
            href={speciesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:underline flex items-center gap-1"
          >
            View on IUCN Red List website
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>

      {/* Assessment timeline navigation */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {allAssessments.map((a, i) => {
          const normalized = normalizeCategory(a.category);
          const color = CATEGORY_COLORS[normalized] || "#6b7280";
          const isSelected = i === selectedIndex;
          const isCompareTarget = compareMode && i === selectedIndex - 1;

          return (
            <button
              key={a.assessment_id}
              className={`flex flex-col items-center px-3 py-1.5 rounded-lg text-xs transition-colors flex-shrink-0 ${
                isSelected
                  ? "bg-zinc-100 dark:bg-zinc-800 ring-1 ring-zinc-300 dark:ring-zinc-600"
                  : isCompareTarget
                  ? "bg-blue-50 dark:bg-blue-900/20 ring-1 ring-blue-200 dark:ring-blue-800"
                  : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              }`}
              onClick={() => setSelectedIndex(i)}
              title={`${a.year} - ${a.category}`}
            >
              <span
                className="font-semibold"
                style={{ color }}
              >
                {a.category}
              </span>
              <span className="text-zinc-400 text-[10px]">{a.year}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {isLoading && <Spinner text="Loading assessment..." />}

      {hasError && (
        <div className="text-sm text-red-500 py-2">
          Failed to load assessment details.{" "}
          <button
            className="underline hover:text-red-600"
            onClick={() => selectedAssessment && retry(selectedAssessment.assessment_id)}
          >
            Retry
          </button>
        </div>
      )}

      {/* Single assessment view */}
      {!compareMode && selectedDetail && !isLoading && (
        <AssessmentDetailView detail={selectedDetail} assessment={selectedAssessment} />
      )}

      {/* Comparison view */}
      {compareMode && !isLoading && !isCompareLoading && selectedDetail && olderDetail && (
        <AssessmentComparison older={olderDetail} newer={selectedDetail} />
      )}

      {compareMode && !isLoading && isCompareLoading && (
        <Spinner text="Loading comparison assessment..." />
      )}

      {compareMode && !olderAssessment && (
        <div className="text-sm text-zinc-400 py-2 italic">
          No previous assessment to compare with. This is the earliest assessment.
        </div>
      )}

      {/* Footer attribution — required by IUCN Red List Terms of Use */}
      <div className="text-[10px] text-zinc-400 dark:text-zinc-500 pt-2 space-y-1">
        <p>
          IUCN ({new Date().getFullYear()}).{" "}
          <em>The IUCN Red List of Threatened Species.</em> Version 2026-1.{" "}
          <a
            href="https://www.iucnredlist.org"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            https://www.iucnredlist.org
          </a>
          . Subject to IUCN Red List{" "}
          <a
            href="https://www.iucnredlist.org/terms/terms-of-use"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            Terms of Use
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function AssessmentDetailView({
  detail,
  assessment,
}: {
  detail: RedListAssessment;
  assessment: PreviousAssessment;
}) {
  const catCode = getCategoryCode(detail.red_list_category) !== "?" ? getCategoryCode(detail.red_list_category) : assessment.category;
  const trendText = getTrendText(detail.population_trend);
  const assessmentUrl =
    detail.url || `https://www.iucnredlist.org/species/${detail.sis_taxon_id}/${detail.assessment_id}`;
  const { sections: narratives, truncated: narrativeCutShort } = truncateSections(
    NARRATIVE_FIELDS.flatMap(({ title, field }) => {
      const text = detail[field] ? stripHtml(detail[field] as string) : "";
      return text ? [{ title, text }] : [];
    }),
    NARRATIVE_WORD_LIMIT
  );

  return (
    <div className="space-y-3">
      {/* Assessment header */}
      <div className="flex flex-wrap items-center gap-3">
        <CategoryBadge code={catCode} />
        {detail.criteria && (
          <span className="text-sm text-zinc-500 font-mono">
            Criteria: {detail.criteria}
          </span>
        )}
        {trendText && (
          <span className="text-xs text-zinc-400 flex items-center gap-1">
            Trend:{" "}
            <span className={
              trendText.toLowerCase().includes("decreasing")
                ? "text-red-500"
                : trendText.toLowerCase().includes("increasing")
                ? "text-green-500"
                : "text-zinc-500"
            }>
              {trendText}
            </span>
          </span>
        )}
        {detail.possibly_extinct && (
          <span className="text-xs px-2 py-0.5 bg-black/10 dark:bg-white/10 text-red-600 dark:text-red-400 rounded font-medium">
            Possibly Extinct
          </span>
        )}
        {detail.possibly_extinct_in_the_wild && (
          <span className="text-xs px-2 py-0.5 bg-black/10 dark:bg-white/10 text-red-600 dark:text-red-400 rounded font-medium">
            Possibly Extinct in the Wild
          </span>
        )}
      </div>

      {/* Date and systems */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
        {detail.assessment_date && (
          <span>Assessed: {formatDate(detail.assessment_date)}</span>
        )}
        {detail.year_published && (
          <span>Published: {detail.year_published}</span>
        )}
        {detail.systems && detail.systems.length > 0 && (
          <span>
            Systems: {detail.systems.map((s) => typeof s === "string" ? s : (s.description || s.code)).join(", ")}
          </span>
        )}
      </div>

      {/* Assessment credits, in the Red List's own billing order: who made the
          call, who checked it, then who else was involved. Each line is dropped
          when empty rather than shown as blank — contributors and institutions
          are absent on most assessments (67% and 81%), so printing empty labels
          would add three rows of nothing to the common case. */}
      {(assessment.assessors || assessment.reviewers || assessment.facilitators
        || assessment.contributors || assessment.institutions) && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5">
          {assessment.assessors && <div><span className="font-medium">Assessors:</span> {assessment.assessors}</div>}
          {assessment.reviewers && <div><span className="font-medium">Reviewers:</span> {assessment.reviewers}</div>}
          {assessment.facilitators && <div><span className="font-medium">Facilitators:</span> {assessment.facilitators}</div>}
          {assessment.contributors && <div><span className="font-medium">Contributors:</span> {assessment.contributors}</div>}
          {assessment.institutions && <div><span className="font-medium">Institutions:</span> {assessment.institutions}</div>}
        </div>
      )}

      {/* Narrative sections */}
      <div className="border border-zinc-100 dark:border-zinc-800 rounded-lg overflow-hidden px-3 divide-y divide-zinc-100 dark:divide-zinc-800">
        {narratives.map((n, i) => (
          <NarrativeSection
            key={n.title}
            title={n.title}
            text={n.text}
            fullTextUrl={narrativeCutShort && i === narratives.length - 1 ? assessmentUrl : undefined}
          />
        ))}
      </div>

      {/* No narrative data message */}
      {narratives.length === 0 && (
        <div className="text-sm text-zinc-400 py-2 italic">
          No detailed narrative data available for this assessment. View the full assessment on{" "}
          <a
            href={assessmentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:underline"
          >
            IUCN Red List
          </a>
          .
        </div>
      )}
    </div>
  );
}
