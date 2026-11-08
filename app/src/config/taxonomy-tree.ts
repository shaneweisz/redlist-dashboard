/**
 * Single taxonomy tree for the Red List dashboard.
 *
 * Rooted at "all", using IUCN Table 1a groups as the primary hierarchy.
 * The current 8 display taxa become a "view" (see taxonomy-views.ts).
 * Supports arbitrary nested drill-downs via children arrays.
 *
 * The tree is assembled here from its two kinds of node: the IUCN groups
 * (taxonomy-groups.ts), each a list of taxon groups, and the SSC Specialist
 * Groups (specialist-groups.ts), the only nodes with remits.
 *
 * Each node's filter is **self-contained** — no inheritance from parent.
 * IUCN API endpoints and GBIF keys stay separate in sync-script config.
 */

import { IUCN_SOURCE, IUCN_SOURCE_URL, ALL_TAXON_GROUPS, ALL_INVERTEBRATE_GROUPS, ALL_PLANT_GROUPS, INSECTS_NODE, ARACHNIDA_NODE, MOLLUSCA_NODE, CRUSTACEA_NODE, CORALS_NODE, OTHER_INVERTEBRATES_NODE, VELVET_WORMS_NODE, HORSESHOE_CRABS_NODE, FLOWERING_PLANTS_NODE, GYMNOSPERMS_NODE, FERNS_AND_ALLIES_NODE, MOSSES_NODE, GREEN_ALGAE_NODE, RED_ALGAE_NODE, MUSHROOMS_NODE, BROWN_ALGAE_NODE } from "./taxonomy-groups";
import { MAMMAL_SPECIALIST_GROUPS, REPTILE_SPECIALIST_GROUPS, FISH_SPECIALIST_GROUPS, INVERTEBRATE_SPECIALIST_GROUPS, PLANT_SPECIALIST_GROUPS, FUNGI_SPECIALIST_GROUPS } from "./specialist-groups";

// ─── Types ───────────────────────────────────────────────────────────

export interface SpeciesFilter {
  /** Which Table 1a CSV files to load */
  taxonGroups: string[];
  /** Filter by class_name (lowercase) */
  classNames?: string[];
  /** Filter by order_name (lowercase) */
  orderNames?: string[];
  /** Filter by family (lowercase) — for future deeper drill-downs */
  families?: string[];
  /** Exclude mode: exclude these orders (for catch-all nodes) */
  excludeOrders?: string[];
  /** Exclude mode: exclude these families */
  excludeFamilies?: string[];
  /** Exclude mode: exclude these classes */
  excludeClasses?: string[];
  /** Filter by genus (lowercase) — derived from the first token of scientific_name.
   * Needed for SSC specialist groups that split a family (e.g. Bovidae's Caprinae
   * vs. Bovini vs. the rest, or Ursidae's polar bear vs. other bears). */
  genera?: string[];
  /** Exclude mode: exclude these genera */
  excludeGenera?: string[];
  /** Filter by full scientific name (lowercase "genus species") — for the rare case
   * a specialist group's boundary is a single species (e.g. polar bear within Ursidae).
   * ANDed with every other clause above, same as the rest of this interface — use
   * this alone (no classNames/families/etc.) when the node IS just that species list. */
  speciesNames?: string[];
  /** Exclude mode: exclude these scientific names */
  excludeSpeciesNames?: string[];
  /** OR escape hatch: species included regardless of every other clause above
   * (bypasses classNames/orderNames/families/genera entirely, but still respects
   * taxonGroups and the CoL-only universe exclusions). For a group whose own stated
   * remit includes named species outside its otherwise-clean taxonomic rule — e.g.
   * the Antelope Specialist Group's own site names Pronghorn (Antilocapridae),
   * Water Chevrotain (Tragulidae), and Wild Camel (Camelidae) as part of its remit
   * "for practical reasons," alongside its Bovidae-based core. Without this, a
   * species outside the node's family/order rule can never be included no matter
   * what speciesNames says, since every clause in this interface is ANDed together. */
  extraSpeciesNames?: string[];
}

export interface TaxonomyNode {
  /** Stable ID for URLs and lookups */
  id: string;
  /** Display name */
  name: string;
  /** Self-contained: which CSVs + how to filter */
  filter: SpeciesFilter;
  /** Optional estimated described species count */
  estimatedDescribed?: number;
  /** Short citation for the estimate */
  estimatedSource?: string;
  /** URL to the source */
  estimatedSourceUrl?: string;
  /** UI color (only on nodes shown at top level) */
  color?: string;
  /** Optional link to the node's own definitive/official page (e.g. an SSC
   * Specialist Group's page on iucn.org) — distinct from estimatedSourceUrl,
   * which cites the described-species count specifically. */
  sourceUrl?: string;
  /** Arbitrary depth children */
  children?: TaxonomyNode[];
}


