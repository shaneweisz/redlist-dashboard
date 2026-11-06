/**
 * Taxonomy tree utilities — cached indexes and helpers.
 *
 * Built once at import time from the taxonomy tree config.
 * Replaces the old taxa-hierarchy helpers (getSubgroupDef, speciesMatchesSubgroup)
 * and taxon-groups (getTaxonGroups).
 */

import { TAXONOMY_TREE, GRA_NAME_EQUIVALENTS, type TaxonomyNode, type SpeciesFilter } from "@/config/taxonomy-tree";
import { TAXONOMY_VIEWS } from "@/config/taxonomy-views";
import { canonicalizeTaxonId } from "@/lib/data/taxonomy-constants";
import { NODE_DESCRIPTION_OVERRIDES, COL_NODE_TOOLTIP_NOTES, COL_EXCLUDE_ALL_NODES, COL_SPECIES_NAME_OVERRIDES } from "@/config/col-described-overrides";
import COL_TAXON_IDS from "@/config/col-taxon-ids.json";
import COL_TAXON_ALIASES from "@/config/col-taxon-aliases.json";
import COL_RELEASE from "@/config/col-release.json";
// dynamic-taxon.ts imports NODE_INDEX/getAncestors back from this file — a
// circular import, but a safe one: both sides only reference the other inside
// function bodies (never at module-eval time), so by the time either function
// actually runs, both modules have finished initializing.
import {
  dynamicNodeFilter, isDynamicNodeId, dynamicNodeAncestors,
  rankOrderFor, parseDynamicNodeId, buildDynamicNodeId, isDynamicRank,
  type DynamicSegment,
} from "@/lib/dynamic-taxon";

// ─── Indexes (built once at import) ──────────────────────────────────

/** O(1) node lookup by ID */
export const NODE_INDEX = new Map<string, TaxonomyNode>();

/** child ID → parent ID */
export const PARENT_INDEX = new Map<string, string>();

function indexTree(node: TaxonomyNode, parentId?: string) {
  NODE_INDEX.set(node.id, node);
  if (parentId) PARENT_INDEX.set(node.id, parentId);
  if (node.children) {
    for (const child of node.children) {
      indexTree(child, node.id);
    }
  }
}

indexTree(TAXONOMY_TREE);

// ─── Lookup helpers ──────────────────────────────────────────────────

/** Find a node by ID, or undefined if not found. */
export function findNode(id: string): TaxonomyNode | undefined {
  return NODE_INDEX.get(id);
}

/** Get ancestor IDs from immediate parent up to root (exclusive). */
export function getAncestors(id: string): string[] {
  // Dynamic (live taxonomic-drilldown) ids delegate to dynamic-taxon.ts, which
  // walks the rank-segment chain down to the real root and then calls back into
  // this function for that root's own (static) ancestors — safe, not circular,
  // since the recursive call is always for a non-dynamic id.
  if (isDynamicNodeId(id)) return dynamicNodeAncestors(id);
  const ancestors: string[] = [];
  let current = PARENT_INDEX.get(id);
  while (current) {
    ancestors.push(current);
    current = PARENT_INDEX.get(current);
  }
  return ancestors;
}

/** Does this node have children? */
export function hasChildren(id: string): boolean {
  const node = NODE_INDEX.get(id);
  return !!node?.children && node.children.length > 0;
}

/** Get the path from root to this node (inclusive), as an array of IDs. */
export function getNodePath(id: string): string[] {
  return [...getAncestors(id).reverse(), id];
}

// ─── View root resolution ────────────────────────────────────────────

const DEFAULT_VIEW_ROOTS = new Set(TAXONOMY_VIEWS.default.roots);

// Nodes whose "# Described Species" figure is genuinely IUCN's own published number
// (the Table 1a PDF) rather than a third-party citation (MDD, Reptile Database,
// AmphibiaWeb, Eschmeyer, Zhang 2011, …) or a hand-typed approximation (the SSC
// pilot groups). That's exactly the 8 default-view summary taxa plus Table 1a's own
// 21 rows (28 taxon groups, with "insects" as one row) — every node one level deeper
// (Rodents, Bats, Beetles, every SSC group, …) cites something else, which — unlike
// the CoL-derived colDescribed figure — never gets automatically re-verified as the
// underlying species data changes. Used to pick the "# Described" default per row:
// IUCN for these, CoL for everything else. See TaxaSummary.tsx's applySource.
export const OFFICIAL_IUCN_DESCRIBED_NODE_IDS = new Set([
  "all", // the grand total across the 8 summary taxa — itself an IUCN-sourced sum
  ...TAXONOMY_VIEWS.default.roots,
  ...TAXONOMY_VIEWS.table1a.roots,
]);

