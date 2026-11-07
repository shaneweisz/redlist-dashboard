/**
 * Translates a taxonomy node's SpeciesFilter into a SQL predicate, mirroring
 * matchesFilter() (taxonomy-utils.ts) exactly — including its `?? ""` null
 * handling (so a null order_name behaves like an empty string, not SQL NULL,
 * which would otherwise drop such rows from both an include and its
 * complementary exclude).
 *
 * Originally lived inline in scripts/sync/precomputed/summaries.ts (used only against
 * the CoL species/ parquet, for colDescribed/colNe counts). Extracted so it can
 * also run against assessed.parquet at request time (src/lib/data/
 * scoped-taxa-summary-duckdb.ts) — the column names it references
 * (scientific_name/class_name/order_name/family/taxon_group) are shared by both
 * parquets, and expandClasses' CoL-specific class aliasing is a harmless no-op
 * superset when matched against IUCN's own (coarser) class names.
 */
import type { TaxonomyNode } from "@/config/taxonomy-tree";
import {
  COL_SPECIES_NAME_OVERRIDES,
  COL_EXCLUDE_ALL_NODES,
} from "@/config/col-described-overrides";

export type NodeFilter = TaxonomyNode["filter"];

// The display tree classifies fishes by the traditional GBIF/IUCN classes, but CoL XR
// uses finer classes — so a node filtering on `actinopterygii` matches zero CoL rows
// (which are `teleostei`, `holostei`, …). Expand those display classes to the CoL
// classes they contain so the four fish sub-groups count correctly. Identity for any
// class name that already exists in CoL (orders are unaffected).
// Unlike the fish entries above (canonical = IUCN's coarse label, alias = CoL's
// finer split), these three fold the OTHER way — CoL's label is the one kept,
// IUCN's is the alias — since IUCN's term is outdated/imprecise or a plain typo,
// not a meaningful coarser grouping worth preserving as its own bucket:
//  - copepoda: IUCN's assessed.parquet never uses "Copepoda" at all, only the
//    older "Maxillopoda" (74 crustacean spp.) or "Hexanauplia" (36) — CoL never
//    uses either literally. Confirmed via direct data query (2026-07-22): every
//    single one of those species' CoL-linked record is class Copepoda, a clean
//    fold, not an ambiguous split across multiple CoL classes.
//  - thecostraca: "Theocostraca" in assessed.parquet (3 crustacean spp.) is a
//    plain misspelling of "Thecostraca" (barnacles etc.), which CoL uses
//    correctly — folding it in also fixes the display name, not just the count.
//  - hoplonemertea: IUCN labels ribbon worms by their phylum name "Nemertea"
//    (6 other_invertebrates spp., all confirmed linked to CoL's actual class
//    Hoplonemertea) rather than a true class-rank name — same pattern as fish
//    classes needing a coarser IUCN label expanded to CoL's finer real one,
//    just the canonical/alias roles swapped since CoL's name is the more
//    precise, correct one here.
const COL_CLASS_ALIASES: Record<string, string[]> = {
  actinopterygii: ["teleostei", "chondrostei", "cladistii", "holostei"],
  sarcopterygii: ["dipneusti", "coelacanthi"],
  chondrichthyes: ["elasmobranchii", "holocephali"],
  copepoda: ["maxillopoda", "hexanauplia"],
  thecostraca: ["theocostraca"],
  hoplonemertea: ["nemertea"],
};
export function expandClasses(names: string[]): string[] {
  // Include the canonical name itself, not just its aliases (expandOrders' own
  // pattern) — filterToSql runs against BOTH species/ (CoL, which never uses the
  // coarse canonical label) AND assessed.parquet (IUCN, which ONLY uses the coarse
  // label, never the finer aliases). Dropping the canonical name here silently
  // zeroed out every IUCN-assessed match for a class with any alias (e.g.
  // "actinopterygii") — found via live-taxa-children.ts showing 0% assessed for
  // every order under Fishes/Molluscs/Crustaceans/Other Invertebrates once drilled
  // past the class level, since getLiveRankChildren's parentWhere is filterToSql'd
  // straight against assessed.parquet.
  return names.flatMap((n) => [n, ...(COL_CLASS_ALIASES[n.toLowerCase()] ?? [])]);
}

