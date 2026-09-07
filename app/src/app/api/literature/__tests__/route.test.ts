import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/server", () => {
  class MockNextRequest {
    nextUrl: URL;
    constructor(url: string) {
      this.nextUrl = new URL(url);
    }
  }
  return {
    NextRequest: MockNextRequest,
    NextResponse: {
      json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
        return {
          _body: body,
          status: init?.status ?? 200,
          headers: new Map(Object.entries(init?.headers ?? {})),
          async json() {
            return body;
          },
        };
      },
    },
  };
});

vi.mock("@/lib/cache-headers", () => ({
  CACHE_1H: { "Cache-Control": "public, s-maxage=3600" },
}));

import { GET } from "../route";
import { clearLiteratureCache } from "@/lib/literature/aggregate";

// ---------------------------------------------------------------------------
// Fixtures — one OpenAlex page spanning a 2015 assessment date.
// ---------------------------------------------------------------------------

const YEARS = [2024, 2023, 2022, 2021, 2020, 2014, 2013, 2012, 2011, 2010, 2009, 2008];

const OPENALEX_RESULTS = YEARS.map((year, index) => ({
  id: `https://openalex.org/W${index}`,
  doi: `https://doi.org/10.1234/w${index}`,
  title: `Panthera leo paper ${year}`,
  publication_year: year,
  publication_date: `${year}-06-01`,
  cited_by_count: index,
  type: "article",
  primary_location: { source: { display_name: "Oryx" } },
}));