// SSC Specialist Group leaves live under a per-taxon wrapper (e.g. "ssc-groups"
// for mammals, "ssc-reptile-groups" for reptiles) — kept OUT of their real taxon's
// tree node (so they don't pollute the normal subgroup list, e.g. Mammals'
// rodents/bats/primates/...) and out of the default view (so they aren't extra
// landing-page taxa). But for URL persistence + click-through navigation they
// behave like a sub-group of their real taxon (onNavigateToSubgroup(taxonId,
// sscLeafId)) — so redirect their view-root resolution there without actually
// re-parenting them. Add an entry here whenever a new taxon's SSC wrapper is added
// (see SSC_SECTIONS in TaxaSummary.tsx for the matching UI-side list).
//
// Same story, different reason, for "invertebrates"/"plantae"/"fungi"'s own CSV-
// group children (insects, molluscs, ..., mushrooms, brown_algae — see
// TAXONOMY_VIEWS.table1a.sections for the full membership): "invertebrates" is a
// virtual grouping node used only for the "all" node's Table 1a-style children
// list and DEFAULT_VIEW_ROOTS — insects/molluscs/etc. are each their OWN direct
// child of "all" in the real tree (PARENT_INDEX), not nested under
// "invertebrates" at all. Without an override here, getAncestors(nodeId) for a
// dynamic id rooted at one of these (e.g. "insects~order:coleoptera") walks
// straight from "insects" to "all" and never finds a DEFAULT_VIEW_ROOTS member —
// getViewRootForNode returned null, so expandTaxaToken's dynamic branch silently
// fell through to treating the WHOLE dynamic id as an unrecognized "arbitrary
// rank" token. Confirmed broken for every root except mammals/birds/reptiles/
// amphibians/fishes (which ARE themselves literal DEFAULT_VIEW_ROOTS members, so
// never hit this path) — reloading a deep-linked URL into Insects/Molluscs/
// Arachnids/Corals/Mosses/Ferns/Gymnosperms/Flowering Plants/Algae/Mushrooms/
// Brown Algae showed the raw dynamic id string instead of a labeled breadcrumb.
const VIEW_ROOT_OVERRIDES: Record<string, string> = {
  "ssc-groups": "mammals",
  "ssc-reptile-groups": "reptiles",
  "ssc-fish-groups": "fishes",
  "ssc-invertebrate-groups": "invertebrates",
  "ssc-plant-groups": "plantae",
  "ssc-fungi-groups": "fungi",
  "insects": "invertebrates",
  "arachnids": "invertebrates",
  "corals": "invertebrates",
  "velvet_worms": "invertebrates",
  "horseshoe_crabs": "invertebrates",
  "molluscs": "invertebrates",
  "crustaceans": "invertebrates",
  "other_invertebrates": "invertebrates",
  // other_invertebrates' own former static children (flatworms, roundworms,
  // ...) are gone now, superseded by its live class-level drilldown (see
  // taxonomy-tree.ts) — so there's no lingering "inv-flatworms"-style token
  // to worry about colliding with, unlike the insects/molluscs/etc. case
  // just above (see getViewRootForNode's own doc comment for that reasoning).
  "mosses": "plantae",
  "ferns_and_allies": "plantae",
  "gymnosperms": "plantae",
  "flowering_plants": "plantae",
  "green_algae": "plantae",
  "red_algae": "plantae",
  "mushrooms": "fungi",
  "brown_algae": "fungi",
};

/**
 * Find the default-view ancestor for a node (one of the 8 display roots).
 * Deliberately does NOT check `VIEW_ROOT_OVERRIDES[nodeId]` itself before the
 * ancestor loop (only its ancestors) — insects/molluscs/etc. each already have
 * a distinct "inv-"-prefixed virtual duplicate node (e.g. "inv-insects") whose
 * real tree ancestors correctly include "invertebrates" with no override
 * needed. DEFAULT_VIEW_TOKEN_INDEX (below) relies on the BARE id ("insects")
 * resolving to null here so the "inv-" one claims that URL token instead;
 * making the bare id resolve directly would make it win that race instead
 * (NODE_INDEX iteration visits it first) and break every legacy insects/
 * molluscs/etc. URL. The loop still correctly resolves a DYNAMIC id rooted at
 * one of these (e.g. "insects~order:coleoptera") without this direct check,
 * since dynamicNodeAncestors already includes the bare rootId ("insects")
 * itself as part of the walked ancestor list, unlike a plain node's own
 * getAncestors (exclusive of self).
 */
export function getViewRootForNode(nodeId: string): string | null {
  if (DEFAULT_VIEW_ROOTS.has(nodeId)) return nodeId;
  for (const a of getAncestors(nodeId)) {
    if (DEFAULT_VIEW_ROOTS.has(a)) return a;
    if (VIEW_ROOT_OVERRIDES[a]) return VIEW_ROOT_OVERRIDES[a];
  }
  return null;
}

// ─── Flat taxa-token URL mapping ─────────────────────────────────────────
//
// The URL carries a single, flat `taxa` list. Internally a selection is a
// display-root + (optional) sub-group node (e.g. `invertebrates` + `inv-corals`,
// because species rows store the coarse root taxon_id: corals → invertebrates).
// These helpers translate between the two so the URL stays clean while the
// dashboard's two-level model is unchanged.
//
// A node's flat token is its id with the virtual-root prefix stripped
// (inv-corals → corals); display roots and arbitrary scientific ranks are their
// own token. The token↔node mapping must be a bijection over the default view —
// enforced by a whole-tree round-trip test (taxonomy-tree.test.ts).

const NODE_ID_PREFIX_RE = /^(inv-|pl-|fu-)/;

/** A node id with its virtual-root prefix (inv-/pl-/fu-) removed. */
export const stripNodePrefix = (id: string) => id.replace(NODE_ID_PREFIX_RE, "");

// token → default-view sub-group node id (built once at import). Only nodes BELOW
// a default root are indexed; the flat Table-1a clones live under `all` and are
// excluded (getViewRootForNode === null), so a token never resolves to one.
const DEFAULT_VIEW_TOKEN_INDEX = new Map<string, string>();
for (const id of NODE_INDEX.keys()) {
  if (DEFAULT_VIEW_ROOTS.has(id)) continue;
  if (!getViewRootForNode(id)) continue;
  const token = stripNodePrefix(id);
  if (!DEFAULT_VIEW_TOKEN_INDEX.has(token)) DEFAULT_VIEW_TOKEN_INDEX.set(token, id);
}

