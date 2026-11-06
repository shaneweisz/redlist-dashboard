import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest {
    nextUrl: URL;
    constructor(url: string) { this.nextUrl = new URL(url); }
  }
  return {
    NextRequest: MockNextRequest,
    NextResponse: {
      json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
        return { _body: body, status: init?.status ?? 200, async json() { return body; } };
      },
    },
  };
});
vi.mock("@/lib/cache-headers", () => ({ CACHE_1H: { "Cache-Control": "public, s-maxage=3600" } }));

const json = (data: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response);

/** A taxon payload shaped like ChecklistBank's, fields and all. */
const taxon = (over: Record<string, unknown> = {}) => ({
  id: "7FDLW",
  name: { scientificName: "Vallonia costata" },
  scrutinizer: "Bieler, Rüdiger",
  // Present upstream on every record, and deliberately never surfaced — see the
  // omission tests below.
  scrutinizerDate: "2019-08-13",
  sectorKey: 1302,
  link: "https://www.molluscabase.org/aphia.php?p=taxdetails&id=819969",
  ...over,
});
const SECTOR = { id: 1302, subjectDatasetKey: 1130 };
const SOURCE = { key: 1130, alias: "WoRMS Mollusca", title: "MolluscaBase", confidence: 4, completeness: 95 };

/** Fresh module per test: the route memoises sector/source lookups for the
 *  process, which is the point of them but would leak between cases. */
async function callRoute(url: string, fetchImpl: (u: string) => Promise<Response>) {
  vi.resetModules();
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { calls.push(String(u)); return fetchImpl(String(u)); }));
  const { GET } = await import("../route");
  const res = await GET(new NextRequest(url));
  return { body: (await res.json()) as Record<string, unknown>, status: res.status, calls };
}

const happyPath = async (u: string) =>
  u.includes("/sector/") ? json(SECTOR) : u.includes("/source/") ? json(SOURCE) : json(taxon());

const URL_BASE = "http://x/api/col/provenance";

describe("/api/col/provenance", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns the provenance CoL shows for a record", async () => {
    const { body } = await callRoute(`${URL_BASE}?colId=7FDLW`, happyPath);
    expect(body).toEqual({
      scrutinizer: "Bieler, Rüdiger",
      link: "https://www.molluscabase.org/aphia.php?p=taxdetails&id=819969",
      sourceAlias: "WoRMS Mollusca",
      sourceTitle: "MolluscaBase",
      sourceKey: 1130,
    });
  });

  // The three fields below are omitted on purpose, and each was removed after it
  // misled someone. They are cheap to re-add from the upstream payload, so the
  // reasoning is pinned here rather than left in a comment nobody reads first.
  it("never surfaces scrutinizerDate — it is a batch timestamp, not a review date", async () => {
    // ColDP defines it as when the concept was last reviewed by the scrutinizer.
    // In the data it is a source refresh: 18 consecutive mammal records shared
    // one date, including records with no scrutinizer at all, and CoL pairs
    // Dasycercus cristicauda with a 2025 date under Colin P. Groves, who died
    // in 2017. Rendered as "<person>, <date>" it states something untrue.
    const { body } = await callRoute(`${URL_BASE}?colId=7FDLW`, happyPath);
    expect(body).not.toHaveProperty("scrutinizerDate");
    expect(JSON.stringify(body)).not.toContain("2019-08-13");
  });

  it("never surfaces the source's confidence or completeness", async () => {
    // Both grade the DATASET. Printed beside one record they read as a verdict
    // on that record — and this tooltip exists because the record may be wrong.
    // CoL rates ITIS 5/5 while its Dasycercus treatment is three years behind.
    const { body } = await callRoute(`${URL_BASE}?colId=7FDLW`, happyPath);
    expect(body).not.toHaveProperty("confidence");
    expect(body).not.toHaveProperty("completeness");
  });

  it("resolves the source through the sector, and caches that hop", async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { calls.push(String(u)); return happyPath(String(u)); }));
    const { GET } = await import("../route");
    await GET(new NextRequest(`${URL_BASE}?colId=AAA`));
    await GET(new NextRequest(`${URL_BASE}?colId=BBB`));
    // Two taxa, but the sector and source are fetched once between them.
    expect(calls.filter((u) => u.includes("/taxon/"))).toHaveLength(2);
    expect(calls.filter((u) => u.includes("/sector/"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("/source/"))).toHaveLength(1);
  });

  it("degrades to an empty object when ChecklistBank fails, rather than erroring", async () => {
    // The tooltip renders the rest and omits the block; a 500 here would take
    // the whole panel down with it.
    const { body, status } = await callRoute(`${URL_BASE}?colId=7FDLW`, async () => json(null, 503));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it("omits a section CoL has nothing for", async () => {
    const noLink = async (u: string) =>
      u.includes("/sector/") ? json(SECTOR) : u.includes("/source/") ? json(SOURCE)
        : json(taxon({ link: undefined, scrutinizer: undefined }));
    const { body } = await callRoute(`${URL_BASE}?colId=7FDLW`, noLink);
    expect(body).not.toHaveProperty("link");
    expect(body).not.toHaveProperty("scrutinizer");
    expect(body.sourceTitle).toBe("MolluscaBase");
  });

  it("drops a World Plants deeplink, which 404s since that site's redesign", async () => {
    // CoL still carries ?deeplink= for every World Plants record (Aria
    // croceocarpa among them), and the new site has no per-species URL to
    // rewrite it to. The source name is kept.
    const worldPlants = async (u: string) =>
      u.includes("/sector/") ? json(SECTOR) : u.includes("/source/") ? json({ ...SOURCE, alias: "WP", title: "World Plants" })
        : json(taxon({ link: "http://www.worldplants.de/?deeplink=Aria-croceocarpa" }));
    const { body } = await callRoute(`${URL_BASE}?colId=V5C4M`, worldPlants);
    expect(body).not.toHaveProperty("link");
    expect(body.sourceTitle).toBe("World Plants");
  });

  it("survives a taxon with no sector to resolve", async () => {
    const noSector = async () => json(taxon({ sectorKey: undefined }));
    const { body, calls } = await callRoute(`${URL_BASE}?colId=7FDLW`, noSector);
    expect(body.scrutinizer).toBe("Bieler, Rüdiger");
    expect(body).not.toHaveProperty("sourceKey");
    expect(calls.filter((u) => u.includes("/sector/"))).toHaveLength(0);
  });

  it("rejects a colId that isn't one, without calling out", async () => {
    for (const bad of ["", "../etc", "a b", "x".repeat(21)]) {
      const { status, calls } = await callRoute(`${URL_BASE}?colId=${encodeURIComponent(bad)}`, happyPath);
      expect(status, `colId=${bad}`).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });
});
