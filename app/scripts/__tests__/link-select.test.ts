/**
 * link/select.ts against docs/specs/matching.md: each step, relation, synonym
 * rule and doubt, on small made-up species shaped like the spec's examples.
 */
import { describe, it, expect } from "vitest";
import { select, selectEvery, type ColRecord, type ColSpecies, type Release, type SpeciesInput } from "../sync/link/select";
import { sameNameKey } from "../sync/link/name-rules";
import { verdictBasis, type Decision } from "../sync/link/decisions";

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
  it("4: the answer, accepted, is the species (Panthera leo)", () => {
    const leo = sp("L", "Panthera leo", "(Linnaeus, 1758)");
    const s = select(species("Panthera leo", "(Linnaeus, 1758)", acc(leo)), release());
    expect(s.step).toBe(4);
    expect(ids(s)).toEqual(["L:is"]);
    expect(s.doubts).toEqual([]);
  });

  it("4: copies join, so both count (Cygnus buccinator, 1831 and a provisional 1832)", () => {
    const a = sp("A", "Cygnus buccinator", "Richardson, 1831"), b = sp("B", "Cygnus buccinator", "Richardson, 1832");
    const s = select(species("Cygnus buccinator", "Richardson, 1832", acc(a), [acc(b, "PROVISIONALLY_ACCEPTED")]), release());
    expect(s.groups).toBe(1);
    expect(ids(s)).toEqual(["A:is", "B:is"]);
    expect(s.doubts).toEqual([]);
  });

  it("4: a contradicted answer gives way to the record the citation matches (Weinmannia heterophylla)", () => {
    const kunth = sp("K", "Weinmannia heterophylla", "Kunth", "magnoliopsida"), cordata = sp("C", "Weinmannia cordata", "Sw.", "magnoliopsida");
    const lopez = rec("X", "Weinmannia heterophylla", "Ruiz & Pav. ex López", "AMBIGUOUS_SYNONYM", cordata);
    const s = select(species("Weinmannia heterophylla", "Ruiz & Pav.", acc(kunth), [lopez]), release());
    expect(s.step).toBe(4);
    expect(ids(s)).toEqual(["X:part of"]);
    expect(s.doubts).toEqual(["chosen by the citation", "ambiguous synonym"]);
    expect(s.untakenSpecies.map((x) => x.id)).toEqual(["K"]);
  });

  it("5: the answer, contradicted, with nothing matching: GBIF files the bare name there (Turdus rubrocanus)", () => {
    const gray = sp("G", "Turdus rubrocanus", "Gray & Gray, 1847"), phil = sp("P", "Philepitta castanea", "(Müller, 1776)");
    const hodgson = rec("H", "Turdus rubrocanus", "Hodgson, BH, 1844", "SYNONYM", phil);
    const s = select(species("Turdus rubrocanus", "Hodgson, 1846", acc(gray), [hodgson]), release());
    expect(s.step).toBe(5);
    expect(ids(s)).toEqual(["G:is"]);
    expect(s.doubts).toEqual(["homonym", "other authors"]);
  });

  it("6: no answer: the groups the citation doesn't contradict (Palaina martensi)", () => {
    const d = sp("D", "Diancta martensi", "(H. Adams, 1867)"), o = sp("O", "Other one", "(Andreae, 1902)");
    const adams = rec("A1", "Palaina martensi", "(H. Adams, 1867)", "SYNONYM", d), andreae = rec("A2", "Palaina martensi", "(Andreae, 1902)", "SYNONYM", o);
    const genus = { ...rec("G", "Palaina", null, "ACCEPTED", null), rank: "GENUS" };
    const s = select(species("Palaina martensi", "(Adams, 1866)", genus, [adams, andreae]), release());
    expect(s.step).toBe(6);
    expect(ids(s)).toEqual(["A1:is"]);
    expect(s.doubts).toEqual(["chosen by the citation", "homonym"]);
  });

  it("2: an informal name takes nothing", () => {
    const s = select(species("Galaxias sp. nov. 'Verlorenvlei'", null, null), release());
    expect(s).toMatchObject({ step: 2, reason: "informal or qualified name", selected: [] });
  });

  it("3: no candidate (a misapplied answer)", () => {
    const s = select(species("Ampedus karpathicus", "(Buysson, 1885)", rec("M", "Ampedus karpathicus", "auct.", "MISAPPLIED", sp("S", "Ampedus x", null))), release());
    expect(s).toMatchObject({ step: 3, reason: "no candidate" });
  });

  it("a candidate across a phylum is no candidate", () => {
    const crab = { ...sp("C", "Hepatus lineatus", null), phylum: "arthropoda" };
    const s = select(species("Hepatus lineatus", null, acc(crab)), release());
    expect(s.step).toBe(3);
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
    expect(s.step).toBe(5);
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

  it("are not added for a species with a reason at step 2, or a holding decision", () => {
    const s = select(species("Leo sp.", null, null, [], { synonyms: [{ name: "Leo old", authors: [] }] }), release([acc(sp("LO", "Leo old", null))]));
    expect(s.selected).toEqual([]);
  });
});

