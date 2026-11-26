/**
 * link/select.ts against docs/specs/matching.md: each step, relation, synonym
 * rule and doubt, on small made-up species shaped like the spec's examples.
 */
import { describe, it, expect } from "vitest";
import { select, selectEvery, type ColRecord, type ColSpecies, type Release, type SpeciesInput } from "../sync/link/select";
import { sameNameKey } from "../sync/link/name-rules";
import { reviewBasis, REVIEW_DOUBT, type Review } from "../sync/link/ai-reviews";

const sp = (id: string, name: string, authorship: string | null, cls = "aves"): ColSpecies =>
  ({ id, name, authorship, class: cls, kingdom: "animalia", phylum: "chordata" });
const rec = (id: string, name: string, authorship: string | null, status: string, species: ColSpecies | null, classification: number | null = 10): ColRecord =>
  ({ id, name, authorship, rank: "SPECIES", status, classification, species });
const acc = (s: ColSpecies, status = "ACCEPTED") => rec(s.id, s.name, s.authorship, status, s);

function species(name: string, authority: string | null, answer: ColRecord | null, alternatives: ColRecord[] = [], extra: Partial<SpeciesInput> = {}): SpeciesInput {
  return { sis: 1, name, authority, kingdom: "Animalia", phylum: "Chordata", synonyms: [],
    match: { matchType: "EXACT", answerName: answer?.name ?? null, answer, alternatives }, ...extra };
}

function release(records: ColRecord[] = [], assessed: string[] = [], occurrences: Record<string, number> = {}, wholeBySteps = new Map<string, Set<number>>()): Release {
  return {
    assessedNames: new Set(assessed.map(sameNameKey)),
    recordsNamed: (n) => records.filter((r) => sameNameKey(r.name) === sameNameKey(n)),
    occurrencesUnder: (id) => occurrences[id] ?? 0,
    byId: (id) => records.find((r) => r.id === id),
    wholeBySteps,
  };
}

const ids = (s: ReturnType<typeof select>) => s.selected.map((x) => `${x.record.id}:${x.relation}`);

