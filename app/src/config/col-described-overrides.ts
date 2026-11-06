/**
 * Overrides layered on top of a node's own SpeciesFilter when computing its
 * Catalogue-of-Life-derived "described species" count (colDescribed) — used by
 * scripts/sync/outputs/build-taxa-summary.ts (which needs the raw name lists to build SQL) and by
 * the frontend (which needs human-readable notes to explain a number that would
 * otherwise look unexplained, e.g. "why does Bison SG show a number at all when its
 * filter is genus: bison and Catalogue of Life has no genus Bison?").
 *
 * Kept in one place so the two stay in sync — a name added here for the SQL exclusion
 * automatically shows up in the tooltip note too, instead of two lists silently drifting.
 */

// Domestic forms and humans aren't here: they are left out of the described
// species once, in the sync (scripts/sync/core/taxon-groups.ts NE_EXCLUDED, which
// sets species/'s `described`), so every count and list agrees.

// CoL lumps genus Bison entirely into Bos (no "Bison" genus exists in this release —
// verified directly), so the Bison SG filter (genera: ["bison"]) matches zero CoL rows.
// Override its CoL computation to match by species name instead of genus. The same two
// names are kept out of every OTHER node (COL_EXCLUDE_ALL_NODES) so Afro-Asian Wild
// Cattle SG, whose own genus filter (bos/bubalus/pseudoryx) would otherwise also
// match them, doesn't double-count.
export const COL_SPECIES_NAME_OVERRIDES: Record<string, string[]> = {
  "ssc-bison": ["bos bison", "bos bonasus"],
};

export const COL_EXCLUDE_ALL_NODES = [...COL_SPECIES_NAME_OVERRIDES["ssc-bison"]];

// Short, human-readable explanations for the "# Described Species" hover tooltip —
// only needed for nodes where the CoL-derived count involves one of the overrides
// above (a plain filter description, generated separately, covers everything else).
export const COL_NODE_TOOLTIP_NOTES: Record<string, string> = {
  "ssc-bison": "Catalogue of Life classifies Bison within genus Bos, so this count matches by species name (Bos bison, Bos bonasus) instead of genus.",
  "ssc-afro-asian-wild-cattle": "Excludes the domestic cow (Bos taurus), gayal (Bos frontalis), and domestic water buffalo (Bubalus bubalis), and Bison (Bos bison, Bos bonasus — counted separately under Bison SG).",
  "ssc-canid": "Excludes the domestic dog (Canis familiaris).",
  "ssc-cat": "Excludes the domestic cat (Felis catus).",
  "ssc-equid": "Excludes the domestic horse (Equus caballus) and donkey (Equus asinus).",
  "ssc-wild-camelid": "Excludes the domestic llama (Lama glama) and alpaca (Vicugna pacos).",
  "ssc-wild-pig": "Excludes the domestic pig (Sus domesticus).",
};

// A handful of nodes have a filter too broad/exclusion-heavy to summarize
// automatically in a readable sentence — a custom base description instead of the
// auto-generated one from their SpeciesFilter fields.
export const NODE_DESCRIPTION_OVERRIDES: Record<string, string> = {
  "ssc-other-mammals": "Mammal orders, families, and genera not claimed by any of the 35 named SSC pilot groups above.",
};
