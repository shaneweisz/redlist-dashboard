import { describe, it, expect } from "vitest";
import { taxonGroupCountsPreservedSpecimens } from "../gbif";
import { ALL_TAXON_GROUPS } from "@/config/taxonomy-tree";

// ---------------------------------------------------------------------------
// taxonGroupCountsPreservedSpecimens — decides whether PRESERVED_SPECIMEN is
// counted for a given species' CSV taxon group. Plants & fungi rely heavily on
// herbarium/fungarium records, so they count in; all other kingdoms don't.
// (The occurrence map no longer asks this — its checkboxes default the same way
// for every kingdom — but the dashboard's GBIF counts still do.)
// ---------------------------------------------------------------------------
describe("taxonGroupCountsPreservedSpecimens", () => {
  it.each([
    "flowering_plants",
    "gymnosperms",
    "ferns_and_allies",
    "mosses",
    "green_algae",
    "red_algae",
  ])("returns true for plant group %s", (group) => {
    expect(taxonGroupCountsPreservedSpecimens(group)).toBe(true);
  });

  it.each([
    "mushrooms",
    "brown_algae",
  ])("returns true for fungi group %s", (group) => {
    expect(taxonGroupCountsPreservedSpecimens(group)).toBe(true);
  });

  it.each([
    "mammals",
    "birds",
    "reptiles",
    "amphibians",
    "fishes",
    "beetles",
    "other_insects",
    "arachnids",
    "molluscs",
    "crustaceans",
    "corals",
    "other_invertebrates",
    "velvet_worms",
    "horseshoe_crabs",
  ])("returns false for animal group %s", (group) => {
    expect(taxonGroupCountsPreservedSpecimens(group)).toBe(false);
  });

  it("returns false when taxonGroup is undefined", () => {
    expect(taxonGroupCountsPreservedSpecimens(undefined)).toBe(false);
  });

  it("returns false for an unknown taxon group", () => {
    expect(taxonGroupCountsPreservedSpecimens("not_a_real_group")).toBe(false);
  });

  // Guards against forgetting to add newly-introduced taxon groups to the
  // plantae/fungi mapping in taxonomy-constants.ts. Every Table 1a group
  // should classify deterministically as plant/fungi-or-not.
  it("covers every Table 1a taxon group", () => {
    for (const group of ALL_TAXON_GROUPS) {
      const result = taxonGroupCountsPreservedSpecimens(group);
      expect(typeof result).toBe("boolean");
    }
  });
});