describe("steps", () => {
  it("3: the answer, accepted, is the species (Panthera leo)", () => {
    const leo = sp("L", "Panthera leo", "(Linnaeus, 1758)");
    const s = select(species("Panthera leo", "(Linnaeus, 1758)", acc(leo)), release());
    expect(s.step).toBe(3);
    expect(ids(s)).toEqual(["L:is"]);
    expect(s.doubts).toEqual([]);
  });

  it("3: copies join, so both count (Cygnus buccinator, 1831 and a provisional 1832)", () => {
    const a = sp("A", "Cygnus buccinator", "Richardson, 1831"), b = sp("B", "Cygnus buccinator", "Richardson, 1832");
    const s = select(species("Cygnus buccinator", "Richardson, 1832", acc(a), [acc(b, "PROVISIONALLY_ACCEPTED")]), release());
    expect(s.groups).toBe(1);
    expect(ids(s)).toEqual(["A:is", "B:is"]);
    expect(s.doubts).toEqual([]);
  });

  it("3: a contradicted answer gives way to the record the citation matches (Weinmannia heterophylla)", () => {
    const kunth = sp("K", "Weinmannia heterophylla", "Kunth", "magnoliopsida"), cordata = sp("C", "Weinmannia cordata", "Sw.", "magnoliopsida");
    const lopez = rec("X", "Weinmannia heterophylla", "Ruiz & Pav. ex López", "AMBIGUOUS_SYNONYM", cordata);
    const s = select(species("Weinmannia heterophylla", "Ruiz & Pav.", acc(kunth), [lopez]), release());
    expect(s.step).toBe(3);
    expect(ids(s)).toEqual(["X:part of"]);
    expect(s.doubts).toEqual(["chosen by the citation", "ambiguous synonym"]);
    expect(s.untakenSpecies.map((x) => x.id)).toEqual(["K"]);
  });

  it("4: the answer, contradicted, with nothing matching: GBIF files the bare name there (Turdus rubrocanus)", () => {
    const gray = sp("G", "Turdus rubrocanus", "Gray & Gray, 1847"), phil = sp("P", "Philepitta castanea", "(Müller, 1776)");
    const hodgson = rec("H", "Turdus rubrocanus", "Hodgson, BH, 1844", "SYNONYM", phil);
    const s = select(species("Turdus rubrocanus", "Hodgson, 1846", acc(gray), [hodgson]), release());
    expect(s.step).toBe(4);
    expect(ids(s)).toEqual(["G:is"]);
    expect(s.doubts).toEqual(["homonym", "other authors"]);
  });

  it("5: no answer: the groups the citation doesn't contradict (Palaina martensi)", () => {
    const d = sp("D", "Diancta martensi", "(H. Adams, 1867)"), o = sp("O", "Other one", "(Andreae, 1902)");
    const adams = rec("A1", "Palaina martensi", "(H. Adams, 1867)", "SYNONYM", d), andreae = rec("A2", "Palaina martensi", "(Andreae, 1902)", "SYNONYM", o);
    const genus = { ...rec("G", "Palaina", null, "ACCEPTED", null), rank: "GENUS" };
    const s = select(species("Palaina martensi", "(Adams, 1866)", genus, [adams, andreae]), release());
    expect(s.step).toBe(5);
    expect(ids(s)).toEqual(["A1:is"]);
    expect(s.doubts).toEqual(["chosen by the citation", "homonym"]);
  });

  it("1: an informal name takes nothing", () => {
    const s = select(species("Galaxias sp. nov. 'Verlorenvlei'", null, null), release());
    expect(s).toMatchObject({ step: 1, reason: "informal or qualified name", selected: [] });
  });

  it("2: no candidate (a misapplied answer)", () => {
    const s = select(species("Ampedus karpathicus", "(Buysson, 1885)", rec("M", "Ampedus karpathicus", "auct.", "MISAPPLIED", sp("S", "Ampedus x", null))), release());
    expect(s).toMatchObject({ step: 2, reason: "no candidate" });
  });

  it("a candidate across a phylum is no candidate", () => {
    const crab = { ...sp("C", "Hepatus lineatus", null), phylum: "arthropoda" };
    const s = select(species("Hepatus lineatus", null, acc(crab)), release());
    expect(s.step).toBe(2);
  });
});

describe("relations of the steps' records", () => {
  it("a synonym that is another genus' same epithet is the species (Sorbus greenii → Aria greenii)", () => {
    const aria = sp("AR", "Aria greenii", "(T.C.G.Rich) Sennikov & Kurtto", "magnoliopsida");
    const s = select(species("Sorbus greenii", "T.C.G.Rich", rec("SG", "Sorbus greenii", "T.C.G.Rich", "SYNONYM", aria)), release());
    expect(s.selected[0]).toMatchObject({ relation: "is", relationStep: 3 });
  });

  it("CoL's own respelling is the species (Lepilemur jamesorum → L. jamesi)", () => {
    const j = sp("J", "Lepilemur jamesi", "Louis Jr. et al., 2006", "mammalia");
    const s = select(species("Lepilemur jamesorum", "Louis Jr. et al., 2006", rec("R", "Lepilemur jamesorum", "Louis Jr. et al., 2006", "SYNONYM", j)), release());
    expect(s.selected[0]).toMatchObject({ relation: "is", relationStep: 2 });
  });

  it("a synonym of another species is part of it (Pararge xiphioides)", () => {
    const aeg = sp("AE", "Pararge aegeria", "(Linnaeus, 1758)", "insecta");
    const s = select(species("Pararge xiphioides", "Staudinger, 1871", rec("X", "Pararge xiphioides", "Staudinger, 1871", "SYNONYM", aeg)), release());
    expect(s.selected[0]).toMatchObject({ relation: "part of", relationStep: 4 });
  });

  it("a synonym of another assessed name is refused, and counts nothing (Lycaena clarki)", () => {
    const al = sp("AL", "Aloeides clarki", "Tite & Dickson, 1968", "insecta");
    const s = select(species("Lycaena clarki", "Clark & Dickson, 1971", rec("LC", "Lycaena clarki", "Clark & Dickson, 1971", "SYNONYM", al)),
      release([], ["Lycaena clarki", "Aloeides clarki"]));
    expect(s.selected[0]).toMatchObject({ relation: "refused", relationStep: 3 });
    expect(s.doubts).toEqual(["counts nothing"]);
  });

  it("an ambiguous synonym is part of its species", () => {
    const t = sp("T", "Genus target", null);
    const s = select(species("Genus own", null, rec("A", "Genus own", null, "AMBIGUOUS_SYNONYM", t)), release());
    expect(s.selected[0]).toMatchObject({ relation: "part of", relationStep: 1 });
    expect(s.doubts).toContain("ambiguous synonym");
  });
});

