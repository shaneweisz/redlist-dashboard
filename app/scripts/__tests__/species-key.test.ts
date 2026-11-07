/**
 * Every case that cost real data during this migration, as one table.
 *
 * Each row was a defect at some point: a threatened species showing a common
 * relative's occurrence count, or a species losing its own records to a guard
 * that was too strict. They are here together because they pull in opposite
 * directions, and any rule that gets one right by ignoring the others has been
 * tried and has failed.
 */
import { describe, it, expect } from "vitest";
import { sameOrganism, isSeparatelyAssessed, decideKey, epithetOf } from "../sync/link/species-key";

const CASES: Array<{ a: [string, string?]; b: [string, string?]; same: boolean; why: string }> = [
  // --- the same organism, renamed -------------------------------------------
  { a: ["Hylatomus pileatus", "(Linnaeus, 1758)"], b: ["Dryocopus pileatus", "(Linnaeus, 1758)"],
    same: true, why: "genus transfer, epithet kept — 156 records vs 5,371,684" },
  { a: ["Drepanis coccinea"], b: ["Vestiaria coccinea"],
    same: true, why: "genus transfer, no authorship needed" },
  { a: ["Pica nutalli", "(Audubon, 1837)"], b: ["Pica nuttallii", "(Audubon, 1837)"],
    same: true, why: "respelling, same author" },
  { a: ["Sminthopsis fuliginosa", "(Gould, 1852)"], b: ["Sminthopsis fuliginosus", "(Gould, 1852)"],
    same: true, why: "gender agreement — GBIF calls this VARIANT; refusing it lost 4,266 records" },
  { a: ["Nothofagus alessandrii", "Espinosa"], b: ["Nothofagus alessandri", "Espinosa"],
    same: true, why: "one letter, EN species" },
  { a: ["Keysseria helena", "(Cass.) Cass."], b: ["Keysseria helenae", "(Cass.) Cass."],
    same: true, why: "one letter, CR species" },
  { a: ["Solanum vallis-mexici"], b: ["Solanum × vallis-mexici"],
    same: true, why: "hybrid marker is notation, not a different plant" },

  // --- different organisms ---------------------------------------------------
  { a: ["Acacia koaia", "Hillebr."], b: ["Acacia koa", "A.Gray"],
    same: false, why: "two edits apart and different authors — the case that started this" },
  { a: ["Pseudophilautus abundus", "(Manamendra-Arachchi & Pethiyagoda, 2005)"],
    b: ["Pseudophilautus procax", "(Manamendra-Arachchi & Pethiyagoda, 2005)"],
    same: false, why: "congeners from one paper share an author string verbatim" },
  { a: ["Malus sieversii", "(Ledeb.) M.Roem."], b: ["Malus domestica", "(Suckow) Borkh."],
    same: false, why: "the wild apple is not the orchard apple" },
  { a: ["Sus bucculentus"], b: ["Sus scrofa"],
    same: false, why: "must never inherit 1.1M wild boar records" },
  { a: ["Pararge xiphioides"], b: ["Pararge aegeria"],
    same: false, why: "a Canary endemic is not a widespread European butterfly" },
  { a: ["Catapodium borgesii"], b: ["Catapodium marinum"],
    same: false, why: "an Azores endemic is not a widespread European grass" },
  { a: ["Copella arnoldi"], b: ["Copella carsevennensis"], same: false, why: "different fish" },
  { a: ["Meiostemon tetrandrus"], b: ["Combretum tetrandrum"], same: true, why: "genus transfer, epithet agreeing with the new gender" },
  { a: ["Sminthopsis fuliginosa"], b: ["Sminthopsis fuliginosus"], same: false, why: "same genus: a termination alone is the variant passes' call, not this one" },
];

describe("sameOrganism", () => {
  for (const c of CASES) {
    it(`${c.same ? "yes" : "no "}: ${c.a[0]} / ${c.b[0]} — ${c.why}`, () => {
      const a = { scientificName: c.a[0], authorship: c.a[1] };
      const b = { scientificName: c.b[0], authorship: c.b[1] };
      expect(sameOrganism(a, b)).toBe(c.same);
      expect(sameOrganism(b, a)).toBe(c.same); // symmetric
    });
  }

  it("treats a missing authorship as no evidence, not as agreement", () => {
    // Two names with no author and different epithets must not pass on the
    // strength of both being blank.
    expect(sameOrganism({ scientificName: "Genus alpha" }, { scientificName: "Genus beta" })).toBe(false);
  });
});

describe("epithetOf", () => {
  it("drops the hybrid marker", () => {
    expect(epithetOf("Solanum × vallis-mexici")).toBe("vallis-mexici");
    expect(epithetOf("Solanum vallis-mexici")).toBe("vallis-mexici");
  });
});

describe("isSeparatelyAssessed", () => {
  const assessed = new Set(["actinodaphne latifolia", "actinodaphne nitida"]);
  it("refuses a lump onto another assessed species", () => {
    expect(isSeparatelyAssessed("Actinodaphne nitida", "Actinodaphne latifolia", assessed)).toBe(true);
  });
  it("does not treat a species' own name as somebody else's", () => {
    expect(isSeparatelyAssessed("Actinodaphne latifolia", "Actinodaphne latifolia", assessed)).toBe(false);
  });
  it("allows a rename onto a name nobody else is assessed under", () => {
    expect(isSeparatelyAssessed("Pica nuttallii", "Pica nutalli", assessed)).toBe(false);
  });
});

