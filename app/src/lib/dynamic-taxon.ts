/**
 * Synthetic node ids for the dynamic (live-query) taxonomic drilldown — a rank
 * chain grafted onto one of the static default-view roots, e.g.
 * "mammals~order:rodentia~family:muridae". `~` never appears in a real static
 * node id (taxonomy-tree.ts ids are all lowercase-hyphen), so isDynamicNodeId is
 * unambiguous and never collides with NODE_INDEX or the bare-token arbitrary-rank
 * search feature (species-duckdb.ts's resolveWhere, used as a fallback when a
 * search-bar taxon suggestion can't be resolved to a real node — see
 * suggestTaxa/resolveTaxonSuggestionNode, which DOES build ids via this module's
 * buildDynamicNodeId/nextDynamicRank when a match resolves to one).
 *
 * matchesFilter/filterToSql already support multiple simultaneous positive
 * dimensions ANDed together and already coalesce null order_name/family to ""
 * before comparing — so a filter segment with value "" naturally matches
 * exactly the Unclassified bucket for that rank, with no special-case code here.
 */
import { NODE_INDEX, getAncestors } from "@/lib/taxonomy-utils";
import type { SpeciesFilter } from "@/config/taxonomy-tree";

export type DynamicRank = "class" | "order" | "family" | "genus";
export interface DynamicSegment {
  rank: DynamicRank;
  value: string; // lowercase; "" = Unclassified bucket for this rank
}

const SEP = "~";
const RANK_TO_FILTER_FIELD: Record<DynamicRank, "classNames" | "orderNames" | "families" | "genera"> = {
  class: "classNames",
  order: "orderNames",
  family: "families",
  genus: "genera",
};
const ALL_RANKS = new Set<DynamicRank>(["class", "order", "family", "genus"]);

/** Is this string one of the four drillable ranks? */
export const isDynamicRank = (s: string): s is DynamicRank => ALL_RANKS.has(s as DynamicRank);

// Every root drills order -> family -> genus by default. Fishes was the first
// exception: its static tree already split at CLASS first (Ray-finned vs.
// Lobe-finned vs. Sharks & Rays — Actinopterygii/Sarcopterygii/Chondrichthyes),
// a biologically meaningful distinction that would silently vanish if live
// enumeration jumped straight to order. Single-class roots (Mammals, Birds,
// Reptiles, Amphibians) deliberately skip "class" — enumerating it would
// return exactly one redundant bucket.
//
// Molluscs/Crustaceans/Other Invertebrates need the same treatment for a
// DIFFERENT reason: on CoL's side, `order_name` has real, large coverage gaps
// (e.g. 36.8% null for molluscs, driven almost entirely by Gastropoda), while
// `class_name` is nearly fully populated everywhere (confirmed via direct data
// query, 2026-07-22) — these three were held back from live drilldown entirely
// until now specifically because starting at order would show real, populous
// orders as "0 described, 0%" purely from missing CoL classification data.
// Starting at class instead gets a fully live, accurate top level; drilling
// into a class still surfaces a real (if sometimes large — Gastropoda is
// ~44% unclassified at order) "Unclassified Order" bucket for the remainder,
// same graceful NULL-segment handling used everywhere else, rather than
// silently zeroing out a named order.
const DEFAULT_RANK_ORDER: DynamicRank[] = ["order", "family", "genus"];
const CLASS_FIRST_RANK_ORDER: DynamicRank[] = ["class", "order", "family", "genus"];
const ROOT_RANK_ORDER: Record<string, DynamicRank[]> = {
  fishes: CLASS_FIRST_RANK_ORDER,
  molluscs: CLASS_FIRST_RANK_ORDER,
  "inv-molluscs": CLASS_FIRST_RANK_ORDER,
  crustaceans: CLASS_FIRST_RANK_ORDER,
  "inv-crustaceans": CLASS_FIRST_RANK_ORDER,
  other_invertebrates: CLASS_FIRST_RANK_ORDER,
  "inv-other_invertebrates": CLASS_FIRST_RANK_ORDER,
};
/** The rank sequence a root drills through (e.g. ["order","family","genus"], or
 *  ["class","order","family","genus"] for a class-first root) — exported so a
 *  caller building a multi-segment id from a single matched rank (e.g. search's
 *  resolveTaxonSuggestionNode) knows which ranks must come before it in the chain. */
