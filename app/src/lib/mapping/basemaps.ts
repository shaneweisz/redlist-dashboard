/**
 * The raster basemaps every map in this app is drawn on.
 *
 * Lifted out of the occurrence map when a second map — the standalone "what is
 * threatened near here" view — needed the same six. Two maps offering different
 * basemaps under the same names, or the same names over different tiles, is the
 * kind of drift that only shows up when someone compares two screenshots.
 */
import type maplibregl from "maplibre-gl";

// Basemap style options for MapLibre GL
export function makeRasterStyle(tileUrl: string, attribution: string): maplibregl.StyleSpecification {
  return {
    version: 8 as const,
    sources: {
      basemap: {
        type: "raster" as const,
        tiles: [tileUrl],
        tileSize: 256,
        attribution,
      },
    },
    layers: [
      {
        id: "basemap-layer",
        type: "raster" as const,
        source: "basemap",
      },
    ],
  };
}
/**
 * Several raster tile sets drawn over each other, bottom first.
 *
 * For the hybrid basemap: imagery answers "what is on the ground here", labels
 * answer "where is here", and reading a locality description against a photo
 * of the ground needs both at once.
 */
export function makeStackedRasterStyle(
  tiles: { url: string; attribution: string }[]
): maplibregl.StyleSpecification {
  return {
    version: 8 as const,
    sources: Object.fromEntries(
      tiles.map((t, i) => [
        `basemap-${i}`,
        { type: "raster" as const, tiles: [t.url], tileSize: 256, attribution: t.attribution },
      ])
    ),
    layers: tiles.map((_, i) => ({
      id: `basemap-layer-${i}`,
      type: "raster" as const,
      source: `basemap-${i}`,
    })),
  };
}

/** A style object, as MapLibre wants it. */
export type MaplibreStyle = ReturnType<typeof makeRasterStyle>;

export const BASEMAP_STYLES: Record<string, { label: string; style: MaplibreStyle }> = {
  streets: {
    label: "Streets",
    style: makeRasterStyle(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    ),
  },
  satellite: {
    label: "Satellite",
    style: makeRasterStyle(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      '&copy; <a href="https://www.esri.com">Esri</a> World Imagery'
    ),
  },
  /**
   * Imagery with place names over it.
   *
   * Esri publishes the labels as a transparent reference layer meant to go
   * over its own World Imagery, so this is the pairing as intended rather than
   * two unrelated tile sets stacked. Satellite on its own is the better view of
   * the ground; this is the one for finding out which valley you are looking at.
   */
  hybrid: {
    label: "Hybrid",
    style: makeStackedRasterStyle([
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attribution: '&copy; <a href="https://www.esri.com">Esri</a> World Imagery',
      },
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        attribution: '&copy; <a href="https://www.esri.com">Esri</a> World Boundaries and Places',
      },
    ]),
  },
  terrain: {
    label: "Terrain",
    style: makeRasterStyle(
      "https://tile.opentopomap.org/{z}/{x}/{y}.png",
      '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)'
    ),
  },
  /**
   * Two quiet basemaps, for reading a data layer rather than a place.
   *
   * Streets and Terrain both colour the ground — green for vegetation, white
   * for ice, blue for water — which is fine when the map is the subject and
   * actively misleading when something is drawn on top of it: a sampling-effort
   * ramp or a biome fill has to compete with colour that means something else
   * entirely. These carry the coastlines, the administrative outlines and
   * their names, and no colour of their own.
   *
   * Street-level place names are what Streets is for, and are worth having
   * while georeferencing; here they would be clutter over the surface being
   * read.
   *
   * Esri's Canvas basemaps rather than CARTO's: CARTO now watermarks every
   * unkeyed tile with "API KEY REQUIRED", which is not a basemap you can read
   * a data layer off. Esri serves the same idea keyless, and is already what
   * Satellite and Hybrid are drawn from.
   */
  plain: {
    label: "Plain",
    style: makeRasterStyle(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      '&copy; <a href="https://www.esri.com">Esri</a> Light Gray Canvas'
    ),
  },
  /** Dark, where a bright ramp reads best — the effort layer especially. */
  dark: {
    label: "Dark",
    style: makeRasterStyle(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      '&copy; <a href="https://www.esri.com">Esri</a> Dark Gray Canvas'
    ),
  },
};
export type BasemapKey = keyof typeof BASEMAP_STYLES;