describe("decideKey", () => {
  const none = new Set<string>();

  it("takes the accepted key when it is the same organism", () => {
    const d = decideKey({
      species: { scientificName: "Hylatomus pileatus", authorship: "(Linnaeus, 1758)" },
      reachedBy: "canonical",
      usage: { key: "VLCNP", scientificName: "Hylatomus pileatus", authorship: "(Linnaeus, 1758)" },
      acceptedUsage: { key: "37VD2", scientificName: "Dryocopus pileatus", authorship: "(Linnaeus, 1758)" },
      assessedNames: none,
    });
    expect(d).toMatchObject({ key: "37VD2", verdict: "own" });
  });

  it("keeps a lumped species' own usage when reached by its own name", () => {
    const d = decideKey({
      species: { scientificName: "Malus sieversii", authorship: "(Ledeb.) M.Roem." },
      reachedBy: "canonical",
      usage: { key: "9Y3S3", scientificName: "Malus sieversii", authorship: "(Ledeb.) M.Roem." },
      acceptedUsage: { key: "OTHER", scientificName: "Malus domestica", authorship: "(Suckow) Borkh." },
      assessedNames: none,
    });
    expect(d).toMatchObject({ key: "9Y3S3", verdict: "lumped", lumpedInto: "Malus domestica" });
  });

  it("keeps nothing when the usage was reached through a synonym", () => {
    const d = decideKey({
      species: { scientificName: "Catapodium borgesii" },
      reachedBy: "synonym",
      usage: { key: "MARINUM", scientificName: "Catapodium marinum" },
      assessedNames: none,
    });
    expect(d).toMatchObject({ key: null, verdict: "refused" });
    expect(d.reason).toMatch(/synonym/);
  });

  it("never takes the key of another species the Red List assesses", () => {
    // Actinodaphne latifolia (CR) and A. nitida are both assessed. CoL folds the
    // first into the second; taking that key made a CR species display the
    // other's records, and left whichever lost the race with nothing at all.
    // Keeping its own usage is the only answer that is right for both.
    const d = decideKey({
      species: { scientificName: "Actinodaphne latifolia" },
      reachedBy: "canonical",
      usage: { key: "K1", scientificName: "Actinodaphne latifolia" },
      acceptedUsage: { key: "K2", scientificName: "Actinodaphne nitida" },
      assessedNames: new Set(["actinodaphne latifolia", "actinodaphne nitida"]),
    });
    expect(d.key).not.toBe("K2");
    expect(d).toMatchObject({ key: "K1", verdict: "lumped", lumpedInto: "Actinodaphne nitida" });
  });

  it("refuses the shared key when CoL calls them one organism but both are assessed", () => {
    // Same shape, but here CoL's rename is credible (same epithet), so the two
    // species would otherwise be handed the same key and one would lose it.
    const d = decideKey({
      species: { scientificName: "Xyrichtys trivittatus" },
      reachedBy: "canonical",
      usage: { key: "K1", scientificName: "Xyrichtys trivittatus" },
      acceptedUsage: { key: "K2", scientificName: "Iniistius trivittatus" },
      assessedNames: new Set(["xyrichtys trivittatus", "iniistius trivittatus"]),
    });
    expect(d).toMatchObject({ key: null, verdict: "refused" });
  });

  it("keeps a species' own usage when CoL demotes it to a subspecies", () => {
    // CoL ranks Fringilla polatzeki (EN) a subspecies of F. teydea. The Red List
    // assesses it as a species, so it keeps its own usage and is counted directly
    // — a subspecies key is never emitted by a facet over species-rank usages.
    //
    // sameOrganism says no here, because the second word is what names the
    // organism in a binomial and "teydea" is not "polatzeki". A deleted rule used
    // to compare the LAST word instead, which said yes; this asserts the outcome
    // is right either way, since the canonical-name branch keeps the key.
    const d = decideKey({
      species: { scientificName: "Fringilla polatzeki", authorship: "Hartert, 1905" },
      reachedBy: "canonical",
      usage: { key: "OWN", scientificName: "Fringilla polatzeki", authorship: "Hartert, 1905" },
      acceptedUsage: { key: "PARENT", scientificName: "Fringilla teydea polatzeki", authorship: "Hartert, 1905" },
      assessedNames: none,
    });
    expect(d).toMatchObject({ key: "OWN", verdict: "lumped" });
    expect(d.key).not.toBe("PARENT");
  });

  it("does not follow a demotion onto a parent the Red List assesses separately", () => {
    // Fringilla teydea is itself assessed. Taking the parent's key would give a
    // species its relative's records and leave the relative with none.
    const d = decideKey({
      species: { scientificName: "Fringilla polatzeki", authorship: "Hartert, 1905" },
      reachedBy: "canonical",
      usage: { key: "OWN", scientificName: "Fringilla polatzeki", authorship: "Hartert, 1905" },
      acceptedUsage: { key: "PARENT", scientificName: "Fringilla teydea", authorship: "Webb, Berthelot & Moquin-Tandon, 1841" },
      assessedNames: new Set(["fringilla polatzeki", "fringilla teydea"]),
    });
    expect(d.key).not.toBe("PARENT");
  });
});
