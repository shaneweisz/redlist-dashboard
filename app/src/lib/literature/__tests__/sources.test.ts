import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bhlSource } from "../sources/bhl";
import { coreSource } from "../sources/core";
import { googleBooksSource } from "../sources/google-books";
import { openAlexSource, reconstructAbstract } from "../sources/openalex";
import { redListSource } from "../sources/redlist";
import { zenodoSource } from "../sources/zenodo";
import { USER_AGENT } from "../sources/http";
import type { SourceQuery } from "../types";

const QUERY: SourceQuery = {
  scientificName: "Panthera leo",
  nameVariants: ["Panthera leo"],
  assessmentId: null,
  limit: 5,
  signal: new AbortController().signal,
};

/** Stand-in for a `fetch` Response, enough for `fetchJson`. */
function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

let lastUrl = "";
let lastInit: RequestInit | undefined;

function mockFetch(data: unknown, status = 200) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    lastUrl = url;
    lastInit = init;
    return jsonResponse(data, status);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  lastUrl = "";
  lastInit = undefined;
  delete process.env.BHL_API_KEY;
  delete process.env.CORE_API_KEY;
  delete process.env.GOOGLE_BOOKS_API_KEY;
  process.env.RED_LIST_API_KEY = "test-redlist-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconstructAbstract", () => {
  it("rebuilds running text from OpenAlex's inverted index", () => {
    expect(reconstructAbstract({ The: [0], lion: [1], is: [2], large: [3] })).toBe(
      "The lion is large",
    );
  });

  it("handles a word appearing more than once", () => {
    expect(reconstructAbstract({ a: [0, 2], b: [1] })).toBe("a b a");
  });

  it("returns null for a missing or empty index", () => {
    expect(reconstructAbstract(null)).toBeNull();
    expect(reconstructAbstract({})).toBeNull();
  });
});

