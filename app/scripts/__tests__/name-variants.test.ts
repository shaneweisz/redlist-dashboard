/**
 * name-variants test: when two spellings are one name (sync/link/name-variants.ts),
 * which the CoL-revision flag and assessment-link.ts's twin and duplicate rules rely on.
 *
 * Every positive case is a real Red List assessment whose name CoL spells
 * differently. Every negative is a real case that must NOT be swept up: a
 * genus transfer, a doubled consonant, a patronymic gender change.
 *
 * The negatives matter more than the positives. A missed variant leaves one
 * species visibly unmatched, which is recoverable; a wrong match silently hands
 * one species' occurrence records and assessment to another.
 */
import { describe, it, expect } from "vitest";
import { canonicalEpithet, speciesNameParts, orthographicallySame, orthographicKey } from "../sync/link/name-variants";

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