/** Deep-clone a TaxonomyNode, prefixing all IDs recursively. */
function prefixTree(node: TaxonomyNode, prefix: string): TaxonomyNode {
  return {
    ...node,
    id: prefix + node.id,
    children: node.children?.map(c => prefixTree(c, prefix)),
  };
}

// ─── The Tree ────────────────────────────────────────────────────────

export const TAXONOMY_TREE: TaxonomyNode = {
  id: "all",
  name: "All Species",
  filter: { taxonGroups: ALL_TAXON_GROUPS },
  estimatedDescribed: 2_121_262,
  estimatedSource: IUCN_SOURCE,
  estimatedSourceUrl: IUCN_SOURCE_URL,
  color: "#dc2626",
  children: [
    // ─── MAMMALS ───────────────────────────────────────────────────────
    // Static order-level children retired (Phase 8) — Mammals is a
    // DYNAMIC_DRILLDOWN_ROOTS root now, replaced by live order-level
    // enumeration. Curated common names (Rodents, Bats, ...) live on as a
    // display-only overlay in dynamic-taxon.ts's COMMON_NAME_BY_VALUE.
    {
      id: "mammals",
      name: "Mammals",
      filter: { taxonGroups: ["mammals"] },
      estimatedDescribed: 6_854,
      estimatedSource: IUCN_SOURCE,
      estimatedSourceUrl: IUCN_SOURCE_URL,
      color: "#f97316",
    },

    // SSC Specialist Groups (ssc-groups): see specialist-groups.ts
    MAMMAL_SPECIALIST_GROUPS,

    // SSC Specialist Groups (ssc-reptile-groups): see specialist-groups.ts
    REPTILE_SPECIALIST_GROUPS,

    // ─── BIRDS ─────────────────────────────────────────────────────────
    {
      id: "birds",
      name: "Birds",
      filter: { taxonGroups: ["birds"] },
      estimatedDescribed: 11_185,
      estimatedSource: IUCN_SOURCE,
      estimatedSourceUrl: IUCN_SOURCE_URL,
      color: "#3b82f6",
    },

    // ─── REPTILES ──────────────────────────────────────────────────────
    // Static order-level children retired (Phase 8) — Reptiles is a
    // DYNAMIC_DRILLDOWN_ROOTS root now, replaced by live order-level
    // enumeration (incl. the Tuataras/Sphenodon punctatus CoL null-order_name
    // fix, which lives on as canonicalOrderColumnSql's species-name override
    // in taxonomy-sql.ts).
    {
      id: "reptiles",
      name: "Reptiles",
      filter: { taxonGroups: ["reptiles"] },
      estimatedDescribed: 12_568,
      estimatedSource: IUCN_SOURCE,
      estimatedSourceUrl: IUCN_SOURCE_URL,
      color: "#84cc16",
    },

    // ─── AMPHIBIANS ────────────────────────────────────────────────────
    // Static order-level children retired (Phase 8) — Amphibians is a
    // DYNAMIC_DRILLDOWN_ROOTS root now.
    {
      id: "amphibians",
      name: "Amphibians",
      filter: { taxonGroups: ["amphibians"] },
      estimatedDescribed: 9_075,
      estimatedSource: IUCN_SOURCE,
      estimatedSourceUrl: IUCN_SOURCE_URL,
      color: "#14b8a6",
    },

    // ─── FISHES ────────────────────────────────────────────────────────
    // Static class-level children retired (Phase 8) — Fishes is a
    // DYNAMIC_DRILLDOWN_ROOTS root now, replaced by live CLASS-level
    // enumeration (see dynamic-taxon.ts's ROOT_RANK_ORDER — Fishes is the one
    // root that starts at class, not order) with the Cetacea-style label-split
    // fixes (canonicalClassColumnSql) applied. "Jawless Fish" (Myxini +
    // Petromyzonti) was a deliberate 2-class umbrella grouping, not a label
    // mismatch — it now shows as two separate live class buckets instead,
    // matching the same middle-path tradeoff already accepted for Insects'
    // "Other Insects" catch-all.
    {
      id: "fishes",
      name: "Fishes",
      filter: { taxonGroups: ["fishes"] },
      estimatedDescribed: 37_630,
      estimatedSource: IUCN_SOURCE,
      estimatedSourceUrl: IUCN_SOURCE_URL,
      color: "#06b6d4",
    },

    // SSC Specialist Groups (ssc-fish-groups): see specialist-groups.ts
    FISH_SPECIALIST_GROUPS,

    // ─── INSECTA ───────────────────────────────────────────────────────
    INSECTS_NODE,

    // ─── ARACHNIDA (leaf) ──────────────────────────────────────────────
    ARACHNIDA_NODE,

    // ─── MOLLUSCA (leaf) ───────────────────────────────────────────────
    MOLLUSCA_NODE,

    // ─── CRUSTACEA (leaf) ──────────────────────────────────────────────
    CRUSTACEA_NODE,

    // ─── CORALS (leaf) ─────────────────────────────────────────────────
    CORALS_NODE,

    // ─── VELVET WORMS (leaf) ───────────────────────────────────────────
    VELVET_WORMS_NODE,

    // ─── HORSESHOE CRABS (leaf) ────────────────────────────────────────
    HORSESHOE_CRABS_NODE,

    // ─── OTHER INVERTEBRATES (catch-all — kept last) ───────────────────
    OTHER_INVERTEBRATES_NODE,

    // SSC Specialist Groups (ssc-invertebrate-groups): see specialist-groups.ts
    INVERTEBRATE_SPECIALIST_GROUPS,

    // ─── FLOWERING PLANTS ──────────────────────────────────────────────
    FLOWERING_PLANTS_NODE,

    // ─── GYMNOSPERMS (leaf) ────────────────────────────────────────────
    GYMNOSPERMS_NODE,

    // ─── FERNS & ALLIES (leaf) ─────────────────────────────────────────
    FERNS_AND_ALLIES_NODE,

    // ─── MOSSES (leaf) ─────────────────────────────────────────────────
    MOSSES_NODE,

    // ─── GREEN ALGAE (leaf) ────────────────────────────────────────────
    GREEN_ALGAE_NODE,

    // ─── RED ALGAE (leaf) ──────────────────────────────────────────────
    RED_ALGAE_NODE,

    // ─── BROWN ALGAE (leaf) ────────────────────────────────────────────
    BROWN_ALGAE_NODE,

    // ─── MUSHROOMS ─────────────────────────────────────────────────────
    MUSHROOMS_NODE,

    // SSC Specialist Groups (ssc-plant-groups): see specialist-groups.ts
    PLANT_SPECIALIST_GROUPS,

    // SSC Specialist Groups (ssc-fungi-groups): see specialist-groups.ts
    FUNGI_SPECIALIST_GROUPS,

    // ─── VIRTUAL GROUPING NODES ────────────────────────────────────────
    // These aggregate Table 1a groups for the default view
    {
      id: "invertebrates",
      name: "Invertebrates",
      filter: { taxonGroups: ALL_INVERTEBRATE_GROUPS },
      estimatedDescribed: 1_457_195,
      estimatedSource: IUCN_SOURCE,
      estimatedSourceUrl: IUCN_SOURCE_URL,
      color: "#78716c",
      children: [
        prefixTree(INSECTS_NODE, "inv-"),
        prefixTree(ARACHNIDA_NODE, "inv-"),
        prefixTree(MOLLUSCA_NODE, "inv-"),
        prefixTree(CRUSTACEA_NODE, "inv-"),
        prefixTree(CORALS_NODE, "inv-"),
        prefixTree(VELVET_WORMS_NODE, "inv-"),
        prefixTree(HORSESHOE_CRABS_NODE, "inv-"),
        prefixTree(OTHER_INVERTEBRATES_NODE, "inv-"),
      ],
    },
    {
      id: "plantae",
      name: "Plants",
      filter: { taxonGroups: ALL_PLANT_GROUPS },
      estimatedDescribed: 424_003,
      estimatedSource: IUCN_SOURCE,
      estimatedSourceUrl: IUCN_SOURCE_URL,
      color: "#22c55e",
      children: [
        prefixTree(FLOWERING_PLANTS_NODE, "pl-"),
        prefixTree(GYMNOSPERMS_NODE, "pl-"),
        prefixTree(FERNS_AND_ALLIES_NODE, "pl-"),
        prefixTree(MOSSES_NODE, "pl-"),
        prefixTree(GREEN_ALGAE_NODE, "pl-"),
        prefixTree(RED_ALGAE_NODE, "pl-"),
      ],
    },
    {
      id: "fungi",
      name: "Fungi & Protists",
      filter: { taxonGroups: ["mushrooms", "brown_algae"] },
      estimatedDescribed: 162_752,
      estimatedSource: IUCN_SOURCE,
      estimatedSourceUrl: IUCN_SOURCE_URL,
      color: "#d97706",
      children: [
        prefixTree(MUSHROOMS_NODE, "fu-"),
        prefixTree(BROWN_ALGAE_NODE, "fu-"),
      ],
    },
  ],
};
