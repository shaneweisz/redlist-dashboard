import * as fs from "fs";
import * as path from "path";

/**
 * Unified taxa configuration for Red List and GBIF pipelines.
 *
 * Each taxon maps to a Table 1a row and defines how to query both
 * the IUCN Red List database and the GBIF occurrence API.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface RedlistQuery {
  filterColumn: "kingdom_name" | "phylum_name" | "class_name" | "order_name";
  filterValues: string[];
}

/**
 * A GBIF taxon key for one of the taxa making up a Table 1a group.
 *
 * These are no longer written by hand. They are derived from this file's own
 * `redlist` definitions by scripts/sync/outputs/derive-gbif-taxon-keys.ts and stored in
 * src/config/gbif-taxon-keys.json, because a hand-maintained parallel list drifts
 * from the definition it mirrors — corals were defined as three orders while the
 * GBIF side carried one class key, and stopped covering octocorals the moment CoL
 * moved them.
 */
export interface GbifQuery {
  taxonKey: string;
  /** The IUCN name it came from, so a key in a query can be traced back. */
  fromName: string;
}

export interface Taxon {
  id: string;
  name: string;
  /** Catalogue of Life kingdom key: N=Animalia, C=Chromista, F=Fungi, P=Plantae. */
  kingdomKey: string;
  redlist: RedlistQuery[];
  /** Derived — see GbifQuery. Populated from the generated config at load time. */
  gbif: GbifQuery[];
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
//
// The GBIF keys for these orders are derived from this list rather than
// maintained beside it — see GbifQuery.

// Red List order_name values for insects NOT in the 7 named groups.
const OTHER_INSECT_ORDERS_REDLIST = [
  "PHASMIDA", "TRICHOPTERA", "MANTODEA", "PLECOPTERA", "BLATTODEA", "ISOPTERA",
  "EPHEMEROPTERA", "DERMAPTERA", "GRYLLOBLATTODEA", "PSOCODEA", "NEUROPTERA",
  "ARCHAEOGNATHA", "SIPHONAPTERA", "THYSANOPTERA", "MEGALOPTERA",
];

// =============================================================================
// TAXA
// =============================================================================

/**
 * The group definitions, before GBIF keys are attached. Exported for
 * derive-gbif-taxon-keys, which generates those keys from exactly this and so
 * cannot depend on them already existing.
 */
export const TAXA_DEFINITIONS: Array<Omit<Taxon, "gbif">> = [
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
// HELPERS
// =============================================================================

/**
 * Overridable so a test can point at a scratch copy. Without it the only way to
 * exercise a rewritten config is to rewrite the real one, and an interrupted run
 * then leaves invented keys in a git-tracked file.
 */
const derivedKeysPath = () =>
  process.env.GBIF_TAXON_KEYS_PATH ?? path.join(__dirname, "..", "..", "src", "config", "gbif-taxon-keys.json");

type DerivedKeyFile = Record<string, Array<{ redlistName: string; taxonKey: string | null }>>;

/**
 * The derived keys, read from disk rather than imported.
 *
 * This used to be a static `import` of the JSON, which meant the group root keys
 * were frozen at module load — and the sync's whole self-healing story depended
 * on them not being. Phase 4b rewrites this file when Catalogue of Life
 * renumbers a root key, and phase 5 then validates the keys it holds against the
 * newly built taxonomy. With a static import phase 5 still held the *previous*
 * release's keys, so the run it was meant to rescue failed instead: Rhodophyta
 * renumbered, red_algae's only root key dead, guard throws, weekly job red every
 * Sunday until someone ran the derivation by hand.
 *
 * Read lazily and cached, with reloadTaxonKeys() to drop the cache after the
 * file is rewritten.
 */
let derivedKeysCache: DerivedKeyFile | null = null;
function derivedKeys(): DerivedKeyFile {
  if (!derivedKeysCache) {
    const file = derivedKeysPath();
    derivedKeysCache = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, "utf8")) as DerivedKeyFile)
      : {};
  }
  return derivedKeysCache;
}

let taxaCache: Taxon[] | null = null;
function allTaxa(): Taxon[] {
  if (!taxaCache) taxaCache = TAXA_DEFINITIONS.map(withGbifKeys);
  return taxaCache;
}

/**
 * Forget the cached keys, so the next read picks up a rewritten config.
 * Called by sync.ts immediately after phase 4b regenerates it.
 */
export function reloadTaxonKeys(): void {
  derivedKeysCache = null;
  taxaCache = null;
}

export function getTaxon(id: string): Taxon {
  const taxon = allTaxa().find((t) => t.id === id);
  if (!taxon) throw new Error(`Unknown taxon: ${id}. Available: ${allTaxa().map((t) => t.id).join(", ")}`);
  assertHasGbifKeys(taxon);
  return taxon;
}

/**
 * A group with no GBIF keys fetches nothing and reports zero — the silent
 * failure this migration exists to stop. Checked when a group is handed out
 * rather than at import, so derive-gbif-taxon-keys can still run to generate the
 * keys that are missing.
 */
function assertHasGbifKeys(taxon: Taxon): void {
  if (taxon.gbif.length === 0) {
    throw new Error(
      `taxa: no GBIF keys for "${taxon.id}". Run scripts/sync/outputs/derive-gbif-taxon-keys.ts --write; ` +
      `a group with no keys fetches nothing and silently reports zero.`
    );
  }
}

/** Attach the derived GBIF keys to each group. */
function withGbifKeys(taxon: Omit<Taxon, "gbif">): Taxon {
  const derived = derivedKeys()[taxon.id] ?? [];
  const gbif = derived
    .filter((d) => d.taxonKey)
    .map((d) => ({ taxonKey: d.taxonKey as string, fromName: d.redlistName }));
  return { ...taxon, gbif };
}

export function getTaxa(ids?: string[]): Taxon[] {
  if (!ids) {
    const all = allTaxa();
    all.forEach(assertHasGbifKeys);
    return all;
  }
  return ids.map(getTaxon);
}

/**
 * Every group, without the has-keys assertion — for callers that only need the
 * Red List side (which group a species belongs to) and must still work before
 * the keys have ever been derived.
 */
export function allTaxaUnchecked(): Taxon[] {
  return allTaxa();
}
