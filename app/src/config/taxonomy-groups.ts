/**
 * The IUCN groups: the Red List's own reporting groups (the rows of its Table 1a),
 * as the taxonomy tree shows them. A species' IUCN group is its taxon_group, so
 * each node here is a list of taxon groups, with its described-species estimate
 * and where that comes from. The tree (taxonomy-tree.ts) places them, alone and
 * inside the Invertebrates, Plants and Fungi wrappers.
 */
import type { TaxonomyNode } from "./taxonomy-tree";

// ─── Sources ─────────────────────────────────────────────────────────

export const IUCN_SOURCE = "IUCN 2026-1";
// Exported so the "# Described" info popover (TaxaSummary.tsx) can link to the
// official Table 1a PDF itself, in addition to a node's own specific citation
// (MolluscaBase, WoRMS, etc.) — a node's estimatedSourceUrl is that specific
// citation, not this one, whenever the two differ.
export const IUCN_SOURCE_URL = "https://nc.iucnredlist.org/redlist/content/attachment_files/2026-1_RL_Table1a.pdf";
export const COL_2025 = "Catalogue of Life 2025";
export const COL_2025_URL = "https://doi.org/10.48580/dgnfb";
export const CHRISTENHUSZ = "Christenhusz & Byng 2016, Phytotaxa 261(3)";
export const CHRISTENHUSZ_URL = "https://doi.org/10.11646/phytotaxa.261.3.1";
export const SPECIES_FUNGORUM = "Species Fungorum Plus via Catalogue of Life";
export const SPECIES_FUNGORUM_URL = "https://doi.org/10.48580/dg9ld-4hj";

// Insect base taxon groups (the Table 1a "Insects" row, split by order)
export const ALL_INSECT_GROUPS = [
  "beetles", "butterflies_and_moths", "flies_and_mosquitoes", "bees_wasps_and_ants",
  "true_bugs", "grasshoppers_crickets_locusts", "dragonflies_and_damselflies", "other_insects",
];

/**
 * How to write the taxon groups that aren't nodes of their own.
 *
 * Every other group is a node in the tree below and takes its name from there.
 * The insect orders are only ever filter values — the tree splits insects by
 * SSC group rather than by order — so anything printing one had nothing to
 * print but the id, and "grasshoppers_crickets_locusts" arrived on screen as
 * "grasshoppers crickets locusts".
 */
export const TAXON_GROUP_NAMES: Record<string, string> = {
  beetles: "Beetles",
  butterflies_and_moths: "Butterflies & Moths",
  flies_and_mosquitoes: "Flies & Mosquitoes",
  bees_wasps_and_ants: "Bees, Wasps & Ants",
  true_bugs: "True Bugs",
  grasshoppers_crickets_locusts: "Grasshoppers, Crickets & Locusts",
  dragonflies_and_damselflies: "Dragonflies & Damselflies",
  other_insects: "Other Insects",
};

// ─── Plant taxonomy ──────────────────────────────────────────────────
//
// Plant Table 1a groups have no STATIC order/class-level split — unlike
// Insects/Mammals/etc. (retired in Phase 8 below), they never had one:
// robust described-species counts at the class/order level weren't reliable
// enough across the full tree for a hand-curated split, and showing "X
// assessed of 0 described" would read as broken data to specialists (still
// true for Molluscs/Crustaceans/Other Invertebrates — see
// dynamic-taxon.ts's DYNAMIC_DRILLDOWN_ROOTS comment). Flowering Plants/
// Gymnosperms/etc. DO get live order-level drilldown now (their CoL data
// turned out clean when checked directly) — this comment is about why they
// never had a STATIC one, not that they're undrillable today.

