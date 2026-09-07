/**
 * Zenodo — conservation grey literature: NGO and project reports, theses,
 * workshop proceedings and other material that never had a journal home and so
 * never reached OpenAlex.
 *
 * Keyless, and it honours quoted phrases, so the Latin gender variants can be
 * OR'd into one query.
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
import { failed, fetchJson, quotedOrQuery } from "./http";

interface ZenodoRecord {
  id?: number | string;
  doi?: string | null;
  links?: { self_html?: string | null } | null;
  files?: Array<{ links?: { self?: string | null } | null }> | null;
  metadata?: {
    title?: string | null;
    publication_date?: string | null;
    description?: string | null;
    creators?: Array<{ name?: string | null }> | null;
    journal?: { title?: string | null } | null;
    imprint?: { publisher?: string | null } | null;
    publisher?: string | null;
    resource_type?: { type?: string | null; title?: string | null } | null;
    access_right?: string | null;
  } | null;
}

interface ZenodoResponse {
  hits?: { total?: number; hits?: ZenodoRecord[] };
}

/**
 * Anonymous requests are capped at 25 records; asking for more is rejected
 * outright with `400 A validation error occurred`, not silently clamped.
 */
const MAX_PAGE_SIZE = 25;

export const zenodoSource: SourceAdapter = {
  id: "zenodo",
  label: "Zenodo",
  homepage: "https://zenodo.org",

  async fetch({ nameVariants, limit, signal }: SourceQuery): Promise<SourceResult> {
    const url =
      `https://zenodo.org/api/records?q=${encodeURIComponent(quotedOrQuery(nameVariants))}` +
      `&size=${Math.max(1, Math.min(limit, MAX_PAGE_SIZE))}&sort=newest`;

    try {
      const data = await fetchJson<ZenodoResponse>(url, { signal });
      const works = (data.hits?.hits ?? [])
        .map(toWork)
        .filter((w): w is LiteratureWork => w !== null);
      return { status: "ok", works, upstreamTotal: data.hits?.total ?? null, note: null };
    } catch (error) {
      return failed(error);
    }
  },
};

function toWork(raw: ZenodoRecord): LiteratureWork | null {
  const meta = raw.metadata;
  const title = cleanText(meta?.title);
  if (!title) return null;

  const doi = normalizeDoi(raw.doi);
  const parsed = parseDate(meta?.publication_date);
  const landing =
    cleanText(raw.links?.self_html) ?? (raw.id ? `https://zenodo.org/records/${raw.id}` : null);

  // Zenodo's own vocabulary ("publication", "poster", "report", "dataset"),
  // with the sub-type carrying the detail we actually want.
  const resourceType = meta?.resource_type;
  const typeText = [resourceType?.title, resourceType?.type].filter(Boolean).join(" ");

  return {
    key: `zenodo:${raw.id ?? title}`,
    title,
    url: doi ? `https://doi.org/${doi}` : (landing ?? "https://zenodo.org"),
    doi,
    date: parsed?.date ?? null,
    datePrecision: parsed?.precision ?? null,
    year: parsed?.year ?? null,
    sortStamp: toSortStamp(parsed?.date ?? null, parsed?.precision ?? null),
    authors: formatAuthors((meta?.creators ?? []).map((c) => c.name)),
    venue:
      cleanText(meta?.journal?.title) ??
      cleanText(meta?.imprint?.publisher) ??
      cleanText(meta?.publisher) ??
      "Zenodo",
    // Zenodo holds no citation data.
    citations: null,
    type: mapWorkType(typeText),
    // Everything openly deposited is readable at its landing page.
    openAccessUrl: meta?.access_right === "closed" ? null : landing,
    abstract: cleanAbstract(meta?.description),
    sources: [{ id: "zenodo", label: "Zenodo", url: landing }],
  };
}