/**
 * Resolve the first "~"-separated piece of a dynamic token back to a real node id.
 *
 * Deliberately mirrors expandTaxaToken's own resolution order rather than hitting
 * NODE_INDEX first: `molluscs` exists BOTH as the flat Table-1a clone (under `all`,
 * not reachable in the default view) and as `inv-molluscs` under Invertebrates.
 * DEFAULT_VIEW_TOKEN_INDEX excludes the clone, so going through it is what picks
 * the drillable one — a direct NODE_INDEX lookup would silently pick the clone.
 */
function resolveRootToken(rootToken: string): string | null {
  const id = canonicalizeTaxonId(rootToken.trim());
  if (DEFAULT_VIEW_ROOTS.has(id)) return id;
  const viaToken = DEFAULT_VIEW_TOKEN_INDEX.get(id) ?? DEFAULT_VIEW_TOKEN_INDEX.get(stripNodePrefix(id));
  if (viaToken) return viaToken;
  return NODE_INDEX.has(id) ? id : null; // explicitly-prefixed legacy token
}

/**
 * URL form of a dynamic (live taxonomic-drilldown) node id.
 *
 * The internal id spells out everything —
 * `pl-flowering_plants~order:dioscoreales~family:dioscoreaceae` — but two thirds of
 * that is recoverable rather than carried:
 *
 *   - The `pl-`/`inv-`/`fu-` prefix marks the virtual view group the root was cloned
 *     into. A STATIC token already drops it and resolves back through
 *     DEFAULT_VIEW_TOKEN_INDEX (`flowering_plants` → `pl-flowering_plants`); a dynamic
 *     one can use the identical path for its root piece.
 *   - The `order:`/`family:` labels are fixed by POSITION. Segments are always a
 *     contiguous prefix of rankOrderFor(root) and never sparse — nodeIdForSpecies
 *     fills a lineage gap with "" rather than skipping the rank, precisely because
 *     "dynamicNodeAncestors/nextDynamicRank read depth positionally" (see its
 *     comment). So segment i is rankOrderFor(root)[i], always.
 *
 * What's left is the root token and the bare values:
 * `flowering_plants~dioscoreales~dioscoreaceae`. An empty value stays an empty
 * segment, so the Unclassified buckets remain expressible (`molluscs~gastropoda~`
 * is Unclassified Order under Gastropoda).
 */
export function dynamicIdToToken(id: string): string {
  const parsed = parseDynamicNodeId(id);
  if (!parsed) return id;
  const ranks = rankOrderFor(parsed.rootId);
  // Position expresses the rank for every id the UI builds. It can't for an id whose
  // rank doesn't match its position, which a link predating a root's rank-order change
  // can be (molluscs/crustaceans/other_invertebrates moved to class-first on
  // 2026-07-22, so `molluscs~order:stylommatophora` has an order at position 0 where
  // the root now starts at class). Those keep an explicit label rather than being
  // flattened into a position that would say something else — otherwise re-serializing
  // such a URL would launder a still-valid order filter into a class filter matching
  // nothing.
  const parts = parsed.segments.map((s, i) => (s.rank === ranks[i] ? s.value : `${s.rank}:${s.value}`));
  return [stripNodePrefix(parsed.rootId), ...parts].join("~");
}

/**
 * Inverse of dynamicIdToToken. Null when the root piece names nothing, or when the
 * token is deeper than the root's rank order — either way the caller falls back to
 * treating the token as-is rather than inventing a node.
 *
 * Also accepts the pre-cleanup labelled form (`pl-flowering_plants~order:dioscoreales`)
 * so links shared before this change keep resolving.
 *
 * An explicit label WINS over position when present. Position is only an inference,
 * and it's wrong for a link that predates a root's rank-order change: molluscs,
 * crustaceans and other_invertebrates moved to class-first on 2026-07-22, so
 * `molluscs~order:stylommatophora` carries an order at the position that now means
 * class. Inferring there would silently turn ~3,300 land snails into a classNames
 * filter matching nothing — a shared link that quietly returns an empty list, which
 * is exactly the failure this token change is supposed to be free of.
 *
 * A label that isn't one of the four ranks rejects the whole token, matching what
 * parseDynamicNodeId did before: better to fall through to arbitrary-rank handling
 * than to invent a rank for it.
 */
export function tokenToDynamicId(token: string): string | null {
  if (!isDynamicNodeId(token)) return null;
  const [rootToken, ...rest] = token.split("~");
  const rootId = resolveRootToken(rootToken);
  if (!rootId) return null;
  const ranks = rankOrderFor(rootId);
  if (rest.length > ranks.length) return null;
  const segments: DynamicSegment[] = [];
  for (const [i, part] of rest.entries()) {
    const idx = part.indexOf(":");
    if (idx === -1) {
      segments.push({ rank: ranks[i], value: part });
      continue;
    }
    const label = part.slice(0, idx);
    if (!isDynamicRank(label)) return null;
    segments.push({ rank: label, value: part.slice(idx + 1) });
  }
  return buildDynamicNodeId(rootId, segments);
}

/**
 * The `taxa=` URL token for any node id, static or dynamic — the single place that
 * knows which of the two token forms applies. Callers building a URL by hand (e.g.
 * TaxaSummary's popover hrefs) must use this rather than stripNodePrefix, which is
 * only correct for a static id and mangles a dynamic one.
 */
