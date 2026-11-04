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
  /** Set when the expectation is the intended outcome and today's sync misses it. */
  knownBug?: string;
}

export const MATCHING_CASES: MatchCase[] = [
  // ── One organism under two names ───────────────────────────────────────────
  {
    name: "Hylatomus pileatus",
    why: "IUCN's genus for the Pileated Woodpecker; GBIF files its 5.4M records under Dryocopus pileatus. Ranking keys by match order showed 156.",
    source: "species-key.ts sameOrganism; build-parquet.ts chooseRepresentative",
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
    source: "name-variants.ts; build-matching.ts passes 4-6",
    expect: { hasRecords: true },
  },
  {
    name: "Ochotona pallasii",
    why: "Patronymic -ii vs CoL's -i.",
    source: "name-variants.ts; build-matching.ts passes 4-6",
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
    source: "build-matching.ts pass 7; name-variants.ts",
    expect: { hasRecords: true },
  },
  {
    name: "Agelaius phoeniceus",
    why: "Without classification context GBIF's matcher backed off to the genus and the bird lost its 20M records.",
    source: "match-redlist-species-to-gbif.ts",
    expect: { gbifKeyName: "Agelaius phoeniceus", minRecords: 1_000_000 },
  },
  {
    name: "Verreauxia africana",
    why: "Linked to CoL's non-Base Verreauxia africana; its IUCN synonym Sasia africana is CoL's Base name for the same bird and must not reappear as Not Evaluated.",
    source: "build-matching.ts iucn_synonym_covered",
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
    source: "species-key.ts sameOrganism; build-parquet.ts",
    expect: { linkedTo: "Pseudophilautus abundus", gbifKeyName: "Pseudophilautus abundus", neListed: { "Pseudophilautus procax": true } },
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
    source: "build-matching.ts pass 7; name-variants.ts",
    expect: { linkedTo: null, gbifKeyName: null },
    knownBug: "build-matching refuses the link, but phase 6 still gives it sabura's key and records",
  },

  // ── Lumped: a synonym in CoL keeps its own records ─────────────────────────
  {
    name: "Malus sieversii",
    why: "CoL lumps it into Malus domestica; it showed 146,340 of the apple's records instead of its own ~8,000.",
    source: "fetch-lumped-own-counts.ts",
    expect: { linkedTo: "Malus domestica", gbifKeyName: "Malus sieversii", hasRecords: true, maxRecords: 30_000 },
  },
  {
    name: "Thymallus aeliani",
    why: "Lumped; showed 73,641 records instead of its own handful.",
    source: "fetch-lumped-own-counts.ts",
    expect: { gbifKeyName: "Thymallus aeliani", maxRecords: 1_000 },
  },
  {
    name: "Epilobium numidicum",
    why: "Lumped; showed 295,698 records instead of its own (none georeferenced).",
    source: "fetch-lumped-own-counts.ts",
    expect: { maxRecords: 100 },
  },
  {
    name: "Pararge xiphioides",
    why: "Lumped into Pararge aegeria; its own usage sat outside every facet and it showed 0.",
    source: "fetch-lumped-own-counts.ts",
    expect: { linkedTo: "Pararge aegeria", gbifKeyName: "Pararge xiphioides", hasRecords: true },
  },
  {
    name: "Fringilla polatzeki",
    why: "A subspecies of F. teydea in CoL, so no species facet emits its key; it showed 0.",
    source: "fetch-lumped-own-counts.ts",
    // Its own records, not the 7,000+ of F. teydea.
    expect: { linkedTo: "Fringilla teydea", hasRecords: true, maxRecords: 3_000 },
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
    source: "match-redlist-species-to-gbif.test.ts",
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
    source: "fetch-lumped-own-counts.ts; species-key.ts decideKey",
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
    source: "build-backbone.ts checklist columns",
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
    source: "fetch-redlist-species.ts",
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
    source: "build-parquet.ts name-twin rule",
    expect: { hasRecords: true, neListed: { "Miniopterus schreibersii": false } },
  },
  {
    name: "Columba livia",
    why: "Provisionally accepted twin of the assessed Rock Dove.",
    source: "build-parquet.ts name-twin rule; taxonomy-constants.ts",
    expect: { minRecords: 1_000_000, neListed: { "Columba livia": false } },
  },
  {
    name: "Homo sapiens",
    why: "IUCN leaves humans out of the Red List; CoL has them.",
    source: "taxonomy-constants.ts, and six other places",
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
    source: "build-backbone.ts curated demotion",
    expect: { assessed: false, neListed: { "Pycnonotus tricolor": false } },
  },
  {
    name: "Brachistus stramoniifolius",
    why: "Assessed under an old genus; CoL's Witheringia stramoniifolia (stramonifolia in the release) is the same plant and must not reappear as Not Evaluated.",
    source: "build-matching.ts pass 2; build-backbone.ts checklist_name",
    expect: { linkedTo: "Witheringia stramoniifolia", neListed: { "Witheringia stramoniifolia": false } },
  },
  {
    name: "Pseudophilautus procax",
    why: "Unassessed: an ordinary Not Evaluated species, so the list is checked for over-filtering too.",
    source: "species-key.test.ts",
    expect: { assessed: false, neListed: { "Pseudophilautus procax": true } },
  },
];