// Reverse of COL_CLASS_ALIASES: collapses a raw CoL-side class value (which is
// always the finer name — CoL never literally uses "actinopterygii") to its
// IUCN-canonical coarse name before grouping. Needed by live-taxa-children.ts's
// class-level enumeration (Fishes only, today) — a plain `GROUP BY class_name`
// would otherwise show "Teleostei"/"Elasmobranchii"/etc. as their own buckets
// reading "0% assessed" (misleading: assessed.parquet only ever uses the coarse
// name), instead of folding into the one real-world class both datasets
// otherwise agree on. Same category of fix as canonicalOrderColumnSql, one rank up.
const COL_CLASS_TO_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(COL_CLASS_ALIASES).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])),
);

/** SQL expression collapsing a class_name column to its canonical value (see
 *  COL_CLASS_TO_CANONICAL) before the usual coalesce(lower(...), '') — for
 *  GROUP BY use, not filter matching (filterToSql/expandClasses handles that). */
export function canonicalClassColumnSql(col: string): string {
  const cases = Object.entries(COL_CLASS_TO_CANONICAL)
    .map(([alias, canonical]) => `WHEN '${alias}' THEN '${canonical}'`)
    .join(" ");
  return `coalesce(lower(CASE lower(${col}) ${cases} ELSE lower(${col}) END), '')`;
}

