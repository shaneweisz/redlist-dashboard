import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { segmentMatches, summarizeChildren } from "@/lib/data/tree-children-build";
import type { TreeChildrenFile } from "../format";

const row = (cls: string, ord: string, fam = "", gen = "") => ({ cls, ord, fam, gen });

describe("segmentMatches mirrors filterToSql's per-segment predicate", () => {
  it("expands order aliases (CoL's Cetacea is IUCN's Artiodactyla)", () => {
    expect(segmentMatches(row("mammalia", "cetacea"), "order", "artiodactyla")).toBe(true);
    expect(segmentMatches(row("mammalia", "artiodactyla"), "order", "artiodactyla")).toBe(true);
    expect(segmentMatches(row("mammalia", "carnivora"), "order", "artiodactyla")).toBe(false);
  });

  it("falls back to class_name only when order_name is empty", () => {
    expect(segmentMatches(row("aves", ""), "order", "aves")).toBe(true);
    expect(segmentMatches(row("aves", "passeriformes"), "order", "aves")).toBe(false);
  });

  it("expands class aliases and keeps the canonical name", () => {
    expect(segmentMatches(row("elasmobranchii", ""), "class", "chondrichthyes")).toBe(true);
    expect(segmentMatches(row("chondrichthyes", ""), "class", "chondrichthyes")).toBe(true);
  });

  it("compares family and genus exactly, case-insensitively on the value", () => {
    expect(segmentMatches(row("", "", "felidae", "panthera"), "family", "Felidae")).toBe(true);
    expect(segmentMatches(row("", "", "felidae", "panthera"), "genus", "panthera")).toBe(true);
    expect(segmentMatches(row("", "", "felidae", "panthera"), "genus", "felis")).toBe(false);
  });
});

describe("summarizeChildren", () => {
  const bucket = (order: string) => ({ class: "mammalia", order, family: "", genus: "" });
  const a = (order: string, category: string | null, n: number, nOutdated = 0) =>
    ({ ...row("mammalia", order), bucket: bucket(order), src: "a" as const, category, n, nOutdated });
  const c = (order: string, colDescribed: number, colNe: number) =>
    ({ ...row("mammalia", order), bucket: bucket(order), src: "c" as const, colDescribed, colNe });

  it("aggregates both sides per bucket, sorts by assessed then name, and skips empty buckets", () => {
    const out = summarizeChildren("mammals", [], "order", [
      a("rodentia", "LC", 5, 1), a("rodentia", null, 3), c("rodentia", 10, 3),
      a("carnivora", "EN", 7), c("carnivora", 7, 0),
      c("ghostia", 0, 0), // in CoL's group-by, but nothing real survives the filters
      c("pholidota", 8, 8), // CoL-only: 0 assessed, still shown
    ]);
    expect(out.map((n) => n.id)).toEqual(["mammals~order:rodentia", "mammals~order:carnivora", "mammals~order:pholidota"]);
    expect(out[0]).toMatchObject({ totalAssessed: 8, outdated: 1, byCategory: { LC: 5, DD: 3 }, colDescribed: 10, colNe: 3 });
    expect(out[2]).toMatchObject({ totalAssessed: 0, colDescribed: 8, colNe: 8 });
  });
});

// ─── Loader ──────────────────────────────────────────────────────────────

const SYNC = "2026-11-02T09-47-21Z";
const FILE: TreeChildrenFile = {
  v: 1, sync: SYNC, root: "mammals",
  children: {
    mammals: [{ id: "mammals~order:rodentia", name: "Rodents", estimatedDescribed: 0, totalAssessed: 1, outdated: 0, gbifNeSpeciesCount: 0, byCategory: { LC: 1 } }],
  },
};
type Loader = typeof import("../loader");
let loader: Loader;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SPECIES_LISTS_SYNC", SYNC);
  loader = await import("../loader");
  fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(FILE))));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("treeChildrenFromFiles", () => {
  it("answers expands under a root from one shared download", async () => {
    expect(await loader.treeChildrenFromFiles("mammals")).toEqual(FILE.children.mammals);
    await loader.treeChildrenFromFiles("mammals~order:rodentia"); // not in this fixture → null, same file
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/species-lists/${SYNC}/tree/mammals.json.br`);
  });

  it("returns null (route fallback) for ids the file lacks, non-drilldown nodes, and missing files", async () => {
    expect(await loader.treeChildrenFromFiles("mammals~order:rodentia")).toBeNull();
    expect(await loader.treeChildrenFromFiles("ssc-orchid")).toBeNull();
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 404 })));
    expect(await loader.treeChildrenFromFiles("birds")).toBeNull();
  });

  it("answers a genus (a leaf) with no children, without downloading", async () => {
    expect(await loader.treeChildrenFromFiles("mammals~order:rodentia~family:muridae~genus:mus")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a root whose download failed", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    expect(await loader.treeChildrenFromFiles("mammals")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await loader.treeChildrenFromFiles("mammals")).toEqual(FILE.children.mammals);
  });
});
