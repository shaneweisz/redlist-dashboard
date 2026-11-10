/**
 * The link's rules (scripts/sync/link/rules.ts), each on a few rows of its own.
 * The real-data cases behind them are the matching fixtures (checks/fixtures/matching.ts).
 */
import { describe, it, expect } from "vitest";
import {
  coverer, coverSynonymSpecies, coverTwins, coverDuplicateConcepts, coverSameNameSynonyms, coverUndecidedCandidates, dropCrossPhylum, oneOwnerPerUsage,
  type LinkRow, type AcceptedSpecies,
} from "../sync/link/rules";

const primary = (sis: number, col_species_id: string | null, over: Partial<LinkRow> = {}): LinkRow => ({
  sis_taxon_id: sis, role: "primary", col_species_id, col_taxon_id: col_species_id, verdict: "own", method: "accepted", basis: "matcher",
  decided_by: null, to_review: null, match_reason: "", counted: true, ...over,
});
const sp = (col_id: string, scientific_name: string, authorship: string | null, family = "F", class_name = "C"): AcceptedSpecies =>
  ({ col_id, scientific_name, authorship, family, class_name });
const covered = (links: LinkRow[]) => links.filter((l) => l.role === "covered");

describe("coverer", () => {
  it("adds a covered row once, and none for the species' own target", () => {
    const links = [primary(1, "A")];
    const cover = coverer(links);
    const row = { sis_taxon_id: 1, col_species_id: "B", col_taxon_id: "B", verdict: "own" as const, method: "m", match_reason: "", counted: true };
    expect(cover(row)).toBe(true);
    expect(cover(row)).toBe(false);
    expect(cover({ ...row, col_species_id: "A", col_taxon_id: "A" })).toBe(false);
    expect(covered(links)).toHaveLength(1);
  });
});

describe("coverSynonymSpecies", () => {
  const species = new Set<string>();
  it("counts another accepted species IUCN's synonyms name, under its own genus", () => {
    const links = [primary(1, "HYL")];
    const touched = coverSynonymSpecies(coverer(links), [{ sis: 1, name: "Hylatomus pileatus", authority: "(Linnaeus, 1758)",
      target_id: "DRY", target_name: "Dryocopus pileatus", target_authorship: "(Linnaeus, 1758)", kind: 0, src: "iucn" }], species);
    expect(touched.size).toBe(1);
    expect(covered(links)[0]).toMatchObject({ col_species_id: "DRY", verdict: "own", counted: true });
  });
  it("refuses one under another genus whose authors differ (pied stilt, not banded stilt)", () => {
    const links = [primary(1, "HIM")];
    coverSynonymSpecies(coverer(links), [{ sis: 1, name: "Himantopus leucocephalus", authority: "Gould, 1837",
      target_id: "CLA", target_name: "Cladorhynchus leucocephalus", target_authorship: "(Vieillot, 1816)", kind: 0, src: "iucn" }], species);
    expect(covered(links)[0]).toMatchObject({ col_species_id: "CLA", verdict: "refused", counted: false, col_taxon_id: "CLA" });
  });
  it("doesn't count one reached through a CoL synonym (kind 1)", () => {
    const links = [primary(1, "X")];
    coverSynonymSpecies(coverer(links), [{ sis: 1, name: "Chiococca alba", authority: "(L.) Hitchc.",
      target_id: "SNOW", target_name: "Chiococca alba", target_authorship: "(L.) Hitchc.", kind: 1, src: "iucn" }], species);
    expect(covered(links)[0]).toMatchObject({ verdict: "refused", counted: false });
  });
});

describe("coverTwins", () => {
  it("counts the identical name held twice in one class, a hybrid sign aside", () => {
    const links = [primary(1, "U1")];
    const accepted = [sp("U1", "Utricularia ochroleuca", null, "Lentibulariaceae", "Magnoliopsida"),
      sp("U2", "Utricularia × ochroleuca", null, "Lentibulariaceae", "Magnoliopsida")];
    expect(coverTwins(links, coverer(links), accepted, new Map([[1, "utricularia ochroleuca"]]), new Set()).size).toBe(1);
    expect(covered(links)[0]).toMatchObject({ col_species_id: "U2", method: "same_name_twin", counted: true });
  });
  it("leaves the same name in two classes alone (Centropogon australis, a plant and a fish)", () => {
    const links = [primary(1, "P")];
    const accepted = [sp("P", "Centropogon australis", null, "Campanulaceae", "Magnoliopsida"), sp("F", "Centropogon australis", "(White)", "Tetrarogidae", "Actinopterygii")];
    expect(coverTwins(links, coverer(links), accepted, new Map(), new Set()).size).toBe(0);
  });
});

