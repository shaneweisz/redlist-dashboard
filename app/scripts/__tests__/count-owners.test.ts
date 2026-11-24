import { describe, it, expect } from "vitest";
import { usageOwners, PART, WHOLE, type OwnerClaim, type OwnerTaxon } from "../sync/count/owners";

// S: an accepted species with a synonym SY and a subspecies SS (under which sits SSY); O: another species; N: a record leading nowhere.
const taxa: OwnerTaxon[] = [
  { col_id: "S", parent_id: null, species_id: "S" }, { col_id: "SY", parent_id: "S", species_id: "S" },
  { col_id: "SS", parent_id: "S", species_id: "S" }, { col_id: "SSY", parent_id: "SS", species_id: "S" },
  { col_id: "O", parent_id: null, species_id: "O" }, { col_id: "N", parent_id: null, species_id: null },
];
const claim = (sis: number, relation: string, col_taxon_id: string, col_species_id: string | null = col_taxon_id): OwnerClaim =>
  ({ sis_taxon_id: sis, relation, counts: relation === "part of" ? PART : relation === "is" || relation === "split into" ? WHOLE : "nothing", col_taxon_id, col_species_id });
const say = (m: ReturnType<typeof usageOwners>) => Object.fromEntries([...m].map(([k, o]) => [k, o.sis !== undefined ? `sis ${o.sis}` : `col ${o.col_id}`]));

describe("usageOwners (usage_owner.sql's rule)", () => {
  it("unassessed species own themselves; a whole-species row takes every usage of its species", () => {
    expect(say(usageOwners([], taxa))).toEqual({ S: "col S", SY: "col S", SS: "col S", SSY: "col S", O: "col O" });
    expect(say(usageOwners([claim(1, "is", "S")], taxa))).toMatchObject({ S: "sis 1", SY: "sis 1", SSY: "sis 1", O: "col O" });
  });
  it("a part-of root owns what lies under it; the rest of its species keeps its own owner", () => {
    expect(say(usageOwners([claim(2, "part of", "SS", "S")], taxa))).toMatchObject({ SS: "sis 2", SSY: "sis 2", S: "col S", SY: "col S" });
    expect(say(usageOwners([claim(1, "is", "S"), claim(2, "part of", "SS", "S")], taxa))).toMatchObject({ S: "sis 1", SS: "sis 2", SSY: "sis 2" });
  });
  it("part of on the accepted record takes its synonyms and subspecies too, and leaves the species to no one", () => {
    expect(say(usageOwners([claim(3, "part of", "S", "S")], taxa))).toMatchObject({ S: "sis 3", SY: "sis 3", SS: "sis 3", SSY: "sis 3" });
  });
  it("two roots: the nearer wins, then the lower SIS id", () => {
    expect(say(usageOwners([claim(4, "part of", "S", "S"), claim(5, "part of", "SS", "S")], taxa))).toMatchObject({ S: "sis 4", SS: "sis 5", SSY: "sis 5" });
    expect(say(usageOwners([claim(7, "part of", "SS", "S"), claim(6, "part of", "SS", "S")], taxa))).toMatchObject({ SS: "sis 6" });
  });
  it("an is row on a record leading nowhere counts nothing, and a species an is row names but doesn't count goes to no one", () => {
    expect(say(usageOwners([claim(8, "is", "N", null)], taxa))).not.toHaveProperty("N");
    expect(say(usageOwners([{ ...claim(9, "is", "O"), counts: "nothing" }], taxa))).not.toHaveProperty("O");
  });
});
