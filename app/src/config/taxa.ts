/**
 * Taxa configuration for IUCN Red List and GBIF data
 *
 * Each taxon has:
 * - id: Unique identifier used in API routes
 * - name: Display name
 * - apiEndpoint: IUCN API endpoint path (kingdom or class)
 * - estimatedDescribed: Estimated number of described species (hardcoded for now)
 * - estimatedSource: Source/citation for the estimate
 * GBIF keys are deliberately NOT here. They live in the generated
 * src/config/gbif-taxon-keys.json, derived from the Red List group definitions in
 * scripts/lib/taxa.ts, and are read via gbifTaxonKeysForGroup(). A second copy in
 * this file went stale when the pipeline moved to Catalogue of Life and silently
 * emptied the world map's occurrence layer.
 * - color: Theme color for UI elements
 */

export interface TaxonConfig {
  id: string;
  name: string;
  apiEndpoint: string; // Primary API endpoint
  apiEndpoints?: string[]; // Multiple API endpoints for combined taxa (e.g., Fishes = Actinopterygii + Chondrichthyes)
  estimatedDescribed: number;
  estimatedSource: string;
  estimatedSourceUrl?: string;
  color: string;
  icon?: string;
}

// Estimated described species from IUCN Red List Table 1a (version 2026-1)
// Source: https://nc.iucnredlist.org/redlist/content/attachment_files/2026-1_RL_Table1a.pdf
// Note: these estimatedDescribed/estimatedSource fields are no longer read for
// display — the landing page's "# Described Species" now comes from
// taxonomy-tree.ts's own estimatedDescribed via /api/redlist/taxa-summary (see
// route.ts's use of findNode). Kept in sync anyway so this file (still used
// elsewhere for id/name/color/gbif keys) doesn't carry stale numbers.
const IUCN_SOURCE = "IUCN 2026-1";
const IUCN_SOURCE_URL = "https://nc.iucnredlist.org/redlist/content/attachment_files/2026-1_RL_Table1a.pdf";

export const TAXA: TaxonConfig[] = [
  {
    id: "all",
    name: "All Species",
    apiEndpoint: "kingdom/Animalia", // Not used directly
    estimatedDescribed: 2121262, // Sum of all taxa
    estimatedSource: "IUCN 2026-1",
    estimatedSourceUrl: "https://nc.iucnredlist.org/redlist/content/attachment_files/2026-1_RL_Table1a.pdf",
    color: "#dc2626", // red-600
  },
  {
    id: "mammals",
    name: "Mammals",
    apiEndpoint: "class/Mammalia",
    estimatedDescribed: 6854,
    estimatedSource: IUCN_SOURCE,
    estimatedSourceUrl: IUCN_SOURCE_URL,
    color: "#f97316", // orange-500
  },
  {
    id: "birds",
    name: "Birds",
    apiEndpoint: "class/Aves",
    estimatedDescribed: 11185,
    estimatedSource: IUCN_SOURCE,
    estimatedSourceUrl: IUCN_SOURCE_URL,
    color: "#3b82f6", // blue-500
  },
  {
    id: "reptiles",
    name: "Reptiles",
    apiEndpoint: "class/Reptilia",
    estimatedDescribed: 12568,
    estimatedSource: IUCN_SOURCE,
    estimatedSourceUrl: IUCN_SOURCE_URL,
    color: "#84cc16", // lime-500
  },
  {
    id: "amphibians",
    name: "Amphibians",
    apiEndpoint: "class/Amphibia",
    estimatedDescribed: 9075,
    estimatedSource: IUCN_SOURCE,
    estimatedSourceUrl: IUCN_SOURCE_URL,
    color: "#14b8a6", // teal-500
  },
  {
    id: "fishes",
    name: "Fishes",
    apiEndpoint: "class/Actinopterygii",
    apiEndpoints: ["class/Actinopterygii", "class/Chondrichthyes"],
    estimatedDescribed: 37630,
    estimatedSource: IUCN_SOURCE,
    estimatedSourceUrl: IUCN_SOURCE_URL,
    color: "#06b6d4", // cyan-500
  },
  {
    id: "invertebrates",
    name: "Invertebrates",
    apiEndpoint: "class/Insecta",
    apiEndpoints: ["class/Insecta", "class/Arachnida", "class/Gastropoda", "class/Bivalvia", "class/Malacostraca", "class/Anthozoa"],
    estimatedDescribed: 1457195, // IUCN invertebrates subtotal
    estimatedSource: IUCN_SOURCE,
    estimatedSourceUrl: IUCN_SOURCE_URL,
    color: "#78716c", // stone-500
  },
  {
    id: "plantae",
    name: "Plants",
    apiEndpoint: "kingdom/Plantae",
    estimatedDescribed: 424003,
    estimatedSource: IUCN_SOURCE,
    estimatedSourceUrl: IUCN_SOURCE_URL,
    color: "#22c55e", // green-500
  },
  {
    id: "fungi",
    name: "Fungi & Protists",
    apiEndpoint: "phylum/Ascomycota",
    apiEndpoints: ["phylum/Ascomycota", "phylum/Basidiomycota"],
    estimatedDescribed: 162752, // IUCN fungi & protists subtotal
    estimatedSource: IUCN_SOURCE,
    estimatedSourceUrl: IUCN_SOURCE_URL,
    color: "#d97706", // amber-600
  },
];