describe("doubts on the steps' records", () => {
  it("other spelling: the answer isn't EXACT and the codes don't make it one name (Agrotis sabine)", () => {
    const las = sp("L", "Agrotis lasserrei", "(Oberthür, 1881)", "insecta");
    const sabura = rec("S", "Agrotis sabura", "Mabille, 1888", "SYNONYM", las);
    const s = select(species("Agrotis sabine", "Brandstetter, 2010", sabura, [], { match: { matchType: "VARIANT", answerName: "Agrotis sabura", answer: sabura, alternatives: [] } }),
      release([], ["Agrotis sabine", "Agrotis lasserrei"]));
    expect(s.step).toBe(4);
    expect(s.doubts).toEqual(["other authors", "other spelling", "counts nothing"]);
  });

  it("placed elsewhere: a record's classification is below 0 (Kuhlia rubens)", () => {
    const ap = sp("AP", "Apogon imberbis", "(Linnaeus, 1758)", "teleostei");
    const s = select(species("Kuhlia rubens", "(Spinola, 1807)", rec("K", "Kuhlia rubens", "(Spinola, 1807)", "SYNONYM", ap, -20)), release());
    expect(s.doubts).toEqual(["placed elsewhere"]);
  });

  it("homonym: two groups, and the citation doesn't settle it (Galium palustre)", () => {
    const hyd = sp("H", "Hydrogalium elongatum", "x", "magnoliopsida"), hp = sp("P", "Galium elongatum", "y", "magnoliopsida");
    const bieb = rec("B", "Galium palustre", "M.Bieb.", "AMBIGUOUS_SYNONYM", hyd), linn = rec("L", "Galium palustre", "L.", "SYNONYM", hp);
    const s = select(species("Galium palustre", "L.", bieb, [linn]), release());
    expect(ids(s)).toEqual(["B:part of", "L:part of"]);
    expect(s.doubts).toEqual(["homonym", "ambiguous synonym"]);
  });

  it("a homonym the citation settles has no doubt, and its other group is noted, not taken", () => {
    const a = sp("A", "Gymnosporia gracilis", "Loes.", "magnoliopsida"), b = sp("B", "Other gracilis", "Sond.", "magnoliopsida");
    const s = select(species("Gymnosporia gracilis", "Loes.", acc(a), [rec("S", "Gymnosporia gracilis", "Sond.", "SYNONYM", b)]), release());
    expect(s.doubts).toEqual([]);
    expect(s.groups).toBe(2);
    expect(s.untakenSpecies.map((x) => x.id)).toEqual(["B"]);
  });
});

