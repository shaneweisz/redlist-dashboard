/**
 * Shared shapes for the multi-source literature timeline.
 *
 * Every source adapter normalises its own payload into `LiteratureWork` so the
 * merge/dedupe/timeline layers never need to know where a record came from.
 */

/** Registry ids for the sources we can query. */
export type SourceId =
  | "openalex"
  | "zenodo"
  | "core"
  | "bhl"
  | "googlebooks"
  | "redlist";

/**
 * How much of a publication date we actually know. Sources disagree wildly:
 * OpenAlex usually gives a full date, BHL only ever gives a year, and Google
 * Books gives whatever the publisher printed. Keeping the precision lets the UI
 * render "1911" rather than a fabricated "1 January 1911".
 */
export type DatePrecision = "day" | "month" | "year";

/** Coarse work type, mapped from each source's own vocabulary. */
export type WorkType = "article" | "preprint" | "book" | "chapter" | "report" | "other";

/** A source that contributed to a (possibly merged) work. */
export interface WorkProvenance {
  id: SourceId;
  label: string;
  /** Link to this record *at that source*, when the source gives one. */
  url: string | null;
}

/** One publication, normalised across sources. */
export interface LiteratureWork {
  /** Stable within a response; used as a React key and for merge bookkeeping. */
  key: string;
  title: string;
  /** Best link for a reader: DOI when we have one, else the source's landing page. */
  url: string;
  doi: string | null;
  /**
   * ISO date truncated to `datePrecision` (e.g. "1911", "2023-03", "2023-03-14").
   * Null when the source gave no usable date at all.
   */
  date: string | null;
  datePrecision: DatePrecision | null;
  year: number | null;
  /**
   * Sortable stamp derived from `date`. Year-only and month-only dates are
   * placed mid-interval (see `toSortStamp`) so they interleave sensibly with
   * fully-dated works instead of all piling up on 1 January.
   */
  sortStamp: string | null;
  authors: string | null;
  venue: string | null;
  citations: number | null;
  type: WorkType;
  openAccessUrl: string | null;
  abstract: string | null;
  sources: WorkProvenance[];
}

/** Per-source outcome, surfaced in the API response so gaps stay visible. */
export type SourceStatus =
  /** Queried successfully. */
  | "ok"
  /** Not configured (needs an API key we don't have). */
  | "unconfigured"
  /** The source asked us to back off. */
  | "rate_limited"
  /** Errored or timed out. */
  | "error";

export interface SourceReport {
  id: SourceId;
  label: string;
  homepage: string;
  status: SourceStatus;
  /** Works this source contributed to the pool (before dedupe). */
  fetched: number;
  /** Total matches the source claims to hold, when it tells us. */
  upstreamTotal: number | null;
  /** Human-readable reason; present for every non-"ok" status. */
  note: string | null;
}

/** What a source adapter returns. */
export interface SourceResult {
  status: SourceStatus;
  works: LiteratureWork[];
  upstreamTotal: number | null;
  note: string | null;
}

export interface SourceQuery {
  /** The accepted name, as the Red List spells it. */
  scientificName: string;
  /** `scientificName` plus Latin gender variants. */
  nameVariants: string[];
  /** Max records to ask this source for. */
  limit: number;
  /**
   * The species' latest assessment id, when it has one. Only the Red List
   * reference-list source uses it; it is a lookup key, not a search term.
   */
  assessmentId: string | null;
  /** Passed to `fetch` so one slow source can't hold up the whole response. */
  signal: AbortSignal;
}

export interface SourceAdapter {
  id: SourceId;
  label: string;
  /** Where the data comes from; shown in the UI's source legend. */
  homepage: string;
  /** Overrides `SOURCE_TIMEOUT_MS` for a source that is legitimately slow. */
  timeoutMs?: number;
  fetch(query: SourceQuery): Promise<SourceResult>;
}
