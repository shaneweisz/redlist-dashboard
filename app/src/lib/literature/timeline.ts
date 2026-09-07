/**
 * Turn a merged, newest-first pool of works into one paginated timeline with a
 * single assessment marker.
 *
 * The marker replaces the old pre-/post-assessment tab pair: instead of two
 * lists you get one chronological run of works with a dotted line dropped in at
 * the assessment date, so "what has been published since we last looked" is a
 * position in the list rather than a mode you have to switch into.
 */

import { toSortStamp } from "./normalize";
import type { LiteratureWork } from "./types";

export interface TimelineCounts {
  /** Dated works published on or after the assessment date. */
  afterAssessment: number;
  /** Dated works published before it. */
  beforeAssessment: number;
  /** Works no source gave a usable date for; shown at the end, uncounted above. */
  undated: number;
}

export interface TimelinePage {
  items: LiteratureWork[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  /**
   * Where the assessment marker sits on *this* page: it renders immediately
   * before `items[markerIndex]`, and `items.length` means "after the last item
   * shown". Null when the marker falls on another page.
   */
  markerIndex: number | null;
}

/**
 * Index in the full sorted pool at which the assessment marker belongs — the
 * position of the first work published before the assessment.
 *
 * Undated works sit at the end of the pool but carry no timeline position, so
 * the marker goes *before* them (after the last dated work) when every dated
 * work postdates the assessment. Returns null when there is no assessment date
 * to mark, e.g. a Not Evaluated species.
 */
export function findMarkerPosition(
  works: LiteratureWork[],
  assessmentStamp: string | null,
): number | null {
  if (!assessmentStamp) return null;
  let datedCount = 0;
  for (let i = 0; i < works.length; i++) {
    const stamp = works[i].sortStamp;
    if (stamp === null) continue;
    datedCount++;
    if (stamp < assessmentStamp) return i;
  }
  return datedCount;
}

/**
 * Normalise whatever the caller gave us for an assessment date into a sortable
 * stamp. Accepts a full ISO date, a "YYYY-MM", or a bare year (which is placed
 * mid-year, matching how imprecise publication dates are placed).
 */
export function assessmentSortStamp(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "" || raw === 0) return null;
  const text = String(raw).trim();
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(text);
  if (!match) return null;
  if (match[3]) return toSortStamp(`${match[1]}-${match[2]}-${match[3]}`, "day");
  if (match[2]) return toSortStamp(`${match[1]}-${match[2]}`, "month");
  return toSortStamp(match[1], "year");
}

export function countAroundAssessment(
  works: LiteratureWork[],
  assessmentStamp: string | null,
): TimelineCounts {
  let afterAssessment = 0;
  let beforeAssessment = 0;
  let undated = 0;
  for (const work of works) {
    if (work.sortStamp === null) {
      undated++;
    } else if (assessmentStamp === null || work.sortStamp >= assessmentStamp) {
      afterAssessment++;
    } else {
      beforeAssessment++;
    }
  }
  return { afterAssessment, beforeAssessment, undated };
}

/**
 * Slice one page out of the pool and say whether the marker lands on it.
 * `page` is 1-based and clamped into range, so a stale `?page=9` after a
 * smaller re-fetch shows the last page rather than an empty one.
 */
export function paginate(
  works: LiteratureWork[],
  page: number,
  perPage: number,
  markerPosition: number | null,
): TimelinePage {
  const total = works.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const clampedPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (clampedPage - 1) * perPage;
  const items = works.slice(start, start + perPage);

  let markerIndex: number | null = null;
  if (markerPosition !== null) {
    const offset = markerPosition - start;
    if (offset >= 0 && offset < items.length) {
      markerIndex = offset;
    } else if (offset === items.length && clampedPage === totalPages) {
      // Everything we found postdates the assessment: the marker closes the
      // list rather than disappearing off the end of it.
      markerIndex = items.length;
    }
  }

  return { items, page: clampedPage, perPage, total, totalPages, markerIndex };
}
