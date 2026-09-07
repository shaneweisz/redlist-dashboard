/**
 * CORE — aggregated open-access repository content: theses, institutional
 * reports and preprints that never got a DOI and so never reached OpenAlex.
 *
 * Needs a key (https://core.ac.uk/services/api). Without `CORE_API_KEY` the
 * adapter reports "unconfigured" and the rest of the timeline still works.
 *
 * Two things about their v3 search shape this adapter, both established against
 * the live API:
 *  - A bare quoted query is rejected outright — the backend answers 500 with
 *    "abstract is not a searchable field", and `fullText:` does the same. Only
 *    an unqualified query and `title:` are accepted.
 *  - Quotes do not enforce a phrase either way: `title:"Encephalartos woodii"`
 *    returns 565 hits for a species with a handful of papers, so it is matching
 *    tokens. CORE therefore needs the same local name guard as any other
 *    relevance search.
 */

import {
  cleanAbstract,
  cleanText,
  formatAuthors,
  mapWorkType,
  mentionsAnyVariant,
  normalizeDoi,
  parseDate,
  toSortStamp,
} from "../normalize";
import type { LiteratureWork, SourceAdapter, SourceQuery, SourceResult } from "../types";
import { failed, fetchJson, unconfigured } from "./http";

interface CoreWork {
  id?: number | string;
  title?: string | null;
  doi?: string | null;
  abstract?: string | null;
  publishedDate?: string | null;
  yearPublished?: number | null;
  publisher?: string | null;
  documentType?: string | null;
  downloadUrl?: string | null;
  authors?: Array<{ name?: string | null }> | null;
  links?: Array<{ type?: string | null; url?: string | null }> | null;
}

interface CoreResponse {
  totalHits?: number;
  results?: CoreWork[];
}

export const coreSource: SourceAdapter = {
  id: "core",
  label: "CORE",
  homepage: "https://core.ac.uk",
  // A 50-result page is ~800KB of repository metadata and measured 2.6s direct,
  // but well past the 8s default under the parallel fan-out.
  timeoutMs: 20_000,

  async fetch({ scientificName, nameVariants, limit, signal }: SourceQuery): Promise<SourceResult> {
    const apiKey = process.env.CORE_API_KEY;
    if (!apiKey) return unconfigured("CORE_API_KEY");

    // Trailing slash: without it CORE 301s, and the redirect costs a round trip.
    const url =
      `https://api.core.ac.uk/v3/search/works/?q=${encodeURIComponent(scientificName)}` +
      `&limit=${Math.max(1, Math.min(limit, 100))}`;

    try {
      const data = await fetchJson<CoreResponse>(url, {
        signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const works = (data.results ?? [])
        .map(toWork)
        .filter((w): w is LiteratureWork => w !== null)
        // CORE's query matches tokens, so an "Encephalartos woodii" search
        // returns every congener; require the actual name in what we display.
        .filter((w) => mentionsAnyVariant(nameVariants, w.title, w.abstract));
      return { status: "ok", works, upstreamTotal: data.totalHits ?? null, note: null };
    } catch (error) {
      return failed(error);
    }
  },
};

function toWork(raw: CoreWork): LiteratureWork | null {
  const title = cleanText(raw.title);
  if (!title) return null;

  const doi = normalizeDoi(raw.doi);
  const parsed = parseDate(raw.publishedDate) ?? parseDate(raw.yearPublished);
  const landing =
    cleanText(raw.links?.find((l) => l.type === "display")?.url) ??
    cleanText(raw.downloadUrl) ??
    (raw.id ? `https://core.ac.uk/works/${raw.id}` : null);

  return {
    key: `core:${raw.id ?? title}`,
    title,
    url: doi ? `https://doi.org/${doi}` : (landing ?? "https://core.ac.uk"),
    doi,
    date: parsed?.date ?? null,
    datePrecision: parsed?.precision ?? null,
    year: parsed?.year ?? raw.yearPublished ?? null,
    sortStamp: toSortStamp(parsed?.date ?? null, parsed?.precision ?? null),
    authors: formatAuthors((raw.authors ?? []).map((a) => a.name)),
    venue: cleanText(raw.publisher),
    citations: null,
    type: mapWorkType(raw.documentType),
    // Everything CORE indexes is open access by definition.
    openAccessUrl: cleanText(raw.downloadUrl) ?? landing,
    abstract: cleanAbstract(raw.abstract),
    sources: [{ id: "core", label: "CORE", url: landing }],
  };
}
