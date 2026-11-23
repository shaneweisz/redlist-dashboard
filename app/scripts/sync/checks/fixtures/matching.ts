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

/** The matching spec's cases (docs/specs/matching.md), added on 23 November 2026; same releases. */
const MATCHING_SPEC: Versions = { redlist: "2026-1", col: "COL26.6 XR", snapshot: "2026-11-01" };
const SPEC_SOURCE = "docs/specs/matching.md; link/select.ts";

/** Cases added on 12 November 2026, one per link rule no case showed yet; same releases. */
const NOVEMBER_12: Versions = { redlist: "2026-1", col: "COL26.6 XR", snapshot: "2026-11-01" };

export interface MatchCase {
  name: string;
  /** The Red List's authority for it: with the name, which species the case is about. */
  authority?: string;
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
    /** That species' CoL authorship: a homonym's name is the same for both (Centropogon australis, a fish and a plant). */
    linkedAuthorship?: string;
    /** CoL name of the GBIF key the app counts and links to; null = no key. */
    gbifKeyName?: string | null;
    hasRecords?: boolean;
    minRecords?: number;
    /** Caps a count that once borrowed a broader taxon's records. */
    maxRecords?: number;
    /** CoL species name → whether the NE list shows it. */
    neListed?: Record<string, boolean>;
    /**
     * The link rules it shows, each one a label its link rows carry (match_reason):
     * "exact, unique", "CoL duplicate", "no candidate". Every label a build gives
     * any species needs a case.
     */
    rules?: string[];
    /** Its doubts, exactly (docs/specs/matching.md, "Doubts"); [] for none. Every doubt a build gives needs a case. */
    doubts?: string[];
    /** CoL records it must count from, with their relations (each present; authorship compared as authors). */
    selected?: { name: string; authorship?: string; relation: "is" | "part of" | "split into" | "refused" }[];
  };
}