export function rankOrderFor(rootId: string): DynamicRank[] {
  return ROOT_RANK_ORDER[rootId] ?? DEFAULT_RANK_ORDER;
}

export function isDynamicNodeId(id: string): boolean {
  return id.includes(SEP);
}

export function buildDynamicNodeId(rootId: string, segments: DynamicSegment[]): string {
  return [rootId, ...segments.map((s) => `${s.rank}:${s.value}`)].join(SEP);
}

export function parseDynamicNodeId(id: string): { rootId: string; segments: DynamicSegment[] } | null {
  if (!id.includes(SEP)) return null;
  const [rootId, ...rest] = id.split(SEP);
  const segments: DynamicSegment[] = [];
  for (const part of rest) {
    const idx = part.indexOf(":");
    if (idx === -1) return null;
    const rank = part.slice(0, idx);
    if (!ALL_RANKS.has(rank as DynamicRank)) return null;
    segments.push({ rank: rank as DynamicRank, value: part.slice(idx + 1) });
  }
  return { rootId, segments };
}

/** The rank one level below this node's deepest segment (or the root's own
 *  starting rank for a bare root — "order" for most roots, "class" for Fishes)
 *  — the rank getLiveRankChildren should enumerate when expanding it. */
export function nextDynamicRank(id: string): DynamicRank | null {
  const parsed = parseDynamicNodeId(id);
  const rootId = parsed ? parsed.rootId : id;
  const depth = parsed ? parsed.segments.length : 0;
  return rankOrderFor(rootId)[depth] ?? null; // null once already at genus (a leaf)
}

/** Root's own filter with every segment's rank ANDed in. Null for a malformed id
 *  or an unknown root. */
export function dynamicNodeFilter(id: string): SpeciesFilter | null {
  const parsed = parseDynamicNodeId(id);
  if (!parsed) return null;
  const root = NODE_INDEX.get(parsed.rootId);
  if (!root) return null;
  const filter: SpeciesFilter = { taxonGroups: root.filter.taxonGroups };
  for (const seg of parsed.segments) {
    filter[RANK_TO_FILTER_FIELD[seg.rank]] = [seg.value];
  }
  return filter;
}

/** Ancestor chain from immediate parent up to the true root (exclusive of self) —
 *  same contract as taxonomy-utils.ts's getAncestors, which this delegates to
 *  once it reaches the real (non-dynamic) root id. */
export function dynamicNodeAncestors(id: string): string[] {
  const parsed = parseDynamicNodeId(id);
  if (!parsed) return [];
  const ancestors: string[] = [];
  for (let n = parsed.segments.length - 1; n >= 0; n--) {
    ancestors.push(buildDynamicNodeId(parsed.rootId, parsed.segments.slice(0, n)));
  }
  return [...ancestors, ...getAncestors(parsed.rootId)];
}

const RANK_LABEL: Record<DynamicRank, string> = { class: "Class", order: "Order", family: "Family", genus: "Genus" };

/** The rank + display label of a dynamic node's own (deepest) segment — e.g.
 *  {rank:"family", label:"Family"} for ".../family:muridae". Unlike
 *  taxonomy-utils.ts's primaryFilterRank (which picks the FIRST set dimension —
 *  correct for a static node's single-dimension filter, but wrong for a dynamic
 *  node's multi-dimension one: an order+family filter's "primary" rank for
 *  display purposes is the deepest one, not the first), this always reflects
 *  the node's actual identity. Null for a bare root (no segments yet). */
export function dynamicNodeRankInfo(id: string): { rank: DynamicRank; label: string } | null {
  const parsed = parseDynamicNodeId(id);
  if (!parsed || parsed.segments.length === 0) return null;
  const rank = parsed.segments[parsed.segments.length - 1].rank;
  return { rank, label: RANK_LABEL[rank] };
}