// Same category of split as COL_CLASS_ALIASES, one rank down — but ADDITIVE, not
// a replacement: unlike actinopterygii (which CoL never uses literally, only its
// finer classes), CoL XR uses BOTH "artiodactyla" (498 mammal spp.) AND, for
// whales/dolphins/porpoises specifically, its own separate traditional order
// label "cetacea" (111 spp.) — while IUCN's assessed.parquet already reflects
// the modern Cetartiodactyla merger and files every cetacean under
// "artiodactyla" too. Without this, a node filtering on
// orderNames:["artiodactyla"] (e.g. the "Artiodactyls" node, or any live
// order-level drilldown bucket) silently misses every CoL-labeled cetacean.
// Same story for birds, found once Birds gained live order-level drilldown for the
// first time (it was a true static leaf before, so no prior code path ever
// GROUP-BY'd its orders against CoL): IUCN's assessed.parquet still uses two old
// lumped orders (pre-modern-taxonomy palaeognath/caprimulgiform classification),
// while CoL uses the finer modern splits. Confirmed via direct data query
// (2026-07-21): every family under each CoL-only order name here maps to exactly
// one IUCN order (a clean split, not an overlapping mess) —
// apodiformes/nyctibiiformes/steatornithiformes -> caprimulgiformes (619 CoL spp.
// folding into IUCN's single "Caprimulgiformes" bucket); tinamiformes/
// rheiformes/casuariiformes/apterygiformes -> struthioniformes (62 CoL spp.
// folding into IUCN's single "Struthioniformes" bucket, which despite the name
// covers all palaeognaths: ostriches, rheas, cassowaries, emus, kiwis, tinamous).
// Without this, a live "Caprimulgiformes" bucket showed 603 assessed vs. only 119
// CoL-described (533% "assessed"), and "Struthioniformes" showed 61 vs. 2 (3050%).
// Third instance of the same pattern, found rolling out live drilldown to
// Gymnosperms: IUCN's assessed.parquet lumps all conifers under the old
// "Pinales" (616 spp: Pinaceae/Cupressaceae/Taxaceae/Sciadopityaceae/
// Podocarpaceae/Araucariaceae), while CoL splits Cupressaceae/Taxaceae/
// Sciadopityaceae into "Cupressales" (231 spp) and Podocarpaceae/Araucariaceae
// into "Araucariales" (250 spp), keeping only Pinaceae under "Pinales" (300 spp)
// — confirmed via family-level cross-check (2026-07-21).
// Batch found by precomputed/summaries.ts's automated checkTaxonomyAliasDrift
// (2026-07-23) — each confirmed via direct data query to be a clean fold (the
// dominant or sole CoL target for every/nearly every assessed species under
// that IUCN order), same verification standard as the entries above. Not
// exhaustive: the same drift check also surfaced several genuinely AMBIGUOUS
// splits (e.g. IUCN's "Alcyonacea" → CoL's Malacalcyonacea/Scleralcyonacea
// roughly 50/50; "Gasterosteiformes" → three different CoL orders) and IUCN's
// literal "Not assigned" placeholder (confirmed multi-order via mushrooms'
// scatter — not a real name to alias) — deliberately left unaliased rather
// than guessing a single target for cases with no clean answer. Most of the
// order-level "no CoL match at all" drift the same check found (Mollusca's
// Stylommatophora & co., several Crustacea/Other-Invertebrate orders) is a
// genuine CoL data gap, not an alias-fixable mismatch — see the
// DYNAMIC_DRILLDOWN_ROOTS comment in dynamic-taxon.ts.
const COL_ORDER_ALIASES: Record<string, string[]> = {
  artiodactyla: ["cetacea"],
  caprimulgiformes: ["apodiformes", "nyctibiiformes", "steatornithiformes"],
  struthioniformes: ["tinamiformes", "rheiformes", "casuariiformes", "apterygiformes"],
  pinales: ["cupressales", "araucariales"],
  // New World vultures: IUCN keeps its own order; CoL lumps them into
  // Accipitriformes (birds of prey) alongside hawks/eagles.
  accipitriformes: ["cathartiformes"],
  // Mite order, alternate spelling.
  holothyrida: ["holothyroidae"],
  // Sea pens: CoL's modern octocoral split keeps these under Scleralcyonacea
  // (hard-axis octocorals) — unlike "Alcyonacea" below, this one IS clean.
  scleralcyonacea: ["pennatulacea"],
  // Krill order, alternate spelling ("euphasiacea" drops a "u").
  euphausiacea: ["euphasiacea"],
  // Whalefishes + pricklefishes: IUCN keeps each as its own order; CoL folds
  // both into Beryciformes.
  beryciformes: ["cetomimiformes", "stephanoberyciformes"],
  // South American lungfish: IUCN keeps its own order; CoL folds it into
  // Ceratodontiformes alongside the Australian lungfish.
  ceratodontiformes: ["lepidosireniformes"],
  // Gulper eels: IUCN keeps its own order; CoL folds them into the true-eel
  // order Anguilliformes.
  anguilliformes: ["saccopharyngiformes"],
  // Scorpionfish: IUCN's older "Scorpaeniformes" is ~99% CoL Perciformes
  // (605/611 assessed species) — the small remainder (Dactylopteriformes, one
  // clearly-mislinked outlier) isn't enough to make this an ambiguous split.
  perciformes: ["scorpaeniformes"],
  // Horseshoe crabs, alternate spelling.
  xiphosurida: ["xiphosura"],
  // Pygmy squid, alternate spelling ("idiosepiida" doubles the "i").
  idiosepida: ["idiosepiida"],
  // Pea clams: IUCN's "Sphaeriida" is ~92% CoL Venerida (146/159 assessed
  // species) — modern classification folds pea clams into the venerid clams.
  venerida: ["sphaeriida"],
  // A single peat-moss species, reclassified.
  sphagnales: ["ambuchananiales"],
  // A single lichen species, reclassified.
  baeomycetales: ["trapeliales"],
  // Ribbon worms, ORDER-level (distinct from COL_CLASS_ALIASES' hoplonemertea
  // entry, which is the CLASS-level fix for the same group's IUCN "Nemertea"
  // class label) — IUCN's "Hoplonemertea" order is CoL's "Monostilifera".
  monostilifera: ["hoplonemertea"],
  // A single soft-coral species, alternate spelling ("malacalcyoncaea" drops
  // an "a") — Malacalcyonacea itself is a real, distinct CoL order (see the
  // corals/other_invertebrates split noted above), just misspelled for this
  // one IUCN record.
  malacalcyonacea: ["malacalcyoncaea"],
  // A single tube-anemone species: IUCN's "Penicillaria" is CoL's Ceriantharia.
  ceriantharia: ["penicillaria"],
  // IUCN keeps "Brassicales"; CoL's modern classification is ~94.5% Capparales
  // (582/616 assessed species) — same category of split as Pinales above.
  capparales: ["brassicales"],
};
export function expandOrders(names: string[]): string[] {
  return names.flatMap((n) => [n, ...(COL_ORDER_ALIASES[n.toLowerCase()] ?? [])]);
}