export const MATCHING_CASES: MatchCase[] = [
  // ── The spec's examples (docs/specs/matching.md, "Examples") and one case per label and doubt ──
  {
    name: "Panthera leo",
    authority: "(Linnaeus, 1758)",
    why: "The plain case: the matcher's answer is the accepted species, once in CoL.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], selected: [{ name: "Panthera leo", relation: "is" }], rules: ["exact, unique"] },
  },
  {
    name: "Sorbus greenii",
    authority: "T.C.G.Rich",
    why: "A synonym of Aria greenii in CoL: a genus move, so the species is Aria greenii, counted whole.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], linkedTo: "Aria greenii", selected: [{ name: "Aria greenii", relation: "is" }] },
  },
  {
    name: "Cygnus buccinator",
    authority: "Richardson, 1832",
    why: "CoL holds the trumpeter swan as an accepted Richardson, 1831 and a provisional 1832 copy in one class: copies, both counted.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], selected: [{ name: "Cygnus buccinator", authorship: "Richardson, 1831", relation: "is" }, { name: "Cygnus buccinator", authorship: "Richardson, 1832", relation: "is" }], rules: ["exact, duplicate in CoL"] },
  },
  {
    name: "Vireo chivi",
    authority: "(Vieillot, 1817)",
    why: "CoL accepts it with no authorship, and also files (Vieillot, 1817) under V. olivaceus: the citation can't contradict either, so both are taken, as a homonym.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: ["homonym"], selected: [{ name: "Vireo chivi", relation: "is" }, { name: "Vireo olivaceus chivi", relation: "part of" }], rules: ["name under another species"] },
  },
  {
    name: "Lycaena clarki",
    authority: "Clark & Dickson, 1971",
    why: "A synonym of Aloeides clarki, which the Red List also assesses: refused, so it counts nothing, with that doubt.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: ["counts nothing"], selected: [{ name: "Lycaena clarki", relation: "refused" }], hasRecords: false },
  },
  {
    name: "Turdus rubrocanus",
    authority: "Hodgson, 1846",
    why: "The answer is Gray & Gray, 1847, which the citation contradicts; the only Hodgson record is under Philepitta castanea. Step 5: GBIF files the bare name at the answer, so it counts, doubted.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: ["homonym", "other authors"], selected: [{ name: "Turdus rubrocanus", relation: "is" }] },
  },
  {
    name: "Palaina martensi",
    authority: "(Adams, 1866)",
    why: "The matcher answers only the genus; of the two records, (H. Adams, 1867) isn't contradicted by the citation and (Andreae, 1902) is: step 6 takes the first.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: ["chosen by the citation", "homonym"], selected: [{ name: "Diancta martensi", relation: "is" }] },
  },
  {
    name: "Amygdalus ledebouriana",
    authority: "Schlecht.",
    why: "No answer; two Schltdl. synonyms under two species, which the citation's abbreviation compares only as unclear: step 6 takes both.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: ["chosen by the citation", "homonym", "other authors"], rules: ["CoL duplicate"] },
  },
  {
    name: "Galaxias sp. nov. 'Verlorenvlei'",
    why: "An undescribed species (sp. nov.): no CoL record is it, so nothing is taken.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { linkedTo: null, doubts: [], rules: ["informal or qualified name"] },
  },
  {
    name: "Lepilemur jamesorum",
    authority: "Louis Jr. et al., 2006",
    why: "CoL's synonym L. jamesorum of L. jamesi has the same citation: a genitive respelling, so the species is L. jamesi, counted whole.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], selected: [{ name: "Lepilemur jamesi", relation: "is" }] },
  },
  {
    name: "Butorides striata",
    authority: "(Linnaeus, 1758)",
    why: "The Red List includes the green heron; CoL holds it as Butorides virescens. Split into: counted whole too, and the GBIF key stays the striated heron's own.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], gbifKeyName: "Butorides striata", neListed: { "Butorides virescens": false }, selected: [{ name: "Butorides virescens", relation: "split into" }], rules: ["Red List synonym, split"] },
  },
  {
    name: "Hoplocephalus bungaroides",
    authority: "(Schlegel, 1837)",
    why: "Wagler, 1830 synonyms sit under it and under Ophiophagus bungarus, the king cobra; the citation contradicts Wagler, so the copy test joins nothing and the king cobra's group stays out, noted on the Not Evaluated list.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], maxRecords: 10_000, rules: ["exact, homonym, author decides", "other group"] },
  },
  {
    name: "Elymus farctus",
    authority: "(Viv.) Runemark ex Melderis",
    why: "Its Red List synonym Elymus junceiformis is filed in CoL under Thinopyrum junceiforme, which the steps don't reach: the records under that name count for it, with the doubt, and T. junceiforme keeps the rest.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: ["synonym filed elsewhere"], selected: [{ name: "Elymus junceiformis", relation: "part of" }], rules: ["Red List synonym, filed elsewhere"] },
  },
  {
    name: "Melanopsis chlorotica",
    authority: "Pallary, 1921",
    why: "A Red List synonym CoL holds as its own species counts whole, but its authors don't compare the same, so the split is doubted.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: ["split, authors unclear"], selected: [{ name: "Melanopsis torquilla", relation: "split into" }] },
  },
  {
    name: "Isoaeschna isoceles",
    authority: "(Müller, 1767)",
    why: "Its Red List synonym Aeshna isoceles (Müller, 1767) is a plain CoL synonym of Anaciaeschna isoceles with the same citation: the same organism, counted whole.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], selected: [{ name: "Anaciaeschna isoceles", relation: "is" }], rules: ["CoL duplicate, Red List synonym"] },
  },
  {
    name: "Aloe ballii",
    authority: "Reynolds",
    why: "CoL's Aloe ballyi Reynolds, a respelling, is another assessed name: refused, it counts nothing for this species.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], selected: [{ name: "Aloe ballyi", relation: "refused" }], rules: ["refused"] },
  },
  {
    name: "Acentrogobius cyanomos",
    authority: "(Bleeker, 1849)",
    why: "A Red List synonym CoL holds as Drombus dentifer, which the Red List assesses separately: refused.",
    source: SPEC_SOURCE,
    confirmed: MATCHING_SPEC,
    expect: { doubts: [], rules: ["Red List synonym, assessed separately"] },
  },

  // ── One organism under two names ───────────────────────────────────────────
  {
    name: "Hylatomus pileatus",
    authority: "(Linnaeus, 1758)",
    why: "IUCN's genus for the Pileated Woodpecker; GBIF files its 5.4M records under Dryocopus pileatus. Ranking keys by match order showed 156.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Dryocopus pileatus", minRecords: 1_000_000, neListed: { "Dryocopus pileatus": false }, doubts: [], selected: [{ name: "Dryocopus pileatus", relation: "is" }], rules: ["CoL duplicate"] },
  },
  {
    name: "Drepanis coccinea",
    authority: "(Forster, 1781)",
    why: "Same bird as CoL's Vestiaria coccinea: a genus move with the epithet unchanged.",
    source: "link/name-rules.ts sameOrganism",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Vestiaria coccinea", linkedAuthorship: "(G. Forster, 1780)", gbifKeyName: "Vestiaria coccinea", hasRecords: true, rules: ["exact, unique"] },
  },
  {
    name: "Pica nutalli",
    authority: "(Audubon, 1837)",
    why: "Spelling variant of nuttallii (same authorship, one edit). Update (2026-11, COL26.6 XR): CoL now spells the accepted name Pica nutallii and holds Pica nutalli as its own synonym, so the link goes through a CoL synonym rather than a respelling. Update (2026-11, COL26.6 XR): CoL also holds it, outside its curated core, as Pica nuttalli with no author and 121,763 records, which counted for nothing until the twin rule read respellings.",
    source: "link/name-rules.ts sameOrganism",
    confirmed: NOVEMBER_2026,
    expect: { minRecords: 50_000, neListed: { "Pica nuttallii": false, "Pica nuttalli": false }, rules: ["CoL duplicate, respelled"] },
  },
  {
    name: "Sminthopsis fuliginosa",
    authority: "(J. Gould, 1852)",
    why: "Gender agreement: CoL spells it fuliginosus. Update (2026-11, COL26.6 XR): CoL's fuliginosus spelling holds, but CoL now has it as a synonym of Sminthopsis griseoventer, so the link is a lump keeping the synonym's own records, not a plain gender variant.",
    source: "link/name-rules.ts; link/select.ts (a spelling variant the codes allow)",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true },
  },
  {
    name: "Ochotona pallasii",
    authority: "(Gray, 1867)",
    why: "Patronymic -ii vs CoL's -i.",
    source: "link/name-rules.ts; link/select.ts (a spelling variant the codes allow)",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true, rules: ["spelling variant"] },
  },
  {
    name: "Solanum vallis-mexici",
    authority: "Juz.",
    why: "CoL writes the hybrid marker (Solanum × vallis-mexici); same plant.",
    source: "link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true },
  },
  {
    name: "Colostygia puengeleri",
    authority: "(Stertz, 1902)",
    why: "CoL spells it pungeleri (both for Püngeler). Accepted by pass 7 only because the GBIF key and the spelling rule agree. Update (2026-11, COL26.6 XR, #629): The spelling still differs; the matching passes were retired (#593, #629), and the matcher now returns the variant itself, which the acceptance rule takes.",
    source: "link/select.ts; link/name-rules.ts",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true },
  },
  {
    name: "Agelaius phoeniceus",
    authority: "(Linnaeus, 1766)",
    why: "Without classification context GBIF's matcher backed off to the genus and the bird lost its 20M records. Update (2026-11, COL26.6 XR): The homonym that drew the matcher off is still in CoL (a synonym in the mite genus Syringophilopsis), but the matcher is now asked with classification hints, so whether it would still back off without them can't be checked from a build.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Agelaius phoeniceus", minRecords: 1_000_000, rules: ["exact, unique"] },
  },
  {
    name: "Verreauxia africana",
    authority: "(Verreaux & Verreaux, 1855)",
    why: "Linked to CoL's non-Base Verreauxia africana; its IUCN synonym Sasia africana is CoL's Base name for the same bird and must not reappear as Not Evaluated.",
    source: "link/select.ts (synonym records)",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Verreauxia africana", linkedAuthorship: "(Verreaux & Verreaux, 1855)", hasRecords: true, neListed: { "Sasia africana": false } },
  },
  {
    name: "Andropogon virginicus",
    authority: "L.",
    why: "Has an ambiguous synonym in CoL; the breakdown once reported it under whichever target the scan reached first.",
    source: "col-breakdown.ts syn_in_checklist",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Andropogon virginicus", linkedAuthorship: "L.", hasRecords: true },
  },

  // ── Two organisms that look alike ──────────────────────────────────────────
  {
    name: "Pseudophilautus abundus",
    authority: "(Manamendra-Arachchi & Pethiyagoda, 2005)",
    why: "Shares authorship with P. procax; authorship alone matched them and abundus (EN) showed procax's records. Update (2026-11, COL26.6 XR, matching spec): IUCN lists \"Philautus procax\" as a synonym of abundus; CoL files that name under P. procax, so its own records (none) count for abundus and P. procax keeps the rest, on the Not Evaluated list with a note: only a row counting a species whole hides it.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Pseudophilautus abundus", linkedAuthorship: "(Manamendra-Arachchi & Pethiyagoda, 2005)", gbifKeyName: "Pseudophilautus abundus", maxRecords: 100, neListed: { "Pseudophilautus procax": true }, rules: ["Red List synonym, filed elsewhere"] },
  },
  {
    name: "Acacia koaia",
    authority: "Hillebr.",
    why: "Two edits from Acacia koa but a different author: a different tree. Must not show koa's records. Update (2026-11, COL26.6 XR): COL26.6 XR holds Acacia koaia as a synonym of A. koa, so the risk now runs through the lumped-synonym path rather than a near-name match; the different-author near-name still exists.",
    source: "link/name-rules.ts sameOrganism",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Acacia koaia", maxRecords: 1_000 },
  },
  {
    name: "Copella arnoldi",
    authority: "(Regan, 1912)",
    why: "Different fish from Copella carsevennensis.",
    source: "name-rules.test.ts",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Copella arnoldi" },
  },
  {
    name: "Agrotis sabine",
    authority: "Brandstetter, 2010",
    why: "GBIF's matcher put it on Agrotis sabura Mabille, 1888 (a synonym of Agrotis lasserrei), neither that name nor a spelling the codes allow (#490). Until 2026-11 it had no link; now the matcher's answer counts, flagged, since a different spelling may be another species. If it is wrong, a decision corrects it. Update (2026-11, COL26.6 XR, matching spec): Agrotis lasserrei is assessed too, so the record is refused: it counts nothing, with the doubts.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Agrotis lasserrei", doubts: ["other authors", "other spelling", "counts nothing"], selected: [{ name: "Agrotis sabura", relation: "refused" }] },
  },

  // ── Lumped: a synonym in CoL keeps its own records ─────────────────────────
  {
    name: "Malus sieversii",
    authority: "M.Roem.",
    why: "CoL lumps it into Malus domestica; it showed 146,340 of the apple's records instead of its own ~8,000.",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Malus domestica", linkedAuthorship: "(Suckow) Borkh.", gbifKeyName: "Malus sieversii", hasRecords: true, maxRecords: 30_000 },
  },
  {
    name: "Thymallus aeliani",
    authority: "Valenciennes, 1848",
    why: "Lumped; showed 73,641 records instead of its own handful.",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Thymallus aeliani", maxRecords: 1_000 },
  },
  {
    name: "Epilobium numidicum",
    authority: "Batt.",
    why: "Lumped; showed 295,698 records instead of its own (none georeferenced).",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100 },
  },
  {
    name: "Pararge xiphioides",
    authority: "Staudinger, 1871",
    why: "Lumped into Pararge aegeria; its own usage sat outside every facet and it showed 0. Update (2026-11, COL26.6 XR, matching spec): its part-of row hid P. aegeria (3.5M records, unassessed) from every list and counted them for no one; only a row counting a species whole hides it now.",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Pararge aegeria", linkedAuthorship: "(Linnaeus, 1758)", gbifKeyName: "Pararge xiphioides", hasRecords: true, neListed: { "Pararge aegeria": true }, selected: [{ name: "Pararge xiphioides", relation: "part of" }] },
  },
  {
    name: "Fringilla polatzeki",
    authority: "(Hartert, 1905)",
    why: "A subspecies of F. teydea in CoL, so no species facet emits its key; it showed 0.",
    source: "docs/specs/matching.md; link/select.ts",
    // Its own records (about 715), not the 7,000+ of F. teydea, and not its
    // synonym's records twice (it showed 1,430 when the synonym sat under both
    // of its roots).
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Fringilla teydea", linkedAuthorship: "Webb, Berthelot & Moquin-Tandon, 1836", hasRecords: true, maxRecords: 1_000, selected: [{ name: "Fringilla teydea polatzeki", relation: "part of" }] },
  },
  {
    name: "Meandrina danae",
    authority: "Milen-Edwards & Haime, 1948",
    why: "CoL's synonym of M. danai with the same citation: one name spelled two ways. The Red List's citation is mistyped (\"Milen-Edwards & Haime, 1948\"), so the name rules called it lumped and counted 86 of its 2,200 records.",
    source: "link/name-rules.ts isCoLRespelling; link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Meandrina danai", linkedAuthorship: "(Milne Edwards & Haime, 1848)", gbifKeyName: "Meandrina danai", minRecords: 1_500 },
  },
  {
    name: "Clithon oualaniensis",
    authority: "Lesson, 1831",
    why: "CoL holds the name three times under different citations; only one is the respelling of C. oualaniense, and the tiebreak picked another (1 record of 201).",
    source: "link/name-rules.ts isCoLRespelling",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Clithon oualaniense", linkedAuthorship: "(R. P. Lesson, 1831)", minRecords: 100 },
  },
  {
    name: "Cipangopaludina chinensis",
    authority: "(Gray in Griffith & Pidgeon, 1833)",
    why: "Provisionally accepted under exactly this name, and also an ambiguous synonym of Margarya chinensis; the ambiguous synonym won and counted 448 records.",
    source: "link/select.ts; seeds/decisions.tsv",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Cipangopaludina chinensis", linkedAuthorship: "(Gray, 1834)", minRecords: 2_000 },
  },
  {
    name: "Vicia grandiflora",
    authority: "Scop.",
    why: "Its IUCN synonym Vicia kitaibeliana is a CoL ambiguous synonym also filed under V. cracca. Ambiguous says nothing about V. cracca, which prod kept off the NE list (871k records).",
    source: "link/select.ts (synonym records)",
    confirmed: NOVEMBER_2026,
    expect: { neListed: { "Vicia cracca": true }, rules: ["exact, homonym, author decides"] },
  },
  {
    name: "Centropogon australis",
    authority: "(Shaw, 1790)",
    why: "A waspfish, and also a plant. IUCN's class (Actinopterygii) isn't CoL's (Teleostei), so the homonym tiebreak fell through to id order and linked the plant (8 records).",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Centropogon australis", linkedAuthorship: "(White, 1790)", gbifKeyName: "Centropogon australis", minRecords: 1_500, rules: ["decision"] },
  },
  {
    name: "Acanthurus lineatus",
    authority: "(Linnaeus, 1758)",
    why: "A surgeonfish whose IUCN synonym Hepatus lineatus is, in CoL, a crab: Hepatus was a fish genus and a crab genus. The shared epithet passed as a genus transfer and the crab's records were counted.",
    source: "link/select.ts (agrees with the lineage)",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Acanthurus lineatus", linkedAuthorship: "(Linnaeus, 1758)", neListed: { "Hepatus lineatus": true } },
  },
  {
    name: "Utricularia ochroleuca",
    authority: "R.Hartm.",
    why: "CoL holds it twice, once with the hybrid sign (Utricularia × ochroleuca, 7,000 records) and once without (none). Twins are matched with the hybrid sign set aside.",
    source: "link/select.ts (copies)",
    confirmed: NOVEMBER_2026,
    expect: { minRecords: 5_000, rules: ["CoL duplicate"] },
  },
  {
    name: "Frullania azorica",
    authority: "Sim-Sim, Sérgio, Mues & L. Kraut",
    why: "Accepted in one liverwort family (61 records) and provisionally accepted in another (2,860). Twins within a class, not only a family.",
    source: "link/select.ts (copies)",
    confirmed: NOVEMBER_2026,
    expect: { minRecords: 2_000 },
  },
  {
    name: "Cathormion umbellatum",
    authority: "(Vahl) Kosterm.",
    why: "COL26.10's curators fold it into Albizia umbellata, but GBIF files its records under the XR's Cathormion umbellatum. Read against the curated release its XR was built from, the checklist leaves it accepted, so it links where its records are.",
    source: "inputs/col-checklist.ts (the XR's own curated release)",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Cathormion umbellatum", linkedAuthorship: "(Vahl) Kosterm.", minRecords: 500 },
  },
  {
    name: "Cladorhynchus leucocephalus",
    authority: "(Vieillot, 1816)",
    why: "The banded stilt (Vieillot, 1816). Its IUCN synonyms name Himantopus leucocephalus, which CoL has as the pied stilt (Gould, 1837); the shared epithet counted the pied stilt's 400k records. Update (2026-11, Red List 2026-1): IUCN's synonym list for the banded stilt is empty in 2026-1; Himantopus leucocephalus now reaches it through CoL's same-name synonym Cladorhynchus leucocephalus Gould, not through an IUCN synonym.",
    source: "link/select.ts (synonym records)",
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100_000 },
  },
  {
    name: "Zosterops simplex",
    authority: "Swinhoe, 1861",
    why: "Owns the subspecies Z. japonicus simplex and the synonym Z. simplex filed under it; walking down from both counted the synonym's 571k records twice (1.14M).",
    source: "dbt/models/count/usage_owner.sql",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Zosterops japonicus", linkedAuthorship: "Temminck & Schlegel, 1845", minRecords: 500_000, maxRecords: 700_000 },
  },
  {
    name: "Dasycercus hillieri",
    authority: "(O. Thomas, 1905)",
    why: "CoL's Dasycercus cristicauda covers both IUCN species; each keeps its own records. Update (2026-11, COL26.6 XR, matching spec): CoL also holds it as Phascogale hillieri Thomas, 1905, provisionally accepted, a Red List synonym; that copy counts whole, and as its is row it is now the GBIF key.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Dasycercus cristicauda", linkedAuthorship: "(Krefft, 1867)", gbifKeyName: "Phascogale hillieri", hasRecords: true, selected: [{ name: "Dasycercus hillieri", relation: "part of" }, { name: "Phascogale hillieri", relation: "is" }] },
  },
  {
    name: "Dasycercus cristicauda",
    authority: "(Krefft, 1867)",
    why: "The other half of the Dasycercus pair.",
    source: "precomputed/col-revisions.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Dasycercus cristicauda", linkedAuthorship: "(Krefft, 1867)", gbifKeyName: "Dasycercus cristicauda", hasRecords: true },
  },
  {
    name: "Actinodaphne latifolia",
    authority: "Teschner",
    why: "A CoL synonym of A. nitida, which IUCN assesses separately; latifolia (CR) showed nitida's records.",
    source: "link/select.ts (another assessed name)",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Actinodaphne latifolia", maxRecords: 100 },
  },
  {
    name: "Pleurobema furvum",
    authority: "Conrad, 1834",
    why: "A CoL synonym of P. rubellum, assessed separately; furvum (CR) showed rubellum's records. Its own usage has records of its own.",
    source: "link/select.ts (another assessed name)",
    // Its own usage's 7 georeferenced records are all preserved specimens, which
    // don't count for animals, so it shows none; what matters is that it never
    // shows rubellum's.
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100 },
  },
  {
    name: "Xyrichtys trivittatus",
    authority: "Randall & Cornish, 2000",
    why: "A CoL synonym of Iniistius trivittatus, assessed separately; same shape as Pleurobema furvum.",
    source: "link/select.ts (another assessed name)",
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100 },
  },
  {
    name: "Sus bucculentus",
    authority: "Heude, 1892",
    why: "Extinct; CoL synonymises it into Sus scrofa (LC). Must never show the wild boar's records.",
    source: "col-breakdown.ts; link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Sus scrofa", linkedAuthorship: "Linnaeus, 1758", maxRecords: 10 },
  },
  {
    name: "Catapodium borgesii",
    authority: "H.Scholz",
    why: "Azores endemic once matched via a synonym onto Catapodium marinum and shown its 19,901 records. Update (2026-11, Red List 2026-1): The synonym trap holds (C. marinum, 21,464 records), but the Red List gives its range as Greece, not the Azores, so 'Azores endemic' doesn't match the 2026-1 assessment. Update (2026-11, COL26.6 XR, matching spec): the Red List lists C. marinum as a synonym, which the rules would split in (20,886 records): a decision (seeds/decisions.tsv) keeps the species to its own record.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_2026,
    expect: { maxRecords: 100, rules: ["decision"] },
  },
  {
    name: "Octolobus angustatus",
    authority: "Hutch.",
    why: "Keys from a CoL join once handed it a broader taxon's records.",
    source: "scripts/config/derive-gbif-taxon-keys.ts",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Octolobus angustatus", maxRecords: 1_000 },
  },

  // ── Linked, so its records must show ───────────────────────────────────────
  {
    name: "Stenocranius raddei",
    authority: "(Poljakov, 1881)",
    why: "Checklist columns case: an XR-only claim once sent readers to a CoL page that didn't corroborate it.",
    source: "sources/taxa.ts checklist columns",
    // GBIF's records for it are all preserved specimens, which don't count for mammals.
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Stenocranius raddei", linkedAuthorship: "(Poljakov, 1881)" },
  },
  {
    name: "Hylomyscus anselli",
    authority: "(Bishop, 1979)",
    why: "XR-only synonym case: a claim sourced from a record the curated release doesn't have.",
    source: "col-breakdown.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Hylomyscus anselli", linkedAuthorship: "(Bishop, 1979)" },
  },
  {
    name: "Mayaheros ericymba",
    authority: "(Hubbs, 1938)",
    why: "Its latest assessment is an amendment flagged latest=false and has to be forced in. Update (2026-11, Red List 2026-1): In Red List 2026-1 the database itself flags the amendment 288151174 latest, so seeds/forced-latest.tsv no longer changes anything for it. The seed was removed; the case stays, so a later release that unflags it fails here instead of losing the species.",
    source: "sources/assessments.ts (the database's latest flag)",
    confirmed: NOVEMBER_2026,
    expect: { assessed: true, linkedTo: "Mayaheros ericymba", linkedAuthorship: "(Hubbs, 1938)" },
  },
  {
    name: "Romankenkius pedderensis",
    authority: "Ball, 1974",
    why: "Turbellaria isn't a CoL class; the group's facet root came back empty. Update (2026-11, COL26.6 XR): CoL does have a class Turbellaria (provisionally accepted, 13 species), but not one holding Tricladida, where the species sits with no class: the class misses the species rather than not existing.",
    source: "scripts/config/derive-gbif-taxon-keys.ts",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Romankenkius pedderensis", linkedAuthorship: "Ball, 1974" },
  },
  {
    name: "Arachnanthus oligopodus",
    authority: "(Cerfontaine, 1891)",
    why: "Penicillaria resolves as Ceriantharia in CoL; the root key had to follow.",
    source: "scripts/config/derive-gbif-taxon-keys.ts",
    confirmed: NOVEMBER_2026,
    expect: { gbifKeyName: "Arachnanthus oligopodus", hasRecords: true },
  },

  // ── Kept out of the Not Evaluated list ─────────────────────────────────────
  {
    name: "Miniopterus schreibersii",
    authority: "(Kühl, 1817)",
    why: "CoL also has a provisionally accepted twin; it must not appear as Not Evaluated.",
    source: "link/select.ts (copies)",
    confirmed: NOVEMBER_2026,
    expect: { hasRecords: true, neListed: { "Miniopterus schreibersii": false } },
  },
  {
    name: "Columba livia",
    authority: "Gmelin, 1789",
    why: "Provisionally accepted twin of the assessed Rock Dove.",
    source: "link/select.ts (copies); seeds/domesticated-and-humans.tsv",
    confirmed: NOVEMBER_2026,
    expect: { minRecords: 1_000_000, neListed: { "Columba livia": false } },
  },
  {
    name: "Homo sapiens",
    why: "IUCN leaves humans out of the Red List; CoL has them.",
    source: "seeds/domesticated-and-humans.tsv",
    confirmed: NOVEMBER_2026,
    expect: { assessed: false, neListed: { "Homo sapiens": false } },
  },
  {
    name: "Canis familiaris",
    why: "Domestic forms have a wild sibling counted separately; goat, sheep, yak, dromedary and guinea pig were once counted as Not Evaluated by one list and left out by another.",
    source: "seeds/domesticated-and-humans.tsv; dbt/models/lists/species.sql described",
    confirmed: NOVEMBER_2026,
    expect: { assessed: false, neListed: { "Canis familiaris": false, "Felis catus": false, "Bos taurus": false, "Bos domesticus": false, "Bombyx mori": false,
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
    authority: "(Kunth) Miers",
    why: "Assessed under an old genus; CoL's Witheringia stramoniifolia (stramonifolia in the release) is the same plant and must not reappear as Not Evaluated. Update (2026-11, COL26.6 XR): The release spelling is a separate XR usage, Witheringia stramonifolia Kunth, not a checklist name of the linked one, and it is on the Not Evaluated list (266 records): the fixture checks only the stramoniifolia spelling.",
    source: "sources/taxa.ts checklist_name",
    confirmed: NOVEMBER_2026,
    expect: { linkedTo: "Witheringia stramoniifolia", linkedAuthorship: "Kunth", neListed: { "Witheringia stramoniifolia": false, "Witheringia stramonifolia": false } },
  },
  {
    name: "Syllepte belialis",
    why: "Unassessed, GBIF-observed only through BOLD barcode records (a BIN under the species): an ordinary NE species, so the list is checked for over-filtering, and BINs for being counted. Update (2026-11, snapshot 2026-11-01): A BIN (BOLD:AAB2537, 81 records) still counts towards it, but 221 of its 302 records now sit on the species usage itself, so it is no longer observed only through BOLD.",
    source: "sources/taxa.ts BELOW_SPECIES",
    confirmed: NOVEMBER_2026,
    expect: { assessed: false, neListed: { "Syllepte belialis": true } },
  },
  // ── One case per link rule: each rule a build applies needs one (check-fixtures.ts uncoveredRules) ──
  {
    name: "Charadrius nivosus",
    authority: "(Cassin, 1858)",
    why: "CoL holds the snowy plover twice, as Charadrius and Anarhynchus nivosus (Cassin, 1858), two accepted species, and the Red List lists neither as the other's synonym. A rule counted the same epithet and dated author in one family under another genus as one organism; the agent audit (2026-11-12) found it wrong for 7 of 20 (Atractus / Apostolepis collaris, both Peracca, 1897, are two snakes), so it was dropped: nothing direct says the two are one, so Anarhynchus nivosus's 196,733 records no longer count for the plover. That copy is outside CoL's curated core, so it isn't listed as unassessed either.",
    source: "link/select.ts (no rule for another genus)",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Charadrius nivosus", maxRecords: 100_000, neListed: { "Anarhynchus nivosus": false }, rules: ["exact, unique"] },
  },
  {
    name: "Turraeanthus africana",
    authority: "(Welw.) Pellegr.",
    why: "CoL spells it africanus, a Latin ending the codes treat as the same name, and holds that name twice (accepted and provisional), so both count.",
    source: "link/select.ts; link/name-rules.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Turraeanthus africanus", hasRecords: true, rules: ["spelling variant, duplicate in CoL"] },
  },
  {
    name: "Elaphoglossum urbanii",
    authority: "(Sodiro) C.Chr.",
    why: "CoL spells it urbani, and holds that spelling twice by two authors; the Red List's (Sodiro) C.Chr. picks the accepted one, not Brause's ambiguous synonym.",
    source: "link/select.ts (groups); link/name-rules.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Elaphoglossum urbani", linkedAuthorship: "(Sodiro) C.Chr.", rules: ["spelling variant, homonym, author decides"] },
  },
  {
    name: "Malaxis brachystachys",
    authority: "(Rchb.f.) Kuntze",
    why: "Two orchids share the name. Asked without the authority the matcher scored Lindley's (a synonym of Oberonia brachystachys) 166 against Kuntze's 165, and the twin rule took it, counting another orchid's records. Found by the agent audit; decided in decisions.tsv.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Malaxis realdelmontensis", rules: ["decision"], selected: [{ name: "Malaxis brachystachys", authorship: "(Rchb.f.) Kuntze", relation: "part of" }] },
  },
  {
    name: "Sipyloidea brevicerci",
    authority: "Hasenpusch & Brock, 2007",
    why: "CoL holds the name as an accepted species and as a synonym of a Brazilian stick insect: it says both that it is a species and that it is another one. The matcher's answer is the link now, flagged: flagged, and queued for review. The agent pilot found the answer wrong (the accepted record, 4XQT5, is the species): a decision should correct it. Update (2026-11, COL26.6 XR, matching spec): the two records share a citation, so they are copies of one group: the accepted species counts whole, and the records under its name in the other species count too. No doubt.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { assessed: true, doubts: [], selected: [{ name: "Sipyloidea brevicerci", relation: "is" }, { name: "Sipyloidea brevicerci", relation: "part of" }], rules: ["exact, duplicate in CoL", "CoL duplicate"] },
  },
  {
    name: "Cantharellus ochraceus",
    authority: "Gillet",
    why: "CoL marks the name an ambiguous synonym: it doesn't say which species it is. The matcher's answer is the link now, flagged: flagged, and queued for review.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { assessed: true, doubts: ["homonym", "other authors", "ambiguous synonym"], rules: ["candidate"] },
  },
  {
    name: "Galium palustre",
    authority: "L.",
    why: "CoL holds Linnaeus's and M.Bieb.'s Galium palustre, leading to two species, and the matcher can't say which the Red List means. The matcher's answer is the link now, flagged: flagged, and queued for review. The citation (L.) can't rule M.Bieb.'s out on its own: a bare initial is unclear to compareAuthors, so no author pick. The agent pilot found the answer wrong (3F682, under Hydrogalium palustre, is the species): a decision should correct it. Update (2026-11, COL26.6 XR, matching spec): the answer and Linnaeus's record both count (step 4), only records under their own name, with the doubts.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { assessed: true, doubts: ["homonym", "ambiguous synonym"], selected: [{ name: "Galium palustre", authorship: "L.", relation: "part of" }, { name: "Galium palustre", authorship: "M.Bieb.", relation: "part of" }] },
  },
  {
    name: "Buteo rufinus",
    authority: "(Cretzschmar, 1827)",
    why: "CoL holds Cretzschmar's long-legged buzzard (accepted, dated 1829) and a Buteo rufinus credited to BirdLife International under Buteo socotraensis. The Red List's citation is dated 1827, so it matches neither record for sure: the matcher's answer counts, flagged as a homonym the authors don't settle.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Buteo rufinus", doubts: ["homonym"], rules: ["candidate"] },
  },
  {
    name: "Weinmannia heterophylla",
    authority: "Ruiz & Pav.",
    why: "CoL holds Kunth's Weinmannia heterophylla (accepted, the matcher's answer) and Ruiz & Pav. ex López's (an ambiguous synonym under Weinmannia cordata). The Red List cites Ruiz & Pav., the latter: it counts, flagged, only records under its own name. Before, Kunth's 70 records counted.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Weinmannia cordata", doubts: ["chosen by the citation", "ambiguous synonym"], rules: ["candidate"], selected: [{ name: "Weinmannia heterophylla", authorship: "Ruiz & Pav. ex López", relation: "part of" }] },
  },
  {
    name: "Vepris onanae",
    authority: "Cheek ined.",
    why: "An unpublished name (ined.), which CoL holds as Vepris onanae Cheek. Unpublished is still the name, so it matches like any other; until 2026-11 it had no link.",
    source: "link/select.ts citationOf",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Vepris onanae", rules: ["exact, unique"] },
  },
  {
    name: "Chalepoxenus muellerianus",
    authority: "(Finzi, 1922)",
    why: "CoL holds it as an accepted species and, by the same authors, as a synonym of Temnothorax muellerianus; the matcher answers the synonym, so the link is flagged. The CoL species Chalepoxenus muellerianus may be the same one, so it is a candidate: listed on the NE list, flagged as possibly this assessed species, not hidden. Update (2026-11, COL26.6 XR, matching spec): the synonym and the accepted record share a citation, so they are copies of one group and both count whole; no doubt, and no candidate.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Temnothorax muellerianus", doubts: [], selected: [{ name: "Temnothorax muellerianus", relation: "is" }, { name: "Chalepoxenus muellerianus", relation: "is" }] },
  },
  {
    name: "Heliotropium aff. wagneri",
    why: "aff.: the Red List says it is near Heliotropium wagneri, not that species, so wagneri's records aren't its.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: null, doubts: [], rules: ["informal or qualified name"] },
  },
  {
    name: "Kuhlia rubens",
    authority: "(Spinola, 1807)",
    why: "The matcher is less than fully sure of its answer, a synonym of Apogon imberbis. The matcher's answer is the link now, flagged: flagged, and queued for review. The agent pilot agreed with it. Update (2026-11, COL26.6 XR, matching spec): its doubt is that the matcher places the record outside the Red List's lineage (classification −20), not its confidence.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Apogon imberbis", doubts: ["placed elsewhere"], rules: ["Red List synonym, filed elsewhere"] },
  },
  {
    name: "Ampedus karpathicus",
    authority: "(Buysson, 1885)",
    why: "The matcher's answer is a name CoL says was misapplied, not a species. Update (2026-11, COL26.6 XR, matching spec): nothing is taken for the name, but its Red List synonym A. suecicus Palm, 1976 is a CoL species, which the Red List includes: split into, counted whole.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: null, gbifKeyName: "Ampedus suecicus", doubts: [], rules: ["no candidate", "Red List synonym, split"], selected: [{ name: "Ampedus suecicus", authorship: "Palm, 1976", relation: "split into" }] },
  },
  {
    name: "Rubus fruticosus",
    authority: "L.",
    why: "The bramble: CoL files the name as a synonym under three species (L., G.N.Jones and Loureiro's), so the matcher answers only the genus. The Red List cites L., which matches only Linnaeus's record, a synonym of Rubus plicatus: that one counts, flagged, as a pick the matcher didn't make; the other two citations don't. Before, the link owned all three (counting Loureiro's Vietnamese Rubus), then none.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Rubus plicatus", doubts: ["chosen by the citation"], rules: ["candidate"], selected: [{ name: "Rubus fruticosus", authorship: "L.", relation: "part of" }] },
  },
  {
    name: "Pleurothallis elegantula",
    authority: "Cogn.",
    why: "CoL holds two Pleurothallis elegantula Cogn., synonyms of different species, so the matcher answers only the genus and the citation can't choose either. No count. Update (2026-11, COL26.6 XR, matching spec): the two records share a citation, so they are copies: both count their own name, with the doubts, and the Red List's synonym Specklinia elegantula (Cogn.) Luer, filed under Pabstiella elegantula (Cogn.) Luer with the same original author, counts that species whole.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Pabstiella elegantula", doubts: ["chosen by the citation", "ambiguous synonym"], selected: [{ name: "Pabstiella elegantula", relation: "is" }] },
  },
  {
    name: "Allanaspides helonomus",
    authority: "Swain, Wilson, Hickman & Ong, 1970",
    why: "CoL holds it twice by the same authors: accepted, and provisionally (the matcher's answer). Provisional is CoL's doubt about the taxonomy, not about which records are this species', so both copies count, as for any species CoL holds twice. Until 2026-11 a provisional answer waited, then was flagged.",
    source: "link/select.ts (copies)",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Allanaspides helonomus", hasRecords: true, rules: ["exact, duplicate in CoL", "CoL duplicate"] },
  },
  {
    name: "Bulimulus eschariferus",
    authority: "(Ancey, 1887)",
    why: "The only CoL name spelt like it is Sowerby's (1838), a synonym of Naesiotus eschariferus: another author, so perhaps another snail. The matcher's answer is the link now, flagged: flagged, and queued for review.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Naesiotus eschariferus", doubts: ["other authors"] },
  },
  {
    name: "Vestia roschitzi",
    authority: "(Brancsik, 1890)",
    why: "CoL holds the name only as a synonym that leads to no species. Update (2026-11, COL26.6 XR, matching spec): CoL now also holds it provisionally accepted (7FR8X) and as an ambiguous synonym of Pavlovicia roschitzi, which the Red List's synonym Vestiella roschitzi Brancsik, 1890 leads to: all count, with the doubts.",
    source: "docs/specs/matching.md; link/select.ts",
    confirmed: NOVEMBER_12,
    expect: { linkedTo: "Pavlovicia roschitzi", doubts: ["chosen by the citation", "ambiguous synonym"], selected: [{ name: "Vestia roschitzi", relation: "is" }, { name: "Pavlovicia roschitzi", relation: "is" }] },
  },
];
