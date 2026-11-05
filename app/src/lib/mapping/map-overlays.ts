/**
 * The two context layers on the occurrence map that come from a file rather
 * than a live service.
 *
 * Both are large, static and openly licensed, so they are built once by the
 * scripts named below, uploaded to the maps bucket, and served through
 * /api/overlays/<asset>. Nothing is fetched from the origin at runtime: these
 * files never change, and depending on somebody else's uptime for them buys
 * nothing — a lesson the protected-areas layer taught the hard way.
 *
 * The names here are the contract between the upload script, the route and the
 * map. The route serves only what this list names, so a request can't be
 * pointed at anything else in the bucket.
 */

// v2 adds the One Earth page slugs. The bucket refuses overwrites, so a change
// to the contents is a change to the name — which is the point: the route
// caches these forever, and a silently-swapped file would be served stale.
import { EFFORT_GROUPS, effortAsset } from "./sampling-effort";

export const ECOREGIONS_ASSET = "ecoregions-2017-v2.json.gz";
/**
 * Everything /api/overlays will serve, built by scripts/maps/build-*-layer.ts.
 *
 * The effort layer is one asset per taxonomic group rather than a single
 * surface — see lib/mapping/sampling-effort.ts for why the taxon matters.
 */
export const OVERLAY_ASSETS: readonly string[] = [
  ECOREGIONS_ASSET,
  ...EFFORT_GROUPS.map(effortAsset),
];

export function isOverlayAsset(name: string): boolean {
  return OVERLAY_ASSETS.includes(name);
}

export const overlayUrl = (asset: string) => `/api/overlays/${asset}`;

/**
 * Attribution for both layers.
 *
 * Ecoregions is CC-BY, so the citation is the licence condition rather than a
 * courtesy. The sampling-effort README likewise grants use of "the code,
 * pre-computed raster products, or derived outputs" on condition of citation.
 */
/** Dinerstein et al. 2017, the paper RESOLVE Ecoregions 2017 comes from. */
export const ECOREGIONS_PAPER_URL = "https://doi.org/10.1093/biosci/bix014";

export const ECOREGIONS_ATTRIBUTION =
  'Ecoregions: <a href="https://doi.org/10.1093/biosci/bix014" target="_blank" rel="noopener noreferrer">Dinerstein et al. (2017)</a>, RESOLVE Ecoregions 2017 (CC BY 4.0)';

// The sampling-effort citation lives in its map legend rather than here: an
// image source takes no attribution in the MapLibre style spec, so the only
// place it can be shown is the legend, and one copy is better than two.

/** One ecoregion, as the overlay carries it. */
export interface EcoregionProperties {
  name: string;
  biome: string;
  realm: string;
  /** Nature Needs Half status, e.g. "Nature Could Reach Half Protected". */
  nnh: string;
  color: string;
  /** The dataset's own colour for the biome — what the overlay draws with. */
  biomeColor: string;
  /**
   * One Earth's page for this ecoregion, where one exists.
   *
   * Only the 760 of 847 whose page was confirmed at build time carry this —
   * One Earth names some ecoregions differently and a few ("Rock and Ice")
   * aren't really ecoregions at all. Absent means don't offer a link.
   */
  oneEarth?: string;
}

/** One Earth's write-up of an ecoregion — the Navigator's content, as a page. */
export const oneEarthEcoregionUrl = (slug: string) =>
  `https://www.oneearth.org/ecoregions/${slug}/`;

/**
 * The 14 biomes, in the dataset's own order, with its own colours.
 *
 * Held here rather than derived from the loaded file so the legend can be
 * drawn before the 2 MB of geometry arrives, and so its order is stable rather
 * than being whatever order the features happen to come in.
 */
export const BIOMES: { name: string; color: string }[] = [
  { name: "Tropical & Subtropical Moist Broadleaf Forests", color: "#38A700" },
  { name: "Tropical & Subtropical Dry Broadleaf Forests", color: "#CCCD65" },
  { name: "Tropical & Subtropical Coniferous Forests", color: "#88CE66" },
  { name: "Temperate Broadleaf & Mixed Forests", color: "#00734C" },
  { name: "Temperate Conifer Forests", color: "#458970" },
  { name: "Boreal Forests/Taiga", color: "#00A884" },
  { name: "Tropical & Subtropical Grasslands, Savannas & Shrublands", color: "#FEAA01" },
  { name: "Temperate Grasslands, Savannas & Shrublands", color: "#FEFF73" },
  { name: "Flooded Grasslands & Savannas", color: "#00C5FF" },
  { name: "Montane Grasslands & Shrublands", color: "#D3FFBF" },
  { name: "Tundra", color: "#9ED7C2" },
  { name: "Mediterranean Forests, Woodlands & Scrub", color: "#CA7AF5" },
  { name: "Deserts & Xeric Shrublands", color: "#FEC0C0" },
  { name: "Mangroves", color: "#FE01C4" },
];