// Reverse of COL_ORDER_ALIASES: collapses a raw CoL order value to its
// IUCN-canonical name before grouping. Needed by live-taxa-children.ts's
// order-level enumeration — a plain `GROUP BY order_name` would otherwise show
// "Cetacea" as its own bucket reading "0% assessed" (misleading: every one of
// those species IS assessed, just filed under "Artiodactyla" there), instead of
// folding into the same real-world order both datasets otherwise agree on.
const COL_ORDER_TO_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(COL_ORDER_ALIASES).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])),
);

// A handful of species whose CoL-side order_name is NULL despite having a real
// IUCN order — a CoL backbone data gap, not an assessment issue. Confirmed for
// Sphenodon punctatus (2026-07-21): the old static "Tuataras" node used an
// extraSpeciesNames escape hatch for the same gap (see taxonomy-tree.ts) before
// live order-rank enumeration existed to expose it as a GROUP BY problem too.
// Without this, such a species' CoL row falls into the "Unclassified Order"
// live bucket instead of its real order. Molluscs/Crustaceans/
// other_invertebrates have many more of these (thousands, per a direct data
// query) but aren't live-drillable yet — revisit generally once they are,
// rather than growing this one-off list further.
const COL_NULL_ORDER_SPECIES_OVERRIDE: Record<string, string> = {
  "sphenodon punctatus": "rhynchocephalia",
};

/** SQL expression collapsing an order_name column to its canonical value (see
 *  COL_ORDER_TO_CANONICAL and COL_NULL_ORDER_SPECIES_OVERRIDE) before the usual
 *  coalesce(lower(...), '') — for GROUP BY use, not filter matching
 *  (filterToSql/expandOrders handles that). sciNameCol backs the species-name
 *  override; omit it (e.g. when `col` isn't paired with a scientific_name
 *  column in this query) to skip that part and only apply the alias collapse. */
export function canonicalOrderColumnSql(col: string, sciNameCol?: string): string {
  const aliasCases = Object.entries(COL_ORDER_TO_CANONICAL)
    .map(([alias, canonical]) => `WHEN '${alias}' THEN '${canonical}'`)
    .join(" ");
  const aliasExpr = `CASE lower(${col}) ${aliasCases} ELSE lower(${col}) END`;
  if (!sciNameCol) return `coalesce(lower(${aliasExpr}), '')`;
  const sciCases = Object.entries(COL_NULL_ORDER_SPECIES_OVERRIDE)
    .map(([sci, order]) => `WHEN lower(${sciNameCol}) = '${sci}' THEN '${order}'`)
    .join(" ");
  return `coalesce(lower(CASE ${sciCases} ELSE ${aliasExpr} END), '')`;
}

/** SQL expression for a row's genus. None of the parquets carries a genus column —
 *  the genus is the first word of the (binomial) scientific name, which is how
 *  taxonomy-utils.ts's matchesFilter derives it on the client too. Shared with
 *  species-duckdb.ts's arbitrary-rank resolver and genus suggestions, so all three
 *  paths agree on what "genus" means without a data rebuild. Not lowercase-safe on
 *  its own: scientific_name is stored as-is (unlike the pre-lowercased
 *  class_name/order_name/family), hence the lower(). */
export const GENUS_SQL = "lower(split_part(scientific_name, ' ', 1))";

/**
 * Non-catch-all siblings whose filter names classes or orders "claim" their rows
 * away from a catch-all sibling (one with excludeClasses, "Other Mammals").
 * Siblings scoped by family, genus or species name deliberately don't claim.
 */
export function claimEligibleSiblingsSql(children: TaxonomyNode[], excludeIdx: number): string | null {
  const clauses = children
    .filter((c, i) => i !== excludeIdx && (c.filter.classNames?.length || c.filter.orderNames?.length))
    .map((c) => filterToSql(c.filter));
  return clauses.length ? clauses.map((c) => `(${c})`).join(" OR ") : null;
}

/**
 * The rows one child of a tree node counts, among its siblings: its own filter,
 * minus, for a catch-all child, what its siblings claim. The precomputed
 * children summaries (scripts/sync/precomputed/summaries.ts) and the live
 * scoped ones (scoped-taxa-summary-duckdb.ts) both count with this.
 */
export function childFilterSql(children: TaxonomyNode[], index: number): string {
  const own = filterToSql(children[index].filter);
  if (!children[index].filter.excludeClasses?.length) return own;
  const claimed = claimEligibleSiblingsSql(children, index);
  return claimed ? `(${own}) AND NOT (${claimed})` : own;
}

