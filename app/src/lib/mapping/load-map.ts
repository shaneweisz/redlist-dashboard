import { createElement, useCallback, useState, type Ref } from "react";
import type { MapProps, MapRef, MapEvent } from "react-map-gl/maplibre";

/** Web Mercator renders the whole world 512px wide at zoom 0. */
const WORLD_WIDTH_AT_Z0 = 512;

/** The lowest zoom at which one world copy still spans `width` pixels. */
export function worldFillingMinZoom(width: number): number {
  return width > 0 ? Math.log2(width / WORLD_WIDTH_AT_Z0) : -2;
}

/**
 * react-map-gl's <Map>, loaded only after MapLibre knows where its worker is.
 *
 * MapLibre 6 ships its web worker as a separate file and finds it relative to
 * its own module URL. Inside a bundle that URL is one of Next's chunks, where
 * the worker doesn't exist, so every map logged "Worker failed to load". The
 * `new URL(..., import.meta.url)` below is the pattern MapLibre documents for
 * Turbopack: the bundler sees it, emits the worker as a hashed asset, and
 * hands back its real URL.
 *
 * It has to run before the first map is constructed, and only in the browser
 * — every map is loaded with `ssr: false` — so it lives in the loader each
 * map's `dynamic()` import goes through rather than at the top of a module.
 *
 * The returned map is also constrained to a single copy of the world: by
 * default MapLibre repeats the world sideways, so zooming out showed e.g.
 * Africa three times. With world copies off and a minimum zoom at which the
 * world still spans the map's width, zooming out stops at "the whole world,
 * once, edge to edge". The min zoom follows the container as it resizes; a
 * caller's own `minZoom` still applies when it is higher.
 */
export async function loadMapGL() {
  const [maplibre, reactMapGL] = await Promise.all([
    import("maplibre-gl"),
    import("react-map-gl/maplibre"),
  ]);
  maplibre.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());
  const Map = reactMapGL.Map;

  function SingleWorldMap({ ref, onLoad, onResize, minZoom, ...props }: MapProps & { ref?: Ref<MapRef> }) {
    const [fillZoom, setFillZoom] = useState<number | undefined>(undefined);
    const fit = useCallback((e: MapEvent) => {
      setFillZoom(worldFillingMinZoom(e.target.getContainer().clientWidth));
    }, []);
    const effectiveMinZoom =
      fillZoom === undefined ? minZoom : Math.max(fillZoom, minZoom ?? -2);
    return createElement(Map, {
      renderWorldCopies: false,
      ...props,
      ref,
      minZoom: effectiveMinZoom,
      onLoad: (e: MapEvent) => {
        fit(e);
        onLoad?.(e);
      },
      onResize: (e: MapEvent) => {
        fit(e);
        onResize?.(e);
      },
    });
  }
  return SingleWorldMap;
}