// All 28 Table 1a taxon groups (Insects split into 8 order-based groups).
//
// These are also the parquet partition values every node's `taxonGroups` draws
// from — species/ is hive-partitioned by taxon_group, and a node's filter compiles
// to `taxon_group IN (…)` (see taxonomy-sql). The two vocabularies coincide because
// Table 1a is the reporting granularity the partitioning was built for; the field
// is named taxonGroups after the COLUMN rather than after Table 1a, so it keeps
// matching the SQL if IUCN ever restructures that table.
//
// Deliberately 28 of the 29 partitions on disk: `other` (~119k rows — foraminifera,
// diatoms and the rest of the CoL universe outside the dashboard's remit) is a real
// partition that NO node lists, so nothing reads it. That's intentional, not a gap,
// but it does mean this is a curated subset rather than "every taxon_group value".
export const ALL_TAXON_GROUPS = [
  "mammals", "birds", "reptiles", "amphibians", "fishes",
  ...ALL_INSECT_GROUPS,
  "arachnids", "molluscs", "crustaceans", "corals",
  "other_invertebrates", "velvet_worms", "horseshoe_crabs",
  "flowering_plants", "gymnosperms", "ferns_and_allies", "mosses",
  "green_algae", "red_algae", "brown_algae",
  "mushrooms",
];

export const ALL_INVERTEBRATE_GROUPS = [
  ...ALL_INSECT_GROUPS,
  "arachnids", "molluscs", "crustaceans", "corals",
  "other_invertebrates", "velvet_worms", "horseshoe_crabs",
];

export const ALL_PLANT_GROUPS = [
  "flowering_plants", "gymnosperms", "ferns_and_allies", "mosses",
  "green_algae", "red_algae",
];

// ─── Canonical Table 1a nodes (reused in virtual grouping nodes) ─────

// Static order-level children retired (Phase 8) — Insects is a
// DYNAMIC_DRILLDOWN_ROOTS root now (dynamic-taxon.ts), replaced by live
// order-level enumeration across ALL_INSECT_GROUPS. Their curated common
// names (Beetles, Butterflies & Moths, ...) live on as a display-only overlay
// in dynamic-taxon.ts's COMMON_NAME_BY_VALUE.
export const INSECTS_NODE: TaxonomyNode = {
  id: "insects",
  name: "Insects",
  filter: { taxonGroups: ALL_INSECT_GROUPS },
  estimatedDescribed: 1_008_355,
  estimatedSource: IUCN_SOURCE + " (" + COL_2025 + ")",
  estimatedSourceUrl: IUCN_SOURCE_URL,
};

export const ARACHNIDA_NODE: TaxonomyNode = {
  id: "arachnids",
  name: "Arachnids",
  filter: { taxonGroups: ["arachnids"] },
  estimatedDescribed: 98_006,
  estimatedSource: IUCN_SOURCE + " (" + COL_2025 + ")",
  estimatedSourceUrl: COL_2025_URL,
};

export const MOLLUSCA_NODE: TaxonomyNode = {
  id: "molluscs",
  name: "Molluscs",
  filter: { taxonGroups: ["molluscs"] },
  estimatedDescribed: 89_129,
  estimatedSource: IUCN_SOURCE + " (MolluscaBase 2025)",
  estimatedSourceUrl: "http://www.molluscabase.org",
};

export const CRUSTACEA_NODE: TaxonomyNode = {
  id: "crustaceans",
  name: "Crustaceans",
  filter: { taxonGroups: ["crustaceans"] },
  estimatedDescribed: 83_805,
  estimatedSource: IUCN_SOURCE + " (" + COL_2025 + "; World Ostracoda Database)",
  estimatedSourceUrl: COL_2025_URL,
};

export const CORALS_NODE: TaxonomyNode = {
  id: "corals",
  name: "Corals & Cnidarians",
  filter: { taxonGroups: ["corals"] },
  estimatedDescribed: 5_695,
  estimatedSource: IUCN_SOURCE + " (WoRMS 2025)",
  estimatedSourceUrl: "https://www.marinespecies.org",
};

// Static phylum-sub-group split retired (2026-07-22) — Other Invertebrates is a
// DYNAMIC_DRILLDOWN_ROOTS root now (class-first, see dynamic-taxon.ts's
// ROOT_RANK_ORDER), replaced by live class-level enumeration. The old static
// split (Flatworms/Roundworms/Annelids/Myriapods/Sponges/Cnidarians/
// Echinoderms/Bryozoans/Tunicates + an "Others" catch-all, each a hand-curated
// CoL-class allowlist) had the exact same NULL-class caveat the live version
// now handles generically via its "Unclassified Class" bucket instead of a
// silent catch-all.
export const OTHER_INVERTEBRATES_NODE: TaxonomyNode = {
  id: "other_invertebrates",
  name: "Other Invertebrates",
  filter: { taxonGroups: ["other_invertebrates"] },
  estimatedDescribed: 171_981,
  estimatedSource: IUCN_SOURCE,
  estimatedSourceUrl: COL_2025_URL,
};