export function sqlStrList(vals: string[]): string {
  return vals.map((v) => `'${v.toLowerCase().replace(/'/g, "''")}'`).join(", ");
}

// See config/col-described-overrides.ts for what these are and why — shared with the
// frontend so the "# Described Species" tooltip explains the same overrides applied
// here, instead of the two silently drifting apart.

// Translate a taxonomy node filter into a SQL predicate, mirroring matchesFilter()
// exactly. Children partition a group by class/order, which is exclusive in the CoL
// universe — so no claim-tracking needed. nodeId (optional) triggers the
// species-name overrides above when computing a node's own CoL described/
// not-evaluated counts — irrelevant when matching real IUCN-assessed rows (which
// don't go through this code path; matchesFilter() never applies it either).
export function filterToSql(filter: NodeFilter, nodeId?: string): string {
  const sciName = "coalesce(lower(scientific_name), '')";
  if (nodeId && COL_SPECIES_NAME_OVERRIDES[nodeId]) {
    return `taxon_group IN (${sqlStrList(filter.taxonGroups)}) AND ${sciName} IN (${sqlStrList(COL_SPECIES_NAME_OVERRIDES[nodeId])})`;
  }
  const cls = "coalesce(lower(class_name), '')";
  const ord = "coalesce(lower(order_name), '')";
  const fam = "coalesce(lower(family), '')";
  const genus = `coalesce(${GENUS_SQL}, '')`;
  const conds: string[] = [`taxon_group IN (${sqlStrList(filter.taxonGroups)})`];
  if (filter.classNames?.length) conds.push(`${cls} IN (${sqlStrList(expandClasses(filter.classNames))})`);
  if (filter.excludeClasses?.length) conds.push(`${cls} NOT IN (${sqlStrList(expandClasses(filter.excludeClasses))})`);
  if (filter.orderNames?.length) {
    // The class_name fallback (order_name empty -> check class_name instead)
    // deliberately uses the UNEXPANDED list — expandOrders' cetacea alias is a
    // CoL-order-label quirk, not a class name, so it has no place in a
    // class-name comparison.
    conds.push(`(${ord} IN (${sqlStrList(expandOrders(filter.orderNames))}) OR (${ord} = '' AND ${cls} IN (${sqlStrList(filter.orderNames)})))`);
  }
  if (filter.excludeOrders?.length) {
    conds.push(`NOT (${ord} IN (${sqlStrList(expandOrders(filter.excludeOrders))}) OR (${ord} = '' AND ${cls} IN (${sqlStrList(filter.excludeOrders)})))`);
  }
  if (filter.families?.length) conds.push(`${fam} IN (${sqlStrList(filter.families)})`);
  if (filter.excludeFamilies?.length) conds.push(`${fam} NOT IN (${sqlStrList(filter.excludeFamilies)})`);
  if (filter.genera?.length) conds.push(`${genus} IN (${sqlStrList(filter.genera)})`);
  if (filter.excludeGenera?.length) conds.push(`${genus} NOT IN (${sqlStrList(filter.excludeGenera)})`);
  if (filter.speciesNames?.length) conds.push(`${sciName} IN (${sqlStrList(filter.speciesNames)})`);
  if (filter.excludeSpeciesNames?.length) conds.push(`${sciName} NOT IN (${sqlStrList(filter.excludeSpeciesNames)})`);
  // Species reassigned to another node's CoL override (Bison, see
  // col-described-overrides.ts), kept out of every other node so two groups don't
  // both count them. matchesFilter() applies the same exclusion to every row.
  conds.push(`${sciName} NOT IN (${sqlStrList(COL_EXCLUDE_ALL_NODES)})`);
  const normalClause = conds.join(" AND ");
  // extraSpeciesNames: mirrors matchesFilter's OR escape hatch (taxonomy-utils.ts) —
  // species included regardless of the class/order/family/genus rule above. Still
  // scoped to this node's taxonGroups and the universe-wide exclusions.
  if (filter.extraSpeciesNames?.length) {
    const extraClause = `taxon_group IN (${sqlStrList(filter.taxonGroups)}) AND ${sciName} IN (${sqlStrList(filter.extraSpeciesNames)}) AND ${sciName} NOT IN (${sqlStrList(COL_EXCLUDE_ALL_NODES)})`;
    return `((${normalClause}) OR (${extraClause}))`;
  }
  return normalClause;
}
