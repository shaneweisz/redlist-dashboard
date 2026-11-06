/**
 * Named matching cases. Each one is a species that once showed the wrong
 * number, or a rule written because of one. See check-fixtures.ts.
 *
 * `name` is the assessed species' IUCN name. Cases about the Not Evaluated
 * list name the CoL species to look for in `expect.neListed`.
 */

export interface MatchCase {
  name: string;
  /** What goes wrong without the rule, in a sentence. */
  why: string;
  /** Where the rule or the case lives in today's code. */
  source: string;
  expect: {
    assessed?: boolean;
    /** Accepted CoL name of the species it is linked to; null = no link. */
    linkedTo?: string | null;
    /** CoL name of the GBIF key the app counts and links to; null = no key. */
    gbifKeyName?: string | null;
    hasRecords?: boolean;
    minRecords?: number;
    /** Caps a count that once borrowed a broader taxon's records. */
    maxRecords?: number;
    /** CoL species name → whether the NE list shows it. */
    neListed?: Record<string, boolean>;
  };
}

export const MATCHING_CASES: MatchCase[] = [
  // ── One organism under two names ───────────────────────────────────────────
  {
    name: "Hylatomus pileatus",
    why: "IUCN's genus for the Pileated Woodpecker; GBIF files its 5.4M records under Dryocopus pileatus. Ranking keys by match order showed 156.",
    source: "species-key.ts sameOrganism; build-read-models.ts species_gbif (the GBIF key)",
    expect: { gbifKeyName: "Dryocopus pileatus", minRecords: 1_000_000, neListed: { "Dryocopus pileatus": false } },
  },
  {
    name: "Drepanis coccinea",
    why: "Same bird as CoL's Vestiaria coccinea: a genus move with the epithet unchanged.",
    source: "species-key.ts sameOrganism",
    expect: { linkedTo: "Vestiaria coccinea", gbifKeyName: "Vestiaria coccinea", hasRecords: true },
  },
  {
    name: "Pica nutalli",
    why: "Spelling variant of nuttallii (same authorship, one edit).",
    source: "species-key.ts sameOrganism",
    expect: { hasRecords: true, neListed: { "Pica nuttallii": false } },
  },
  {
    name: "Sminthopsis fuliginosa",
    why: "Gender agreement: CoL spells it fuliginosus.",
    source: "name-variants.ts; accept-match.ts; decisions.tsv",
    expect: { hasRecords: true },
  },
  {
    name: "Ochotona pallasii",
    why: "Patronymic -ii vs CoL's -i.",
    source: "name-variants.ts; accept-match.ts; decisions.tsv",
    expect: { hasRecords: true },
  },
  {
    name: "Solanum vallis-mexici",
    why: "CoL writes the hybrid marker (Solanum × vallis-mexici); same plant.",
    source: "species-key.ts",
    expect: { hasRecords: true },
  },
  {
    name: "Colostygia puengeleri",
    why: "CoL spells it pungeleri (both for Püngeler). Accepted by pass 7 only because the GBIF key and the spelling rule agree.",
    source: "accept-match.ts; name-variants.ts",
    expect: { hasRecords: true },
  },
  {
    name: "Agelaius phoeniceus",
    why: "Without classification context GBIF's matcher backed off to the genus and the bird lost its 20M records.",
    source: "build-matches.ts (the classification hints)",
    expect: { gbifKeyName: "Agelaius phoeniceus", minRecords: 1_000_000 },
  },
  {
    name: "Verreauxia africana",
    why: "Linked to CoL's non-Base Verreauxia africana; its IUCN synonym Sasia africana is CoL's Base name for the same bird and must not reappear as Not Evaluated.",
    source: "build-link.ts covered rows",
    expect: { linkedTo: "Verreauxia africana", hasRecords: true, neListed: { "Sasia africana": false } },
  },
  {
    name: "Andropogon virginicus",
    why: "Has an ambiguous synonym in CoL; the breakdown once reported it under whichever target the scan reached first.",
    source: "col-breakdown.ts syn_in_checklist",
    expect: { linkedTo: "Andropogon virginicus", hasRecords: true },
  },

  // ── Two organisms that look alike ──────────────────────────────────────────
  {
    name: "Pseudophilautus abundus",
    why: "Shares authorship with P. procax; authorship alone matched them and abundus (EN) showed procax's records.",
    source: "species-key.ts sameOrganism; build-link.ts",
    // IUCN also lists "Philautus  procax" (sic, double space) as a synonym of
    // abundus, so procax stays off the NE list once the space is normalised.
    // Its records still don't count for abundus.
    expect: { linkedTo: "Pseudophilautus abundus", gbifKeyName: "Pseudophilautus abundus", maxRecords: 100, neListed: { "Pseudophilautus procax": false } },
  },
  {
    name: "Acacia koaia",
    why: "Two edits from Acacia koa but a different author: a different tree. Must not show koa's records.",
    source: "species-key.ts sameOrganism",
    expect: { gbifKeyName: "Acacia koaia", maxRecords: 1_000 },
  },
  {
    name: "Copella arnoldi",
    why: "Different fish from Copella carsevennensis.",
    source: "species-key.test.ts",
    expect: { gbifKeyName: "Copella arnoldi" },
  },
  {
    name: "Agrotis sabine",
    why: "GBIF's matcher put it on Agrotis sabura Mabille, 1888 — neither that name nor a spelling of it (#490).",
    source: "accept-match.ts; name-variants.ts",
    expect: { linkedTo: null, gbifKeyName: null },
  },

  // ── Lumped: a synonym in CoL keeps its own records ─────────────────────────
  {
    name: "Malus sieversii",
    why: "CoL lumps it into Malus domestica; it showed 146,340 of the apple's records instead of its own ~8,000.",
    source: "build-read-models.ts ownedUsages",
    expect: { linkedTo: "Malus domestica", gbifKeyName: "Malus sieversii", hasRecords: true, maxRecords: 30_000 },
  },
  {
    name: "Thymallus aeliani",
    why: "Lumped; showed 73,641 records instead of its own handful.",
    source: "build-read-models.ts ownedUsages",
    expect: { gbifKeyName: "Thymallus aeliani", maxRecords: 1_000 },
  },
  {
    name: "Epilobium numidicum",
    why: "Lumped; showed 295,698 records instead of its own (none georeferenced).",
    source: "build-read-models.ts ownedUsages",
    expect: { maxRecords: 100 },
  },
  {
    name: "Pararge xiphioides",
    why: "Lumped into Pararge aegeria; its own usage sat outside every facet and it showed 0.",
    source: "build-read-models.ts ownedUsages",
    expect: { linkedTo: "Pararge aegeria", gbifKeyName: "Pararge xiphioides", hasRecords: true },
  },
  {
    name: "Fringilla polatzeki",
    why: "A subspecies of F. teydea in CoL, so no species facet emits its key; it showed 0.",
    source: "build-read-models.ts ownedUsages",
    // Its own records (about 715), not the 7,000+ of F. teydea, and not its
    // synonym's records twice (it showed 1,430 when the synonym sat under both
    // of its roots).
    expect: { linkedTo: "Fringilla teydea", hasRecords: true, maxRecords: 1_000 },
  },
  {
    name: "Meandrina danae",
    why: "CoL's synonym of M. danai with the same citation: one name spelled two ways. The Red List's citation is mistyped (\"Milen-Edwards & Haime, 1948\"), so the name rules called it lumped and counted 86 of its 2,200 records.",
    source: "species-key.ts isCoLRespelling; build-link.ts",
    expect: { linkedTo: "Meandrina danai", gbifKeyName: "Meandrina danai", minRecords: 1_500 },
  },
  {
    name: "Clithon oualaniensis",
    why: "CoL holds the name three times under different citations; only one is the respelling of C. oualaniense, and the tiebreak picked another (1 record of 201).",
    source: "build-link.ts ownNameSynonyms",
    expect: { linkedTo: "Clithon oualaniense", minRecords: 100 },
  },
  {
    name: "Cipangopaludina chinensis",
    why: "Provisionally accepted under exactly this name, and also an ambiguous synonym of Margarya chinensis; the ambiguous synonym won and counted 448 records.",
    source: "build-link.ts offer kind 4",
    expect: { linkedTo: "Cipangopaludina chinensis", minRecords: 2_000 },
  },
  {
    name: "Vicia grandiflora",
    why: "Its IUCN synonym Vicia kitaibeliana is a CoL ambiguous synonym also filed under V. cracca. Ambiguous says nothing about V. cracca, which prod kept off the NE list (871k records).",
    source: "build-link.ts covered rows (kinds 0-2 only)",
    expect: { neListed: { "Vicia cracca": true } },
  },
  {
    name: "Centropogon australis",
    why: "A waspfish, and also a plant. IUCN's class (Actinopterygii) isn't CoL's (Teleostei), so the homonym tiebreak fell through to id order and linked the plant (8 records).",
    source: "build-link.ts tiebreak (phylum, kingdom)",
    expect: { gbifKeyName: "Centropogon australis", minRecords: 1_500 },
  },
  {
    name: "Acanthurus lineatus",
    why: "A surgeonfish whose IUCN synonym Hepatus lineatus is, in CoL, a crab: Hepatus was a fish genus and a crab genus. The shared epithet passed as a genus transfer and the crab's records were counted.",
    source: "build-link.ts sameLineage",
    expect: { linkedTo: "Acanthurus lineatus", neListed: { "Hepatus lineatus": true } },
  },
  {
    name: "Utricularia ochroleuca",
    why: "CoL holds it twice, once with the hybrid sign (Utricularia × ochroleuca, 7,000 records) and once without (none). Twins are matched with the hybrid sign set aside.",
    source: "build-link.ts twinKeys",
    expect: { minRecords: 5_000 },
  },
  {
    name: "Frullania azorica",
    why: "Accepted in one liverwort family (61 records) and provisionally accepted in another (2,860). Twins within a class, not only a family.",
    source: "build-link.ts twinKeys",
    expect: { minRecords: 2_000 },
  },
  {
    name: "Cathormion umbellatum",
    why: "An XR species the checklist folds into Albizia umbellata, which has no records; GBIF files them under the XR name, which counted for nobody.",
    source: "build-link.ts checklist_demoted",
    expect: { linkedTo: "Albizia umbellata", minRecords: 500 },
  },
  {
    name: "Cladorhynchus leucocephalus",
    why: "The banded stilt (Vieillot, 1816). Its IUCN synonyms name Himantopus leucocephalus, which CoL has as the pied stilt (Gould, 1837); the shared epithet counted the pied stilt's 400k records.",
    source: "build-link.ts covered rows (authorsAgree)",
    expect: { maxRecords: 100_000 },
  },
  {
    name: "Zosterops simplex",
    why: "Owns the subspecies Z. japonicus simplex and the synonym Z. simplex filed under it; walking down from both counted the synonym's 571k records twice (1.14M).",
    source: "build-read-models.ts ownedUsages",
    expect: { linkedTo: "Zosterops japonicus", minRecords: 500_000, maxRecords: 700_000 },
  },
  {
    name: "Dasycercus hillieri",
    why: "CoL's Dasycercus cristicauda covers both IUCN species; each keeps its own records.",
    source: "build-col-revisions.ts",
    expect: { linkedTo: "Dasycercus cristicauda", gbifKeyName: "Dasycercus hillieri", hasRecords: true },
  },
  {
    name: "Dasycercus cristicauda",
    why: "The other half of the Dasycercus pair.",
    source: "build-col-revisions.ts",
    expect: { linkedTo: "Dasycercus cristicauda", gbifKeyName: "Dasycercus cristicauda", hasRecords: true },
  },
  {
    name: "Actinodaphne latifolia",
    why: "A CoL synonym of A. nitida, which IUCN assesses separately; latifolia (CR) showed nitida's records.",
    source: "species-key.ts isSeparatelyAssessed",
    expect: { gbifKeyName: "Actinodaphne latifolia", maxRecords: 100 },
  },
  {
    name: "Pleurobema furvum",
    why: "A CoL synonym of P. rubellum, assessed separately; furvum (CR) showed rubellum's records. Its own usage has records of its own.",
    source: "species-key.ts isSeparatelyAssessed",
    // Its own usage's 7 georeferenced records are all preserved specimens, which
    // don't count for animals, so it shows none; what matters is that it never
    // shows rubellum's.
    expect: { maxRecords: 100 },
  },
  {
    name: "Xyrichtys trivittatus",
    why: "A CoL synonym of Iniistius trivittatus, assessed separately; same shape as Pleurobema furvum.",
    source: "species-key.ts isSeparatelyAssessed",
    expect: { maxRecords: 100 },
  },
  {
    name: "Sus bucculentus",
    why: "Extinct; CoL synonymises it into Sus scrofa (LC). Must never show the wild boar's records.",
    source: "col-breakdown.ts; species-key.ts",
    expect: { linkedTo: "Sus scrofa", maxRecords: 10 },
  },
  {
    name: "Catapodium borgesii",
    why: "Azores endemic once matched via a synonym onto Catapodium marinum and shown its 19,901 records.",
    source: "build-read-models.ts ownedUsages; species-key.ts decideKey",
    expect: { maxRecords: 100 },
  },
  {
    name: "Octolobus angustatus",
    why: "Keys from a CoL join once handed it a broader taxon's records.",
    source: "derive-gbif-taxon-keys.ts",
    expect: { gbifKeyName: "Octolobus angustatus", maxRecords: 1_000 },
  },

  // ── Linked, so its records must show ───────────────────────────────────────
  {
    name: "Stenocranius raddei",
    why: "Checklist columns case: an XR-only claim once sent readers to a CoL page that didn't corroborate it.",
    source: "build-taxa.ts checklist columns",
    // GBIF's records for it are all preserved specimens, which don't count for mammals.
    expect: { linkedTo: "Stenocranius raddei" },
  },
  {
    name: "Hylomyscus anselli",
    why: "XR-only synonym case: a claim sourced from a record the curated release doesn't have.",
    source: "col-breakdown.ts",
    expect: { linkedTo: "Hylomyscus anselli" },
  },
  {
    name: "Mayaheros ericymba",
    why: "Its latest assessment is an amendment flagged latest=false and has to be forced in.",
    source: "build-assessments.ts FORCED_LATEST",
    expect: { assessed: true, linkedTo: "Mayaheros ericymba" },
  },
  {
    name: "Romankenkius pedderensis",
    why: "Turbellaria isn't a CoL class; the group's facet root came back empty.",
    source: "derive-gbif-taxon-keys.ts",
    expect: { linkedTo: "Romankenkius pedderensis" },
  },
  {
    name: "Arachnanthus oligopodus",
    why: "Penicillaria resolves as Ceriantharia in CoL; the root key had to follow.",
    source: "derive-gbif-taxon-keys.ts",
    expect: { gbifKeyName: "Arachnanthus oligopodus", hasRecords: true },
  },

  // ── Kept out of the Not Evaluated list ─────────────────────────────────────
  {
    name: "Miniopterus schreibersii",
    why: "CoL also has a provisionally accepted twin; it must not appear as Not Evaluated.",
    source: "build-link.ts twinKeys",
    expect: { hasRecords: true, neListed: { "Miniopterus schreibersii": false } },
  },
  {
    name: "Columba livia",
    why: "Provisionally accepted twin of the assessed Rock Dove.",
    source: "build-link.ts twinKeys; taxon-groups.ts NE_EXCLUDED",
    expect: { minRecords: 1_000_000, neListed: { "Columba livia": false } },
  },
  {
    name: "Homo sapiens",
    why: "IUCN leaves humans out of the Red List; CoL has them.",
    source: "taxon-groups.ts NE_EXCLUDED",
    expect: { assessed: false, neListed: { "Homo sapiens": false } },
  },
  {
    name: "Canis familiaris",
    why: "Domestic forms have a wild sibling counted separately.",
    source: "col-described-overrides.ts COL_DOMESTIC_EXCLUDE_NAMES",
    expect: { assessed: false, neListed: { "Canis familiaris": false, "Felis catus": false, "Bos taurus": false } },
  },
  {
    name: "Pycnonotus tricolor",
    why: "An XR over-split the curated checklist demotes; it showed as a spurious Not Evaluated bulbul.",
    source: "build-taxa.ts demoted",
    expect: { assessed: false, neListed: { "Pycnonotus tricolor": false } },
  },
  {
    name: "Brachistus stramoniifolius",
    why: "Assessed under an old genus; CoL's Witheringia stramoniifolia (stramonifolia in the release) is the same plant and must not reappear as Not Evaluated.",
    source: "build-taxa.ts checklist_name",
    expect: { linkedTo: "Witheringia stramoniifolia", neListed: { "Witheringia stramoniifolia": false } },
  },
  {
    name: "Syllepte belialis",
    why: "Unassessed, GBIF-observed only through BOLD barcode records (a BIN under the species): an ordinary NE species, so the list is checked for over-filtering, and BINs for being counted.",
    source: "build-taxa.ts BELOW_SPECIES",
    expect: { assessed: false, neListed: { "Syllepte belialis": true } },
  },
];
