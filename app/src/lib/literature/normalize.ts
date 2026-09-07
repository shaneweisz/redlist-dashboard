/**
 * Normalisation helpers shared by every literature source adapter.
 *
 * The sources disagree on almost everything — date formats, DOI casing, how
 * much punctuation ends up in a title — so all of that is flattened here once,
 * before merging. Keeping it in one place is also what makes the dedupe
 * testable without touching the network.
 */

import type { DatePrecision, WorkType } from "./types";

/**
 * Strip a DOI down to a comparable form: no resolver prefix, no case, no
 * trailing punctuation. `null` for anything that isn't recognisably a DOI —
 * some sources put "n/a" or a bare URL in the DOI field.
 */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;)\]]+$/, "");
  if (!/^10\.\d{4,9}\/\S+$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Collapse a title to a comparison key: no diacritics, no punctuation, no
 * case, no runs of whitespace. This is what catches the same paper indexed as
 * "Ecology of *Panthera leo*" in one source and "Ecology of Panthera leo." in
 * another.
 */
export function normalizeTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFKD")
    // Combining marks left behind by NFKD (é -> e + U+0301).
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // HTML/JATS markup leaks into Crossref- and CORE-sourced titles.
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Strip markup and collapse whitespace in an abstract; `null` if nothing is left. */
export function cleanAbstract(raw: string | null | undefined, maxChars = 1200): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

/** Collapse whitespace; `null` for empty/whitespace-only input. */
export function cleanText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  return text || null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface ParsedDate {
  /** ISO date truncated to `precision`: "1911", "2023-03" or "2023-03-14". */
  date: string;
  precision: DatePrecision;
  year: number;
}

/**
 * Parse the many date shapes the sources emit into an ISO date plus the
 * precision we actually have. Handles "2023-03-14", "2023-03-14T00:00:00Z",
 * "2023-03", "2023", "March 2023", "14 Mar 2023" and "1911-1913" (takes the
 * first year). Returns `null` when no plausible year can be read.
 */
export function parseDate(raw: string | number | null | undefined): ParsedDate | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "number") {
    return Number.isFinite(raw) && isPlausibleYear(raw)
      ? { date: String(raw), precision: "year", year: raw }
      : null;
  }

  const text = raw.trim();
  if (!text) return null;

  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    if (!isPlausibleYear(year)) return null;
    const month = iso[2] ? Number(iso[2]) : null;
    const day = iso[3] ? Number(iso[3]) : null;
    if (month !== null && (month < 1 || month > 12)) {
      return { date: String(year), precision: "year", year };
    }
    if (month === null) return { date: String(year), precision: "year", year };
    if (day === null || day < 1 || day > 31) {
      return { date: `${year}-${pad(month)}`, precision: "month", year };
    }
    return { date: `${year}-${pad(month)}-${pad(day)}`, precision: "day", year };
  }

  // "March 2023", "14 Mar 2023", "Mar 14, 2023" and friends.
  const monthMatch = /([a-z]{3,})/i.exec(text);
  const yearMatch = /(\d{4})/.exec(text);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (!isPlausibleYear(year)) return null;
    const month = monthMatch ? MONTHS[monthMatch[1].slice(0, 3).toLowerCase()] : undefined;
    if (!month) return { date: String(year), precision: "year", year };
    const dayMatch = /\b(\d{1,2})\b/.exec(text);
    const day = dayMatch ? Number(dayMatch[1]) : null;
    if (day !== null && day >= 1 && day <= 31) {
      return { date: `${year}-${pad(month)}-${pad(day)}`, precision: "day", year };
    }
    return { date: `${year}-${pad(month)}`, precision: "month", year };
  }

  return null;
}

/**
 * A sortable "YYYY-MM-DD" stamp for a possibly-imprecise date.
 *
 * Imprecise dates are placed **mid-interval** — a year-only 1996 sorts as
 * 1996-07-01, a month-only 2023-03 as 2023-03-15 — rather than at the start of
 * the interval. Mid-interval is the least-wrong guess: it keeps year-only works
 * interleaved with dated ones from the same year instead of stacking them all
 * ahead of every January paper, and it is what decides which side of the
 * assessment marker such a work lands on.
 */
export function toSortStamp(date: string | null, precision: DatePrecision | null): string | null {
  if (!date || !precision) return null;
  if (precision === "day") return date;
  if (precision === "month") return `${date}-15`;
  return `${date}-07-01`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isPlausibleYear(year: number): boolean {
  // BHL reaches back to the 1400s; anything outside this is a parsing artefact.
  return Number.isInteger(year) && year >= 1400 && year <= 2200;
}

/** Join author names into a short display string ("A, B, C +4"). */
export function formatAuthors(names: (string | null | undefined)[], max = 3): string | null {
  const cleaned = names.map(cleanText).filter((n): n is string => Boolean(n));
  if (cleaned.length === 0) return null;
  const head = cleaned.slice(0, max).join(", ");
  return cleaned.length > max ? `${head} +${cleaned.length - max}` : head;
}

/**
 * Map a source's own type vocabulary onto our small shared one. Unknown values
 * fall through to "other" rather than being guessed at.
 */
export function mapWorkType(raw: string | null | undefined): WorkType {
  const value = (raw ?? "").toLowerCase();
  if (!value) return "other";
  // OpenAlex's "peer-review" is a referee report, not a paper — check it before
  // the "review" keyword below, which does mean a review article.
  if (value.includes("peer-review")) return "other";
  if (value.includes("preprint") || value.includes("posted-content")) return "preprint";
  if (value.includes("book-chapter") || value.includes("chapter")) return "chapter";
  if (value.includes("book") || value.includes("monograph")) return "book";
  if (value.includes("report") || value.includes("thesis") || value.includes("dissertation")) {
    return "report";
  }
  if (
    value.includes("article") ||
    value.includes("journal") ||
    value.includes("paper") ||
    value.includes("review")
  ) {
    return "article";
  }
  return "other";
}

/**
 * True when any of the name variants appears as a whole phrase in the given
 * text. This is the precision guard for Semantic Scholar, whose search is
 * relevance-ranked with no phrase operator and so happily returns a paper about
 * a congener. The other sources take an exact-phrase query, so they need no
 * such guard — and applying one there would discard the multi-species floras
 * and reports that only name the species in their scanned body text.
 */
export function mentionsAnyVariant(variants: string[], ...texts: (string | null | undefined)[]): boolean {
  const haystack = normalizeTitle(texts.filter(Boolean).join(" "));
  if (!haystack) return false;
  return variants.some((variant) => {
    const needle = normalizeTitle(variant);
    if (!needle) return false;
    return haystack === needle || haystack.includes(` ${needle} `) ||
      haystack.startsWith(`${needle} `) || haystack.endsWith(` ${needle}`);
  });
}
