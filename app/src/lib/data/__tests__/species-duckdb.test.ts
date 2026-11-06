import { describe, it, expect, vi } from "vitest";

// nodeIdForSpecies only needs each group's Not Evaluated count, which it reads
// from the sync's taxa-summary.json. A fixed one keeps these tests off the data
// (CI has none): insects far over NE_CAP, the rest well under it.
vi.mock("@/lib/data/species-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/species-store")>()),
  getTaxaSummary: () => [
    { table1a_taxon_group: "beetles", col_ne: 900_000 },
    { table1a_taxon_group: "velvet_worms", col_ne: 200 },
    { table1a_taxon_group: "molluscs", col_ne: 60_000 },
  ],
}));

import { resolveWhere, toSpeciesRow, nodeIdForSpecies } from "@/lib/data/species-duckdb";
import { speciesRowKey, parseSpeciesRowKey, parseSpeciesParam, migratePinnedSpecies } from "@/lib/species-row-key";

// Unit tests for the parity-critical pure logic of the DuckDB read layer (#261):
// the taxon→SQL resolver and the row→SpeciesRow mapping. (Full v1-vs-v2 parity is
// verified manually against the live data — it can't run in CI without the R2 data.)

describe("resolveWhere", () => {
  it("returns no predicate for 'all'", () => {
    expect(resolveWhere("all")).toEqual({ clauses: [], params: {} });
  });

  it("filters a taxonomy node by its taxonGroups", () => {
    const w = resolveWhere("mammals");
    expect(w.clauses).toEqual(["taxon_group = ANY(string_split($g, '|'))"]);
    expect(w.params.g).toBe("mammals");
  });

  it("expands a virtual node to all its taxonGroups", () => {
    const groups = resolveWhere("insecta").params.g.split("|");
    expect(groups).toContain("beetles");
    expect(groups).toContain("other_insects");
    expect(groups).toHaveLength(8);
  });

  it("canonicalizes a legacy alias before resolving (mammalia → mammals)", () => {
    expect(resolveWhere("mammalia").params.g).toBe("mammals");
  });

  it("matches an arbitrary rank (non-node) at class/order/family/genus", () => {
    const w = resolveWhere("turdidae");
    expect(w.clauses).toEqual([
      "(class_name = $arv OR order_name = $arv OR family = $arv OR lower(split_part(scientific_name, ' ', 1)) = $arv)",
    ]);
    expect(w.params.arv).toBe("turdidae");
  });

  // No parquet carries a genus column — it is the leading word of the binomial, derived
  // the same way taxonomy-sql.ts's filterToSql derives a node's `genera` filter. Without
  // this branch, ?taxa=panthera compared "panthera" against class/order/family only and
  // returned an empty view, which is why suggestTaxa used to refuse to offer genus hits.
  it("matches a genus (no genus column exists) off the scientific name", () => {
    const w = resolveWhere("panthera");
    expect(w.clauses[0]).toContain("lower(split_part(scientific_name, ' ', 1)) = $arv");
    expect(w.params.arv).toBe("panthera");
  });

  it("lowercases arbitrary values", () => {
    expect(resolveWhere("Turdidae").params.arv).toBe("turdidae");
    expect(resolveWhere("Panthera").params.arv).toBe("panthera");
  });
});

// Regression coverage for a real reported bug: querySpecies' NE branch used to assign
// each row a synthetic id from a counter that RESET on every single query (per-taxon
// fetch) — so the same species got a DIFFERENT id depending on which taxon scope it was
// fetched through, while two UNRELATED species from two different queries could easily
// land on the identical counter value. RedListView.tsx's client-side speciesDetails
// cache is keyed purely by that key and never revalidates an existing entry, so the
// second species silently rendered under the first's cached iNaturalist photo/common
// name (a Giraffe's cached thumbnail showing for Fictidomys parvidens after drilling
// from Mammals into Rodentia — the Giraffe's query-local id and the squirrel's
// query-local id collided). Hashing col_id fixed it; keying on col_id itself makes the
// property hold by construction — the key IS the identity, so it cannot vary by query.
describe("speciesRowKey", () => {
  it("keys an assessed species on its SIS id", () => {
    expect(speciesRowKey({ sis_taxon_id: 18, col_id: null })).toBe("sis-18");
  });

  it("keys a Not Evaluated species on its CoL id", () => {
    expect(speciesRowKey({ sis_taxon_id: null, col_id: "3LLS" })).toBe("col-3LLS");
  });

  it("is stable: the same species always gets the same key, whatever query produced it", () => {
    expect(speciesRowKey({ col_id: "3LLS" })).toBe(speciesRowKey({ col_id: "3LLS" }));
  });

  it("gives different species different keys", () => {
    const keys = new Set(["3LLS", "6255W", "3Z5", "KTYZ7", "B3FVX"].map((c) => speciesRowKey({ col_id: c })));
    expect(keys.size).toBe(5);
  });

  it("prefers the SIS id, so a species keeps its key when a CoL link appears", () => {
    expect(speciesRowKey({ sis_taxon_id: 18, col_id: "3LLS" })).toBe("sis-18");
  });

  it("is null for a species with neither id (no row can address it)", () => {
    expect(speciesRowKey({ sis_taxon_id: null, col_id: null })).toBeNull();
  });

  it("never collides across the two namespaces, even for an all-digit CoL id", () => {
    expect(speciesRowKey({ col_id: "176168" })).not.toBe(speciesRowKey({ sis_taxon_id: 176168 }));
  });
});