export const taxaUrlToken = (nodeId: string): string =>
  isDynamicNodeId(nodeId) ? dynamicIdToToken(nodeId) : stripNodePrefix(nodeId);

/**
 * Expand one flat URL token into the internal selection it represents:
 * `{ taxa }` for a display root or an arbitrary scientific rank, or
 * `{ taxa, subgroup }` for a default-view sub-group (corals → invertebrates +
 * inv-corals). Accepts legacy/prefixed ids too (canonicalized first).
 */
export function expandTaxaToken(token: string): { taxa: string; subgroup?: string } {
  const id = canonicalizeTaxonId(token.trim());
  if (DEFAULT_VIEW_ROOTS.has(id)) return { taxa: id };
  // A dynamic (live taxonomic-drilldown) token carries its root as its own first
  // "~"-separated piece, so it needs no DEFAULT_VIEW_TOKEN_INDEX lookup for the
  // WHOLE token — but the root piece itself does (see dynamicIdToToken), which is
  // what tokenToDynamicId rebuilds before getViewRootForNode resolves the ancestry.
  if (isDynamicNodeId(id)) {
    const dynamicId = tokenToDynamicId(id) ?? id;
    const root = getViewRootForNode(dynamicId);
    if (root) return { taxa: root, subgroup: dynamicId };
  }
  const nodeId = DEFAULT_VIEW_TOKEN_INDEX.get(id) ?? DEFAULT_VIEW_TOKEN_INDEX.get(stripNodePrefix(id));
  if (nodeId) {
    const root = getViewRootForNode(nodeId);
    if (root) return { taxa: root, subgroup: nodeId };
  }
  return { taxa: id }; // a display root outside the default view, or an arbitrary rank
}

/**
 * Collapse an internal taxa + subgroups selection into the flat URL token list.
 * A selected sub-group is emitted as its token (and its root is dropped, since the
 * sub-group implies it); a root with no sub-group is emitted whole.
 */
export function collapseTaxaToTokens(taxa: Iterable<string>, subgroups: Iterable<string>): string[] {
  const tokens = new Set<string>();
  const rootsWithSubgroup = new Set<string>();
  for (const sg of subgroups) {
    // Both branches drop the pl-/inv-/fu- prefix, but they are NOT interchangeable:
    // a static id's token is just the bare id, while a dynamic id's token also drops
    // its per-segment rank labels (see dynamicIdToToken). Applying the static form
    // blanket-style to a dynamic id was a real bug: "pl-flowering_plants~order:
    // malpighiales" became "flowering_plants~order:malpighiales", which round-tripped
    // back as a DIFFERENT dynamic id (a bare root where the prefixed one was meant),
    // silently, on any URL rewrite — e.g. toggling the Assessed/Not Evaluated view
    // mode re-serializes the whole taxa list. TaxaSummary's subgroupData cache is
    // keyed by whichever root string first populated it, so the bare-rooted id was a
    // fresh miss and its ancestor row fell back to a zeroed placeholder.
    //
    // That specific rewrite is now the DEFINED token form rather than an accident, so
    // the invariant that matters is the round-trip: collapse→expand→collapse must be
    // stable, which tokenToDynamicId restores the prefix to satisfy. Covered by the
    // repeated-cycle test in dynamic-taxon.test.ts.
    tokens.add(taxaUrlToken(sg));
    const root = getViewRootForNode(sg);
    if (root) rootsWithSubgroup.add(root);
  }
  for (const t of taxa) {
    if (rootsWithSubgroup.has(t)) continue; // represented by its sub-group token(s)
    tokens.add(stripNodePrefix(t));
  }
  return [...tokens];
}

// ─── taxon group resolution ────────────────────────────────────────────

/** Get the taxon groups needed to load data for a node. */
export function getTaxonGroupsForNode(nodeId: string): string[] {
  const id = canonicalizeTaxonId(nodeId); // map legacy IDs (e.g. mammalia → mammals)
  const node = NODE_INDEX.get(id);
  if (!node) return [id]; // Fallback: treat as taxon group name
  return node.filter.taxonGroups;
}

// ─── Filter matching ─────────────────────────────────────────────────

/**
 * Does a species row match a SpeciesFilter?
 *
 * Works both server-side (with RedlistRow/GbifRow) and client-side
 * (with SpeciesRow). Caller must ensure the row comes from one of
 * the filter's taxonGroups.
 *
 * Falls back to class_name when order_name is empty (GBIF taxonomy quirk).
 */
