/**
 * The Table 1a groups, as IUCN defines them: each group's Red List kingdom,
 * phylum, class or order names. build-assessments assigns every assessed
 * species to one; derive-gbif-taxon-keys turns them into the GBIF keys in
 * src/config/gbif-taxon-keys.json, which the app reads.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface RedlistQuery {
  filterColumn: "kingdom_name" | "phylum_name" | "class_name" | "order_name";
  filterValues: string[];
}

export interface Taxon {
  id: string;
  name: string;
  /** Catalogue of Life kingdom key: N=Animalia, C=Chromista, F=Fungi, P=Plantae. */
  kingdomKey: string;
  redlist: RedlistQuery[];
}

// =============================================================================
// INSECT "OTHER" ORDERS
// =============================================================================

// The Table 1a "Insects" row is split into 7 named order-groups (Beetles,
// Butterflies & Moths, etc.) plus an "Other Insects" catch-all. Because the Red
// List SQL is include-only (no NOT-IN), the catch-all is defined by positive
// enumeration of every remaining order. Add new insect orders here as they
// appear in the source data; the build-taxa-summary lossless-split check (sum of
// the 8 groups == old single insecta total) will flag any drift.

// Red List order_name values for insects NOT in the 7 named groups.
const OTHER_INSECT_ORDERS_REDLIST = [
  "PHASMIDA", "TRICHOPTERA", "MANTODEA", "PLECOPTERA", "BLATTODEA", "ISOPTERA",
  "EPHEMEROPTERA", "DERMAPTERA", "GRYLLOBLATTODEA", "PSOCODEA", "NEUROPTERA",
  "ARCHAEOGNATHA", "SIPHONAPTERA", "THYSANOPTERA", "MEGALOPTERA",
];

// =============================================================================
// TAXA
// =============================================================================

