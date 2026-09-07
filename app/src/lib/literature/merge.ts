/**
 * Merge the per-source result pools into one deduplicated timeline.
 *
 * The same work routinely appears in several sources at once — and a paper the
 * assessment cited will appear both there and in OpenAlex — so "not repeating
 * duplicates" is the whole job here. Two records are the same work when either
 *   - they share a normalised DOI, or
 *   - they share a normalised title and their years are within one of each
 *     other (sources disagree on print vs online year all the time).
 *
 * Merging is field-by-field rather than "pick a winner", because each source is
 * good at something different: OpenAlex has citation counts and clean metadata,
 * BHL has the only record of anything published in 1887, and the Red List
 * reference list contributes the fact that an assessor cited it at all.
 */

import { normalizeDoi, normalizeTitle } from "./normalize";
import type { LiteratureWork, SourceId } from "./types";

/**
 * Which source's *value* wins for a scalar field when several supply one.
 * Ordering reflects observed metadata quality, not coverage: OpenAlex is the
 * best-curated, Google Books and the Red List citation strings the roughest.
 */
const FIELD_PRIORITY: SourceId[] = [
  "openalex",
  "zenodo",
  "core",
  "bhl",
  "googlebooks",
  // Last for scalars: a Red List reference is a formatted citation string, so
  // its title and author are rougher than an indexer's. Its value is the
  // provenance tag, which survives regardless of this ordering.
  "redlist",
];

function priorityOf(work: LiteratureWork): number {
  const best = work.sources.reduce((acc, s) => {
    const rank = FIELD_PRIORITY.indexOf(s.id);
    return rank === -1 ? acc : Math.min(acc, rank);
  }, Number.MAX_SAFE_INTEGER);
  return best;
}

const PRECISION_RANK = { day: 3, month: 2, year: 1 } as const;

/**
 * True when exactly one of the pair is a preprint — i.e. they are the same work
 * at two stages, not two different works. Version-of-record fields (DOI, venue,
 * type, link) should come from the published side.
 */
function isPreprintPair(a: LiteratureWork, b: LiteratureWork): boolean {
  return (a.type === "preprint") !== (b.type === "preprint");
}

/** The record whose identity fields win: the published version, else priority. */
function canonicalOf(
  a: LiteratureWork,
  b: LiteratureWork,
  preferred: LiteratureWork,
): LiteratureWork {
  if (isPreprintPair(a, b)) return a.type === "preprint" ? b : a;
  return preferred;
}

/**
 * Fold `incoming` into `base`, returning a new work. `base` is whichever record
 * we saw first; priority decides scalar conflicts, not arrival order.
 */
export function mergeWorks(base: LiteratureWork, incoming: LiteratureWork): LiteratureWork {
  const basePriority = priorityOf(base);
  const incomingPriority = priorityOf(incoming);
  // `preferred` supplies scalars when both records have a value.
  const preferred = incomingPriority < basePriority ? incoming : base;
  const other = preferred === base ? incoming : base;

  const pick = <K extends keyof LiteratureWork>(field: K): LiteratureWork[K] =>
    (preferred[field] ?? other[field]) as LiteratureWork[K];

  // Keep the most precise date we were given, whoever gave it.
  const dateSource =
    rankPrecision(incoming) > rankPrecision(base)
      ? incoming
      : rankPrecision(base) > rankPrecision(incoming)
        ? base
        : preferred.date
          ? preferred
          : other;

  const sources = [...base.sources];
  for (const source of incoming.sources) {
    if (!sources.some((s) => s.id === source.id)) sources.push(source);
  }
  sources.sort((a, b) => FIELD_PRIORITY.indexOf(a.id) - FIELD_PRIORITY.indexOf(b.id));

  // A preprint and its published version each have their own DOI; the reader
  // wants the version of record.
  const canonical = canonicalOf(base, incoming, preferred);
  const secondary = canonical === base ? incoming : base;
  const doi = canonical.doi ?? secondary.doi;

  return {
    key: base.key,
    // A longer title is usually the un-truncated one; sources clip subtitles.
    title: preferred.title.length >= other.title.length ? preferred.title : other.title,
    // A DOI outranks any landing page as the canonical link for a reader.
    url: doi ? `https://doi.org/${doi}` : (canonical.url ?? secondary.url),
    doi,
    date: dateSource.date,
    datePrecision: dateSource.datePrecision,
    year: dateSource.year ?? pick("year"),
    sortStamp: dateSource.sortStamp,
    authors: pick("authors"),
    // "Genes", not "Preprints.org".
    venue: canonical.venue ?? secondary.venue,
    // Citation counts are floors, not measurements — take the fullest one.
    citations: maxOrNull(base.citations, incoming.citations),
    // "other" is a fallback, so any source with a real opinion overrides it —
    // and a published version outranks its own preprint.
    type: canonical.type !== "other" ? canonical.type : secondary.type,
    openAccessUrl: pick("openAccessUrl"),
    abstract: longer(base.abstract, incoming.abstract),
    sources,
  };
}

