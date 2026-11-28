/**
 * The region scope: ?scope=Europe makes the dashboard read a region's
 * assessments (regional-assessed.parquet) instead of the global ones
 * (assessed.parquet). Global is the default and needs no parameter.
 *
 * The region is IUCN's scope name ("Europe", "Pan-Africa", "S. Africa FW"), so
 * the list of regions comes from the data, not from here.
 */

// Not "region": that already names a set of countries (useFilterParams' region= picker).
export const REGION_PARAM = "scope";

/** A region name from a URL, or null for global (absent, empty or malformed). */
export function parseRegion(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && /^[A-Za-z][A-Za-z .\-]{0,40}$/.test(v) ? v : null;
}

/** `url` with the region added (or left unchanged when global). */
export function withRegion(url: string, region: string | null): string {
  if (!region) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${REGION_PARAM}=${encodeURIComponent(region)}`;
}