describe("decisions", () => {
  const waspfish = sp("5XHD2", "Centropogon australis", "(White, 1790)", "teleostei");
  const plant = { ...sp("PL", "Centropogon australis", "Gaudich.", "magnoliopsida"), kingdom: "plantae", phylum: "tracheophyta" };
  const input = species("Centropogon australis", "(Shaw, 1790)", acc(waspfish), [], { kingdom: "Animalia", phylum: "Chordata" });
  const decision = (over: Partial<Decision> = {}): Decision => ({
    sis: 1, redlistName: "Centropogon australis", redlistAuthority: "(Shaw, 1790)", candidates: ["Centropogon australis"], by: "fixture", reviewed: true,
    date: "2026-11-10", evidence: "the waspfish", sources: [], transcripts: [], context: "",
    rows: [{ id: "5XHD2", name: "Centropogon australis", authorship: "(White, 1790)", status: "accepted", species: "Centropogon australis", relation: "is" }], ...over });
  const rel = release([acc(waspfish), acc(plant)]);

  it("holds: its records, step 1, no doubts", () => {
    const s = select(input, rel, decision());
    expect(s).toMatchObject({ step: 1, doubts: [], toReview: null });
    expect(ids(s)).toEqual(["5XHD2:is"]);
    expect(s.selected[0].basis).toBe("decision");
  });

  it("lapses when the Red List renames the species, or cites other authors", () => {
    expect(select(input, rel, decision({ redlistName: "Centropogon other" })).toReview).toBe("decision lapsed (name)");
    expect(select(input, rel, decision({ redlistAuthority: "Gaudich." })).toReview).toBe("decision lapsed (citation)");
  });

  it("lapses when its record is gone, or names another assessed species", () => {
    const gone = decision({ rows: [{ ...decision().rows[0], id: "NOPE", authorship: "Somebody" }] });
    expect(select(input, rel, gone).toReview).toBe("decision lapsed (record not found)");
    const assessed = release([acc(waspfish)], ["Centropogon australis", "Centropogon other"]);
    const other = decision({ rows: [{ ...decision().rows[0], species: "Centropogon other" }] });
    expect(select(input, assessed, other).toReview).toBe("decision lapsed (assessed name)");
  });

  it("finds a record whose id moved, by name, status, species and an equal authorship", () => {
    const moved = decision({ rows: [{ ...decision().rows[0], id: "OLD" }] });
    expect(ids(select(input, rel, moved))).toEqual(["5XHD2:is"]);
  });

  it("is listed when its candidates changed, or it isn't reviewed", () => {
    expect(select(input, rel, decision({ candidates: [] })).toReview).toBe("decision's candidates changed (Centropogon australis)");
    expect(select(input, rel, decision({ by: "someone", reviewed: false })).toReview).toBe("decision not yet reviewed (someone)");
    expect(select(input, rel, decision({ by: "fixture", reviewed: false })).toReview).toBeNull();
  });

  it("not in CoL: holds with no records", () => {
    expect(select(input, rel, decision({ rows: [] }))).toMatchObject({ step: 1, reason: "decision: not in CoL", selected: [] });
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

  it("a judge's verdict applies only while its answer is the rules': confirmed takes the species off the review list, undecided adds the doubt", () => {
    const leo = sp("L", "Panthera leo", "(Linnaeus, 1758)");
    const a = species("Panthera leo", "(Gray, 1867)", acc(leo));  // other authors: listed
    const r = release() as Omit<Release, "wholeBySteps">;
    const basis = verdictBasis(a, selectEvery([a], r, new Map())[0]);
    const c = (answer: string, verdict: "confirmed" | "undecided" = "confirmed", b = basis) =>
      new Map([[1, { sis: 1, redlistName: "Panthera leo", verdict, answer, basis: b, votes: "3/5 rules; 2/5 other", by: "judge:m", date: "2026-11-24", transcripts: [], context: "" }]]);
    const L = "Panthera leo linnaeus 1758 [accepted, of Panthera leo]: is", X = "Panthera leo linnaeus 1758 [synonym, of Panthera leo]: is";
    expect(selectEvery([a], r, new Map())[0].toReview).toMatch(/^other authors/);
    expect(selectEvery([a], r, new Map(), c(L))[0].toReview).toBeNull();
    expect(selectEvery([a], r, new Map(), c(X))[0].toReview).toMatch(/^other authors/);
    const u = selectEvery([a], r, new Map(), c(L, "undecided"))[0];
    expect(u.doubts).toEqual(["other authors", "judge undecided"]);
    expect(u.toReview).toBe("judge undecided (3/5 rules; 2/5 other)");
    expect(u.selected.map((x) => x.record.id)).toEqual(["L"]);
    expect(selectEvery([a], r, new Map(), c(X, "undecided"))[0].doubts).toEqual(["other authors"]);
    // A release that renumbers the record keeps the verdict.
    const moved = species("Panthera leo", "(Gray, 1867)", acc({ ...leo, id: "L2" }));
    expect(selectEvery([moved], r, new Map(), c(L))[0].toReview).toBeNull();
    // A new synonym, candidate or doubt changes what it was given: the verdict no longer applies.
    const synonym = { ...a, synonyms: [{ name: "Felis leo", authors: ["Linnaeus, 1758"] }] };
    expect(selectEvery([synonym], r, new Map(), c(L))[0].toReview).toMatch(/^other authors/);
    expect(selectEvery([a], r, new Map(), c(L, "confirmed", "something else"))[0].toReview).toMatch(/^other authors/);
  });
});

describe("jury notes", () => {
  it("say what an AI jury's check found, in words", async () => {
    const { juryVotes } = await import("../sync/link/assessment-link");
    expect(juryVotes("2/2 rules")).toBe("2 independent runs agreed with the rules");
    expect(juryVotes("3/5 rules; 1/5 can't tell; 1/5 other")).toBe("3 of 5 independent runs agreed with the rules, 1 couldn't tell, 1 gave another answer");
  });
  it("a confirmed or undecided verdict keeps the species' doubts and adds the check to its note", async () => {
    const { matchNote } = await import("../sync/link/assessment-link");
    const leo = sp("L", "Panthera leo", "(Linnaeus, 1758)");
    const a = species("Panthera leo", "(Gray, 1867)", acc(leo));
    const r = release() as Omit<Release, "wholeBySteps">;
    const s0 = selectEvery([a], r, new Map())[0];
    const v = (verdict: "confirmed" | "undecided", votes: string) => new Map([[1, { sis: 1, redlistName: "Panthera leo", verdict,
      answer: "Panthera leo linnaeus 1758 [accepted, of Panthera leo]: is", basis: verdictBasis(a, s0), votes, by: "judge:m", date: "2026-11-25", transcripts: [], context: "" }]]);
    const c = selectEvery([a], r, new Map(), v("confirmed", "2/2 rules"))[0];
    expect(c.doubts).toEqual(["other authors"]);
    expect(matchNote(c, a)!.note).toMatch(/Checked by an AI jury on 2026-11-25: 2 independent runs agreed with the rules; the doubt stands/);
    const u = selectEvery([a], r, new Map(), v("undecided", "3/5 rules; 2/5 other"))[0];
    expect(matchNote(u, a)!.note).toMatch(/Checked by an AI jury on 2026-11-25, which couldn't agree .* \(3 of 5 independent runs agreed with the rules, 2 gave another answer\)/);
  });
});