export const VELVET_WORMS_NODE: TaxonomyNode = {
  id: "velvet_worms",
  name: "Velvet Worms",
  filter: { taxonGroups: ["velvet_worms"] },
  estimatedDescribed: 220,
  estimatedSource: IUCN_SOURCE,
  estimatedSourceUrl: IUCN_SOURCE_URL,
};

export const HORSESHOE_CRABS_NODE: TaxonomyNode = {
  id: "horseshoe_crabs",
  name: "Horseshoe Crabs",
  filter: { taxonGroups: ["horseshoe_crabs"] },
  estimatedDescribed: 4,
  estimatedSource: IUCN_SOURCE,
  estimatedSourceUrl: IUCN_SOURCE_URL,
};

// ─── Plant nodes (all leaves — see comment above) ────────────────────

export const FLOWERING_PLANTS_NODE: TaxonomyNode = {
  id: "flowering_plants",
  name: "Flowering Plants",
  filter: { taxonGroups: ["flowering_plants"] },
  estimatedDescribed: 369_000,
  estimatedSource: IUCN_SOURCE + " (State of the World's Plants 2017)",
  estimatedSourceUrl: IUCN_SOURCE_URL,
};

export const GYMNOSPERMS_NODE: TaxonomyNode = {
  id: "gymnosperms",
  name: "Gymnosperms",
  filter: { taxonGroups: ["gymnosperms"] },
  estimatedDescribed: 1_113,
  estimatedSource: IUCN_SOURCE + " (Christenhusz et al. 2011)",
  estimatedSourceUrl: "https://stateoftheworldsplants.org/2017/report/SOTWP_2017.pdf",
};

export const FERNS_AND_ALLIES_NODE: TaxonomyNode = {
  id: "ferns_and_allies",
  name: "Ferns & Allies",
  filter: { taxonGroups: ["ferns_and_allies"] },
  estimatedDescribed: 11_800,
  estimatedSource: IUCN_SOURCE + " (State of the World's Plants 2017)",
  estimatedSourceUrl: "https://stateoftheworldsplants.org/2017/report/SOTWP_2017.pdf",
};

export const MOSSES_NODE: TaxonomyNode = {
  id: "mosses",
  name: "Mosses, Liverworts & Hornworts",
  filter: { taxonGroups: ["mosses"] },
  estimatedDescribed: 19_539,
  estimatedSource: IUCN_SOURCE + " (" + CHRISTENHUSZ + ")",
  estimatedSourceUrl: CHRISTENHUSZ_URL,
};

export const GREEN_ALGAE_NODE: TaxonomyNode = {
  id: "green_algae",
  name: "Green Algae",
  filter: { taxonGroups: ["green_algae"] },
  estimatedDescribed: 14_739,
  estimatedSource: IUCN_SOURCE,
  estimatedSourceUrl: IUCN_SOURCE_URL,
};

export const RED_ALGAE_NODE: TaxonomyNode = {
  id: "red_algae",
  name: "Red Algae",
  filter: { taxonGroups: ["red_algae"] },
  estimatedDescribed: 7_812,
  estimatedSource: IUCN_SOURCE,
  estimatedSourceUrl: IUCN_SOURCE_URL,
};

// Static Ascomycota/Other-Fungi split retired (Phase 8) — Fungi is a
// DYNAMIC_DRILLDOWN_ROOTS root now, replaced by live order-level enumeration.
export const MUSHROOMS_NODE: TaxonomyNode = {
  id: "mushrooms",
  name: "Fungi",
  filter: { taxonGroups: ["mushrooms"] },
  estimatedDescribed: 157_648,
  estimatedSource: IUCN_SOURCE + " (" + SPECIES_FUNGORUM + ")",
  estimatedSourceUrl: SPECIES_FUNGORUM_URL,
};

export const BROWN_ALGAE_NODE: TaxonomyNode = {
  id: "brown_algae",
  name: "Brown Algae",
  filter: { taxonGroups: ["brown_algae"] },
  estimatedDescribed: 5_104,
  estimatedSource: IUCN_SOURCE,
  estimatedSourceUrl: IUCN_SOURCE_URL,
};
