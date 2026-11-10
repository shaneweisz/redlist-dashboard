/**
 * Named matching cases. Each one is a species that once showed the wrong
 * number, or a rule written because of one. See check-fixtures.ts.
 *
 * `name` is the assessed species' IUCN name. Cases about the Not Evaluated
 * list name the CoL species to look for in `expect.neListed`.
 *
 * `confirmed` is the releases a case last passed on, and on which its `why` was
 * checked: where that why no longer (fully) holds there, it ends with an update. A case failing on those same releases is a regression in the code; one
 * failing on newer ones may be the data moving (CoL renamed the species, a
 * snapshot dropped records), and needs checking against the new releases, then
 * `confirmed` updated. The snapshot counts only for a case about records.
 */

/** The releases a case was last confirmed against. */
export interface Versions {
  /** The Red List release, e.g. "2026-1". */
  redlist: string;
  /** The CoL extended release linked against, e.g. "COL26.6 XR". */
  col: string;
  /** The GBIF occurrence snapshot counted, e.g. "2026-11-01". */
  snapshot: string;
}

/**
 * Every case below passed on the build of 10 November 2026, on these releases.
 * That is when each was last confirmed, not when it was first written: the cases
 * were added over several months, and the releases each was first checked on
 * weren't recorded.
 */
const NOVEMBER_2026: Versions = { redlist: "2026-1", col: "COL26.6 XR", snapshot: "2026-11-01" };