export function matchesFilter(
  row: {
    class_name: string | null;
    order_name: string | null;
    family?: string | null;
    scientific_name?: string | null;
  },
  filter: SpeciesFilter,
): boolean {
  const sciNameLower = (row.scientific_name ?? "").trim().toLowerCase();

  // Names another node's CoL override claims (Bison), even for extraSpeciesNames
  // below — checked first so nothing can bypass it.
  if (sciNameLower && COL_EXCLUDE_ALL_NODES.includes(sciNameLower)) return false;

  // extraSpeciesNames: named species included regardless of every other clause in
  // this filter — see the SpeciesFilter interface doc comment for why this exists.
  if (filter.extraSpeciesNames?.length && filter.extraSpeciesNames.includes(sciNameLower)) return true;

  // Class include filter
  if (filter.classNames && filter.classNames.length > 0) {
    const cls = (row.class_name ?? "").toLowerCase();
    if (!filter.classNames.includes(cls)) return false;
  }

  // Class exclude filter
  if (filter.excludeClasses && filter.excludeClasses.length > 0) {
    const cls = (row.class_name ?? "").toLowerCase();
    if (cls && filter.excludeClasses.includes(cls)) return false;
  }

  // Order include filter (with class_name fallback when order_name is empty)
  if (filter.orderNames && filter.orderNames.length > 0) {
    const ord = (row.order_name ?? "").toLowerCase();
    const cls = (row.class_name ?? "").toLowerCase();
    if (!filter.orderNames.includes(ord) && !(ord === "" && filter.orderNames.includes(cls))) return false;
  }

  // Order exclude filter (same class_name fallback)
  if (filter.excludeOrders && filter.excludeOrders.length > 0) {
    const ord = (row.order_name ?? "").toLowerCase();
    const cls = (row.class_name ?? "").toLowerCase();
    if (filter.excludeOrders.includes(ord) || (ord === "" && filter.excludeOrders.includes(cls))) return false;
  }

  // Family include filter
  if (filter.families && filter.families.length > 0) {
    const fam = (row.family ?? "").toLowerCase();
    if (!filter.families.includes(fam)) return false;
  }

  // Family exclude filter
  if (filter.excludeFamilies && filter.excludeFamilies.length > 0) {
    const fam = (row.family ?? "").toLowerCase();
    if (fam && filter.excludeFamilies.includes(fam)) return false;
  }

  // Genus include/exclude filter (derived from the first token of scientific_name)
  if (filter.genera?.length || filter.excludeGenera?.length) {
    const genus = (row.scientific_name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (filter.genera && filter.genera.length > 0 && !filter.genera.includes(genus)) return false;
    if (filter.excludeGenera && filter.excludeGenera.length > 0 && genus && filter.excludeGenera.includes(genus)) return false;
  }

  // Full scientific name include/exclude filter (for species-level carve-outs)
  if (filter.speciesNames?.length || filter.excludeSpeciesNames?.length) {
    const name = (row.scientific_name ?? "").trim().toLowerCase();
    if (filter.speciesNames && filter.speciesNames.length > 0 && !filter.speciesNames.includes(name)) return false;
    if (filter.excludeSpeciesNames && filter.excludeSpeciesNames.length > 0 && name && filter.excludeSpeciesNames.includes(name)) return false;
  }

  // (Names reassigned to another node's species-name override, e.g. Bison, are
  // checked at the top of this function, before the extraSpeciesNames bypass.)

  return true;
}

/**
 * Client-side filter: does a species row match a taxonomy node?
 *
 * Replaces the old `speciesMatchesSubgroup`. Uses the same filter logic
 * but checks taxon group membership first.
 */
export function speciesMatchesNode(
  species: { taxon_group: string; class_name: string | null; order_name: string | null; family?: string | null; scientific_name?: string | null },
  nodeId: string,
): boolean {
  const node = NODE_INDEX.get(nodeId);
  if (!node) {
    // Dynamic (live taxonomic-drilldown) node — not a static tree entry, but a
    // real, filterable rank chain (see dynamic-taxon.ts). Falling through to
    // "don't filter" here would show every species in the taxonGroup regardless
    // of the selected order/family/genus — a serious correctness bug, not a
    // graceful degradation, so this is resolved explicitly rather than assumed.
    const dynFilter = dynamicNodeFilter(nodeId);
    if (dynFilter) {
      if (!dynFilter.taxonGroups.includes(species.taxon_group)) return false;
      return matchesFilter(species, dynFilter);
    }
    return true; // Genuinely unknown, non-dynamic id → don't filter
  }

  const f = node.filter;

  // Must belong to one of the filter's taxon groups
  if (!f.taxonGroups.includes(species.taxon_group)) return false;

  // Mirrors filterToSql's COL_SPECIES_NAME_OVERRIDES branch (build-taxa-summary.ts):
  // CoL lumps genus Bison into Bos, so a CoL-sourced row (NE species, named "Bos
  // bison") never matches Bison SG's own filter (genera: ["bison"]) — but an
  // IUCN-sourced row (assessed species, still named "Bison bison") DOES match the
  // normal filter directly, since IUCN hasn't adopted CoL's lumping. Added as an
  // extra match path, not a replacement, so both naming conventions work.
  const override = COL_SPECIES_NAME_OVERRIDES[nodeId];
  if (override) {
    const name = (species.scientific_name ?? "").trim().toLowerCase();
    if (override.includes(name)) return true;
  }

  return matchesFilter(species, f);
}

/**
 * Look up a node definition by its ID.
 * Returns { node, parentId } or null if not found.
 *
 * Drop-in replacement for the old `getSubgroupDef` — callers that used
 * `result.def` can use `result.node`, and `result.taxonId` → `result.parentId`.
 */
export function getNodeDef(nodeId: string): { node: TaxonomyNode; parentId: string } | null {
  const node = NODE_INDEX.get(nodeId);
  if (!node) return null;
  const parentId = PARENT_INDEX.get(nodeId);
  if (!parentId) return null; // Root node
  return { node, parentId };
}

// ─── Plain-language filter description (for the "# Described Species" tooltip) ──

export const COL_SOURCE_URL = "https://www.catalogueoflife.org/";

// The exact CoL XR release colDescribed is built from (the sync writes
// this, scripts/sync/inputs/col.ts) — cited by alias (e.g. "COL26.6 XR") and linked via its
// DOI, so "Source" points at the specific dataset version actually used instead of a
// generic, dateless homepage link that says nothing about which release produced the
// numbers on screen.
export const COL_RELEASE_LABEL = `Catalogue of Life (${COL_RELEASE.alias})`;
export const COL_RELEASE_URL = COL_RELEASE.doi ? `https://doi.org/${COL_RELEASE.doi}` : COL_SOURCE_URL;

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Binomial convention: capitalize the genus, leave the species epithet lowercase.
const capitalizeSpeciesName = (s: string): string => s.split(" ").map((w, i) => (i === 0 ? capitalize(w) : w)).join(" ");

// "remainder": a catch-all/remainder node (e.g. "Other Mammals", any "No/Other SSC
// Group") whose filter has no positive dimension to enumerate, only exclude*
// clauses — see primaryFilterRank below.
export type FilterRank = "class" | "order" | "family" | "genus" | "species" | "remainder";

// name → CoL taxon id, built by scripts/sync/outputs/build-col-taxon-ids.ts from the taxonomy tree
// + taxa.parquet. Only covers names actually referenced by a SpeciesFilter
// somewhere in the tree — not every name resolves (CoL classifies a few things
// differently, e.g. Bison is lumped into Bos), in which case the segment below just
// has no href and renders as plain text.
const COL_TAXON_ID_MAP: Record<string, string> = COL_TAXON_IDS;

// A container rank (class/order/family/genus) links to a species-level search scoped
// to that taxon, with the same extant + accepted-only definition colDescribed itself
// uses (SPECIES_STATUS in scripts/sync/core/build-taxa.ts) — so clicking through shows
// exactly the species being counted, not just a static profile page. Deliberately
// omits status=provisionally%20accepted: colDescribed excludes those names (they
// overshoot IUCN's own described-species totals — see the SPECIES_STATUS comment),
// so including them here would make the count look wrong on click-through even
// though it isn't. Known gap: a handful of nodes' colDescribed also includes
// CoL-extinct species IUCN has confirmed EX/EW (see createExEwAssessedTable in
// build-taxa-summary.ts) — those don't show up here since CoL's extinct=0/1 filter
// can't express "extinct, but only the IUCN-confirmed ones," so a clicked-through
// count can undercount colDescribed by that node's EX/EW additions. A species-rank
// name has no "species under it" to browse, so it links straight to its own taxon
// page instead.
//
// "Not extinct" is two filter values, not one. Some CoL sources mark living
// species extinct=false; others, the Reptile Database among them, leave the
// field empty. extinct=0 alone matched none of the latter, so every reptile
// link opened on an empty search; repeating the parameter ORs the two.
function colHref(rank: FilterRank, colId: string): string {
  if (rank === "species") return `${COL_SOURCE_URL}data/taxon/${colId}`;
  return `${COL_SOURCE_URL}data/search?TAXON_ID=${colId}&extinct=0&extinct=_NULL&rank=species&status=accepted`;
}

// Which of a filter's include fields enumerates this node's species (its "primary
// dimension") — the tree never sets more than one at a time (verified by
// taxonomy-tree.test.ts), so the first non-empty one is unambiguous. Mirrors
// primaryDimension() in scripts/sync/outputs/build-taxa-summary.ts, which decides the same thing
// server-side to compute NodeSummary.colBreakdown.
export function primaryFilterRank(filter: SpeciesFilter): { rank: FilterRank; label: string } | null {
  if (filter.classNames?.length) return { rank: "class", label: "Class" };
  if (filter.orderNames?.length) return { rank: "order", label: "Order" };
  if (filter.families?.length) return { rank: "family", label: "Family" };
  if (filter.genera?.length) return { rank: "genus", label: "Genus" };
  if (filter.speciesNames?.length) return { rank: "species", label: "Species" };
  // Catch-all/remainder node (excludeOrders/excludeClasses/excludeFamilies/
  // excludeGenera/excludeSpeciesNames only, no positive dimension) — mirrors
  // isExcludeOnlyCatchAll in scripts/sync/outputs/build-taxa-summary.ts, which computes exactly
  // one colBreakdown bucket (keyed by the node's own name) for these nodes.
  if (
    filter.excludeOrders?.length ||
    filter.excludeClasses?.length ||
    filter.excludeFamilies?.length ||
    filter.excludeGenera?.length ||
    filter.excludeSpeciesNames?.length
  ) {
    return { rank: "remainder", label: "Group" };
  }
  return null;
}

/** Display text for one breakdown row's name (binomial capitalization for species). */
export function breakdownDisplayName(rank: FilterRank, name: string): string {
  return rank === "species" ? capitalizeSpeciesName(name) : capitalize(name);
}

/** CoL page/search link for one breakdown row's name, if we could resolve its taxon id.
 *  Checks the precomputed static-tree snapshot first, then `liveColIds` (a dynamic
 *  node's own ancestor chain, resolved live — see live-breakdown.ts's
 *  resolveLiveColTaxonIds — since a genus like "Chaetodipus" reached purely via live
 *  drilldown is never referenced by any static SpeciesFilter and so never in the
 *  snapshot). */
// Tree names CoL files under a different name or rank (a synonym, a spelling
// variant, or a family CoL ranks as a subfamily), built alongside COL_TAXON_IDS.
// Their link goes to the CoL taxon, so the label has to say which one.
const COL_TAXON_ALIAS_MAP: Record<string, { name: string; rank: string }> = COL_TAXON_ALIASES;

/**
 * How to label a name CoL files differently, with its link on CoL's name:
 * "Bolyeridae (Bolyeriidae on CoL)" splits into
 * { colName: "Bolyeriidae", suffix: " on CoL" }, rendered as
 * `${name} (${colName}${suffix})` with only colName linked. When CoL keeps the
 * name but not the rank there is no second name, so the name itself stays the
 * link and only a note follows: { note: "a parvphylum on CoL" }.
 * Undefined for a name CoL accepts as written.
 */
export function colAliasLabel(rank: FilterRank, name: string): { colName: string; suffix: string } | { note: string } | undefined {
  const alias = COL_TAXON_ALIAS_MAP[`${rank}:${name.toLowerCase()}`];
  if (!alias) return undefined;
  if (alias.name.toLowerCase() === name.toLowerCase()) return { note: `${/^[aeiou]/i.test(alias.rank) ? "an" : "a"} ${alias.rank} on CoL` };
  return { colName: alias.name, suffix: " on CoL" };
}

/** The label as plain text, e.g. for an email or a title attribute. */
export function colAliasNote(rank: FilterRank, name: string): string | undefined {
  const label = colAliasLabel(rank, name);
  if (!label) return undefined;
  return "note" in label ? label.note : `${label.colName}${label.suffix}`;
}

/** For a filter name that isn't the GRA master list's own, what it is in the
 *  GRA's terms: "Trogonophiidae in the GRA list", "part of Tropiduridae in the
 *  GRA list". Undefined for any other name. */
export function graNameNote(rank: FilterRank, name: string): string | undefined {
  const eq = GRA_NAME_EQUIVALENTS[`${rank}:${name.toLowerCase()}`];
  if (!eq) return undefined;
  return eq.relation === "within" ? `part of ${eq.graName} in the GRA list` : `${eq.graName} in the GRA list`;
}

/** The names as the GRA list would give them, for text addressed to a GRA
 *  reader: a variant spelling becomes the GRA's, and a family the GRA folds
 *  into another (or a spelling of one already listed) drops out. */
export function graDisplayNames(rank: FilterRank, names: string[], display: (n: string) => string): string[] {
  const out: string[] = [];
  for (const n of names) {
    const eq = GRA_NAME_EQUIVALENTS[`${rank}:${n.toLowerCase()}`];
    if (eq?.relation === "within") continue;
    const shown = eq ? eq.graName : display(n);
    if (!out.some((o) => o.toLowerCase() === shown.toLowerCase())) out.push(shown);
  }
  return out;
}

/** A name's segments: linked as is, or plain with its CoL name linked in
 *  brackets; then, for a name the GRA list writes differently, its GRA name. */
function nameSegments(rank: FilterRank, display: string, name: string, liveColIds?: Record<string, string>): DescribeFilterSegment[] {
  const href = breakdownHref(rank, name, liveColIds);
  const label = colAliasLabel(rank, name);
  const gra = graNameNote(rank, name);
  const graSeg: DescribeFilterSegment[] = gra ? [{ text: ` (${gra})` }] : [];
  if (!label) return [{ text: display, href }, ...graSeg];
  if ("note" in label) return [{ text: display, href }, { text: ` (${label.note})` }, ...graSeg];
  return [{ text: display }, { text: " (" }, { text: label.colName, href }, { text: `${label.suffix})` }, ...graSeg];
}

export function breakdownHref(rank: FilterRank, name: string, liveColIds?: Record<string, string>): string | undefined {
  const key = `${rank}:${name.toLowerCase()}`;
  const colId = COL_TAXON_ID_MAP[key] ?? liveColIds?.[key];
  return colId ? colHref(rank, colId) : undefined;
}

/**
 * Does a species row belong to one specific name within a filter rank — e.g. rank
 * "order", name "rodentia"? Used to narrow a node's species list down to a single
 * breakdown row (RedListView's `bd=` URL param, set when a described-species popover
 * breakdown row is clicked — see TaxaSummary.tsx's BreakdownList). Mirrors the same
 * order/class_name fallback matchesFilter() uses for the GBIF-taxonomy quirk where
 * order_name is sometimes empty.
 *
 * `nodeId` is optional but should be passed whenever the caller has it: a species
 * pulled into the node via extraSpeciesNames (e.g. Antelope SG's Pronghorn, not
 * Bovidae) would otherwise never match ANY breakdown name for that node — the
 * node's whole primary dimension is "Family: Bovidae", so a strict rank/name check
 * would silently drop it from the narrowed species list even though it's correctly
 * counted in the node's total (the exact "count vs. displayed list disagree" bug
 * class this file's COL_EXCLUDE_ALL_NODES check exists to prevent elsewhere).
 */
export function matchesBreakdownName(
  row: { class_name: string | null; order_name: string | null; family?: string | null; scientific_name?: string | null },
  rank: FilterRank,
  name: string,
  nodeId?: string,
): boolean {
  if (nodeId) {
    const extra = findNode(nodeId)?.filter.extraSpeciesNames;
    if (extra?.length && extra.includes((row.scientific_name ?? "").trim().toLowerCase())) return true;
  }
  const n = name.toLowerCase();
  switch (rank) {
    case "class":
      return (row.class_name ?? "").toLowerCase() === n;
    case "order": {
      const ord = (row.order_name ?? "").toLowerCase();
      const cls = (row.class_name ?? "").toLowerCase();
      return ord === n || (ord === "" && cls === n);
    }
    case "family":
      return (row.family ?? "").toLowerCase() === n;
    case "genus":
      return ((row.scientific_name ?? "").trim().split(/\s+/)[0] ?? "").toLowerCase() === n;
    case "species":
      return (row.scientific_name ?? "").trim().toLowerCase() === n;
    case "remainder":
      // A remainder bucket represents the WHOLE node's filter, not one narrower
      // name within it — speciesMatchesNode (checked alongside this, see
      // SpeciesListPanel) already fully qualifies membership, so no further
      // narrowing is meaningful here.
      return true;
  }
}

/** One piece of a describeFilter() result: plain text, or a taxon name to link. */
export interface DescribeFilterSegment {
  text: string;
  /** Present when this segment is a taxon name we could resolve to a CoL page. */
  href?: string;
}

// Every name gets its own segment (linked when we have a CoL id for it) — no capping,
// so a skeptical reviewer can see and click through to every single name, even for a
// long list like Antelope SG's 14-genus excludeGenera.
function joinSegments(rank: FilterRank, names: string[], liveColIds?: Record<string, string>): DescribeFilterSegment[] {
  const segs: DescribeFilterSegment[] = [];
  names.forEach((n, i) => {
    if (i > 0) segs.push({ text: ", " });
    segs.push(...nameSegments(rank, capitalize(n), n, liveColIds));
  });
  return segs;
}

function speciesSegments(names: string[], liveColIds?: Record<string, string>): DescribeFilterSegment[] {
  const segs: DescribeFilterSegment[] = [];
  names.forEach((n, i) => {
    if (i > 0) segs.push({ text: ", " });
    segs.push(...nameSegments("species", capitalizeSpeciesName(n), n, liveColIds));
  });
  return segs;
}

/**
 * Render a node's SpeciesFilter as a short, human-readable description for the
 * "# Described Species" tooltip — e.g. "Family: Felidae" or "Genus: Bos, Bubalus,
 * Pseudoryx (excluding Bison, Bos taurus)". Checks NODE_DESCRIPTION_OVERRIDES first
 * for filters too broad/exclusion-heavy to summarize automatically (e.g. the SSC "No
 * SSC Group" catch-all), then appends a COL_NODE_TOOLTIP_NOTES note (if any)
 * explaining a CoL-specific quirk (lumped genus, domestic-form exclusion, coverage
 * gap).
 *
 * Returns segments rather than a plain string so the caller can render each taxon
 * name as a link to its Catalogue of Life page where we have one (see
 * COL_TAXON_IDS, and `liveColIds` for a dynamic node's ancestor chain — resolved
 * live, since names reached purely through live drilldown are never in that
 * build-time snapshot). Unlike an older version of this function, always includes
 * EVERY set dimension (e.g. a dynamic node's full "Order: Rodentia; Family:
 * Heteromyidae; Genus: Chaetodipus" ancestor chain), never just the primary one —
 * that used to matter because a caller could ask to hide the primary dimension
 * once a breakdown loaded (on the theory BreakdownList's own rows already showed
 * it), but that only ever covers the node's own DEEPEST segment, not its
 * ancestors, so hiding uniformly silently dropped ancestor context nothing else
 * showed. Whether/when the caller actually displays these segments (e.g.
 * TaxaSummary.tsx shows them only while a dynamic node's breakdown is still
 * loading, then hands off to the table) is entirely the caller's own decision —
 * this function no longer has an opinion on that.
 */
export function describeFilter(
  filter: SpeciesFilter,
  nodeId?: string,
  liveColIds?: Record<string, string>
): DescribeFilterSegment[] {
  const override = nodeId ? NODE_DESCRIPTION_OVERRIDES[nodeId] : undefined;
  const note = nodeId ? COL_NODE_TOOLTIP_NOTES[nodeId] : undefined;

  if (override) {
    const segs: DescribeFilterSegment[] = [{ text: override }];
    if (note) segs.push({ text: ` — ${note}` });
    return segs;
  }

  const segs: DescribeFilterSegment[] = [];
  let hasPart = false;
  const addPart = (label: string, rank: FilterRank, names: string[] | undefined) => {
    if (!names?.length) return;
    if (hasPart) segs.push({ text: "; " });
    hasPart = true;
    segs.push({ text: `${label}: ` }, ...joinSegments(rank, names, liveColIds));
  };
  addPart("Class", "class", filter.classNames);
  addPart("Order", "order", filter.orderNames);
  addPart("Family", "family", filter.families);
  addPart("Genus", "genus", filter.genera);
  if (filter.speciesNames?.length) {
    if (hasPart) segs.push({ text: "; " });
    hasPart = true;
    segs.push({ text: "Species: " }, ...speciesSegments(filter.speciesNames, liveColIds));
  }
  if (!hasPart) segs.push({ text: "All species in this group" });

  const excludeSegs: DescribeFilterSegment[] = [];
  let hasExclude = false;
  const addExclude = (rank: FilterRank, names: string[] | undefined) => {
    if (!names?.length) return;
    if (hasExclude) excludeSegs.push({ text: "; " });
    hasExclude = true;
    excludeSegs.push(...joinSegments(rank, names, liveColIds));
  };
  addExclude("class", filter.excludeClasses);
  addExclude("order", filter.excludeOrders);
  addExclude("family", filter.excludeFamilies);
  addExclude("genus", filter.excludeGenera);
  if (filter.excludeSpeciesNames?.length) {
    if (hasExclude) excludeSegs.push({ text: "; " });
    hasExclude = true;
    excludeSegs.push(...speciesSegments(filter.excludeSpeciesNames, liveColIds));
  }
  if (hasExclude) segs.push({ text: " (excluding " }, ...excludeSegs, { text: ")" });

  if (note) segs.push({ text: ` — ${note}` });
  return segs;
}

