/**
 * Shared constants used by species-store.ts (runtime) and build-read-models.ts
 * (build time).
 */

/**
 * GBIF taxon keys for domesticated species excluded from new assessments.
 *
 * Catalogue of Life keys, each resolved through GBIF rather than a local copy of
 * the checklist (see src/lib/gbif.ts).
 *
 * The domestic pigeon is deliberately absent. IUCN's "Columba domestica" is a
 * synonym of Columba livia in CoL — the wild Rock Dove, which is itself an
 * assessed species — so there is no key that excludes the domestic form without
 * also excluding the wild one. Excluding it would remove a real assessed species
 * from the dashboard, which is worse than leaving the domestic form in.
 */
export const EXCLUDED_DOMESTICATED_GBIF_KEYS = new Set([
  "MLQ5",  // Bos taurus (Cow)
  "3DXV3", // Felis catus (Cat)
  "4B9VF", // Ovis aries (Domestic Sheep)
  "QS68",  // Capra hircus (Domestic Goat)
  "7TKN2", // Equus caballus (Horse)
  "NKLN",  // Bubalus bubalis (Water Buffalo)
  "7TKMV", // Equus asinus (Donkey)
  "Q9XD",  // Camelus dromedarius (Arabian Camel)
  "Q9XC",  // Camelus bactrianus (Bactrian Camel)
  "3RYF2", // Lama glama (Llama)
  "5BD72", // Vicugna pacos (Alpaca)
  "MLPW",  // Bos grunniens (Yak)
  "RY7S",  // Cavia porcellus (Guinea Pig)
  "6MB3T", // Homo sapiens (Human)
]);

/**
 * Maps taxon group names (IUCN Table 1a) to display taxon IDs.
 * Groups not listed here map to themselves (e.g., "mammals" → "mammals").
 */
export const DB_GROUP_TO_TAXON_ID: Record<string, string> = {
  fishes: "fishes",
  beetles: "invertebrates",
  butterflies_and_moths: "invertebrates",
  flies_and_mosquitoes: "invertebrates",
  bees_wasps_and_ants: "invertebrates",
  true_bugs: "invertebrates",
  grasshoppers_crickets_locusts: "invertebrates",
  dragonflies_and_damselflies: "invertebrates",
  other_insects: "invertebrates",
  arachnids: "invertebrates",
  molluscs: "invertebrates",
  crustaceans: "invertebrates",
  corals: "invertebrates",
  other_invertebrates: "invertebrates",
  velvet_worms: "invertebrates",
  horseshoe_crabs: "invertebrates",
  flowering_plants: "plantae",
  gymnosperms: "plantae",
  ferns_and_allies: "plantae",
  mosses: "plantae",
  green_algae: "plantae",
  red_algae: "plantae",
  brown_algae: "fungi",
  mushrooms: "fungi",
};

/** Map a taxon group name to its display taxon ID. */
export function mapTaxonId(group: string): string {
  return DB_GROUP_TO_TAXON_ID[group] ?? group;
}

/**
 * Back-compat aliases: legacy taxon/group identifiers (the scientific class
 * names used as IDs before the 2026-06 rename) → their current IDs. Lets old
 * shared/bookmarked URLs (e.g. ?taxa=mammalia) and direct API calls keep
 * resolving. Single source of truth — extend here to add more synonyms.
 */
export const TAXON_ID_ALIASES: Record<string, string> = {
  mammalia: "mammals",
  aves: "birds",
  reptilia: "reptiles",
  amphibia: "amphibians",
  arachnida: "arachnids",
  mollusca: "molluscs",
  crustacea: "crustaceans",
  insecta: "insects", // node id renamed insecta → insects; keep old links resolving
};

// Virtual grouping roots (invertebrates/plants/fungi) clone their children with
// these prefixes to keep node IDs unique, so the subgroups param can carry e.g.
// "inv-crustacea". Alias the base after stripping the prefix, then re-attach.
const NODE_ID_PREFIXES = ["inv-", "pl-", "fu-"];

/** Resolve a possibly-legacy taxon/group identifier (bare or prefixed) to its current ID. */
export function canonicalizeTaxonId(id: string): string {
  for (const prefix of NODE_ID_PREFIXES) {
    if (id.startsWith(prefix)) {
      const base = id.slice(prefix.length);
      return prefix + (TAXON_ID_ALIASES[base] ?? base);
    }
  }
  return TAXON_ID_ALIASES[id] ?? id;
}
