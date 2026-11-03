import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeColumns, encodeColumns, type SpeciesListManifest } from "../format";

describe("columnar species-list format", () => {
  it("round-trips assessed rows, keeping nulls and empty arrays as they were", () => {
    const rows = [
      { species_key: "sis-1", col_id: null, countries: ["GB", "FR"], previous_assessments: [], possibly_extinct: false, gbif_occurrence_count: 7 },
      { species_key: "sis-2", col_id: null, countries: [], previous_assessments: [], possibly_extinct: true, gbif_occurrence_count: null },
    ];
    const decoded = decodeColumns(JSON.parse(JSON.stringify(encodeColumns(rows))));
    expect(decoded).toEqual(rows);
    expect(Object.keys(decoded[0])).toEqual(Object.keys(rows[0])); // same key order as the API
  });

  it("leaves a key absent (not null) on rows that never had it", () => {
    const rows = [{ a: 1, b: null }, { a: 2 }];
    const decoded = decodeColumns<Record<string, unknown>>(JSON.parse(JSON.stringify(encodeColumns(rows))));
    expect(decoded[0]).toEqual({ a: 1, b: null });
    expect("b" in decoded[1]).toBe(false);
  });

  it("refuses a format version it doesn't know", () => {
    expect(() => decodeColumns({ v: 2, n: 0, keys: [], cols: [] } as never)).toThrow(/v2/);
  });
});

// ─── Loader ──────────────────────────────────────────────────────────────

const SYNC = "2026-11-02T09-47-21Z";
const group = (assessed: number, ne: number, names: string[]) => ({
  assessed: { rows: assessed, bytes: assessed * 10 },
  ne: { rows: ne, bytes: ne * 10 },
  names,
});
const MANIFEST: SpeciesListManifest = {
  v: 1,
  sync: SYNC,
  groups: {
    mammals: group(2, 1, ["mammalia", "rodentia"]),
    beetles: group(1, 300_000, ["insecta", "coleoptera"]),
    butterflies_and_moths: group(1, 200_000, ["insecta", "lepidoptera"]),
    flowering_plants: group(3, 5, ["magnoliopsida", "fabales"]),
  },
};
const fileBody = (group: string, kind: string) =>
  encodeColumns([{ species_key: `${group}-${kind}-1`, taxon_group: group, category: kind === "ne" ? "NE" : "LC" }]);

type Loader = typeof import("../loader");
let loader: Loader;
let requested: string[];
let pending: Map<string, () => void>;

/** fetch stub: the manifest answers at once; group files resolve only when `release(name)` is called. */
function stubFetch({ manifest = MANIFEST as SpeciesListManifest | null } = {}) {
  requested = [];
  pending = new Map();
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const name = url.split("/").pop()!;
    if (name === "manifest.json") {
      return Promise.resolve(manifest ? new Response(JSON.stringify(manifest)) : new Response("", { status: 404 }));
    }
    requested.push(name);
    const [g, kind] = name.split(".");
    return new Promise<Response>((resolve) => pending.set(name, () => resolve(new Response(JSON.stringify(fileBody(g, kind))))));
  }));
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const release = async (name: string) => { pending.get(name)!(); pending.delete(name); await flush(); await flush(); };

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SPECIES_LISTS_SYNC", SYNC);
  loader = await import("../loader");
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("groupsForTaxon", () => {
  it("maps 'all', static nodes, and dynamic nodes to the groups they need", () => {
    expect(loader.groupsForTaxon("all", MANIFEST)?.sort()).toEqual(Object.keys(MANIFEST.groups).sort());
    expect(loader.groupsForTaxon("mammals", MANIFEST)).toEqual(["mammals"]);
    expect(loader.groupsForTaxon("mammalia", MANIFEST)).toEqual(["mammals"]); // legacy alias
    // A dynamic node is its root's groups, narrowed by the order it pins.
    expect(loader.groupsForTaxon("insects~order:coleoptera", MANIFEST)).toEqual(["beetles"]);
    expect(loader.groupsForTaxon("mammals~order:rodentia~family:muridae", MANIFEST)).toEqual(["mammals"]);
  });

  it("returns null for an arbitrary rank the files can't place", () => {
    expect(loader.groupsForTaxon("turdidae", MANIFEST)).toBeNull();
  });
});