describe("synonym records", () => {
  const striata = sp("BS", "Butorides striata", "(Linnaeus, 1758)");
  const virescens = sp("BV", "Butorides virescens", "(Linnaeus, 1758)");

  it("split into: a synonym CoL holds as a species (Butorides striata includes the green heron)", () => {
    const s = select(species("Butorides striata", "(Linnaeus, 1758)", acc(striata), [], { synonyms: [{ name: "Butorides virescens", authors: ["(Linnaeus, 1758)"] }] }),
      release([acc(virescens)]));
    expect(ids(s)).toEqual(["BS:is", "BV:split into"]);
    expect(s.selected[1]).toMatchObject({ basis: "synonym", relationStep: 2 });
    expect(s.doubts).toEqual([]);
  });

  it("split, authors unclear: no author of the synonym compares the same", () => {
    const s = select(species("Butorides striata", "(Linnaeus, 1758)", acc(striata), [], { synonyms: [{ name: "Butorides virescens", authors: [] }] }),
      release([acc(virescens)]));
    expect(s.doubts).toEqual(["split, authors unclear"]);
  });

  it("is: the same organism under another genus, citation the same (Isoaeschna isoceles → Anaciaeschna isoceles)", () => {
    const iso = sp("I", "Isoaeschna isoceles", "(Müller, 1767)", "insecta"), ana = sp("AN", "Anaciaeschna isoceles", "(Müller, 1767)", "insecta");
    const s = select(species("Isoaeschna isoceles", "(Müller, 1767)", acc(iso), [], { synonyms: [{ name: "Aeshna isoceles", authors: ["(Müller, 1767)"] }] }),
      release([rec("AE", "Aeshna isoceles", "(Müller, 1767)", "SYNONYM", ana)]));
    expect(ids(s)).toEqual(["I:is", "AE:is"]);
  });

  it("a synonym's 'is' needs the citation to compare the same, not merely not other (Chiococca alba / the snowberry)", () => {
    const ch = sp("CH", "Chiococca alba", "(L.) Hitchc.", "magnoliopsida"), snow = sp("SN", "Symphoricarpos albus", "(L.) S.F.Blake", "magnoliopsida");
    const s = select(species("Chiococca alba", "(L.) Hitchc.", acc(ch), [], { kingdom: "Plantae", phylum: "Tracheophyta",
      synonyms: [{ name: "Symphoricarpos albus", authors: [] }, { name: "Symphoricarpos racemosus", authors: [] }] }),
      release([rec("SR", "Symphoricarpos racemosus", "Michx.", "SYNONYM", { ...snow, kingdom: "plantae", phylum: "tracheophyta" })]));
    expect(ids(s)).not.toContain("SR:is");
  });

  it("part of, with the doubt, under a species the steps don't reach (Elymus farctus)", () => {
    const self = sp("EF", "Elymus farctus", "(Viv.) Runemark ex Melderis", "liliopsida"), thin = sp("TJ", "Thinopyrum junceiforme", "(Á.Löve & D.Löve) Á.Löve", "liliopsida");
    const s = select(species("Elymus farctus", "(Viv.) Runemark ex Melderis", acc(self), [], { synonyms: [{ name: "Elymus junceiformis", authors: ["(Á.Löve & D.Löve) Hand & Buttler"] }] }),
      release([rec("EJ", "Elymus junceiformis", null, "SYNONYM", thin)], [], { EJ: 5832 }));
    expect(ids(s)).toEqual(["EF:is", "EJ:part of"]);
    expect(s.selected[1].relationStep).toBe(3);
    expect(s.doubts).toEqual(["synonym filed elsewhere"]);
  });

  it("no doubt for part of under a species the steps already reach (3s)", () => {
    const aeg = sp("AE", "Pararge aegeria", "(Linnaeus, 1758)", "insecta");
    const s = select(species("Pararge xiphioides", "Staudinger, 1871", rec("X", "Pararge xiphioides", "Staudinger, 1871", "SYNONYM", aeg), [],
      { synonyms: [{ name: "Papilio xiphioides", authors: ["Staudinger, 1871"] }] }),
      release([rec("PX", "Papilio xiphioides", "Staudinger, 1871", "SYNONYM", aeg)], [], { PX: 10 }));
    expect(s.selected[1]).toMatchObject({ relation: "part of", relationStep: "3s" });
    expect(s.doubts).toEqual([]);
  });

  it("isn't added under another assessed species, or one another species' steps count whole", () => {
    const other = sp("O", "Other species", null);
    const base = species("Panthera leo", null, acc(sp("L", "Panthera leo", null)), [], { synonyms: [{ name: "Leo old", authors: [] }] });
    const r = rec("LO", "Leo old", null, "SYNONYM", other);
    expect(ids(select(base, release([r], ["Panthera leo", "Other species"])))).toEqual(["L:is"]);
    expect(ids(select(base, release([r], [], {}, new Map([["O", new Set([99])]]))))).toEqual(["L:is"]);
    expect(ids(select(base, release([r])))).toEqual(["L:is", "LO:part of"]);
  });

  it("a synonym whose every author is qualified adds nothing (auct., pro parte)", () => {
    const base = species("Panthera leo", null, acc(sp("L", "Panthera leo", null)), [], { synonyms: [{ name: "Leo old", authors: ["auct. non Smith"] }, { name: "Leo older", authors: ["Roux, 1907 [pro parte]"] }] });
    const s = select(base, release([acc(sp("LO", "Leo old", null)), acc(sp("LR", "Leo older", "Roux, 1907"))]));
    expect(ids(s)).toEqual(["L:is"]);
  });

  it("matching records win over unclear ones, with their copies (Mentha verticillata D.Don, not the hybrid L.)", () => {
    const pog = sp("P", "Pogostemon crassicaulis", "(Benth.) Press", "magnoliopsida");
    const hybrid = sp("H", "Mentha × verticillata", "L.", "magnoliopsida"), dd = sp("D", "Pogostemon pumilus", "x", "magnoliopsida");
    const base = species("Pogostemon crassicaulis", "(Benth.) Press", acc(pog), [], { synonyms: [{ name: "Mentha verticillata", authors: ["D.Don"] }] });
    const s = select(base, release([acc(hybrid), rec("MD", "Mentha verticillata", "D.Don", "SYNONYM", dd)]));
    expect(ids(s)).toEqual(["P:is", "MD:part of"]);
  });

  it("other authors' records are left out (Solanum glabrum Merr., for S. glabrum Dunal)", () => {
    const own = sp("O", "Solanum nigrum", "L.", "magnoliopsida");
    const base = species("Solanum nigrum", "L.", acc(own), [], { synonyms: [{ name: "Solanum glabrum", authors: ["Dunal"] }] });
    const s = select(base, release([acc(sp("M", "Solanum glabrum", "Merr.", "magnoliopsida"))]));
    expect(ids(s)).toEqual(["O:is"]);
  });

  it("are not added for a species with a reason at step 1", () => {
    const s = select(species("Leo sp.", null, null, [], { synonyms: [{ name: "Leo old", authors: [] }] }), release([acc(sp("LO", "Leo old", null))]));
    expect(s.selected).toEqual([]);
  });
});