export interface MatchCase {
  name: string;
  /** The releases it last passed on, and on which its `why` was checked. */
  confirmed: Versions;
  /**
   * What goes wrong without the rule, in a sentence. Each was checked against
   * `confirmed`'s releases; where the situation it describes has changed since it
   * was written, an "Update (<yyyy-mm>, <release>):" sentence says what the data shows now.
   */
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
    source: "species-key.ts sameOrganism; dbt/models/count/record_counts.sql (the GBIF key)",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Dryocopus pileatus", minRecords: 1_000_000, neListed: { "Dryocopus pileatus": false } },
  },
  {
    name: "Drepanis coccinea",
    why: "Same bird as CoL's Vestiaria coccinea: a genus move with the epithet unchanged.",
    source: "species-key.ts sameOrganism",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Vestiaria coccinea", gbifKeyName: "Vestiaria coccinea", hasRecords: true },
  },
  {
    name: "Pica nutalli",
    why: "Spelling variant of nuttallii (same authorship, one edit). Update (2026-11, COL26.6 XR): CoL now spells the accepted name Pica nutallii and holds Pica nutalli as its own synonym, so the link goes through a CoL synonym rather than a respelling. Update (2026-11, COL26.6 XR): CoL also holds it, outside its curated core, as Pica nuttalli with no author and 121,763 records, which counted for nothing until the twin rule read respellings.",
    source: "species-key.ts sameOrganism",
    confirmed: NOVEMBER_2026,
    expect: { minRecords: 50_000, neListed: { "Pica nuttallii": false, "Pica nuttalli": false } },
  },
  {
    name: "Sminthopsis fuliginosa",
    why: "Gender agreement: CoL spells it fuliginosus. Update (2026-11, COL26.6 XR): CoL's fuliginosus spelling holds, but CoL now has it as a synonym of Sminthopsis griseoventer, so the link is a lump keeping the synonym's own records, not a plain gender variant.",
    source: "name-variants.ts; accept-match.ts (a spelling variant the codes allow)",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true },
  },
  {
    name: "Ochotona pallasii",
    why: "Patronymic -ii vs CoL's -i.",
    source: "name-variants.ts; accept-match.ts (a spelling variant the codes allow)",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true },
  },
  {
    name: "Solanum vallis-mexici",
    why: "CoL writes the hybrid marker (Solanum × vallis-mexici); same plant.",
    source: "species-key.ts",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true },
  },
  {
    name: "Colostygia puengeleri",
    why: "CoL spells it pungeleri (both for Püngeler). Accepted by pass 7 only because the GBIF key and the spelling rule agree. Update (2026-11, COL26.6 XR, #629): The spelling still differs; the matching passes were retired (#593, #629), and the matcher now returns the variant itself, which the acceptance rule takes.",
    source: "accept-match.ts; name-variants.ts",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true },
  },
  {
    name: "Agelaius phoeniceus",
    why: "Without classification context GBIF's matcher backed off to the genus and the bird lost its 20M records. Update (2026-11, COL26.6 XR): The homonym that drew the matcher off is still in CoL (a synonym in the mite genus Syringophilopsis), but the matcher is now asked with classification hints, so whether it would still back off without them can't be checked from a build.",
    source: "link/matches.ts (the classification hints)",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Agelaius phoeniceus", minRecords: 1_000_000 },
  },
  {
    name: "Verreauxia africana",
    why: "Linked to CoL's non-Base Verreauxia africana; its IUCN synonym Sasia africana is CoL's Base name for the same bird and must not reappear as Not Evaluated.",
    source: "link/assessment-link.ts covered rows",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Verreauxia africana", hasRecords: true, neListed: { "Sasia africana": false } },
  },
  {
    name: "Andropogon virginicus",
    why: "Has an ambiguous synonym in CoL; the breakdown once reported it under whichever target the scan reached first.",
    source: "col-breakdown.ts syn_in_checklist",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Andropogon virginicus", hasRecords: true },
  },

  // ── Two organisms that look alike ──────────────────────────────────────────
  {
    name: "Pseudophilautus abundus",
    why: "Shares authorship with P. procax; authorship alone matched them and abundus (EN) showed procax's records.",
    source: "species-key.ts sameOrganism; link/assessment-link.ts",
    // IUCN also lists "Philautus  procax" (sic, double space) as a synonym of
    // abundus, so procax stays off the NE list once the space is normalised.
    // Its records still don't count for abundus.
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Pseudophilautus abundus", gbifKeyName: "Pseudophilautus abundus", maxRecords: 100, neListed: { "Pseudophilautus procax": false } },
  },
  {
    name: "Acacia koaia",
    why: "Two edits from Acacia koa but a different author: a different tree. Must not show koa's records. Update (2026-11, COL26.6 XR): COL26.6 XR holds Acacia koaia as a synonym of A. koa, so the risk now runs through the lumped-synonym path rather than a near-name match; the different-author near-name still exists.",
    source: "species-key.ts sameOrganism",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Acacia koaia", maxRecords: 1_000 },
  },
  {
    name: "Copella arnoldi",
    why: "Different fish from Copella carsevennensis.",
    source: "species-key.test.ts",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Copella arnoldi" },
  },
  {
    name: "Agrotis sabine",
    why: "GBIF's matcher put it on Agrotis sabura Mabille, 1888 — neither that name nor a spelling of it (#490).",
    source: "accept-match.ts; name-variants.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: null, gbifKeyName: null },
  },

  // ── Lumped: a synonym in CoL keeps its own records ─────────────────────────
  {
    name: "Malus sieversii",
    why: "CoL lumps it into Malus domestica; it showed 146,340 of the apple's records instead of its own ~8,000.",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Malus domestica", gbifKeyName: "Malus sieversii", hasRecords: true, maxRecords: 30_000 },
  },
  {
    name: "Thymallus aeliani",
    why: "Lumped; showed 73,641 records instead of its own handful.",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Thymallus aeliani", maxRecords: 1_000 },
  },
  {
    name: "Epilobium numidicum",
    why: "Lumped; showed 295,698 records instead of its own (none georeferenced).",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100 },
  },
  {
    name: "Pararge xiphioides",
    why: "Lumped into Pararge aegeria; its own usage sat outside every facet and it showed 0.",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Pararge aegeria", gbifKeyName: "Pararge xiphioides", hasRecords: true },
  },
  {
    name: "Fringilla polatzeki",
    why: "A subspecies of F. teydea in CoL, so no species facet emits its key; it showed 0.",
    source: "dbt/models/count/usage_owner.sql",
    // Its own records (about 715), not the 7,000+ of F. teydea, and not its
    // synonym's records twice (it showed 1,430 when the synonym sat under both
    // of its roots).
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Fringilla teydea", hasRecords: true, maxRecords: 1_000 },
  },
  {
    name: "Meandrina danae",
    why: "CoL's synonym of M. danai with the same citation: one name spelled two ways. The Red List's citation is mistyped (\"Milen-Edwards & Haime, 1948\"), so the name rules called it lumped and counted 86 of its 2,200 records.",
    source: "species-key.ts isCoLRespelling; link/assessment-link.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Meandrina danai", gbifKeyName: "Meandrina danai", minRecords: 1_500 },
  },
  {
    name: "Clithon oualaniensis",
    why: "CoL holds the name three times under different citations; only one is the respelling of C. oualaniense, and the tiebreak picked another (1 record of 201).",
    source: "link/assessment-link.ts ownNameSynonyms",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Clithon oualaniense", minRecords: 100 },
  },
  {
    name: "Cipangopaludina chinensis",
    why: "Provisionally accepted under exactly this name, and also an ambiguous synonym of Margarya chinensis; the ambiguous synonym won and counted 448 records.",
    source: "link/assessment-link.ts offer kind 4",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Cipangopaludina chinensis", minRecords: 2_000 },
  },
  {
    name: "Vicia grandiflora",
    why: "Its IUCN synonym Vicia kitaibeliana is a CoL ambiguous synonym also filed under V. cracca. Ambiguous says nothing about V. cracca, which prod kept off the NE list (871k records).",
    source: "link/assessment-link.ts covered rows (kinds 0-2 only)",
    confirmed: NOVEMBER_2026,
    expect: { neListed: { "Vicia cracca": true } },
  },
  {
    name: "Centropogon australis",
    why: "A waspfish, and also a plant. IUCN's class (Actinopterygii) isn't CoL's (Teleostei), so the homonym tiebreak fell through to id order and linked the plant (8 records).",
    source: "link/assessment-link.ts tiebreak (phylum, kingdom)",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Centropogon australis", minRecords: 1_500 },
  },
  {
    name: "Acanthurus lineatus",
    why: "A surgeonfish whose IUCN synonym Hepatus lineatus is, in CoL, a crab: Hepatus was a fish genus and a crab genus. The shared epithet passed as a genus transfer and the crab's records were counted.",
    source: "link/assessment-link.ts sameLineage",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Acanthurus lineatus", neListed: { "Hepatus lineatus": true } },
  },
  {
    name: "Utricularia ochroleuca",
    why: "CoL holds it twice, once with the hybrid sign (Utricularia × ochroleuca, 7,000 records) and once without (none). Twins are matched with the hybrid sign set aside.",
    source: "link/assessment-link.ts twinKeys",
    confirmed: NOVEMBER_2026,
    expect: { minRecords: 5_000 },
  },
  {
    name: "Frullania azorica",
    why: "Accepted in one liverwort family (61 records) and provisionally accepted in another (2,860). Twins within a class, not only a family.",
    source: "link/assessment-link.ts twinKeys",
    confirmed: NOVEMBER_2026,
    expect: { minRecords: 2_000 },
  },
  {
    name: "Cathormion umbellatum",
    why: "COL26.10's curators fold it into Albizia umbellata, but GBIF files its records under the XR's Cathormion umbellatum. Read against the curated release its XR was built from, the checklist leaves it accepted, so it links where its records are.",
    source: "inputs/col-checklist.ts (the XR's own curated release)",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Cathormion umbellatum", minRecords: 500 },
  },
  {
    name: "Cladorhynchus leucocephalus",
    why: "The banded stilt (Vieillot, 1816). Its IUCN synonyms name Himantopus leucocephalus, which CoL has as the pied stilt (Gould, 1837); the shared epithet counted the pied stilt's 400k records. Update (2026-11, Red List 2026-1): IUCN's synonym list for the banded stilt is empty in 2026-1; Himantopus leucocephalus now reaches it through CoL's same-name synonym Cladorhynchus leucocephalus Gould, not through an IUCN synonym.",
    source: "link/assessment-link.ts covered rows (authorsAgree)",
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100_000 },
  },
  {
    name: "Zosterops simplex",
    why: "Owns the subspecies Z. japonicus simplex and the synonym Z. simplex filed under it; walking down from both counted the synonym's 571k records twice (1.14M).",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Zosterops japonicus", minRecords: 500_000, maxRecords: 700_000 },
  },
  {
    name: "Dasycercus hillieri",
    why: "CoL's Dasycercus cristicauda covers both IUCN species; each keeps its own records.",
    source: "precomputed/col-revisions.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Dasycercus cristicauda", gbifKeyName: "Dasycercus hillieri", hasRecords: true },
  },
  {
    name: "Dasycercus cristicauda",
    why: "The other half of the Dasycercus pair.",
    source: "precomputed/col-revisions.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Dasycercus cristicauda", gbifKeyName: "Dasycercus cristicauda", hasRecords: true },
  },
  {
    name: "Actinodaphne latifolia",
    why: "A CoL synonym of A. nitida, which IUCN assesses separately; latifolia (CR) showed nitida's records.",
    source: "species-key.ts isSeparatelyAssessed",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Actinodaphne latifolia", maxRecords: 100 },
  },
  {
    name: "Pleurobema furvum",
    why: "A CoL synonym of P. rubellum, assessed separately; furvum (CR) showed rubellum's records. Its own usage has records of its own.",
    source: "species-key.ts isSeparatelyAssessed",
    // Its own usage's 7 georeferenced records are all preserved specimens, which
    // don't count for animals, so it shows none; what matters is that it never
    // shows rubellum's.
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100 },
  },
  {
    name: "Xyrichtys trivittatus",
    why: "A CoL synonym of Iniistius trivittatus, assessed separately; same shape as Pleurobema furvum.",
    source: "species-key.ts isSeparatelyAssessed",
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100 },
  },
  {
    name: "Sus bucculentus",
    why: "Extinct; CoL synonymises it into Sus scrofa (LC). Must never show the wild boar's records.",
    source: "col-breakdown.ts; species-key.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Sus scrofa", maxRecords: 10 },
  },
  {
    name: "Catapodium borgesii",
    why: "Azores endemic once matched via a synonym onto Catapodium marinum and shown its 19,901 records. Update (2026-11, Red List 2026-1): The synonym trap holds (C. marinum, 21,464 records), but the Red List gives its range as Greece, not the Azores, so 'Azores endemic' doesn't match the 2026-1 assessment.",
    source: "dbt/models/count/usage_owner.sql; species-key.ts decideKey",
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100 },
  },
  {
    name: "Octolobus angustatus",
    why: "Keys from a CoL join once handed it a broader taxon's records.",
    source: "scripts/config/derive-gbif-taxon-keys.ts",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Octolobus angustatus", maxRecords: 1_000 },
  },

  // ── Linked, so its records must show ───────────────────────────────────────
  {
    name: "Stenocranius raddei",
    why: "Checklist columns case: an XR-only claim once sent readers to a CoL page that didn't corroborate it.",
    source: "sources/taxa.ts checklist columns",
    // GBIF's records for it are all preserved specimens, which don't count for mammals.
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Stenocranius raddei" },
  },
  {
    name: "Hylomyscus anselli",
    why: "XR-only synonym case: a claim sourced from a record the curated release doesn't have.",
    source: "col-breakdown.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Hylomyscus anselli" },
  },
  {
    name: "Mayaheros ericymba",
    why: "Its latest assessment is an amendment flagged latest=false and has to be forced in. Update (2026-11, Red List 2026-1): In Red List 2026-1 the database itself flags the amendment 288151174 latest, so seeds/forced-latest.tsv no longer changes anything for it. Kept in case a later release brings it back.",
    source: "seeds/forced-latest.tsv",
    confirmed: NOVEMBER_2026,
    expect: { assessed: true, linkedTo: "Mayaheros ericymba" },
  },
  {
    name: "Romankenkius pedderensis",
    why: "Turbellaria isn't a CoL class; the group's facet root came back empty. Update (2026-11, COL26.6 XR): CoL does have a class Turbellaria (provisionally accepted, 13 species), but not one holding Tricladida, where the species sits with no class: the class misses the species rather than not existing.",
    source: "scripts/config/derive-gbif-taxon-keys.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Romankenkius pedderensis" },
  },
  {
    name: "Arachnanthus oligopodus",
    why: "Penicillaria resolves as Ceriantharia in CoL; the root key had to follow.",
    source: "scripts/config/derive-gbif-taxon-keys.ts",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Arachnanthus oligopodus", hasRecords: true },
  },

  // ── Kept out of the Not Evaluated list ─────────────────────────────────────
  {
    name: "Miniopterus schreibersii",
    why: "CoL also has a provisionally accepted twin; it must not appear as Not Evaluated.",
    source: "link/assessment-link.ts twinKeys",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true, neListed: { "Miniopterus schreibersii": false } },
  },
  {
    name: "Columba livia",
    why: "Provisionally accepted twin of the assessed Rock Dove.",
    source: "link/assessment-link.ts twinKeys; seeds/ne-excluded.tsv",
    confirmed: NOVEMBER_2026,
    expect: { minRecords: 1_000_000, neListed: { "Columba livia": false } },
  },
  {
    name: "Homo sapiens",
    why: "IUCN leaves humans out of the Red List; CoL has them.",
    source: "seeds/ne-excluded.tsv",
    confirmed: NOVEMBER_2026,
    expect: { assessed: false, neListed: { "Homo sapiens": false } },
  },
  {
    name: "Canis familiaris",
    why: "Domestic forms have a wild sibling counted separately; goat, sheep, yak, dromedary and guinea pig were once counted as Not Evaluated by one list and left out by another.",
    source: "seeds/ne-excluded.tsv; dbt/models/lists/species.sql described",
    confirmed: NOVEMBER_2026,
    expect: { assessed: false, neListed: { "Canis familiaris": false, "Felis catus": false, "Bos taurus": false, "Bos domesticus": false,
      "Capra hircus": false, "Ovis aries": false, "Bos grunniens": false, "Camelus dromedarius": false, "Cavia porcellus": false } },
  },
  {
    name: "Pycnonotus tricolor",
    why: "An XR over-split the curated checklist demotes; it showed as a spurious Not Evaluated bulbul. Update (2026-11, COL26.6 XR): In COL26.6 XR Pycnonotus tricolor is already a synonym of P. barbatus tricolor, and the curated release demotes nothing, so the case no longer exercises the demoted rule. Kept in case a later release brings it back.",
    source: "sources/taxa.ts demoted",
    confirmed: NOVEMBER_2026,
    expect: { assessed: false, neListed: { "Pycnonotus tricolor": false } },
  },
  {
    name: "Brachistus stramoniifolius",
    why: "Assessed under an old genus; CoL's Witheringia stramoniifolia (stramonifolia in the release) is the same plant and must not reappear as Not Evaluated. Update (2026-11, COL26.6 XR): The release spelling is a separate XR usage, Witheringia stramonifolia Kunth, not a checklist name of the linked one, and it is on the Not Evaluated list (266 records): the fixture checks only the stramoniifolia spelling.",
    source: "sources/taxa.ts checklist_name",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Witheringia stramoniifolia", neListed: { "Witheringia stramoniifolia": false, "Witheringia stramonifolia": false } },
  },
  {
    name: "Syllepte belialis",
    why: "Unassessed, GBIF-observed only through BOLD barcode records (a BIN under the species): an ordinary NE species, so the list is checked for over-filtering, and BINs for being counted. Update (2026-11, snapshot 2026-11-01): A BIN (BOLD:AAB2537, 81 records) still counts towards it, but 221 of its 302 records now sit on the species usage itself, so it is no longer observed only through BOLD.",
    source: "sources/taxa.ts BELOW_SPECIES",
    confirmed: NOVEMBER_2026,
    expect: { assessed: false, neListed: { "Syllepte belialis": true } },
  },
];
