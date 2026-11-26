/**
 * The one rule across species (scripts/sync/link/rules.ts): each CoL record
 * counts for one assessed species at most, and the tie-break in
 * docs/specs/matching.md, "Counting and the NE list", says which.
 */
import { describe, it, expect } from "vitest";
import { oneOwnerPerUsage, type LinkRow } from "../sync/link/rules";

const row = (sis: number, taxon: string, over: Partial<LinkRow> = {}): LinkRow => ({
  sis_taxon_id: sis, role: "primary", col_species_id: taxon, col_taxon_id: taxon, relation: "is", method: "accepted", basis: "matcher",
  step: 3, doubts: null, match_reason: null, col_treatment: null, match_description: null, to_review: null,
  counted: true, ...over,
});
const owner = (links: LinkRow[], flagged: number[] = [], exact: number[] = []) => {
  oneOwnerPerUsage(links, new Set(flagged), new Set(exact));
  return links.filter((l) => l.counted).map((l) => l.sis_taxon_id);
};

describe("oneOwnerPerUsage", () => {
  it("primary before covered", () => {
    expect(owner([row(1, "A", { role: "covered" }), row(2, "A")])).toEqual([2]);
  });
  it("no doubts before doubts", () => {
    expect(owner([row(1, "A"), row(2, "A")], [1])).toEqual([2]);
  });
  it("is, then split into, then part of", () => {
    expect(owner([row(1, "A", { relation: "part of" }), row(2, "A", { relation: "split into" })])).toEqual([2]);
    expect(owner([row(1, "A", { relation: "split into" }), row(2, "A")])).toEqual([2]);
  });
  it("the species whose CoL name is its Red List name as written (Peltophorum dasyrhachis / dasyrachis)", () => {
    expect(owner([row(1, "A"), row(2, "A")], [], [2])).toEqual([2]);
  });
  it("then the lower SIS id; the loser becomes a duplicate that counts nothing", () => {
    const links = [row(2, "A"), row(1, "A")];
    expect(owner(links)).toEqual([1]);
    expect(links[0]).toMatchObject({ relation: "duplicate", counted: false });
  });
  it("leaves rows that count nothing, and different records, alone", () => {
    const links = [row(1, "A"), row(2, "A", { relation: "refused", counted: false }), row(3, "B")];
    expect(owner(links)).toEqual([1, 3]);
    expect(links[1].relation).toBe("refused");
  });
});