describe("selectEvery", () => {
  it("tells each species which CoL species another's steps count whole", () => {
    const leo = sp("L", "Panthera leo", null), tig = sp("T", "Panthera tigris", null);
    const a = species("Panthera leo", null, acc(leo), [], { sis: 1, synonyms: [{ name: "Felis tigris", authors: [] }] });
    const b = species("Panthera tigris", null, acc(tig), [], { sis: 2 });
    const r = { ...release([rec("FT", "Felis tigris", null, "SYNONYM", tig)]) } as Omit<Release, "wholeBySteps">;
    const [sa] = selectEvery([a, b], r, new Map());
    // Panthera tigris is another assessed name too; either way the record isn't added.
    expect(ids(sa)).toEqual(["L:is"]);
  });

  it("a review applies only while the rules give the answer and basis it was given, and never changes the records", () => {
    const leo = sp("L", "Panthera leo", "(Linnaeus, 1758)");
    const a = species("Panthera leo", "(Gray, 1867)", acc(leo));  // other authors: listed
    const r = release() as Omit<Release, "wholeBySteps">;
    const basis = reviewBasis(a, selectEvery([a], r)[0]);
    const rv = (rulesAnswer: string, findings: Review["finding"][] = ["agrees", "agrees"], b = basis) => new Map([[1, findings.map((finding, i): Review => ({
      sis: 1, redlistName: "Panthera leo", reviewer: i + 1, finding, records: [], reason: "r", sources: [], rulesAnswer, basis: b, model: "m", date: "2026-11-26", transcript: "", context: "" }))]]);
    const L = "Panthera leo linnaeus 1758 [accepted, of Panthera leo]: is", X = "Panthera leo linnaeus 1758 [synonym, of Panthera leo]: is";
    expect(selectEvery([a], r)[0].toReview).toMatch(/^other authors/);
    expect(selectEvery([a], r, rv(L))[0].toReview).toBeNull();
    expect(selectEvery([a], r, rv(X))[0].toReview).toMatch(/^other authors/);
    const u = selectEvery([a], r, rv(L, ["agrees", "other records"]))[0];
    expect(u.doubts).toEqual(["other authors", REVIEW_DOUBT]);
    expect(u.toReview).toBe(`${REVIEW_DOUBT} (agrees; other records)`);
    expect(u.selected.map((x) => x.record.id)).toEqual(["L"]);
    // A release that renumbers the record keeps the review.
    const moved = species("Panthera leo", "(Gray, 1867)", acc({ ...leo, id: "L2" }));
    expect(selectEvery([moved], r, rv(L))[0].toReview).toBeNull();
    // A new synonym or another basis: the review no longer applies.
    const synonym = { ...a, synonyms: [{ name: "Felis leo", authors: ["Linnaeus, 1758"] }] };
    expect(selectEvery([synonym], r, rv(L))[0].toReview).toMatch(/^other authors/);
    expect(selectEvery([a], r, rv(L, ["agrees", "agrees"], "something else"))[0].toReview).toMatch(/^other authors/);
  });
});

