import { describe, it, expect } from "vitest";
import {
  taxonGroups, groupKeyOf, groupNote, isClaimed, shapeSdf, shapeSvgPath, SHAPES, type ColFiling, type CountedTaxon,
} from "../occurrence-taxa-groups";
import { taxaFromLinkRows } from "@/lib/data/occurrence-taxa";

// Butorides striata: CoL splits it into B. striata and B. virescens (and holds
// B. virescens twice), and keeps the misspelling B. striatus as a synonym.
const butorides: CountedTaxon[] = [
  { key: "NZ6J", relation: "is", speciesKey: "NZ6J" },
  { key: "NZ6M", relation: "split into", speciesKey: "NZ6M" },
  { key: "VHFPC", relation: "split into", speciesKey: "VHFPC" },
];
const striata: ColFiling = { colUsageKey: "NZ6J", colUsageName: "Butorides striata", colStatus: "ACCEPTED", colSpeciesKey: "NZ6J", colSpeciesName: "Butorides striata" };
const striataSsp: ColFiling = { colUsageKey: "X1", colUsageName: "Butorides striata atricapilla", colStatus: "ACCEPTED", colSpeciesKey: "NZ6J", colSpeciesName: "Butorides striata", colPath: ["NZ6J"] };
const striatus: ColFiling = { colUsageKey: "NZ6K", colUsageName: "Butorides striatus (Linnaeus, 1758)", colStatus: "SYNONYM", colSpeciesKey: "NZ6J", colSpeciesName: "Butorides striata" };
const virescens: ColFiling = { colUsageKey: "NZ6M", colUsageName: "Butorides virescens", colStatus: "ACCEPTED", colSpeciesKey: "NZ6M", colSpeciesName: "Butorides virescens" };

// Pararge xiphioides: CoL files it under P. aegeria, and only its own name counts.
const pararge: CountedTaxon[] = [{ key: "946KG", relation: "part of", speciesKey: "75R3T" }];
const xiphioides: ColFiling = { colUsageKey: "946KG", colUsageName: "Pararge xiphioides Staudinger, 1871", colStatus: "SYNONYM", colSpeciesKey: "75R3T", colSpeciesName: "Pararge aegeria", colPath: ["75R3T"] };
const aegeria: ColFiling = { colUsageKey: "75R3T", colUsageName: "Pararge aegeria", colStatus: "ACCEPTED", colSpeciesKey: "75R3T", colSpeciesName: "Pararge aegeria", colPath: ["75R3T"] };

describe("groupKeyOf", () => {
  it("rolls a subspecies into its species, and keeps a synonym on its own", () => {
    expect(groupKeyOf(striataSsp)).toBe("species:NZ6J");
    expect(groupKeyOf(striatus)).toBe("name:NZ6K");
    expect(groupKeyOf({})).toBe("unfiled");
  });
});

describe("taxonGroups", () => {
  it("puts the species' own name first, its synonyms beside it, then the split's other species", () => {
    const records = [virescens, virescens, virescens, striata, striataSsp, striatus];
    const groups = taxonGroups(records, butorides);
    expect(groups.map((g) => [g.name, g.loaded, g.shape, g.relation])).toEqual([
      ["Butorides striata", 2, "circle", "is"],
      ["Butorides striatus (Linnaeus, 1758)", 1, "square", "is"],
      ["Butorides virescens", 3, "triangle", "split into"],
    ]);
    expect(groups[0].primary).toBe(true);
    expect(groupNote(groups[1])).toBe("synonym of Butorides striata, counted");
    expect(groupNote(groups[2])).toBe("CoL species split from it, counted");
    // Totals are by claimed taxon: the species' rows, not a synonym inside one.
    expect(groups.map((g) => g.taxonKey)).toEqual(["NZ6J", null, "NZ6M"]);
  });

  it("names a part-of record as the only part that counts", () => {
    const [g] = taxonGroups([xiphioides], pararge);
    expect(g).toMatchObject({ name: "Pararge xiphioides Staudinger, 1871", kind: "synonym", relation: "part of", taxonKey: "946KG", primary: true, shape: "circle" });
    expect(groupNote(g)).toBe("synonym of Pararge aegeria; only these count");
  });

  it("shares the last shape from the seventh name on", () => {
    const many = Array.from({ length: 8 }, (_, i): ColFiling => ({ colUsageKey: `S${i}`, colUsageName: `Name ${i}`, colStatus: "SYNONYM", colSpeciesKey: "NZ6J", colSpeciesName: "Butorides striata" }));
    const shapes = taxonGroups(many, butorides).map((g) => g.shape);
    expect(shapes.slice(0, 6)).toEqual([...SHAPES]);
    expect(shapes.slice(6)).toEqual(["star", "star"]);
  });
});

describe("isClaimed", () => {
  it("keeps the context to what the count leaves to the other species", () => {
    expect(isClaimed(xiphioides, pararge)).toBe(true);
    expect(isClaimed(aegeria, pararge)).toBe(false);
    expect(isClaimed(virescens, butorides)).toBe(true);
    expect(isClaimed(striataSsp, butorides)).toBe(true);
  });
});

describe("taxaFromLinkRows", () => {
  it("asks for the species of is and split into, and the record of part of", () => {
    expect(taxaFromLinkRows("NZ6J", [
      { relation: "split into", col_species_id: "NZ6M", col_taxon_id: "NZ6M" },
      { relation: "is", col_species_id: "NZ6J", col_taxon_id: "NZ6J" },
    ]).counted.map((t) => t.key)).toEqual(["NZ6J", "NZ6M"]);
    expect(taxaFromLinkRows("946KG", [{ relation: "part of", col_species_id: "75R3T", col_taxon_id: "946KG" }]))
      .toEqual({ counted: [{ key: "946KG", relation: "part of", speciesKey: "75R3T" }], context: ["75R3T"] });
  });

  it("falls back to the key alone for a species with no link rows (Not Evaluated)", () => {
    expect(taxaFromLinkRows("ABC", [])).toEqual({ counted: [{ key: "ABC", relation: "is", speciesKey: "ABC" }], context: [] });
  });

  it("has no context where the species is also counted whole", () => {
    expect(taxaFromLinkRows("A", [
      { relation: "is", col_species_id: "A", col_taxon_id: "A" },
      { relation: "part of", col_species_id: "A", col_taxon_id: "A2" },
    ]).context).toEqual([]);
  });
});

describe("shape images", () => {
  it("encodes the edge where MapLibre's SDF shader draws it", () => {
    for (const shape of SHAPES) {
      const { width, data } = shapeSdf(shape);
      const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3];
      const c = width / 2;
      expect(alpha(c, c)).toBeGreaterThan(192); // inside: past the edge's 0.75
      expect(alpha(0, 0)).toBe(0); // the corner, outside the outline's reach
      expect(shapeSvgPath(shape)).toMatch(/^M/);
    }
  });
});