describe("openAlexSource", () => {
  it("maps a work and reports the upstream total", async () => {
    mockFetch({
      meta: { count: 312 },
      results: [
        {
          id: "https://openalex.org/W1",
          doi: "https://doi.org/10.1234/ABC",
          title: "Lions of the Serengeti",
          publication_year: 2021,
          publication_date: "2021-04-02",
          cited_by_count: 7,
          type: "article",
          primary_location: { source: { display_name: "Oryx" } },
          abstract_inverted_index: { Lions: [0], roar: [1] },
          authorships: [{ author: { display_name: "A One" } }],
          best_oa_location: { pdf_url: "https://example.org/paper.pdf" },
        },
      ],
    });

    const result = await openAlexSource.fetch(QUERY);

    expect(result.status).toBe("ok");
    expect(result.upstreamTotal).toBe(312);
    expect(result.works[0]).toMatchObject({
      title: "Lions of the Serengeti",
      doi: "10.1234/abc",
      url: "https://doi.org/10.1234/abc",
      date: "2021-04-02",
      datePrecision: "day",
      sortStamp: "2021-04-02",
      citations: 7,
      venue: "Oryx",
      type: "article",
      authors: "A One",
      abstract: "Lions roar",
      openAccessUrl: "https://example.org/paper.pdf",
    });
  });

  it("asks for exact phrases, excludes datasets and joins the polite pool", async () => {
    mockFetch({ meta: { count: 0 }, results: [] });
    await openAlexSource.fetch({ ...QUERY, nameVariants: ["Aloe vera", "Aloe verum"] });

    const filter = decodeURIComponent(new URL(lastUrl).searchParams.get("filter")!);
    expect(filter).toContain('"Aloe vera"|"Aloe verum"');
    expect(filter).toContain("type:!dataset");
    expect(lastUrl).toContain("mailto=");
    expect((lastInit?.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
  });

  it("drops records with no title rather than rendering a blank row", async () => {
    mockFetch({ meta: { count: 1 }, results: [{ id: "W2", title: null, display_name: null }] });
    expect((await openAlexSource.fetch(QUERY)).works).toHaveLength(0);
  });

  it("reports an error status instead of throwing", async () => {
    mockFetch({}, 500);
    expect(await openAlexSource.fetch(QUERY)).toMatchObject({
      status: "error",
      works: [],
      note: "HTTP 500",
    });
  });

  it("reports rate limiting distinctly from other failures", async () => {
    mockFetch({}, 429);
    expect((await openAlexSource.fetch(QUERY)).status).toBe("rate_limited");
  });
});

describe("zenodoSource", () => {
  it("maps a deposited report", async () => {
    mockFetch({
      hits: {
        total: 4,
        hits: [
          {
            id: 6630613,
            doi: "10.5281/zenodo.6630613",
            links: { self_html: "https://zenodo.org/records/6630613" },
            metadata: {
              title: "Status survey of Panthera leo in Kenya",
              publication_date: "2022-06-10",
              description: "<p>A field report.</p>",
              creators: [{ name: "Haynes, Jody L." }],
              resource_type: { type: "publication", title: "Report" },
              publisher: "Wildlife Trust",
            },
          },
        ],
      },
    });

    const result = await zenodoSource.fetch(QUERY);

    expect(result.upstreamTotal).toBe(4);
    expect(result.works[0]).toMatchObject({
      title: "Status survey of Panthera leo in Kenya",
      doi: "10.5281/zenodo.6630613",
      date: "2022-06-10",
      type: "report",
      authors: "Haynes, Jody L.",
      venue: "Wildlife Trust",
      abstract: "A field report.",
      openAccessUrl: "https://zenodo.org/records/6630613",
    });
  });

  it("sends the variants as an OR of quoted phrases, newest first", async () => {
    mockFetch({ hits: { total: 0, hits: [] } });
    await zenodoSource.fetch({ ...QUERY, nameVariants: ["Aloe vera", "Aloe verum"] });
    expect(decodeURIComponent(lastUrl)).toContain('q="Aloe vera" OR "Aloe verum"');
    expect(lastUrl).toContain("sort=newest");
  });

  it("never asks for more than the anonymous page-size cap", async () => {
    // Zenodo rejects size>25 with a 400 rather than clamping it.
    mockFetch({ hits: { total: 0, hits: [] } });
    await zenodoSource.fetch({ ...QUERY, limit: 50 });
    expect(new URL(lastUrl).searchParams.get("size")).toBe("25");
  });

  it("falls back to Zenodo as the venue and withholds closed deposits", async () => {
    mockFetch({
      hits: {
        total: 1,
        hits: [
          {
            id: 1,
            links: { self_html: "https://zenodo.org/records/1" },
            metadata: { title: "A closed deposit", publication_date: "2020", access_right: "closed" },
          },
        ],
      },
    });
    expect((await zenodoSource.fetch(QUERY)).works[0]).toMatchObject({
      venue: "Zenodo",
      openAccessUrl: null,
      datePrecision: "year",
    });
  });
});

describe("redListSource", () => {
  const ASSESSMENT = {
    url: "https://www.iucnredlist.org/species/41881/243434007",
    assessment_date: "2020-05-19",
    // Published two years after it was assessed — the label must follow the
    // assessment date, which is what the rest of the dashboard shows.
    year_published: "2022",
    references: [
      {
        citation: "Osborne, R. 1986. Focus on <i>Encephalartos woodii</i>. <i>Encephalartos</i> 5: 4-10.",
        year: "1986",
        title: "Focus on <i>Encephalartos woodii</i>",
        author: "Osborne, R.",
        citation_short: null,
      },
      // Some references carry only the formatted citation.
      { citation: "IUCN. 2020. Guidelines.", year: "2020", title: null, author: null },
      // Boilerplate: the assessment citing the Red List itself.
      {
        citation:
          "IUCN. 2026. The IUCN Red List of Threatened Species. Version 2026-1. Available at: www.iucnredlist.org.",
        year: "2026",
        title: "The IUCN Red List of Threatened Species. Version 2026-1",
        author: "IUCN",
      },
    ],
  };

  it("contributes nothing, and makes no request, without an assessment", async () => {
    const spy = mockFetch({});
    const result = await redListSource.fetch(QUERY);
    expect(result).toMatchObject({ status: "ok", works: [], upstreamTotal: 0 });
    expect(result.note).toContain("No assessment");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports itself unconfigured without an API key", async () => {
    delete process.env.RED_LIST_API_KEY;
    const spy = mockFetch({});
    expect(await redListSource.fetch({ ...QUERY, assessmentId: "243434007" })).toMatchObject({
      status: "unconfigured",
      note: "Set RED_LIST_API_KEY to enable this source",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps the assessment's reference list, stripping citation markup", async () => {
    mockFetch(ASSESSMENT);

    const result = await redListSource.fetch({ ...QUERY, assessmentId: "243434007" });

    expect(lastUrl).toContain("/api/v4/assessment/243434007");
    expect((lastInit?.headers as Record<string, string>).Authorization).toBe("test-redlist-key");
    expect(result.upstreamTotal).toBe(2);
    // The Red List's citation of itself is boilerplate, not species evidence.
    expect(result.works.map((w) => w.title)).not.toContain(
      "The IUCN Red List of Threatened Species. Version 2026-1",
    );
    expect(result.works[0]).toMatchObject({
      title: "Focus on Encephalartos woodii",
      date: "1986",
      datePrecision: "year",
      sortStamp: "1986-07-01",
      authors: "Osborne, R.",
      // The Red List does not break a citation into a venue.
      venue: null,
      citations: null,
      // Points at the assessment that cites it, since references carry no link.
      url: ASSESSMENT.url,
    });
    // The full formatted citation is what a reader wants on expand.
    expect(result.works[0].abstract).toBe(
      "Osborne, R. 1986. Focus on Encephalartos woodii . Encephalartos 5: 4-10.",
    );
    expect(result.works[0].sources).toEqual([
      { id: "redlist", label: "Cited by 2020 assessment", url: ASSESSMENT.url },
    ]);
  });

  it("falls back to the citation when a reference has no title", async () => {
    mockFetch(ASSESSMENT);
    const result = await redListSource.fetch({ ...QUERY, assessmentId: "243434007" });
    expect(result.works[1]).toMatchObject({ title: "IUCN. 2020. Guidelines.", year: 2020 });
    // Citation and title are the same string here, so it isn't repeated.
    expect(result.works[1].abstract).toBeNull();
  });

  it("falls back to an unqualified label when the API gives no date", async () => {
    mockFetch({ url: null, references: [{ title: "A work", year: "1990" }] });
    const result = await redListSource.fetch({ ...QUERY, assessmentId: "1" });
    expect(result.works[0].sources[0].label).toBe("Cited by assessment");
  });

  it("degrades rather than throwing when the Red List API fails", async () => {
    mockFetch({}, 503);
    expect(await redListSource.fetch({ ...QUERY, assessmentId: "1" })).toMatchObject({
      status: "rate_limited",
      works: [],
    });
  });
});

describe("key-gated sources", () => {
  it.each([
    ["bhl", bhlSource, "BHL_API_KEY"],
    ["core", coreSource, "CORE_API_KEY"],
    ["googlebooks", googleBooksSource, "GOOGLE_BOOKS_API_KEY"],
  ])("%s reports itself unconfigured without a key, and makes no request", async (_id, source, envVar) => {
    const spy = mockFetch({});
    const result = await source.fetch(QUERY);
    expect(result.status).toBe("unconfigured");
    expect(result.note).toContain(envVar);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("bhlSource", () => {
  beforeEach(() => {
    process.env.BHL_API_KEY = "test-key";
  });

  it("maps a scanned part and keeps its landing page as the free-to-read link", async () => {
    mockFetch({
      Status: "ok",
      Result: [
        {
          BHLType: "Part",
          PartID: 12345,
          Title: "On a new Panthera leo from Somaliland",
          PartUrl: "https://www.biodiversitylibrary.org/part/12345",
          Authors: [{ Name: "Sclater, P. L." }],
          Date: "1898",
          ContainerTitle: "Proceedings of the Zoological Society of London",
          Genre: "Article",
        },
      ],
    });

    expect((await bhlSource.fetch(QUERY)).works[0]).toMatchObject({
      title: "On a new Panthera leo from Somaliland",
      date: "1898",
      datePrecision: "year",
      sortStamp: "1898-07-01",
      type: "article",
      citations: null,
      openAccessUrl: "https://www.biodiversitylibrary.org/part/12345",
    });
  });

  it("keeps a volume whose title never names the species", async () => {
    // The 1860 flora that mentions the species only in its scanned body text is
    // the record BHL exists to contribute; the quoted full-text query, not a
    // local title filter, is what keeps results on-species.
    mockFetch({
      Status: "ok",
      Result: [{ BHLType: "Item", ItemID: 1, Title: "Flora of the Cape", Date: "1860" }],
    });
    expect((await bhlSource.fetch(QUERY)).works).toHaveLength(1);
  });

  it("searches the name as a quoted phrase", async () => {
    mockFetch({ Status: "ok", Result: [] });
    await bhlSource.fetch(QUERY);
    expect(decodeURIComponent(lastUrl)).toContain('searchterm="Panthera leo"');
  });

  it("surfaces a BHL-level error status", async () => {
    mockFetch({ Status: "error", ErrorMessage: "Invalid API key", Result: null });
    expect(await bhlSource.fetch(QUERY)).toMatchObject({
      status: "error",
      note: "Invalid API key",
    });
  });

  it("declares a longer budget than the default", () => {
    expect(bhlSource.timeoutMs).toBeGreaterThan(8_000);
  });
});

describe("coreSource", () => {
  beforeEach(() => {
    process.env.CORE_API_KEY = "test-key";
  });

  it("authenticates with a bearer token and maps a repository record", async () => {
    mockFetch({
      totalHits: 4,
      results: [
        {
          id: 99,
          title: "Population survey of Panthera leo",
          doi: "10.5555/xyz",
          publishedDate: "2018-09-30T00:00:00",
          abstract: "Counts of lions.",
          authors: [{ name: "B Two" }],
          publisher: "University of Somewhere",
          documentType: "thesis",
          downloadUrl: "https://core.ac.uk/download/99.pdf",
        },
      ],
    });

    const result = await coreSource.fetch(QUERY);

    expect((lastInit?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(result.works[0]).toMatchObject({
      doi: "10.5555/xyz",
      date: "2018-09-30",
      type: "report",
      openAccessUrl: "https://core.ac.uk/download/99.pdf",
    });
  });

  it("sends an unqualified query to the trailing-slash path", async () => {
    // A quoted query is rejected outright by CORE ("abstract is not a
    // searchable field"), and without the trailing slash it 301s.
    mockFetch({ totalHits: 0, results: [] });
    await coreSource.fetch(QUERY);
    expect(lastUrl).toContain("/v3/search/works/?q=");
    expect(decodeURIComponent(lastUrl)).toContain("q=Panthera leo");
    expect(lastUrl).not.toContain("%22");
  });

  it("drops the congeners its token search returns", async () => {
    // CORE's quotes do not enforce a phrase, so this guard is what keeps the
    // results on-species.
    mockFetch({
      totalHits: 2,
      results: [
        { id: 1, title: "Diet of Panthera leo in Kenya", yearPublished: 2020 },
        { id: 2, title: "Diet of Panthera pardus in Kenya", yearPublished: 2020 },
      ],
    });
    const result = await coreSource.fetch(QUERY);
    expect(result.works.map((w) => w.title)).toEqual(["Diet of Panthera leo in Kenya"]);
  });

  it("declares a longer budget than the default", () => {
    expect(coreSource.timeoutMs).toBeGreaterThan(8_000);
  });
});

describe("googleBooksSource", () => {
  beforeEach(() => {
    process.env.GOOGLE_BOOKS_API_KEY = "test-key";
  });

  it("joins title and subtitle and reads a prose publication date", async () => {
    mockFetch({
      totalItems: 2,
      items: [
        {
          id: "vol1",
          volumeInfo: {
            title: "Mammals of Africa",
            subtitle: "including Panthera leo",
            authors: ["C Three", "D Four"],
            publisher: "Bloomsbury",
            publishedDate: "2013-05",
            description: "A reference work.",
            infoLink: "https://books.google.com/books?id=vol1",
          },
          accessInfo: { viewability: "PARTIAL", webReaderLink: "https://reader" },
        },
      ],
    });

    expect((await googleBooksSource.fetch(QUERY)).works[0]).toMatchObject({
      title: "Mammals of Africa: including Panthera leo",
      date: "2013-05",
      datePrecision: "month",
      sortStamp: "2013-05-15",
      type: "book",
      authors: "C Three, D Four",
      venue: "Bloomsbury",
      // Only fully viewable volumes count as readable.
      openAccessUrl: null,
    });
  });

  it("keeps a flora that matched on its contents rather than its title", async () => {
    mockFetch({
      totalItems: 1,
      items: [{ id: "vol2", volumeInfo: { title: "Flora of Tropical Africa", publishedDate: "2001" } }],
    });
    expect((await googleBooksSource.fetch(QUERY)).works).toHaveLength(1);
  });

  it("searches the variants as an OR of quoted phrases", async () => {
    mockFetch({ totalItems: 0, items: [] });
    await googleBooksSource.fetch({ ...QUERY, nameVariants: ["Aloe vera", "Aloe verum"] });
    expect(decodeURIComponent(lastUrl)).toContain('q="Aloe vera" OR "Aloe verum"');
  });
});