describe("review notes", () => {
  it("say what the AI taxonomic reviewers found: both agree, both suggest the same, or each reviewer", async () => {
    const { matchNote } = await import("../sync/link/assessment-link");
    const leo = sp("L", "Panthera leo", "(Linnaeus, 1758)");
    const a = species("Panthera leo", "(Gray, 1867)", acc(leo));
    const r = release() as Omit<Release, "wholeBySteps">;
    const s0 = selectEvery([a], r)[0];
    const given = { rulesAnswer: "Panthera leo linnaeus 1758 [accepted, of Panthera leo]: is", basis: reviewBasis(a, s0) };
    const tigris = { id: "T", relation: "split into" as const, label: "Panthera tigris", status: "accepted", species: "Panthera tigris", records: 1234 };
    const part = { id: "P", relation: "part of" as const, label: "Felis leo L.", status: "synonym", species: "Panthera pardus", records: 7 };
    const rv = (...xs: [Review["finding"], Review["records"]][]) => new Map([[1, xs.map(([finding, records], i): Review => ({
      sis: 1, redlistName: "Panthera leo", reviewer: i + 1, finding, records, reason: "r", sources: [], ...given, model: "claude-opus-5-5", date: "2026-11-25", transcript: "", context: "" }))]]);
    const note = (m: Map<number, Review[]>) => matchNote(selectEvery([a], r, m)[0], a)!.note;
    expect(note(rv(["agrees", []], ["agrees", []]))).toContain("Both AI taxonomic reviewers agree with these records (claude-opus-5-5, 2026-11-25).");
    expect(note(rv(["other records", [tigris]], ["other records", [tigris]])))
      .toContain("Both AI taxonomic reviewers suggest other records (claude-opus-5-5, 2026-11-25): they would count all of CoL's Panthera tigris, 1,234 GBIF records. The count follows the rules.");
    expect(note(rv(["agrees", []], ["other records", [part]])))
      .toContain("reviewer 1 agrees with these records; reviewer 2 would count the records under Felis leo L. (which CoL files under Panthera pardus), 7 GBIF records. The count follows the rules.");
    expect(note(rv(["agrees", []], ["can't tell", []]))).toContain("reviewer 1 agrees with these records; reviewer 2 couldn't tell.");
  });
});