/** The raw (lowercase) scientific value of a dynamic node's own (deepest)
 *  segment — e.g. "muridae" for ".../family:muridae". This is the MATCHABLE
 *  identifier: unlike dynamicNodeDisplayName (a human-facing "Scientific name
 *  (Common name)" string), it's safe to compare case-insensitively against a
 *  species row's own order_name/family/etc. column (taxonomy-utils.ts's
 *  matchesBreakdownName does exactly this for the live no-match-breakdown
 *  species-list click-through — see live-breakdown.ts's getLiveBreakdown,
 *  which passes this, not dynamicNodeDisplayName, as a BreakdownEntry's
 *  `name`). Returns `id` itself for a malformed/non-dynamic id (shouldn't
 *  happen in practice — callers only reach this for a confirmed dynamic id). */
export function dynamicNodeMatchValue(id: string): string {
  const parsed = parseDynamicNodeId(id);
  if (!parsed || parsed.segments.length === 0) return id;
  return parsed.segments[parsed.segments.length - 1].value;
}

// CoL-derived vernacular names (class/order/family/genus rank — species already
// have their own common name from our Red List/GBIF data), populated once per
// warm server process by vernacular-names.ts's ensureVernacularNamesLoaded()
// (see scripts/sync/lists/vernacular-names.ts). Empty on the
// client and before that call — dynamicNodeDisplayName then just shows the
// capitalized scientific name alone, same as before this existed. Kept as a
// plain settable Record (not an import from vernacular-names.ts) so this module
// stays free of fs/DuckDB imports — it's bundled into the browser too.
let EXTRA_VERNACULAR_NAMES: Record<string, string> = {};
export function setVernacularNames(names: Record<string, string>): void {
  EXTRA_VERNACULAR_NAMES = names;
}

/** Display name for a dynamic node's own (deepest) segment: "Scientific name
 *  (Common name)" when a common name is known — checking the hand-curated
 *  COMMON_NAME_BY_VALUE override first (Decision 3: lets us pick a nicer/more
 *  specific name than CoL's own, e.g. "Beetles" over a more clinical CoL
 *  phrasing, where they differ), then the CoL-derived EXTRA_VERNACULAR_NAMES —
 *  else just the capitalized scientific name. "" = "Unclassified <Rank>". */
export function dynamicNodeDisplayName(id: string): string {
  const parsed = parseDynamicNodeId(id);
  if (!parsed || parsed.segments.length === 0) return NODE_INDEX.get(id)?.name ?? id;
  const last = parsed.segments[parsed.segments.length - 1];
  if (last.value === "") return `Unclassified ${RANK_LABEL[last.rank]}`;
  const sciName = last.value.charAt(0).toUpperCase() + last.value.slice(1);
  const common = COMMON_NAME_BY_VALUE[last.value] ?? EXTRA_VERNACULAR_NAMES[last.value];
  return common ? `${sciName} (${common})` : sciName;
}

// Static roots that get the new live, arbitrary-depth drilldown instead of the
// old precomputed table1a/ssc-group-children-summaries.json path — see taxa-subgroups/
// route.ts. Rolled out one root at a time (Phase 6) once the mechanism was
// proven on Mammals (Phase 2). Birds gains drilldown for the first time here
// (it's a true leaf in the static tree today, per taxonomy-tree.test.ts's own
// "Aves is a leaf" assertion) — isLiveDrilldownNode doesn't require existing
// static children, so this alone is enough for it to become expandable.
//
// Molluscs, Crustaceans, and Other Invertebrates were held back at first: on
// CoL's side, order_name has a large, genuine coverage gap (confirmed via
// direct data query, 2026-07-21: 37% of Molluscs' CoL rows, 18% of
// Crustaceans', 14% of Other Invertebrates' have a NULL order_name, vs. <1%
// everywhere else) — not a clean alias-fixable split like Cetacea/
// Struthioniformes/Pinales, but missing classification data outright. Order-
// first would've shown large, well-populated real orders (e.g. Stylommatophora,
// 3,338 assessed land snail species) as "0 described, 0%" purely from this gap.
// Fixed (2026-07-22) by putting these three on the class-first rank order too
// (see ROOT_RANK_ORDER above) — class_name is nearly fully populated even where
// order_name isn't (per-class breakdown confirmed the gap concentrates in a
// few specific classes: Gastropoda ~44% null order, Copepoda ~98%, Diplopoda
// ~96%, vs. ~0% in most others), so the live top level is now fully accurate;
// drilling into an affected class still surfaces a real "Unclassified Order"
// bucket for its remainder rather than a misleadingly-zeroed named order.
// Insects/Arachnids/Corals/plant & algae groups/Fungi are each defined ONCE
// (INSECTS_NODE etc. in taxonomy-tree.ts) but spliced into the tree TWICE:
// once with their bare id under the "invertebrates"/"plantae"/"fungi" virtual
// grouping nodes (id-prefixed via prefixTree — "inv-insects", "pl-gymnosperms",
// "fu-mushrooms", etc. — these are what the default "By Taxon" view actually
// renders and expands) and, separately, with their bare id for Table 1a mode
// (which has its own flat, non-hierarchical rendering path — Table1aRowData —
// and never consults this set, so including the bare id here is inert for it,
// not a Decision-7 violation). Both forms are listed below so drilldown works
// wherever a user can actually reach these nodes.
export const DYNAMIC_DRILLDOWN_ROOTS = new Set<string>([
  "mammals", "birds", "reptiles", "amphibians", "fishes",
  "insects", "inv-insects",
  "arachnids", "inv-arachnids",
  "corals", "inv-corals",
  "velvet_worms", "inv-velvet_worms",
  "horseshoe_crabs", "inv-horseshoe_crabs",
  "molluscs", "inv-molluscs",
  "crustaceans", "inv-crustaceans",
  "other_invertebrates", "inv-other_invertebrates",
  "flowering_plants", "pl-flowering_plants",
  "gymnosperms", "pl-gymnosperms",
  "ferns_and_allies", "pl-ferns_and_allies",
  "mosses", "pl-mosses",
  "green_algae", "pl-green_algae",
  "red_algae", "pl-red_algae",
  "brown_algae", "fu-brown_algae",
  "mushrooms", "fu-mushrooms",
]);

