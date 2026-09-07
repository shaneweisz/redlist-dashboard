/**
 * Google Books — floras, field guides, monographs and Red Data Books. Kew's
 * resource list leans heavily on printed floras and checklists, and this is the
 * only source here that indexes their contents.
 *
 * A key is required despite the docs implying otherwise: the anonymous quota is
 * now literally zero (the API answers 429 with
 * `quota_limit_value: "0"` for `defaultPerDayPerProject`). So this adapter is
 * gated on `GOOGLE_BOOKS_API_KEY` — any Google Cloud API key with the Books API
 * enabled — and reports "unconfigured" without one.
 */

import {
  cleanAbstract,
  cleanText,
  formatAuthors,
  parseDate,
  toSortStamp,
} from "../normalize";
import type { LiteratureWork, SourceAdapter, SourceQuery, SourceResult } from "../types";
import { failed, fetchJson, quotedOrQuery, unconfigured } from "./http";

interface GoogleBooksVolume {
  id?: string;
  volumeInfo?: {
    title?: string | null;
    subtitle?: string | null;
    authors?: string[] | null;
    publisher?: string | null;
    publishedDate?: string | null;
    description?: string | null;
    infoLink?: string | null;
    previewLink?: string | null;
  } | null;
  accessInfo?: { viewability?: string | null; webReaderLink?: string | null } | null;
  searchInfo?: { textSnippet?: string | null } | null;
}

interface GoogleBooksResponse {
  totalItems?: number;
  items?: GoogleBooksVolume[];
}

export const googleBooksSource: SourceAdapter = {
  id: "googlebooks",
  label: "Google Books",
  homepage: "https://books.google.com",

  async fetch({ nameVariants, limit, signal }: SourceQuery): Promise<SourceResult> {
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
    if (!apiKey) return unconfigured("GOOGLE_BOOKS_API_KEY");

    const url =
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(quotedOrQuery(nameVariants))}` +
      `&maxResults=${Math.max(1, Math.min(limit, 40))}&orderBy=newest&printType=books` +
      `&key=${encodeURIComponent(apiKey)}`;

    try {
      const data = await fetchJson<GoogleBooksResponse>(url, { signal });
      // No local name filter: the floras and field guides this source exists
      // to surface match on their scanned contents, not on a title that names
      // one species out of the thousands they cover. The quoted phrase query
      // does the filtering.
      const works = (data.items ?? [])
        .map(toWork)
        .filter((w): w is LiteratureWork => w !== null);
      return { status: "ok", works, upstreamTotal: data.totalItems ?? null, note: null };
    } catch (error) {
      return failed(error);
    }
  },
};

function toWork(raw: GoogleBooksVolume): LiteratureWork | null {
  const info = raw.volumeInfo;
  const base = cleanText(info?.title);
  if (!base) return null;
  const subtitle = cleanText(info?.subtitle);
  const title = subtitle ? `${base}: ${subtitle}` : base;

  const parsed = parseDate(info?.publishedDate);
  const landing =
    cleanText(info?.infoLink) ??
    cleanText(info?.previewLink) ??
    (raw.id ? `https://books.google.com/books?id=${raw.id}` : null);

  return {
    key: `googlebooks:${raw.id ?? title}`,
    title,
    url: landing ?? "https://books.google.com",
    // Books rarely carry a DOI, and Google never exposes one.
    doi: null,
    date: parsed?.date ?? null,
    datePrecision: parsed?.precision ?? null,
    year: parsed?.year ?? null,
    sortStamp: toSortStamp(parsed?.date ?? null, parsed?.precision ?? null),
    authors: formatAuthors(info?.authors ?? []),
    venue: cleanText(info?.publisher),
    citations: null,
    type: "book",
    openAccessUrl:
      raw.accessInfo?.viewability === "ALL_PAGES" ? cleanText(raw.accessInfo?.webReaderLink) : null,
    abstract: cleanAbstract(info?.description ?? raw.searchInfo?.textSnippet),
    sources: [{ id: "googlebooks", label: "Google Books", url: landing }],
  };
}
