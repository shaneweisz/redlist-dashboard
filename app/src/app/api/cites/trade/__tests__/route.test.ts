import { describe, it, expect, vi, beforeEach } from "vitest";
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

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

// The route fetches the history in year-windows, so a fetch mock must return
// only the rows whose Year falls inside the requested time range — otherwise
// every window would return the full set and rows would be duplicated.
function rangeAwareFetch(rows: Array<Record<string, unknown>>) {
  return vi.fn((url: string) => {
    const params = new URL(url).searchParams;
    const start = Number(params.get("filters[time_range_start]"));
    const end = Number(params.get("filters[time_range_end]"));
    const inRange = rows.filter((r) => {
      const y = r.Year as number;
      return y >= start && y <= end;
    });
    return Promise.resolve(
      jsonResponse({ shipment_comptab_export: { rows: inRange } })
    );
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTradeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    Year: 2023,
    "App.": "I",
    Taxon: "Manis gigantea",
    Importer: "US",
    Exporter: "CM",
    Origin: null,
    "Importer reported quantity": "10",
    "Exporter reported quantity": "8",
    Term: "specimens",
    Unit: null,
    Purpose: "S",
    Source: "W",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function importRoute() {
  return import("../route");
}

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/cites/trade");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/api/cites/trade", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("returns 400 when taxon_id is missing", async () => {
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/taxon_id must be a numeric value/);
  });

  it("returns 400 when taxon_id is not numeric", async () => {
    const { GET } = await importRoute();
    const res = await GET(makeRequest({ taxon_id: "abc" }));
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // CITES Trade DB errors
  // -------------------------------------------------------------------------

  it("propagates CITES Trade DB error status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 503)));
    const { GET } = await importRoute();
    const res = await GET(makeRequest({ taxon_id: "11136" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/CITES Trade DB error/);
  });

  // -------------------------------------------------------------------------
  // No data
  // -------------------------------------------------------------------------

  it("returns found:false when no trade rows exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ shipment_comptab_export: { rows: [] } })
      )
    );
    const { GET } = await importRoute();
    const res = await GET(makeRequest({ taxon_id: "11136" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.found).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Summarization
  // -------------------------------------------------------------------------

  it("returns every row compacted, with the year range", async () => {
    const rows = [
      makeTradeRow({ Year: 2022, Exporter: "CM", Importer: "US", Purpose: "S", Source: "W", Term: "specimens" }),
      makeTradeRow({ Year: 2022, Exporter: "CM", Importer: "DE", Purpose: "T", Source: "C", Term: "skins", Unit: "kg" }),
      makeTradeRow({ Year: 2023, Exporter: "GH", Importer: "US", Origin: "CM", Purpose: null, Source: null, Term: "specimens" }),
    ];

    vi.stubGlobal("fetch", rangeAwareFetch(rows));
    const { GET } = await importRoute();
    const res = await GET(makeRequest({ taxon_id: "11136" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.found).toBe(true);
    expect(body.yearRange).toEqual([2022, 2023]);
    expect(body.shipments).toHaveLength(3);
    expect(body.shipments[0]).toEqual({ y: 2022, s: "W", p: "S", t: "specimens", u: "", qe: 8, qi: 10, e: "CM", i: "US", o: "" });
    expect(body.shipments[1].u).toBe("kg");
    // A re-export keeps its origin; blank purpose/source become "".
    expect(body.shipments[2]).toEqual(expect.objectContaining({ o: "CM", p: "", s: "" }));
  });

  it("keeps the exporter's and importer's quantities apart", async () => {
    const rows = [
      makeTradeRow({ "Importer reported quantity": "20", "Exporter reported quantity": "15" }),
      makeTradeRow({ "Importer reported quantity": "20", "Exporter reported quantity": null }),
      makeTradeRow({ "Importer reported quantity": null, "Exporter reported quantity": "7" }),
      makeTradeRow({ "Importer reported quantity": null, "Exporter reported quantity": null }),
    ];

    vi.stubGlobal("fetch", rangeAwareFetch(rows));
    const { GET } = await importRoute();
    const res = await GET(makeRequest({ taxon_id: "11136" }));
    const body = await res.json();

    const q = body.shipments.map((r: { qe?: number; qi?: number }) => [r.qe, r.qi]);
    // A party that didn't report has no quantity at all, never the other party's.
    expect(q).toEqual([[15, 20], [undefined, 20], [7, undefined], [undefined, undefined]]);
  });

  // -------------------------------------------------------------------------
  // Caching
  // -------------------------------------------------------------------------

  it("caches results on repeated requests", async () => {
    const rows = [makeTradeRow()];
    const fetchMock = rangeAwareFetch(rows);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await importRoute();

    await GET(makeRequest({ taxon_id: "11136" }));
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // one request per year-window

    await GET(makeRequest({ taxon_id: "11136" }));
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst); // served from cache
  });
});