/** The 28 groups, in Table 1a order. */
export const TAXA_DEFINITIONS: Taxon[] = [
  // ── Vertebrates ──
  {
    id: "mammals", name: "Mammals", kingdomKey: "N",
    redlist: [{ filterColumn: "class_name", filterValues: ["MAMMALIA"] }],
  },
  {
    id: "birds", name: "Birds", kingdomKey: "N",
    redlist: [{ filterColumn: "class_name", filterValues: ["AVES"] }],
  },
  {
    id: "reptiles", name: "Reptiles", kingdomKey: "N",
    redlist: [{ filterColumn: "class_name", filterValues: ["REPTILIA"] }],
  },
  {
    id: "amphibians", name: "Amphibians", kingdomKey: "N",
    redlist: [{ filterColumn: "class_name", filterValues: ["AMPHIBIA"] }],
  },
  {
    id: "fishes", name: "Fishes", kingdomKey: "N",
    redlist: [{ filterColumn: "class_name", filterValues: ["ACTINOPTERYGII", "CHONDRICHTHYES", "MYXINI", "PETROMYZONTI", "SARCOPTERYGII"] }],
  },

  // ── Invertebrates: Insects (Table 1a "Insects" row, split by order) ──
  {
    id: "beetles", name: "Beetles", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: ["COLEOPTERA"] }],
  },
  {
    id: "butterflies_and_moths", name: "Butterflies & Moths", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: ["LEPIDOPTERA"] }],
  },
  {
    id: "flies_and_mosquitoes", name: "Flies & Mosquitoes", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: ["DIPTERA"] }],
  },
  {
    id: "bees_wasps_and_ants", name: "Bees, Wasps & Ants", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: ["HYMENOPTERA"] }],
  },
  {
    id: "true_bugs", name: "True Bugs", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: ["HEMIPTERA"] }],
  },
  {
    id: "grasshoppers_crickets_locusts", name: "Grasshoppers, Crickets & Locusts", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: ["ORTHOPTERA"] }],
  },
  {
    id: "dragonflies_and_damselflies", name: "Dragonflies & Damselflies", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: ["ODONATA"] }],
  },
  {
    id: "other_insects", name: "Other Insects", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: OTHER_INSECT_ORDERS_REDLIST }],
  },

  // ── Invertebrates: Other ──
  {
    id: "molluscs", name: "Molluscs", kingdomKey: "N",
    redlist: [{ filterColumn: "phylum_name", filterValues: ["MOLLUSCA"] }],
  },
  {
    id: "crustaceans", name: "Crustaceans", kingdomKey: "N",
    // IUCN's Table 1a note 6 defines crustaceans as 7 classes — Maxillopoda has
    // since been split (Copepoda/Thecostraca/Hexanauplia/Ichthyostraca), and the
    // IUCN SIS database has already moved a few species out of the legacy
    // Maxillopoda bucket into "THEOCOSTRACA" (their own misspelling of
    // Thecostraca — verified against the live DB, not a typo here). Copepoda and
    // Ichthyostraca have no SIS-assessed species yet (verified: 0 taxons rows),
    // so they're omitted rather than added speculatively — add them if/when SIS
    // starts using those class names. Missing THEOCOSTRACA silently dropped 2
    // barnacle species (Armatobalanus nefrens, Menesiniella aquila) from every
    // crustaceans fetch.
    redlist: [{ filterColumn: "class_name", filterValues: ["MALACOSTRACA", "MAXILLOPODA", "BRANCHIOPODA", "OSTRACODA", "HEXANAUPLIA", "THEOCOSTRACA"] }],
  },
  {
    id: "arachnids", name: "Arachnids", kingdomKey: "N",
    redlist: [{ filterColumn: "class_name", filterValues: ["ARACHNIDA"] }],
  },
  {
    id: "corals", name: "Corals & Cnidarians", kingdomKey: "N",
    redlist: [{ filterColumn: "order_name", filterValues: ["SCLERACTINIA", "ALCYONACEA", "PENNATULACEA"] }],
  },
  {
    id: "velvet_worms", name: "Velvet Worms", kingdomKey: "N",
    redlist: [{ filterColumn: "class_name", filterValues: ["UDEONYCHOPHORA"] }],
  },
  {
    id: "horseshoe_crabs", name: "Horseshoe Crabs", kingdomKey: "N",
    redlist: [{ filterColumn: "class_name", filterValues: ["MEROSTOMATA"] }],
  },
  {
    id: "other_invertebrates", name: "Other Invertebrates", kingdomKey: "N",
    redlist: [
      // Non-coral Anthozoa (filtered by order to separate from corals in class ANTHOZOA)
      { filterColumn: "order_name", filterValues: [
        "ACTINIARIA", "ZOANTHARIA", "PENICILLARIA", "MALACALCYONCAEA", "SCLERALCYONACEA",
      ] },
      { filterColumn: "class_name", filterValues: [
        "HOLOTHUROIDEA", "CLITELLATA", "DIPLOPODA", "COLLEMBOLA", "CHILOPODA",
        "DEMOSPONGIAE", "HEXACTINELLIDA", "HYDROZOA", "NEMERTEA",
        "ASTEROIDEA", "CALCAREA", "POLYCHAETA", "TURBELLARIA", "ECHINOIDEA",
      ] },
    ],
  },

  // ── Plants ──
  {
    id: "mosses", name: "Mosses", kingdomKey: "P",
    redlist: [{ filterColumn: "phylum_name", filterValues: ["BRYOPHYTA", "ANTHOCEROTOPHYTA", "MARCHANTIOPHYTA"] }],
  },
  {
    id: "ferns_and_allies", name: "Ferns and Allies", kingdomKey: "P",
    redlist: [{ filterColumn: "class_name", filterValues: ["LYCOPODIOPSIDA", "ISOETOPSIDA", "EQUISETOPSIDA", "MARATTIOPSIDA", "POLYPODIOPSIDA", "PSILOTOPSIDA"] }],
  },
  {
    id: "gymnosperms", name: "Gymnosperms", kingdomKey: "P",
    redlist: [{ filterColumn: "class_name", filterValues: ["PINOPSIDA", "CYCADOPSIDA", "GINKGOOPSIDA", "GNETOPSIDA"] }],
  },
  {
    id: "flowering_plants", name: "Flowering Plants", kingdomKey: "P",
    redlist: [{ filterColumn: "class_name", filterValues: ["MAGNOLIOPSIDA", "LILIOPSIDA"] }],
  },
  {
    id: "green_algae", name: "Green Algae", kingdomKey: "P",
    redlist: [{ filterColumn: "phylum_name", filterValues: ["CHLOROPHYTA", "CHAROPHYTA"] }],
  },
  {
    id: "red_algae", name: "Red Algae", kingdomKey: "P",
    redlist: [{ filterColumn: "phylum_name", filterValues: ["RHODOPHYTA"] }],
  },

  // ── Fungi & Protists ──
  {
    id: "mushrooms", name: "Mushrooms, etc.", kingdomKey: "F",
    redlist: [{ filterColumn: "phylum_name", filterValues: ["ASCOMYCOTA", "BASIDIOMYCOTA"] }],
  },
  {
    id: "brown_algae", name: "Brown Algae", kingdomKey: "C",
    redlist: [{ filterColumn: "phylum_name", filterValues: ["HETEROKONTOPHYTA"] }],
  },
];

// =============================================================================
// LOOKUP
// =============================================================================

export function getTaxon(id: string): Taxon {
  const taxon = TAXA_DEFINITIONS.find((t) => t.id === id);
  if (!taxon) throw new Error(`Unknown taxon: ${id}. Available: ${TAXA_DEFINITIONS.map((t) => t.id).join(", ")}`);
  return taxon;
}

/** The groups with these ids, or every group. */
export function getTaxa(ids?: string[]): Taxon[] {
  return ids ? ids.map(getTaxon) : TAXA_DEFINITIONS;
}
