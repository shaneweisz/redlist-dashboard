/**
 * OpenAlex — the broadest of the sources, and the only one that was wired up
 * before this timeline existed. Fully open (CC0), no key, and it honours exact
 * phrase search, so the Latin gender variants can be OR'd into one query.
 */

import {
  cleanAbstract,
  cleanText,
  formatAuthors,
  mapWorkType,
  normalizeDoi,
  parseDate,
  toSortStamp,
} from "../normalize";
import type { LiteratureWork, SourceAdapter, SourceQuery, SourceResult } from "../types";
import { CONTACT_EMAIL, failed, fetchJson } from "./http";

interface OpenAlexWork {
  id: string;
  doi: string | null;
  title: string | null;
  display_name?: string | null;
  publication_year: number | null;
  publication_date: string | null;
  cited_by_count: number | null;
  type: string | null;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: Array<{ author?: { display_name?: string | null } | null }> | null;
}

interface OpenAlexResponse {
  meta?: { count?: number };
  results?: OpenAlexWork[];
}

/**
 * OpenAlex stores abstracts as a word -> positions map (a licensing dodge).
 * Rebuild the running text from it.
 */
export function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null | undefined,
): string | null {
  if (!invertedIndex) return null;
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions) words.push([position, word]);
  }
  if (words.length === 0) return null;
  words.sort((a, b) => a[0] - b[0]);
  return cleanAbstract(words.map(([, word]) => word).join(" "));
}

export const openAlexSource: SourceAdapter = {
  id: "openalex",
  label: "OpenAlex",
  homepage: "https://openalex.org",

  async fetch({ nameVariants, limit, signal }: SourceQuery): Promise<SourceResult> {
    // Quoted terms give exact phrase matching; `type:!dataset` drops the GBIF
    // occurrence downloads that would otherwise dominate a species search.
    const searchTerms = nameVariants.map((v) => `"${v}"`).join("|");
    const filter = encodeURIComponent(
      `default.search:${searchTerms},type:!dataset`,
    );
    const url =
      `https://api.openalex.org/works?filter=${filter}` +
      `&sort=publication_date:desc&per_page=${Math.max(1, limit)}&mailto=${CONTACT_EMAIL}`;

    try {
      const data = await fetchJson<OpenAlexResponse>(url, { signal });
      const works = (data.results ?? []).map(toWork).filter((w): w is LiteratureWork => w !== null);
      return {
        status: "ok",
        works,
        upstreamTotal: data.meta?.count ?? null,
        note: null,
      };
    } catch (error) {
      return failed(error);
    }
  },
};

function toWork(raw: OpenAlexWork): LiteratureWork | null {
  const title = cleanText(raw.title ?? raw.display_name);
  if (!title) return null;

  const doi = normalizeDoi(raw.doi);
  const parsed = parseDate(raw.publication_date) ?? parseDate(raw.publication_year);
  const landing = raw.id;

  return {
    key: `openalex:${raw.id}`,
    title,
    url: doi ? `https://doi.org/${doi}` : landing,
    doi,
    date: parsed?.date ?? null,
    datePrecision: parsed?.precision ?? null,
    year: parsed?.year ?? raw.publication_year ?? null,
    sortStamp: toSortStamp(parsed?.date ?? null, parsed?.precision ?? null),
    authors: formatAuthors((raw.authorships ?? []).map((a) => a.author?.display_name)),
    venue: cleanText(raw.primary_location?.source?.display_name),
    citations: raw.cited_by_count ?? null,
    type: mapWorkType(raw.type),
    openAccessUrl:
      cleanText(raw.best_oa_location?.pdf_url) ?? cleanText(raw.best_oa_location?.landing_page_url),
    abstract: reconstructAbstract(raw.abstract_inverted_index),
    sources: [{ id: "openalex", label: "OpenAlex", url: landing }],
  };
}