/** Is `id` (a bare root or a dynamic id under one) inside DYNAMIC_DRILLDOWN_ROOTS? */
export function isLiveDrilldownNode(id: string): boolean {
  const parsed = parseDynamicNodeId(id);
  return DYNAMIC_DRILLDOWN_ROOTS.has(parsed ? parsed.rootId : id);
}

// Seeded from the curated node names this feature replaces (Decisions 3/9) —
// purely a display overlay over live-computed data, never used for filtering.
// Extend this as more taxa roll out (Phase 6).
export const COMMON_NAME_BY_VALUE: Record<string, string> = {
  // Mammals
  rodentia: "Rodents",
  chiroptera: "Bats",
  carnivora: "Carnivores",
  artiodactyla: "Artiodactyls",
  lagomorpha: "Rabbits & Hares",
  sirenia: "Sirenians",
  perissodactyla: "Odd-toed Ungulates",
  pholidota: "Pangolins",
  // Insects
  coleoptera: "Beetles",
  lepidoptera: "Butterflies & Moths",
  diptera: "Flies & Mosquitoes",
  hymenoptera: "Bees, Wasps & Ants",
  hemiptera: "True Bugs",
  orthoptera: "Grasshoppers, Crickets & Locusts",
  odonata: "Dragonflies & Damselflies",
  // Reptiles
  squamata: "Squamates",
  testudines: "Turtles & Tortoises",
  crocodylia: "Crocodilians",
  rhynchocephalia: "Tuataras",
  // Amphibians
  anura: "Frogs & Toads",
  caudata: "Salamanders & Newts",
  gymnophiona: "Caecilians",
  // Fishes (class-level split)
  actinopterygii: "Ray-finned Fishes",
  sarcopterygii: "Lobe-finned Fishes",
  chondrichthyes: "Sharks & Rays",
  // CoL-derived vernacular-names.json overrides (see scripts/sync/sources/common-names.ts):
  // its selection rule (prefer col:preferred=true, else the shortest candidate)
  // picks a good name in the overwhelming majority of cases (checked 44
  // multi-candidate order/class taxa against the real 2026-07-21 CoL XR data —
  // "Ducks" for Anseriformes, "Pangolins" for Pholidota, "Frogs"/"Toads" for
  // Anura, etc.), but Hyracoidea's candidates are "cories" (6 chars, an obscure
  // archaic synonym) vs. "dassies"/"Hyraxes" (7 chars each) — "cories" wins on
  // pure length despite being far less recognizable. Override here rather than
  // trying to make the general heuristic smarter for one outlier.
  hyracoidea: "Hyraxes",
};