describe("coverTwins: a name CoL spells two ways", () => {
  it("counts the other spelling the codes make one name, in one class (Pica nutallii / nuttalli)", () => {
    const links = [primary(1, "P1")];
    const accepted = [sp("P1", "Pica nutallii", "(Audubon, 1837)", "Corvidae", "Aves"), sp("P2", "Pica nuttalli", null, "Corvidae", "Aves")];
    expect(coverTwins(links, coverer(links), accepted, new Map([[1, "pica nutalli"]]), new Set()).size).toBe(1);
    expect(covered(links)[0]).toMatchObject({ col_species_id: "P2", method: "respelled_twin", counted: true });
  });
  it("not two spellings whose citations disagree on the year (Mycalesis ita, 1863 / itys, 1867)", () => {
    const links = [primary(1, "M2")];
    const accepted = [sp("M1", "Mycalesis ita", "Felder, 1863", "Nymphalidae", "Insecta"), sp("M2", "Mycalesis itys", "Felder, 1867", "Nymphalidae", "Insecta")];
    expect(coverTwins(links, coverer(links), accepted, new Map(), new Set()).size).toBe(0);
  });
  it("not by clearly other authors, nor one the Red List assesses separately", () => {
    const accepted = [sp("W1", "Witheringia stramoniifolia", "Kunth", "Solanaceae", "Magnoliopsida"), sp("W2", "Witheringia stramonifolia", "Smith, 1990", "Solanaceae", "Magnoliopsida")];
    const a = [primary(1, "W1")];
    expect(coverTwins(a, coverer(a), accepted, new Map(), new Set()).size).toBe(0);
    const kunth = [accepted[0], { ...accepted[1], authorship: "Kunth" }];
    const b = [primary(1, "W1")];
    expect(coverTwins(b, coverer(b), kunth, new Map(), new Set(["witheringia stramonifolia"])).size).toBe(0);
  });
});

describe("coverDuplicateConcepts", () => {
  const accepted = [sp("C1", "Charadrius nivosus", "(Cassin, 1858)", "Charadriidae"), sp("A1", "Anarhynchus nivosus", "(Cassin, 1858)", "Charadriidae")];
  it("counts the same epithet and dated citation under another genus in one family", () => {
    const links = [primary(1, "C1")];
    expect(coverDuplicateConcepts(links, coverer(links), accepted, new Map(), new Set()).size).toBe(1);
    expect(covered(links)[0]).toMatchObject({ col_species_id: "A1", method: "duplicate_concept" });
  });
  it("not when the other is a species the Red List assesses separately", () => {
    const links = [primary(1, "C1")];
    expect(coverDuplicateConcepts(links, coverer(links), accepted, new Map(), new Set(["anarhynchus nivosus"])).size).toBe(0);
  });
});

describe("coverSameNameSynonyms", () => {
  it("gives a lumped species every synonym usage carrying its name", () => {
    const links = [primary(1, "R1", { verdict: "lumped", method: "synonym", col_taxon_id: "S1" })];
    const touched = coverSameNameSynonyms(links, coverer(links),
      [{ sis: 1, usage: "S1", target: "R1" }, { sis: 1, usage: "S2", target: "R2" }, { sis: 1, usage: "S3", target: "R3" }]);
    expect(touched.size).toBe(1);
    expect(covered(links).map((l) => l.col_taxon_id)).toEqual(["S2", "S3"]);
  });
  it("does nothing for a species that isn't lumped", () => {
    const links = [primary(1, "R1")];
    expect(coverSameNameSynonyms(links, coverer(links), [{ sis: 1, usage: "S2", target: "R2" }]).size).toBe(0);
  });
});

describe("coverUndecidedCandidates", () => {
  it("keeps what a waiting species might be off the NE list, counting nothing; not for a linked species", () => {
    const links = [primary(1, null, { verdict: "none", method: "unmatched", counted: false }), primary(2, "B")];
    const touched = coverUndecidedCandidates(links, coverer(links), [
      { sis: 1, target_id: "C1", target_name: "Coenonympha pamphilus" }, { sis: 2, target_id: "X", target_name: "Other" }]);
    expect([...touched]).toEqual([1]);
    expect(covered(links)).toEqual([expect.objectContaining({ sis_taxon_id: 1, col_species_id: "C1", verdict: "refused", counted: false, col_taxon_id: "C1" })]);
  });
});

describe("dropCrossPhylum", () => {
  it("unlinks a primary row and drops a covered one across a phylum", () => {
    const links = [primary(1, "CRAB"), { ...primary(2, "FISH"), role: "covered" as const }, primary(3, "OK")];
    expect(dropCrossPhylum(links, new Set(["1|CRAB", "2|FISH"])).size).toBe(2);
    expect(links.map((l) => [l.sis_taxon_id, l.verdict, l.col_species_id])).toEqual([[1, "none", null], [3, "own", "OK"]]);
  });
});

describe("oneOwnerPerUsage", () => {
  it("gives a usage two spellings claim to the one CoL writes exactly (Peltophorum dasyrhachis / dasyrachis)", () => {
    const links = [primary(62522, "U"), primary(226500158, "U")];
    oneOwnerPerUsage(links, new Set([226500158]));
    expect(links.map((l) => [l.sis_taxon_id, l.verdict])).toEqual([[62522, "duplicate"], [226500158, "own"]]);
  });

  it("gives a usage to the primary row, then the matcher, then the lower SIS id", () => {
    const links = [
      primary(5, "U", { basis: "decision" }),
      primary(7, "U"),
      { ...primary(2, "U"), role: "covered" as const, method: "same_name_twin", basis: "rule" as const },
    ];
    expect(oneOwnerPerUsage(links).size).toBe(2);
    expect(links.map((l) => [l.sis_taxon_id, l.verdict, l.counted])).toEqual([[5, "duplicate", false], [7, "own", true], [2, "own", false]]);
  });
});