describe("parseSpeciesRowKey", () => {
  it("round-trips both namespaces", () => {
    expect(parseSpeciesRowKey("sis-176168")).toEqual({ kind: "sis", sisTaxonId: 176168 });
    expect(parseSpeciesRowKey("col-6CX6F")).toEqual({ kind: "col", colId: "6CX6F" });
  });

  it("rejects anything outside them", () => {
    for (const bad of [null, undefined, "", "176168", "sis-", "col-", "gbif-5"]) {
      expect(parseSpeciesRowKey(bad)).toBeNull();
    }
  });
});

// Links written before the key was namespaced carry a bare number.
describe("parseSpeciesParam", () => {
  it("reads a namespaced key as-is", () => {
    expect(parseSpeciesParam("col-6CX6F")).toBe("col-6CX6F");
  });

  it("upgrades a legacy positive id (a SIS id) so old links still resolve", () => {
    expect(parseSpeciesParam("176168")).toBe("sis-176168");
  });

  it("drops a legacy negative id — it was a one-way hash, so guessing risks the wrong species", () => {
    expect(parseSpeciesParam("-1938472651")).toBeNull();
  });
});

describe("migratePinnedSpecies", () => {
  it("keeps assessed pins, drops un-invertible hash pins, passes new keys through", () => {
    expect(migratePinnedSpecies([176168, -1938472651, "col-6CX6F"])).toEqual(["sis-176168", "col-6CX6F"]);
  });

  it("survives absent or corrupt storage", () => {
    expect(migratePinnedSpecies(null)).toEqual([]);
    expect(migratePinnedSpecies("nonsense")).toEqual([]);
  });
});

describe("toSpeciesRow", () => {
  it("maps an assessed row: splits ';' arrays, numifies BigInts, carries latest assessors", () => {
    const row = toSpeciesRow({
      id: BigInt(18),
      assessment_id: BigInt(123456),
      scientific_name: "Aotus lemurinus",
      common_name: "Lemurine Night Monkey",
      family: "aotidae",
      category: "VU",
      assessment_date: "2016-03-01",
      year_published: "2018",
      population_trend: "Decreasing",
      countries: "CO;EC",
      class_name: "mammalia",
      order_name: "primates",
      taxon_group: "mammals",
      gbif_species_key: BigInt(2436503),
      gbif_georeferenced_records_count: BigInt(1273),
      gbif_georeferenced_records_since_assessment: BigInt(42),
      systems: "Terrestrial",
      growth_forms: "",
      movement_pattern: null,
      possibly_extinct: false,
      possibly_extinct_in_the_wild: false,
      criteria: "A2c",
      threat_codes: "1.1;2.2.1",
      latest_assessors: "X, Y.",
      latest_reviewers: "Z, A.",
    });
    expect(row.sis_taxon_id).toBe(18);
    expect(row.species_key).toBe("sis-18");
    expect(row.assessment_id).toBe(123456);
    expect(row.countries).toEqual(["CO", "EC"]);
    expect(row.systems).toEqual(["Terrestrial"]);
    expect(row.growth_forms).toEqual([]);
    expect(row.threat_codes).toEqual(["1.1", "2.2.1"]);
    expect(row.gbif_georeferenced_records_count).toBe(1273);
    expect(row.gbif_georeferenced_records_since_assessment).toBe(42);
    expect(row.taxon_id).toBe("mammals"); // mapTaxonId fallthrough (display root)
    // latest assessors/reviewers are inline; full history is lazy (empty here).
    expect(row.latest_assessors).toBe("X, Y.");
    expect(row.latest_reviewers).toBe("Z, A.");
    expect(row.previous_assessments).toEqual([]);
  });

  // toSpeciesRow is the assessed path only — Not Evaluated rows are built inline by
  // querySpecies' NE branch (they come from a different parquet with a slimmer schema),
  // so what matters here is that a row missing every assessment-only column degrades to
  // empty rather than throwing.
  it("maps a row with no assessment columns: empty history, group → invertebrates", () => {
    const row = toSpeciesRow({
      id: BigInt(99),
      scientific_name: "Beetlus novus",
      common_name: null,
      family: "x",
      category: "NE",
      countries: "",
      class_name: "insecta",
      order_name: "coleoptera",
      taxon_group: "beetles",
      gbif_species_key: BigInt(99),
      gbif_georeferenced_records_count: BigInt(5),
    });
    expect(row.previous_assessments).toEqual([]);
    expect(row.taxon_id).toBe("invertebrates"); // mapTaxonId("beetles")
    expect(row.gbif_georeferenced_records_since_assessment).toBeNull();
  });
});

