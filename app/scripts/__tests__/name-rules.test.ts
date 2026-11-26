/**
 * name-rules test: the name functions docs/specs/matching.md is written against
 * (scripts/sync/link/name-rules.ts): when two spellings are one name, when two
 * names are one organism, and when a CoL synonym only respells its species.
 *
 * Every positive case is a real name pair that CoL and the Red List spell
 * differently; every negative a real pair that must NOT be swept up. The
 * negatives matter more: a missed variant leaves a species unmatched, which shows;
 * a wrong match silently hands one species' records to another.
 */
import { describe, it, expect } from "vitest";
import { canonicalEpithet, orthographicallySame, orthographicKey, sameOrganism, isCoLRespelling, epithetOf, respelling,
  genderEnding, sameName, MAX_TYPO_LETTERS } from "../sync/link/name-rules";
import { speciesNameParts } from "../../src/lib/name-parts";

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

describe("sameOrganism: cases that cost real data", () => {
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

describe("speciesNameParts", () => {
  it("drops a parenthesised subgenus", () => {
    // CoL prints Ochotona pallasi with its subgenus; the Red List doesn't.
    expect(speciesNameParts("Ochotona (Pika) pallasi")).toEqual(["ochotona", "pallasi"]);
  });

  it("drops the hybrid sign but keeps a literal ASCII x", () => {
    expect(speciesNameParts("Agave × peacockii")).toEqual(["agave", "peacockii"]);
    // "xanthina" must survive intact — stripping ASCII x would corrupt it.
    expect(speciesNameParts("Aloe xanthina")).toEqual(["aloe", "xanthina"]);
  });

  it("declines anything that is not a binomial", () => {
    expect(speciesNameParts("Ochotona")).toBeNull();
    expect(speciesNameParts("Ochotona pallasi hamica")).toBeNull();
    expect(speciesNameParts("")).toBeNull();
  });
});

describe("canonicalEpithet", () => {
  it("collapses a doubled terminal i without stripping the patronymic i", () => {
    expect(canonicalEpithet("pallasii")).toBe("pallasi");
    expect(canonicalEpithet("pallasi")).toBe("pallasi");
  });

  it("never reduces an epithet to nothing", () => {
    // Without the length guard these would all normalise to "" and so to each other.
    expect(canonicalEpithet("ova")).not.toBe("");
    expect(canonicalEpithet("us")).toBe("us");
    expect(canonicalEpithet("a")).toBe("a");
  });
});

/**
 * orthographicallySame — spellings of one name, used to corroborate a candidate
 * some other source has already produced (the CoL-revision flag).
 *
 * Every positive below is a real Red List assessment that the dashboard reported
 * as having NO Catalogue of Life match while its own gbif_species_key pointed at
 * a CoL record holding the same name differently spelled. 124 assessments were
 * in that state; 86 of them are these.
 *
 * The negatives are the reason this rule is never allowed to decide alone. They
 * are cases a names-only rule must refuse, and they must keep
 * failing here — a looser rule that swallowed them would launder GBIF's fuzzy
 * matching into an assertion about CoL.
 */
describe("orthographicallySame — spellings the codes call one name", () => {
  const same: [string, string, string][] = [
    // The case that started this: Rudolf Pungeler's name, transliterated by IUCN
    // and stripped of its diaeresis by CoL. CoL X8JX, accepted, in the checklist,
    // and we were reporting "No CoL match".
    ["umlaut transliterated vs dropped", "Colostygia puengeleri", "Colostygia pungeleri"],
    ["ij is Dutch for y", "Daphniphyllum teysmannii", "Daphniphyllum teijsmannii"],
    ["i / y interchange, ICN 60.7", "Gagea elliptica", "Gagea ellyptica"],
    ["doubled consonant, ICN 60.1", "Cestrum strigilatum", "Cestrum strigillatum"],
    ["doubled consonant, ICN 60.1", "Inga vilosissima", "Inga villosissima"],
    ["doubled i inside the epithet", "Iva xanthifolia", "Iva xanthiifolia"],
    ["doubled i inside the epithet", "Weinmannia paulliniifolia", "Weinmannia paullinifolia"],
    // The -i / -ii / -ei family: Rec. 60C.1 gives -i for a personal name ending
    // in a vowel or -er and -ii for one ending in a consonant, and ICN 60.12
    // makes the wrong choice an error to be CORRECTED. One man, one name.
    ["personal-name termination, -ii / -ei", "Chionanthus holdridgii", "Chionanthus holdridgei"],
    ["personal-name termination, -ii / -ei", "Sterculia cheekii", "Sterculia cheekei"],
    ["personal-name termination, -i / -ei", "Quercus augustinei", "Quercus augustini"],
    // Reclassified from a negative while writing this. #490 called it "an
    // inserted syllable", but there is no inserted syllable: La Billardiere's
    // name ends in a vowel, so -ei is the regular termination and -eri treats it
    // as ending in -er. Same person, same name, wrong connecting vowel.
    ["personal-name termination, -i / -ei", "Agathis labillardieri", "Agathis labillardierei"],
    ["hyphen carries no weight", "Solanum rudepannum", "Solanum rude-pannum"],
    ["hyphen carries no weight", "Xylopia le-testui", "Xylopia letestui"],
    ["identical names are trivially the same", "Panthera leo", "Panthera leo"],
  ];
  for (const [why, iucn, col] of same) {
    it(`${why}: ${iucn} = ${col}`, () => {
      expect(orthographicallySame(iucn, col)).toBe(true);
      expect(orthographicallySame(col, iucn)).toBe(true); // symmetric
    });
  }

  it("folds Latin terminations too, which the codes deem one name", () => {
    for (const [a, b] of [["Ochotona pallasii", "Ochotona pallasi"],
                          ["Sminthopsis fuliginosa", "Sminthopsis fuliginosus"],
                          ["Allium lefkadensis", "Allium lefkadense"]]) {
      expect(orthographicallySame(a, b), `${a} / ${b}`).toBe(true);
    }
  });
});

describe("orthographicallySame — differences no folding may erase", () => {
  const different: [string, string, string][] = [
    // GBIF's index put this Red List assessment on Agrotis sabura Mabille, 1888
    // — a different name, and a synonym.
    ["GBIF's fuzzy matcher reaching past the name", "Agrotis sabine", "Agrotis sabura"],
    ["a genus transfer is a taxonomic act", "Agrochola kindermannii", "Anchoscelis kindermanni"],
    ["different species in one genus", "Ochotona pallasii", "Ochotona curzoniae"],
    ["a subspecies is a different rank", "Ochotona pallasii", "Ochotona pallasi hamica"],
    // -ae is where the termination folding STOPS: it honours a different person
    // (or corrects which one), which no code calls a spelling. Folding the
    // trailing "i" away outright would equate all of these.
    ["patronymic gender is not a termination", "Asparagus faulknerae", "Asparagus faulkneri"],
    ["patronymic gender is not a termination", "Acrogomphus walshi", "Acrogomphus walshae"],
    ["patronymic gender is not a termination", "Ceratinopsis dippenaari", "Ceratinopsis dippenaarae"],
    ["patronymic gender is not a termination", "Ephedra fedtschenkoae", "Ephedra fedtschenkoi"],
    // Reported, and refused on purpose. CoL holds NO record named Andrena
    // juliana at any status; only GBIF's fuzzy matcher connects it to CoL's
    // Andrena julliani (a synonym of Andrena mucida). juliana is a feminine
    // form and julliani a masculine genitive of a different stem — no code makes
    // them one name, so this needs evidence neither signal supplies.
    ["a feminine form is not a masculine genitive", "Andrena juliana", "Andrena julliani"],
  ];
  for (const [why, a, b] of different) {
    it(`${why}: ${a} != ${b}`, () => {
      expect(orthographicallySame(a, b)).toBe(false);
      expect(orthographicallySame(b, a)).toBe(false);
    });
  }

  it("does not let folding collapse real congeners together", () => {
    // The danger of a looser rule: dropping doubled letters and equating i/y
    // must not make distinct epithets equal.
    expect(orthographicallySame("Acacia alba", "Acacia albida")).toBe(false);
    expect(orthographicallySame("Allium nigrum", "Allium nigricans")).toBe(false);
    expect(orthographicallySame("Panthera leo", "Panthera onca")).toBe(false);
  });

  it("keeps the genus, which no orthographic rule may cross", () => {
    // Same epithet, different genus — a transfer, which needs synonymy evidence.
    // This rule has none.
    expect(orthographicallySame("Aplexa elongata", "Sibirenauta elongata")).toBe(false);
  });
});

describe("orthographicKey", () => {
  it("is null for anything that is not a binomial", () => {
    expect(orthographicKey("Colostygia")).toBeNull();
    expect(orthographicKey("Colostygia puengeleri stertzi")).toBeNull();
    expect(orthographicKey("")).toBeNull();
  });

  it("never folds a name part away to nothing", () => {
    // "Ii ii" folds to "i i", not to "" — otherwise every short name keys alike.
    expect(orthographicKey("Ii ii")).toBe("i i");
    expect(orthographicKey("Yy yy")).toBe("i i");
  });

  it("folds spelling, not only terminations, which is why it is never used alone", () => {
    expect(orthographicallySame("Iva xanthifolia", "Iva xanthiifolia")).toBe(true);
  });
});

describe("respelling: the spec's rule", () => {
  it("takes a gender ending, including -er / -ra / -rum and -tor / -trix", () => {
    expect(genderEnding("niger", "nigrum")).toBe(true);
    expect(genderEnding("ruber", "rubra")).toBe(true);
    expect(genderEnding("simulator", "simulatrix")).toBe(true);
    expect(genderEnding("fuliginosa", "fuliginosus")).toBe(true);
    expect(genderEnding("alba", "albida")).toBe(false);
  });

  it("takes a genitive ending, the longest that fits", () => {
    expect(respelling("jamesi", "jamesorum", "lepilemur")).toBe(true);
    expect(respelling("smithii", "smithiae", "genus")).toBe(true);
  });

  it(`takes at most ${MAX_TYPO_LETTERS} letters' difference, and no more`, () => {
    expect(respelling("nutalli", "nuttallii", "pica")).toBe(true);
    // Three letters apart: two words from one paper (Drimys confertifolia / confertiflora).
    expect(respelling("confertifolia", "confertiflora", "drimys")).toBe(false);
  });
});

describe("sameOrganism", () => {
  it("needs equal authorships for a respelling within a genus", () => {
    expect(sameOrganism({ scientificName: "Lepilemur jamesorum", authorship: "Louis Jr. et al., 2006" },
      { scientificName: "Lepilemur jamesi", authorship: "Louis Jr. et al., 2006" })).toBe(true);
    expect(sameOrganism({ scientificName: "Lepilemur jamesorum" }, { scientificName: "Lepilemur jamesi" })).toBe(false);
  });

  it("keeps a snake and a king cobra apart: different genera, epithets not a gender ending", () => {
    expect(sameOrganism({ scientificName: "Hoplocephalus bungaroides", authorship: "(Schlegel, 1837)" },
      { scientificName: "Ophiophagus bungarus", authorship: "(Schlegel, 1837)" })).toBe(false);
  });
});

describe("isCoLRespelling", () => {
  it("is one genus, the same citation, two epithets that are a respelling", () => {
    expect(isCoLRespelling({ scientificName: "Meandrina danae", authorship: "(Milne Edwards & Haime, 1848)" },
      { scientificName: "Meandrina danai", authorship: "(Milne Edwards & Haime, 1848)" })).toBe(true);
    expect(isCoLRespelling({ scientificName: "Clithon oualaniensis", authorship: "(Lesson, 1831)" },
      { scientificName: "Clithon oualaniense", authorship: "(Lesson, 1831)" })).toBe(true);
  });
  it("reads f. and fil. as one, and ignores diacritics", () => {
    expect(isCoLRespelling({ scientificName: "Genus alba", authorship: "Hook.f." }, { scientificName: "Genus albus", authorship: "Hook.fil." })).toBe(true);
  });
  it("isn't a respelling across genera, between other citations, or of the same epithet", () => {
    expect(isCoLRespelling({ scientificName: "Meandrina danae", authorship: "A" }, { scientificName: "Meandrina danai", authorship: "B" })).toBe(false);
    expect(isCoLRespelling({ scientificName: "Aria danae", authorship: "A" }, { scientificName: "Meandrina danai", authorship: "A" })).toBe(false);
    expect(isCoLRespelling({ scientificName: "Meandrina danai", authorship: "A" }, { scientificName: "Meandrina danai", authorship: "A" })).toBe(false);
  });
});

describe("sameName", () => {
  it("is case, × and whitespace blind (tabs too)", () => {
    expect(sameName("Mentha × verticillata", "mentha verticillata")).toBe(true);
    expect(sameName("Hyla  cinerascens", "Hyla\tcinerascens")).toBe(true);
    expect(sameName("Hyla cinerascens", "Hyla cinerea")).toBe(false);
  });
});