function rankPrecision(work: LiteratureWork): number {
  return work.datePrecision ? PRECISION_RANK[work.datePrecision] : 0;
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function longer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}

/**
 * Deduplicate a pool of works and return them newest-first.
 *
 * Works with no usable date sort to the end — they can't be placed on a
 * timeline, but dropping them would silently lose records (BHL in particular
 * has undated items).
 */
export function dedupeWorks(pools: LiteratureWork[][]): LiteratureWork[] {
  const merged: LiteratureWork[] = [];
  const byDoi = new Map<string, number>();
  // Title key -> indices, so we can check the ±1 year window before merging.
  const byTitle = new Map<string, number[]>();

  for (const pool of pools) {
    for (const work of pool) {
      const doi = normalizeDoi(work.doi);
      const titleKey = normalizeTitle(work.title);

      let matchIndex: number | undefined;

      if (doi !== null) matchIndex = byDoi.get(doi);

      if (matchIndex === undefined && titleKey) {
        for (const candidate of byTitle.get(titleKey) ?? []) {
          const existing = merged[candidate];
          // A DOI mismatch is usually real evidence of two different works (an
          // article and its erratum can share a title) — except for a preprint
          // and its published version, which are one work with two DOIs.
          const existingDoi = normalizeDoi(existing.doi);
          if (
            doi !== null &&
            existingDoi !== null &&
            doi !== existingDoi &&
            !isPreprintPair(existing, work)
          ) {
            continue;
          }
          if (yearsCompatible(existing.year, work.year)) {
            matchIndex = candidate;
            break;
          }
        }
      }

      if (matchIndex === undefined) {
        merged.push(work);
        const index = merged.length - 1;
        if (doi !== null) byDoi.set(doi, index);
        if (titleKey) byTitle.set(titleKey, [...(byTitle.get(titleKey) ?? []), index]);
        continue;
      }

      merged[matchIndex] = mergeWorks(merged[matchIndex], work);
      // The merge may have supplied a DOI the first record lacked; index it so
      // a third source arriving with only that DOI still matches.
      const mergedDoi = normalizeDoi(merged[matchIndex].doi);
      if (mergedDoi !== null && !byDoi.has(mergedDoi)) byDoi.set(mergedDoi, matchIndex);
    }
  }

  return sortNewestFirst(merged);
}

/** Two records describe the same work only if their years are within one. */
function yearsCompatible(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return Math.abs(a - b) <= 1;
}

/** Newest first; undated works last; ties broken by title for a stable order. */
export function sortNewestFirst(works: LiteratureWork[]): LiteratureWork[] {
  return [...works].sort((a, b) => {
    if (a.sortStamp === b.sortStamp) return a.title.localeCompare(b.title);
    if (a.sortStamp === null) return 1;
    if (b.sortStamp === null) return -1;
    return b.sortStamp.localeCompare(a.sortStamp);
  });
}
