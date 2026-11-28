/**
 * The Regional view's shared pieces: its row shape and the two categories that
 * exist only in regional assessments.
 *
 * Regional assessments use the IUCN regional guidelines: the global categories
 * plus RE (Regionally Extinct: gone from the region, still extant elsewhere)
 * and NA (Not Applicable: not eligible for assessment in the region, e.g. a
 * vagrant or recent introduction). Kept here rather than in config/taxa.ts so
 * nothing outside this view starts listing them.
 */
import { CATEGORY_COLORS, CATEGORY_NAMES, normalizeCategory } from "@/config/taxa";

export const REGIONAL_CATEGORY_ORDER = ["EX", "EW", "RE", "CR", "EN", "VU", "NT", "LC", "DD", "NA"] as const;

const REGIONAL_ONLY_COLORS: Record<string, string> = { RE: "#6b2142", NA: "#d4d4d8" };
const REGIONAL_ONLY_NAMES: Record<string, string> = {
  RE: "Regionally Extinct",
  NA: "Not Applicable",
};

export const regionalCategoryColor = (c: string) => REGIONAL_ONLY_COLORS[c] ?? CATEGORY_COLORS[normalizeCategory(c)] ?? "#a3a3a3";
export const regionalCategoryName = (c: string) => REGIONAL_ONLY_NAMES[c] ?? CATEGORY_NAMES[normalizeCategory(c)] ?? c;
export const isThreatened = (c: string | null) => c === "CR" || c === "EN" || c === "VU";

/** One species' latest assessment in a region, as the API sends it. */
export interface RegionalRow {
  sis: number;
  assessmentId: number;
  name: string;
  common: string | null;
  group: string | null;
  category: string;
  criteria: string | null;
  year: string;
  globalCategory: string | null;
  globalYear: string | null;
}

export interface RegionSummary {
  region: string;
  species: number;
  threatened: number;
  noGlobal: number;
}

export interface RegionDetail {
  region: string;
  /** Per country: species in this region's assessments native there, and how many are regionally threatened. */
  countries: Record<string, { species: number; threatened: number }>;
  rows: RegionalRow[];
}

/** "butterflies_and_moths" → "Butterflies and moths". */
export function groupLabel(id: string | null): string {
  if (!id) return "Other";
  const s = id.replace(/_/g, " ");
  return s[0].toUpperCase() + s.slice(1);
}

/** How a species' regional category compares with its global one. */
export function comparison(r: Pick<RegionalRow, "category" | "globalCategory">): "no-global" | "same" | "differs" | "not-applicable" {
  if (!r.globalCategory) return "no-global";
  // NA means the region didn't assess it, so there is nothing to compare.
  if (r.category === "NA") return "not-applicable";
  return normalizeCategory(r.globalCategory) === normalizeCategory(r.category) ? "same" : "differs";
}
