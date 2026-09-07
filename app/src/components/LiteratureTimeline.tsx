"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateNameVariants } from "@/lib/nameVariants";

/**
 * The Literature tab: one chronological table of everything published about a
 * species, newest first, with a dotted line marking where the last Red List
 * assessment falls.
 *
 * This replaces a pre-assessment / post-assessment tab pair. The split forced a
 * reader to hold two lists in their head to answer one question — "what has
 * appeared since we last looked?" — which on a timeline is just a position.
 *
 * Records are merged from several sources by `/api/literature`; the per-source
 * report it returns is rendered at the foot of the tab so a source that is
 * missing, throttled or unconfigured is visible rather than silently narrowing
 * what you see.
 */

type DatePrecision = "day" | "month" | "year";
type WorkType = "article" | "preprint" | "book" | "chapter" | "report" | "other";
type SourceStatus = "ok" | "unconfigured" | "rate_limited" | "error";

interface WorkProvenance {
  id: string;
  label: string;
  url: string | null;
}

interface LiteratureWork {
  key: string;
  title: string;
  url: string;
  doi: string | null;
  date: string | null;
  datePrecision: DatePrecision | null;
  year: number | null;
  authors: string | null;
  venue: string | null;
  citations: number | null;
  type: WorkType;
  openAccessUrl: string | null;
  abstract: string | null;
  sources: WorkProvenance[];
}

interface SourceReport {
  id: string;
  label: string;
  homepage: string;
  status: SourceStatus;
  fetched: number;
  upstreamTotal: number | null;
  note: string | null;
}