function stubSources({ openAlexStatus = 200 }: { openAlexStatus?: number } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const respond = (data: unknown, status = 200) =>
        ({ ok: status >= 200 && status < 300, status, json: async () => data }) as unknown as Response;
      if (url.includes("api.openalex.org")) {
        if (openAlexStatus !== 200) return respond({}, openAlexStatus);
        return respond({ meta: { count: 200 }, results: OPENALEX_RESULTS });
      }
      if (url.includes("zenodo.org")) return respond({ hits: { total: 0, hits: [] } });
      if (url.includes("api.iucnredlist.org")) return respond({ references: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

type Body = {
  items: { title: string }[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  markerIndex: number | null;
  counts: { afterAssessment: number; beforeAssessment: number; undated: number };
  sources: { id: string; status: string; note: string | null }[];
  upstreamTotal: number | null;
  poolTruncated: boolean;
  nameVariants: string[];
  assessmentStamp: string | null;
  cached: boolean;
  error?: string;
};

async function get(query: string): Promise<{ status: number; body: Body }> {
  const response = await GET(new NextRequest(`http://localhost/api/literature?${query}`));
  return { status: response.status, body: (await response.json()) as Body };
}

beforeEach(() => {
  clearLiteratureCache();
  delete process.env.BHL_API_KEY;
  delete process.env.GOOGLE_BOOKS_API_KEY;
  process.env.RED_LIST_API_KEY = "test-redlist-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/literature", () => {
  it("requires a scientific name", async () => {
    const { status, body } = await get("assessmentDate=2015-01-01");
    expect(status).toBe(400);
    expect(body.error).toContain("scientificName");
  });

  it("returns one paginated timeline, newest first", async () => {
    stubSources();
    const { status, body } = await get("scientificName=Panthera%20leo&assessmentDate=2015-06-30");

    expect(status).toBe(200);
    expect(body).toMatchObject({ page: 1, perPage: 10, total: 12, totalPages: 2 });
    expect(body.items).toHaveLength(10);
    expect(body.items[0].title).toBe("Panthera leo paper 2024");
    expect(body.items[9].title).toBe("Panthera leo paper 2010");
  });

  it("places the assessment marker between the works either side of it", async () => {
    stubSources();
    const { body } = await get("scientificName=Panthera%20leo&assessmentDate=2015-06-30");

    // Five works postdate the assessment, so the marker renders before the sixth.
    expect(body.markerIndex).toBe(5);
    expect(body.items[4].title).toBe("Panthera leo paper 2020");
    expect(body.items[5].title).toBe("Panthera leo paper 2014");
    expect(body.counts).toEqual({ afterAssessment: 5, beforeAssessment: 7, undated: 0 });
  });

  it("keeps the marker off pages it does not fall on", async () => {
    stubSources();
    const { body } = await get("scientificName=Panthera%20leo&assessmentDate=2015-06-30&page=2");
    expect(body.page).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.markerIndex).toBeNull();
  });

  it("accepts a bare assessment year and places it mid-year", async () => {
    stubSources();
    const { body } = await get("scientificName=Panthera%20leo&assessmentYear=2015");
    expect(body.assessmentStamp).toBe("2015-07-01");
    expect(body.markerIndex).toBe(5);
  });

  it("omits the marker entirely when there is no assessment (Not Evaluated)", async () => {
    stubSources();
    const { body } = await get("scientificName=Panthera%20leo");
    expect(body.assessmentStamp).toBeNull();
    expect(body.markerIndex).toBeNull();
    expect(body.counts.beforeAssessment).toBe(0);
  });

  it("clamps an out-of-range page rather than returning an empty list", async () => {
    stubSources();
    const { body } = await get("scientificName=Panthera%20leo&page=99");
    expect(body.page).toBe(2);
    expect(body.items).toHaveLength(2);
  });

  it("honours perPage within bounds", async () => {
    stubSources();
    expect((await get("scientificName=Panthera%20leo&perPage=5")).body).toMatchObject({
      perPage: 5,
      totalPages: 3,
    });
    // Above the cap, and non-numeric, both fall back to something sane.
    expect((await get("scientificName=Panthera%20leo&perPage=500")).body.perPage).toBe(50);
    expect((await get("scientificName=Panthera%20leo&perPage=abc")).body.perPage).toBe(10);
  });

  it("pages without re-querying the sources", async () => {
    stubSources();
    const fetchSpy = globalThis.fetch as unknown as { mock: { calls: unknown[] } };

    await get("scientificName=Panthera%20leo&page=1");
    const afterFirstPage = fetchSpy.mock.calls.length;
    const { body } = await get("scientificName=Panthera%20leo&page=2");

    expect(fetchSpy.mock.calls.length).toBe(afterFirstPage);
    expect(body.cached).toBe(true);
  });

  it("reports every source, including the ones it could not use", async () => {
    stubSources();
    const { body } = await get("scientificName=Panthera%20leo");

    const byId = Object.fromEntries(body.sources.map((s) => [s.id, s]));
    expect(byId.openalex.status).toBe("ok");
    expect(byId.bhl.status).toBe("unconfigured");
    expect(byId.bhl.note).toContain("BHL_API_KEY");
    // The pool holds 12 of the 200 works OpenAlex claims.
    expect(body.upstreamTotal).toBe(200);
    expect(body.poolTruncated).toBe(true);
  });

  it("still serves a timeline when a source fails", async () => {
    stubSources({ openAlexStatus: 500 });
    const { status, body } = await get("scientificName=Panthera%20leo");

    expect(status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.sources.find((s) => s.id === "openalex")?.status).toBe("error");
  });

  it("passes the assessment id through to the reference-list source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const respond = (data: unknown) =>
          ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
        if (url.includes("api.openalex.org")) return respond({ meta: { count: 0 }, results: [] });
        if (url.includes("zenodo.org")) return respond({ hits: { total: 0, hits: [] } });
        if (url.includes("api.iucnredlist.org/api/v4/assessment/98765")) {
          return respond({
            url: "https://www.iucnredlist.org/species/1/2",
            references: [{ title: "A cited field study", year: "1994", author: "B Two" }],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { body } = await get("scientificName=Panthera%20leo&assessmentId=98765");

    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe("A cited field study");
    expect(body.sources.find((s) => s.id === "redlist")?.status).toBe("ok");
  });

  it("searches the Latin gender variants too", async () => {
    stubSources();
    const { body } = await get("scientificName=Stenocephalemys%20albocaudata");
    expect(body.nameVariants).toContain("Stenocephalemys albocaudatus");
  });

  it("sets an edge cache header", async () => {
    stubSources();
    const response = await GET(
      new NextRequest("http://localhost/api/literature?scientificName=Panthera%20leo"),
    );
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=3600");
  });
});