// Map for quick lookup by ID
export const TAXA_BY_ID: Record<string, TaxonConfig> = Object.fromEntries(
  TAXA.map((t) => [t.id, t])
);

// Get taxon by ID, with fallback to plantae
export function getTaxonConfig(id: string): TaxonConfig {
  return TAXA_BY_ID[id] || TAXA_BY_ID["plantae"];
}

// IUCN category colors (shared across all taxa)
export const CATEGORY_COLORS: Record<string, string> = {
  EX: "#000000",
  EW: "#542344",
  CR: "#d81e05",
  EN: "#fc7f3f",
  VU: "#f9e814",
  NT: "#cce226",
  LC: "#60c659",
  DD: "#6b7280",
  NE: "#a3a3a3",
  // Pre-1994 Red Data Book category: a catch-all "Threatened" verdict, predating
  // the CR/EN/VU split — not equivalent to any single modern category, so left
  // un-normalized (see normalizeCategory below) with its own color rather than
  // folded into one of them.
  T: "#ea580c",
};

// Category order for sorting (most threatened first)
export const CATEGORY_ORDER: Record<string, number> = {
  EX: 0,
  EW: 1,
  CR: 2,
  EN: 3,
  VU: 4,
  NT: 5,
  LC: 6,
  DD: 7,
  NE: 8,
};

// IUCN "Threatened" categories: Critically Endangered, Endangered, Vulnerable
export const THREATENED_CATEGORIES = ["CR", "EN", "VU"] as const;

// Category full names
export const CATEGORY_NAMES: Record<string, string> = {
  EX: "Extinct",
  EW: "Extinct in the Wild",
  CR: "Critically Endangered",
  EN: "Endangered",
  VU: "Vulnerable",
  NT: "Near Threatened",
  LC: "Least Concern",
  DD: "Data Deficient",
  NE: "Not Evaluated",
  T: "Threatened (pre-1994 category)",
};

// Older/historical Red List assessments sometimes use legacy category codes
// (pre-1994 system letters, or the old "LR/xx" Lower Risk subdivisions) —
// normalize those to their modern equivalent so callers can key straight
// into CATEGORY_COLORS/CATEGORY_NAMES above.
export function normalizeCategory(code: string): string {
  if (code.startsWith("LR/")) {
    const sub = code.split("/")[1];
    if (sub === "lc") return "LC";
    if (sub === "nt") return "NT";
    if (sub === "cd") return "VU"; // Conservation Dependent -> treat as VU-adjacent
    return code;
  }
  if (code === "V") return "VU";
  if (code === "E") return "EN";
  if (code === "R") return "VU";
  return code;
}
