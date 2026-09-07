/**
 * Biodiversity Heritage Library — scanned historical biodiversity literature.
 *
 * This is the source that reaches the material none of the modern indexes hold:
 * protologues, nineteenth-century floras and faunas, the original descriptions
 * a Red List assessor actually needs. Kew's "Selected resources for IUCN
 * conservation assessment species research" lists it under both Distribution
 * and Habitat & ecology.
 *
 * BHL's API requires a free key (https://www.biodiversitylibrary.org/getapikey.aspx).
 * Without `BHL_API_KEY` the adapter reports itself "unconfigured" rather than
 * failing, so the timeline still renders from the keyless sources.
 */

import {
  cleanAbstract,
  cleanText,
  mapWorkType,
  normalizeDoi,
  parseDate,
  toSortStamp,
} from "../normalize";
import type { LiteratureWork, SourceAdapter, SourceQuery, SourceResult } from "../types";
import { failed, fetchJson, unconfigured } from "./http";

interface BhlResult {
  BHLType?: string;
  TitleID?: number | string;
  ItemID?: number | string;
  PartID?: number | string;
  Title?: string | null;
  PartUrl?: string | null;
  ItemUrl?: string | null;
  TitleUrl?: string | null;
  Authors?: Array<{ Name?: string | null }> | null;
  Date?: string | null;
  PublicationDate?: string | null;
  PublisherName?: string | null;
  ContainerTitle?: string | null;
  Genre?: string | null;
  Doi?: string | null;
  PageRange?: string | null;
  Notes?: string | null;
}

interface BhlResponse {
  Status?: string;
  ErrorMessage?: string | null;
  Result?: BhlResult[] | null;
}

export const bhlSource: SourceAdapter = {
  id: "bhl",
  label: "Biodiversity Heritage Library",
  homepage: "https://www.biodiversitylibrary.org",
  // Full-text search across scanned books is slow: 8.5s measured on a cold
  // query, which the default budget was cutting off.
  timeoutMs: 25_000,

  async fetch({ scientificName, limit, signal }: SourceQuery): Promise<SourceResult> {
    const apiKey = process.env.BHL_API_KEY;
    if (!apiKey) return unconfigured("BHL_API_KEY");

    // searchtype=F searches metadata *and* scanned full text, which is the
    // whole point of BHL for a species name that only ever appeared in print.
    // The term is quoted so the two words match as a phrase.
    const url =
      `https://www.biodiversitylibrary.org/api3?op=PublicationSearch` +
      `&searchterm=${encodeURIComponent(`"${scientificName}"`)}&searchtype=F` +
      `&format=json&apikey=${encodeURIComponent(apiKey)}`;

    try {
      const data = await fetchJson<BhlResponse>(url, { signal });
      if (data.Status && data.Status !== "ok") {
        return {
          status: "error",
          works: [],
          upstreamTotal: null,
          note: data.ErrorMessage || `BHL returned status "${data.Status}"`,
        };
      }
      const all = data.Result ?? [];
      // Deliberately no local name filter here: BHL's value is the volume
      // whose *scanned text* mentions the species while its title says only
      // "Flora of Tropical Africa". Filtering on the metadata we display would
      // throw away exactly the records BHL is here to contribute; the quoted
      // full-text query is what keeps the results on-species.
      const works = all
        .map(toWork)
        .filter((w): w is LiteratureWork => w !== null)
        .slice(0, limit);
      // BHL returns the whole (capped) hit list rather than a total, so the
      // count of what it handed us is the only honest "upstream total".
      return { status: "ok", works, upstreamTotal: all.length, note: null };
    } catch (error) {
      return failed(error);
    }
  },
};

function toWork(raw: BhlResult): LiteratureWork | null {
  const title = cleanText(raw.Title);
  if (!title) return null;

  const doi = normalizeDoi(raw.Doi);
  const parsed = parseDate(raw.PublicationDate) ?? parseDate(raw.Date);
  const landing =
    cleanText(raw.PartUrl) ?? cleanText(raw.ItemUrl) ?? cleanText(raw.TitleUrl) ??
    (raw.TitleID ? `https://www.biodiversitylibrary.org/bibliography/${raw.TitleID}` : null);

  const id = raw.PartID ?? raw.ItemID ?? raw.TitleID ?? title;

  return {
    key: `bhl:${raw.BHLType ?? "?"}:${id}`,
    title,
    url: landing ?? "https://www.biodiversitylibrary.org",
    doi,
    date: parsed?.date ?? null,
    datePrecision: parsed?.precision ?? null,
    year: parsed?.year ?? null,
    sortStamp: toSortStamp(parsed?.date ?? null, parsed?.precision ?? null),
    authors: cleanText((raw.Authors ?? []).map((a) => a.Name).filter(Boolean).slice(0, 3).join("; ")),
    venue: cleanText(raw.ContainerTitle) ?? cleanText(raw.PublisherName),
    // BHL holds no citation data.
    citations: null,
    type: mapWorkType(raw.Genre ?? (raw.BHLType === "Part" ? "article" : "book")),
    // Everything in BHL is free to read at the landing page.
    openAccessUrl: landing,
    abstract: cleanAbstract(raw.Notes),
    sources: [{ id: "bhl", label: "Biodiversity Heritage Library", url: landing }],
  };
}