describe("nodeIdForSpecies", () => {
  const butterfly = { class_name: "insecta", order_name: "lepidoptera", family: "nymphalidae" };

  it("drills to the species' family", () => {
    expect(nodeIdForSpecies("butterflies_and_moths", butterfly))
      .toBe("inv-insects~order:lepidoptera~family:nymphalidae");
    expect(nodeIdForSpecies("mammals", { class_name: "mammalia", order_name: "carnivora", family: "felidae" }))
      .toBe("mammals~order:carnivora~family:felidae");
  });

  it("starts at class for a class-first root, skipping no rank", () => {
    expect(nodeIdForSpecies("molluscs", { class_name: "gastropoda", order_name: "littorinimorpha", family: "cypraeidae" }))
      .toBe("inv-molluscs~class:gastropoda~order:littorinimorpha~family:cypraeidae");
  });

  it("stops above a gap rather than showing an Unclassified rung", () => {
    // Velvet worms have no order in CoL; drilling to the family anyway would read
    // "Velvet Worms → Unclassified Order → Peripatidae".
    expect(nodeIdForSpecies("velvet_worms", { class_name: null, order_name: null, family: "peripatidae" }))
      .toBe("inv-velvet_worms");
    // A bivalve keeps the class it does have, and stops before the missing order.
    expect(nodeIdForSpecies("molluscs", { class_name: "bivalvia", order_name: null, family: "astartidae" }))
      .toBe("inv-molluscs~class:bivalvia");
  });

  it("accepts an Unclassified rung when the group's own node can't list the species", () => {
    // Insects is over NE_CAP, so stopping short would land on the drill-down prompt —
    // a gap is worth wearing to reach a node that can actually show the species.
    expect(nodeIdForSpecies("beetles", { class_name: "insecta", order_name: null, family: "coccinellidae" }))
      .toBe("inv-insects~order:~family:coccinellidae");
  });

  it("falls back to the group's own node when the species has no lineage at all", () => {
    expect(nodeIdForSpecies("beetles", {})).toBe("inv-insects");
    expect(nodeIdForSpecies("velvet_worms", {})).toBe("inv-velvet_worms");
  });

  it("never routes to a Specialist Group node — they hold a curated subset, not the group", () => {
    for (const [group, lineage] of [
      ["beetles", { class_name: "insecta", order_name: "coleoptera", family: "coccinellidae" }],
      ["dragonflies_and_damselflies", { class_name: "insecta", order_name: "odonata", family: "aeshnidae" }],
      ["reptiles", { class_name: "reptilia", order_name: "squamata", family: "dactyloidae" }],
    ] as const) {
      const id = nodeIdForSpecies(group, lineage);
      expect(id).not.toBeNull();
      expect(id!.startsWith("ssc-")).toBe(false); // "ssc-" is the id convention for them
    }
  });

  it("returns null for a group no taxonomy node covers", () => {
    expect(nodeIdForSpecies("not_a_real_group", butterfly)).toBeNull();
  });
});

/**
 * The mapping page's "exit fullscreen" link has to land on the species' own row
 * in the dashboard, which means producing the same key the row does.
 */
describe("getSpeciesByGbifKey row key", () => {
  it("keys an assessed species on its SIS id", () => {
    expect(speciesRowKey({ sis_taxon_id: 44393, col_id: "6CX6F" })).toBe("sis-44393");
  });

  it("keys a Not Evaluated species on its CoL id", () => {
    expect(speciesRowKey({ sis_taxon_id: null, col_id: "6CX6F" })).toBe("col-6CX6F");
  });

  // unassessed.parquet is one row per GBIF key, the NE list one row per col_id,
  // and 3,756 col_ids carry more than one GBIF key — so the key can't be built
  // from the GBIF key even though the two usually coincide.
  it("has no key for a species with neither identity", () => {
    expect(speciesRowKey({ sis_taxon_id: null, col_id: null })).toBeNull();
  });
});
