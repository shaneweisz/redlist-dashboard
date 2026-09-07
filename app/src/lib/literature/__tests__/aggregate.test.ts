import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearLiteratureCache, getLiteraturePool, SOURCES } from "../aggregate";

/**
 * These exercise the fan-out end to end with a routed `fetch` mock: the real
 * adapters run, so this covers the parts that only show up once several sources
 * are in play — cross-source dedupe, per-source reporting, caching and
 * in-flight coalescing.
 */

const OPENALEX_WORK = {
  id: "https://openalex.org/W1",
  doi: "https://doi.org/10.1234/shared",
  title: "Lions of the Serengeti",
  publication_year: 2021,
  publication_date: "2021-04-02",
  cited_by_count: 7,
  type: "article",
  primary_location: { source: { display_name: "Oryx" } },
};

const ZENODO_SHARED = {
  id: 555,
  doi: "10.1234/SHARED",
  links: { self_html: "https://zenodo.org/records/555" },
  metadata: {
    title: "Lions of the Serengeti",
    publication_date: "2021-04-02",
    description: "An abstract only Zenodo has.",
    resource_type: { type: "publication" },
  },
};

const ZENODO_UNIQUE = {
  id: 556,
  doi: "10.1234/other",
  links: { self_html: "https://zenodo.org/records/556" },
  metadata: {
    title: "An older note on lions",
    publication_date: "2005-02-01",
    resource_type: { type: "publication" },
  },
};

interface RouteOptions {
  openAlexStatus?: number;
  zenodoStatus?: number;
}