interface TimelineResponse {
  scientificName: string;
  nameVariants: string[];
  assessmentDate: string | null;
  assessmentStamp: string | null;
  items: LiteratureWork[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  markerIndex: number | null;
  counts: { afterAssessment: number; beforeAssessment: number; undated: number };
  upstreamTotal: number | null;
  poolTruncated: boolean;
  sources: SourceReport[];
}

const PER_PAGE = 10;

const TYPE_LABELS: Record<WorkType, string> = {
  article: "Article",
  preprint: "Preprint",
  book: "Book",
  chapter: "Chapter",
  report: "Report",
  other: "",
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Render only as much of a date as the sources actually knew. */
function formatDate(date: string | null, precision: DatePrecision | null): string {
  if (!date) return "No date";
  const [year, month, day] = date.split("-");
  if (precision === "day" && month && day) return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
  if (precision === "month" && month) return `${MONTHS[Number(month) - 1]} ${year}`;
  return year;
}

function formatAssessmentDate(raw: string | null): string {
  if (!raw) return "";
  const parsed = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(raw);
  if (!parsed) return raw;
  const [, year, month, day] = parsed;
  if (day && month) return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
  if (month) return `${MONTHS[Number(month) - 1]} ${year}`;
  return year;
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

/** Columns in the works table; the marker row spans all of them. */
const COLUMN_COUNT = 6;

/**
 * The sources a record came from, each linking to that source's own page for
 * it — the OpenAlex work, the BHL scan, the assessment that cited it. Rendered
 * inline so the cell still truncates with the full list on hover.
 */
function SourceLinks({ sources }: { sources: WorkProvenance[] }) {
  return (
    <>
      {sources.map((source, index) => (
        <Fragment key={source.id}>
          {index > 0 && ", "}
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              // The row toggles on click; following a link must not also expand it.
              onClick={(e) => e.stopPropagation()}
              className="hover:text-blue-500 hover:underline dark:hover:text-blue-400"
            >
              {source.label}
            </a>
          ) : (
            source.label
          )}
        </Fragment>
      ))}
    </>
  );
}

/** The dotted line that says where the assessment sits in the record. */
function AssessmentMarkerRow({ assessmentDate }: { assessmentDate: string | null }) {
  return (
    <tr aria-label="Last assessment">
      <td colSpan={COLUMN_COUNT} className="px-2 py-1.5">
        <div className="flex items-center gap-3">
          <span className="whitespace-nowrap text-xs font-medium text-red-600 dark:text-red-400">
            Last assessed{assessmentDate ? ` ${formatAssessmentDate(assessmentDate)}` : ""}
          </span>
          <span className="h-0 flex-1 border-t border-dashed border-red-400 dark:border-red-800" />
        </div>
      </td>
    </tr>
  );
}

function WorkRow({
  work,
  isExpanded,
  onToggle,
}: {
  work: LiteratureWork;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        // The whole tab sits inside the species row, whose own click handler
        // collapses it — so an expand here must not reach it.
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-expanded={isExpanded}
        className={`cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50 ${
          isExpanded ? "bg-zinc-50 dark:bg-zinc-800/30" : ""
        }`}
      >
        <td className="whitespace-nowrap px-2 py-1 align-top text-[11px] tabular-nums text-zinc-500">
          {formatDate(work.date, work.datePrecision)}
        </td>
        <td className="px-2 py-1 align-top">
          <div className="flex items-start gap-1.5">
            <svg
              className={`mt-0.5 h-3 w-3 flex-shrink-0 text-zinc-400 transition-transform ${isExpanded ? "rotate-90" : ""}`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
            {/* Some deposits carry a whole page of text as their "title"; two
                lines keeps every row a predictable height. The full string is
                on hover, and in the expanded row. */}
            <span
              className="line-clamp-2 text-xs leading-snug text-zinc-800 dark:text-zinc-200"
              title={work.title}
            >
              {work.title}
            </span>
          </div>
        </td>
        <td
          className="hidden truncate px-2 py-1 align-top text-[11px] text-zinc-500 md:table-cell"
          title={work.venue ?? undefined}
        >
          {work.venue || "—"}
        </td>
        <td className="hidden whitespace-nowrap px-2 py-1 align-top text-[11px] text-zinc-500 lg:table-cell">
          {TYPE_LABELS[work.type] || "—"}
        </td>
        {/* On a phone the title needs this width more than a citation count
            does; the expanded row carries it instead. */}
        <td className="hidden whitespace-nowrap px-2 py-1 text-right align-top text-[11px] tabular-nums text-zinc-500 sm:table-cell">
          {work.citations !== null && work.citations > 0 ? work.citations.toLocaleString() : "—"}
        </td>
        <td
          className="hidden truncate px-2 py-1 align-top text-[11px] text-zinc-400 lg:table-cell"
          title={work.sources.map((s) => s.label).join(", ")}
        >
          <SourceLinks sources={work.sources} />
        </td>
      </tr>

      {isExpanded && (
        <tr className="border-b border-zinc-100 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/30">
          <td colSpan={COLUMN_COUNT} className="space-y-2 px-2 py-2 pl-7 text-[11px] text-zinc-500">
            <div className="font-medium text-zinc-700 dark:text-zinc-300">{work.title}</div>
            {work.authors && <div>{work.authors}</div>}
            {/* Every column the table may have dropped at this width, so the
                expanded row is complete on a phone as well as a desktop. */}
            <div className="text-zinc-400">
              {[
                work.venue,
                TYPE_LABELS[work.type] || null,
                work.citations ? `${work.citations.toLocaleString()} citations` : null,
              ]
                .filter(Boolean)
                .map((part) => `${part} · `)
                .join("")}
              <SourceLinks sources={work.sources} />
            </div>
            {work.abstract && <p className="leading-relaxed">{work.abstract}</p>}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <a
                href={work.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-blue-500 hover:text-blue-600 dark:hover:text-blue-400"
              >
                {work.doi ? "View via DOI" : "View record"}
              </a>
              {work.openAccessUrl && work.openAccessUrl !== work.url && (
                <a
                  href={work.openAccessUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-blue-500 hover:text-blue-600 dark:hover:text-blue-400"
                >
                  Free full text
                </a>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** Footer line naming what answered and what didn't. */
function SourceLegend({ sources }: { sources: SourceReport[] }) {
  const contributing = sources.filter((s) => s.status === "ok");
  const missing = sources.filter((s) => s.status !== "ok");

  return (
    <div className="mt-4 space-y-1 border-t border-zinc-100 pt-3 text-[10px] leading-relaxed text-zinc-400 dark:border-zinc-800">
      <div>
        Searched{" "}
        {contributing.map((source, index) => (
          <span key={source.id}>
            {index > 0 && ", "}
            <a
              href={source.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-blue-500 hover:underline"
            >
              {source.label}
            </a>
            {source.fetched > 0 && ` (${source.fetched})`}
          </span>
        ))}
        {contributing.length === 0 && "no sources"} — duplicates merged across sources.
      </div>
      <div>
        Searches match on full text as well as title and abstract, so a work may mention the
        species only in passing. Latin gender variants of the epithet are searched too.
      </div>
      {missing.length > 0 && (
        <div>
          Not included:{" "}
          {missing
            .map((source) => `${source.label}${source.note ? ` — ${source.note}` : ""}`)
            .join("; ")}
          .
        </div>
      )}
    </div>
  );
}

interface LiteratureTimelineProps {
  scientificName: string;
  /** ISO assessment date; where the dotted marker goes. */
  assessmentDate?: string | null;
  /** Latest assessment id — its reference list is one of the sources. */
  assessmentId?: string | null;
  /** Fallback when only the year is known. Null/0 means no assessment to mark. */
  assessmentYear?: number | null;
  className?: string;
}

export default function LiteratureTimeline({
  scientificName,
  assessmentDate = null,
  assessmentId = null,
  assessmentYear = null,
  className = "",
}: LiteratureTimelineProps) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const listTopRef = useRef<HTMLDivElement | null>(null);

  const nameVariants = useMemo(() => generateNameVariants(scientificName), [scientificName]);

  // A new species starts at the top of its own timeline.
  useEffect(() => {
    setPage(1);
    setExpandedKey(null);
  }, [scientificName]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          scientificName,
          page: String(page),
          perPage: String(PER_PAGE),
        });
        if (assessmentDate) params.set("assessmentDate", assessmentDate);
        else if (assessmentYear) params.set("assessmentYear", String(assessmentYear));
        if (assessmentId) params.set("assessmentId", assessmentId);

        const response = await fetch(`/api/literature?${params}`);
        if (!response.ok) throw new Error("Failed to fetch literature");
        const result: TimelineResponse = await response.json();
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (scientificName) load();
    return () => {
      cancelled = true;
    };
  }, [scientificName, assessmentDate, assessmentId, assessmentYear, page]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    setExpandedKey(null);
    listTopRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const searchDisplay =
    nameVariants.length > 1
      ? `${scientificName} + ${nameVariants.length - 1} name variant${nameVariants.length > 2 ? "s" : ""}`
      : scientificName;

  const items = data?.items ?? [];
  const counts = data?.counts;
  const hasAssessment = Boolean(data?.assessmentStamp);

  return (
    <div className={className}>
      <div ref={listTopRef} className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Literature</h3>
        {data && (
          <span className="text-sm text-zinc-500">
            {data.total.toLocaleString()} work{data.total === 1 ? "" : "s"}
            {hasAssessment && counts && (
              <>
                {" — "}
                <span className="text-zinc-700 dark:text-zinc-300">
                  {counts.afterAssessment.toLocaleString()}
                </span>{" "}
                since the last assessment
              </>
            )}
          </span>
        )}
        <span className="text-[10px] text-zinc-400">Searching: {searchDisplay}</span>
      </div>

      {loading && !data && (
        <div className="flex items-center gap-2 py-4 text-sm text-zinc-400">
          <Spinner />
          Searching the literature…
        </div>
      )}

      {error && !data && (
        <div className="py-4 text-sm text-zinc-500">Could not load the literature timeline.</div>
      )}

      {data && items.length === 0 && (
        <div className="py-4 text-sm text-zinc-500">
          No literature found for <span className="italic">{scientificName}</span>.
        </div>
      )}

      {data && items.length > 0 && (
        <div
          className={`overflow-x-auto rounded-lg border border-zinc-200 transition-opacity dark:border-zinc-700 ${
            loading ? "pointer-events-none opacity-50" : ""
          }`}
          aria-busy={loading}
        >
          <table className="w-full table-fixed text-left">
            <thead className="bg-zinc-100 dark:bg-zinc-800">
              <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="w-20 px-2 py-1.5 font-medium">Date</th>
                {/* Title takes whatever the fixed columns leave. */}
                <th className="px-2 py-1.5 font-medium">Title</th>
                <th className="hidden w-44 px-2 py-1.5 font-medium md:table-cell">Published in</th>
                <th className="hidden w-16 px-2 py-1.5 font-medium lg:table-cell">Type</th>
                <th className="hidden w-12 px-2 py-1.5 text-right font-medium sm:table-cell">Cited</th>
                <th className="hidden w-44 px-2 py-1.5 font-medium lg:table-cell">Source</th>
              </tr>
            </thead>
            <tbody>
              {items.map((work, index) => (
                <Fragment key={work.key}>
                  {data.markerIndex === index && (
                    <AssessmentMarkerRow assessmentDate={data.assessmentDate} />
                  )}
                  <WorkRow
                    work={work}
                    isExpanded={expandedKey === work.key}
                    onToggle={() => setExpandedKey(expandedKey === work.key ? null : work.key)}
                  />
                </Fragment>
              ))}
              {data.markerIndex === items.length && (
                <AssessmentMarkerRow assessmentDate={data.assessmentDate} />
              )}
            </tbody>
          </table>
        </div>
      )}

      {data && data.totalPages > 1 && (
        <div className="mt-2 flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goToPage(data.page - 1); }}
            disabled={data.page <= 1 || loading}
            className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            ← Newer
          </button>
          <span className="flex items-center gap-1.5 text-xs tabular-nums text-zinc-500">
            {loading && <Spinner className="h-3 w-3" />}
            Page {data.page} of {data.totalPages}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goToPage(data.page + 1); }}
            disabled={data.page >= data.totalPages || loading}
            className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Older →
          </button>
        </div>
      )}

      {data && data.poolTruncated && (
        <p className="mt-2 text-[10px] text-zinc-400">
          Showing the {data.total.toLocaleString()} most recent works found. At least one source
          holds more ({data.upstreamTotal?.toLocaleString()} matches at the largest), so older
          material may not appear here.
        </p>
      )}

      {data && <SourceLegend sources={data.sources} />}
    </div>
  );
}
