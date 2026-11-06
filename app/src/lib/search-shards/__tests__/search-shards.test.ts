import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeColumns } from "@/lib/species-lists/format";
import { hexKey, prefixKey, type SearchShard, type SearchShardManifest } from "../format";
import { dedupeByRowKey, rankSpecies, rankTaxa, type ShardSpeciesRow, type ShardTaxonRow } from "../rank";

const row = (n: string, sci: string, common: string | null, key: string, gbif = 0): ShardSpeciesRow => ({
  n, sl: sci.toLowerCase(), cl: common?.toLowerCase() ?? null,
  species_key: key as ShardSpeciesRow["species_key"], sis_taxon_id: null, col_id: null,
  scientific_name: sci, common_name: common, taxon_id: "mammals", taxon_group: "mammals", category: "LC",
  gbif_species_key: null, gbif_georeferenced_records_count: gbif, assessment_id: null, assessment_date: null, countries: [],
  class_name: null, order_name: null, family: null, node_id: null,
});

describe("rankSpecies (the route's tier-0 ORDER BY)", () => {
  it("puts an exact common-name match first, then common-name prefixes, then scientific-name prefixes", () => {
    const rows = [
      row("lion's mane", "Cyanea capillata", "Lion's mane jellyfish", "sis-3"),
      row("lion", "Panthera leo", "Lion", "sis-1"),
      row("lionfish", "Pterois volitans", "Lionfish", "sis-2"),
      row("lionepha", "Lionepha erasa", null, "sis-4"),
    ];
    expect(rankSpecies(rows, "lion", 10).map((r) => r.species_key)).toEqual(["sis-1", "sis-3", "sis-2", "sis-4"]);
  });

  it("sorts a NULL common name after false, as DuckDB's NULLS LAST does", () => {
    const rows = [row("ab", "Abx", null, "sis-1"), row("ab", "Aby", "Zebra", "sis-2")];
    // Both fail (cl LIKE 'ab%'); NULL ranks below false, so the named one leads despite its later name.
    expect(rankSpecies(rows, "ab", 10).map((r) => r.species_key)).toEqual(["sis-2", "sis-1"]);
  });

  it("collapses one species reached by several names, keeping the best-observed row", () => {
    const rows = [row("panthera leo", "Panthera leo", "Lion", "sis-1", 5), row("panthera", "Panthera leo", "Lion", "sis-1", 9)];
    const out = rankSpecies(rows, "panthera", 10);
    expect(out).toHaveLength(1);
    expect(out[0].gbif_georeferenced_records_count).toBe(9);
    expect(out[0]).not.toHaveProperty("n"); // internal sort keys never leak into results
  });

  it("dedupeByRowKey never collapses rows without a key", () => {
    const hits = [{ species_key: null, gbif_georeferenced_records_count: 1 }, { species_key: null, gbif_georeferenced_records_count: 2 }];
    expect(dedupeByRowKey(hits as never)).toHaveLength(2);
  });
});

describe("rankTaxa (suggestTaxa's tiers and slots)", () => {
  const t = (name: string, rp: number, taxon = name, common: string | null = null): ShardTaxonRow =>
    ({ name, rp, rank: (["class", "order", "family", "genus"] as const)[rp], nodeId: `n-${taxon}`, taxon, common });

  it("reserves a slot for the best genus, and puts an exact match first", () => {
    const rows = [t("ursidae", 2), t("ursus", 3), t("urs", 3), t("ursinia", 3)];
    expect(rankTaxa(rows, "urs").map((s) => s.taxon)).toEqual(["urs", "ursidae", "ursus"]);
  });

  it("prettifies the name and carries the baked-in node id", () => {
    expect(rankTaxa([t("felidae", 2)], "fel")).toEqual([{ name: "Felidae", rank: "family", taxon: "felidae", nodeId: "n-felidae", common_name: null }]);
  });

  it("suggests a taxon by its common name, once even when both names match", () => {
    const rows = [t("adansonia", 3, "adansonia", "Baobabs"), t("baobabs", 3, "adansonia", "Baobabs"), t("adansoniaceae", 2)];
    expect(rankTaxa(rows, "baobab")).toEqual([{ name: "Adansonia", rank: "genus", taxon: "adansonia", nodeId: "n-adansonia", common_name: "Baobabs" }]);
    // "adans" reaches the genus through its own name; it is offered once, not twice.
    expect(rankTaxa(rows, "adans").map((s) => s.taxon)).toEqual(["adansoniaceae", "adansonia"]);
  });
});

describe("prefix keys", () => {
  it("counts code points, as DuckDB does, and hex-encodes UTF-8", () => {
    expect(prefixKey("panthera", 2)).toBe("pa");
    expect(prefixKey("é", 2)).toBeNull();
    expect(hexKey("pa")).toBe("7061");
    expect(hexKey("×a")).toBe("c39761");
  });
});

// ─── client ──────────────────────────────────────────────────────────────

const SYNC = "2026-11-02T09-47-21Z";
const shardFile = (complete: boolean, species: ShardSpeciesRow[], taxa: ShardTaxonRow[] = [], p3?: string[]): SearchShard =>
  ({ v: 1, complete, ...(p3 ? { p3 } : {}), species: encodeColumns(species as never), taxa: encodeColumns(taxa as never) });
const files: Record<string, unknown> = {
  "manifest.json": { v: 1, sync: SYNC, p2: { li: true, pa: false } } satisfies SearchShardManifest,
  [`p2/${hexKey("li")}.json.br`]: shardFile(true, [row("lion", "Panthera leo", "Lion", "sis-1")]),
  [`p2/${hexKey("pa")}.json.br`]: shardFile(false, [row("pa", "Pa x", null, "sis-9")], [], ["pan"]),
  [`p3/${hexKey("pan")}.json.br`]: shardFile(true, [row("panthera", "Panthera leo", "Lion", "sis-1")]),
};
let fetched: string[];
let client: typeof import("../client");

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SPECIES_LISTS_SYNC", SYNC);
  fetched = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(url);
    const name = url.replace(`/prebuilt/${SYNC}/search-shards/`, "");
    if (url.startsWith("/api/search")) return new Response(JSON.stringify({ results: [{ species_key: "route" }], taxa: [] }));
    return name in files ? new Response(JSON.stringify(files[name])) : new Response("", { status: 404 });
  }));
  client = await import("../client");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("search (shards first, route fallback)", () => {
  it("answers from a complete two-letter shard, with no request for later keystrokes", async () => {
    expect((await client.search("li")).results.map((r) => r.species_key)).toEqual(["sis-1"]);
    const before = fetched.length;
    expect((await client.search("lion")).results.map((r) => r.species_key)).toEqual(["sis-1"]);
    expect(fetched.length).toBe(before); // same shard, no new fetch
  });

  it("uses the three-letter shard under a split prefix", async () => {
    expect((await client.search("pant")).results.map((r) => r.species_key)).toEqual(["sis-1"]);
    expect(fetched.some((u) => u.includes(`p3/${hexKey("pan")}`))).toBe(true);
  });

  it("falls back to the route when no indexed name starts with the query", async () => {
    expect((await client.search("zz")).results).toEqual([{ species_key: "route" }]); // no shard at all
    expect((await client.search("pax")).results).toEqual([{ species_key: "route" }]); // no p3 file
    expect((await client.search("lix")).results).toEqual([{ species_key: "route" }]); // shard, no prefix hit
  });

  it("answers a one-character query with nothing, like the route", async () => {
    expect(await client.search("p")).toEqual({ results: [], taxa: [] });
    expect(fetched).toEqual([]);
  });
});