function routedFetch(options: RouteOptions = {}) {
  return vi.fn(async (url: string) => {
    const respond = (data: unknown, status = 200) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => data }) as unknown as Response;

    if (url.includes("api.openalex.org")) {
      if (options.openAlexStatus) return respond({}, options.openAlexStatus);
      return respond({ meta: { count: 40 }, results: [OPENALEX_WORK] });
    }
    if (url.includes("zenodo.org")) {
      if (options.zenodoStatus) return respond({}, options.zenodoStatus);
      return respond({ hits: { total: 12, hits: [ZENODO_SHARED, ZENODO_UNIQUE] } });
    }
    if (url.includes("api.iucnredlist.org")) {
      return respond({ url: "https://www.iucnredlist.org/species/1/2", references: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  clearLiteratureCache();
  // Key-gated sources stay off, so only the keyless ones make requests.
  delete process.env.BHL_API_KEY;
  delete process.env.CORE_API_KEY;
  delete process.env.GOOGLE_BOOKS_API_KEY;
  process.env.RED_LIST_API_KEY = "test-redlist-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getLiteraturePool", () => {
  it("merges across sources and reports each one", async () => {
    vi.stubGlobal("fetch", routedFetch());

    const { pool, cached } = await getLiteraturePool("Panthera leo");

    expect(cached).toBe(false);
    // The shared DOI collapses two records into one, newest first.
    expect(pool.works.map((w) => w.title)).toEqual([
      "Lions of the Serengeti",
      "An older note on lions",
    ]);
    expect(pool.works[0].sources.map((s) => s.id)).toEqual(["openalex", "zenodo"]);
    // Each source's best contribution survives the merge.
    expect(pool.works[0].citations).toBe(7);
    expect(pool.works[0].abstract).toBe("An abstract only Zenodo has.");
    expect(pool.works[0].venue).toBe("Oryx");

    expect(pool.sources).toHaveLength(SOURCES.length);
    expect(pool.sources.map((s) => [s.id, s.status])).toEqual([
      ["openalex", "ok"],
      ["zenodo", "ok"],
      ["core", "unconfigured"],
      ["bhl", "unconfigured"],
      ["googlebooks", "unconfigured"],
      // No assessment id was given, so there is no reference list to read.
      ["redlist", "ok"],
    ]);
    expect(pool.sources[0]).toMatchObject({ fetched: 1, upstreamTotal: 40 });
    expect(pool.sources[1]).toMatchObject({ fetched: 2, upstreamTotal: 12 });
  });

  it("reads the assessment's reference list when given an assessment id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const respond = (data: unknown) =>
          ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
        if (url.includes("api.iucnredlist.org")) {
          return respond({
            url: "https://www.iucnredlist.org/species/1/2",
            references: [
              // Same work OpenAlex returned: it must merge, not duplicate.
              { title: "Lions of the Serengeti", year: "2021", author: "A One" },
              { title: "A 1994 field study", year: "1994", author: "B Two" },
            ],
          });
        }
        if (url.includes("api.openalex.org")) {
          return respond({ meta: { count: 40 }, results: [OPENALEX_WORK] });
        }
        return respond({ hits: { total: 0, hits: [] } });
      }),
    );

    const { pool } = await getLiteraturePool("Panthera leo", "12345");

    expect(pool.assessmentId).toBe("12345");
    expect(pool.works).toHaveLength(2);
    // The cited paper carries both tags; that is the whole point of the source.
    expect(pool.works[0].sources.map((s) => s.id)).toEqual(["openalex", "redlist"]);
    // A reference nothing else returned still appears, in date order.
    expect(pool.works[1]).toMatchObject({ title: "A 1994 field study", year: 1994 });
    expect(pool.sources.find((s) => s.id === "redlist")).toMatchObject({
      status: "ok",
      fetched: 2,
    });
  });

  it("keys the cache on the assessment id, not just the name", async () => {
    const fetchSpy = routedFetch();
    vi.stubGlobal("fetch", fetchSpy);

    await getLiteraturePool("Panthera leo", "111");
    const afterFirst = fetchSpy.mock.calls.length;
    // Same species, different assessment — the reference list differs, so this
    // must not be served from the first pool.
    expect((await getLiteraturePool("Panthera leo", "222")).cached).toBe(false);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("includes the Latin gender variants in the query", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const { pool } = await getLiteraturePool("Stenocephalemys albocaudata");
    expect(pool.nameVariants).toContain("Stenocephalemys albocaudata");
    expect(pool.nameVariants).toContain("Stenocephalemys albocaudatus");
  });

  it("serves a repeat request from cache without touching the network", async () => {
    const fetchSpy = routedFetch();
    vi.stubGlobal("fetch", fetchSpy);

    await getLiteraturePool("Panthera leo");
    const callsAfterFirst = fetchSpy.mock.calls.length;
    const second = await getLiteraturePool("Panthera leo");

    expect(second.cached).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("is case- and whitespace-insensitive when caching", async () => {
    const fetchSpy = routedFetch();
    vi.stubGlobal("fetch", fetchSpy);

    await getLiteraturePool("Panthera leo");
    const calls = fetchSpy.mock.calls.length;
    expect((await getLiteraturePool("  panthera LEO ")).cached).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it("coalesces concurrent requests for the same species into one fan-out", async () => {
    const fetchSpy = routedFetch();
    vi.stubGlobal("fetch", fetchSpy);

    const [a, b, c] = await Promise.all([
      getLiteraturePool("Panthera leo"),
      getLiteraturePool("Panthera leo"),
      getLiteraturePool("Panthera leo"),
    ]);

    // Two keyless searches, queried once between the three callers. (The Red
    // List source makes no request without an assessment id.)
    expect(fetchSpy.mock.calls.length).toBe(2);
    expect(a.pool.works).toBe(b.pool.works);
    expect(b.pool.works).toBe(c.pool.works);
  });

  it("degrades a failing source instead of failing the whole pool", async () => {
    vi.stubGlobal("fetch", routedFetch({ openAlexStatus: 500 }));

    const { pool } = await getLiteraturePool("Panthera leo");

    expect(pool.sources.find((s) => s.id === "openalex")).toMatchObject({
      status: "error",
      fetched: 0,
    });
    // Zenodo's two records still make it through.
    expect(pool.works).toHaveLength(2);
  });

  it("gives a slow source its own clock and still returns the rest", async () => {
    // OpenAlex hangs; the others answer. Its budget must expire on its own
    // without capping the sources that were ready in time.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
        const respond = (data: unknown) =>
          ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
        if (url.includes("api.openalex.org")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
        }
        if (url.includes("zenodo.org")) {
          return respond({ hits: { total: 1, hits: [ZENODO_UNIQUE] } });
        }
        return respond({ references: [] });
      }),
    );

    // Fake timers so the 8s budget elapses instantly rather than in real time.
    vi.useFakeTimers();
    let pool;
    try {
      const pending = getLiteraturePool("Panthera leo");
      await vi.advanceTimersByTimeAsync(9_000);
      ({ pool } = await pending);
    } finally {
      vi.useRealTimers();
    }

    expect(pool.sources.find((s) => s.id === "openalex")).toMatchObject({
      status: "error",
      note: "Timed out",
    });
    expect(pool.works.map((w) => w.title)).toEqual(["An older note on lions"]);
  });

  it("declares a longer budget for the source that needs one", () => {
    // BHL measured 8.5s against the live API; at the 8s default it was timing
    // out often enough to be effectively absent.
    const byId = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
    expect(byId.bhl.timeoutMs).toBeGreaterThan(8_000);
    expect(byId.openalex.timeoutMs).toBeUndefined();
  });

  it("retries a throttled source sooner than a healthy one", async () => {
    // A rate limit shortens the TTL, so the gap doesn't stick for six hours.
    vi.useFakeTimers();
    try {
      const fetchSpy = routedFetch({ zenodoStatus: 429 });
      vi.stubGlobal("fetch", fetchSpy);

      await getLiteraturePool("Panthera leo");
      const callsAfterFirst = fetchSpy.mock.calls.length;

      vi.advanceTimersByTime(11 * 60 * 1000);
      const second = await getLiteraturePool("Panthera leo");

      expect(second.cached).toBe(false);
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});