describe("speciesEntryFromFiles", () => {
  it("answers a request from the group files", async () => {
    const p = loader.speciesEntryFromFiles("/api/redlist/species?taxon=mammals");
    await flush();
    expect(requested).toEqual(["mammals.assessed.json.br"]);
    await release("mammals.assessed.json.br");
    const entry = await p;
    expect(entry?.species.map((s) => s.species_key)).toEqual(["mammals-assessed-1"]);
    expect(entry?.tooLarge).toBe(false);
  });

  it("flags tooLarge from the manifest without downloading anything", async () => {
    const entry = await loader.speciesEntryFromFiles("/api/redlist/species?taxon=insects&category=NE");
    expect(entry).toMatchObject({ species: [], tooLarge: true, neTotal: 500_000 });
    expect(requested).toEqual([]);
  });

  it("returns null (route fallback) when this deployment has no files", async () => {
    stubFetch({ manifest: null });
    expect(await loader.speciesEntryFromFiles("/api/redlist/species?taxon=mammals")).toBeNull();
  });

  it("returns null for a taxon the files can't answer", async () => {
    expect(await loader.speciesEntryFromFiles("/api/redlist/species?taxon=turdidae")).toBeNull();
  });
});

describe("prefetch queue", () => {
  it("downloads low-priority files one at a time", async () => {
    loader.loadGroup("mammals", "assessed", "low");
    loader.loadGroup("beetles", "assessed", "low");
    await flush();
    expect(requested).toEqual(["mammals.assessed.json.br"]);
    await release("mammals.assessed.json.br");
    expect(requested).toEqual(["mammals.assessed.json.br", "beetles.assessed.json.br"]);
  });

  it("starts a click at once and holds the queue until it lands", async () => {
    loader.loadGroup("mammals", "assessed", "low");
    loader.loadGroup("beetles", "assessed", "low");
    await flush();
    loader.loadGroup("flowering_plants", "ne", "high");
    await flush();
    expect(requested).toEqual(["mammals.assessed.json.br", "flowering_plants.ne.json.br"]);
    await release("mammals.assessed.json.br");
    expect(requested).not.toContain("beetles.assessed.json.br"); // still paused behind the click
    await release("flowering_plants.ne.json.br");
    expect(requested).toContain("beetles.assessed.json.br");
  });

  it("promotes a queued file the user asks for, and never downloads it twice", async () => {
    loader.loadGroup("mammals", "assessed", "low");
    const queued = loader.loadGroup("beetles", "assessed", "low");
    await flush();
    const clicked = loader.loadGroup("beetles", "assessed", "high");
    await flush();
    expect(clicked).toBe(queued);
    expect(requested).toEqual(["mammals.assessed.json.br", "beetles.assessed.json.br"]);
    await release("beetles.assessed.json.br");
    await release("mammals.assessed.json.br");
    expect(requested.filter((r) => r === "beetles.assessed.json.br")).toHaveLength(1);
  });

  it("lets a later request retry a file that failed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 404 }))));
    await expect(loader.loadGroup("mammals", "assessed", "high")).rejects.toThrow(/404/);
    stubFetch();
    const retry = loader.loadGroup("mammals", "assessed", "high");
    await flush();
    expect(requested).toEqual(["mammals.assessed.json.br"]);
    await release("mammals.assessed.json.br");
    await expect(retry).resolves.toHaveLength(1);
  });
});

describe("prefetchAllowed", () => {
  it("is off on cellular and data-saver connections", () => {
    vi.stubGlobal("navigator", { connection: { type: "cellular" } });
    expect(loader.prefetchAllowed()).toBe(false);
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    expect(loader.prefetchAllowed()).toBe(false);
    vi.stubGlobal("navigator", { connection: { type: "wifi", effectiveType: "4g" } });
    expect(loader.prefetchAllowed()).toBe(true);
    vi.stubGlobal("navigator", {}); // Safari/Firefox: no Network Information API → allowed
    expect(loader.prefetchAllowed()).toBe(true);
  });
});
