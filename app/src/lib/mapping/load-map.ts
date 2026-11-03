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
 */
export async function loadMapGL() {
  const [maplibre, reactMapGL] = await Promise.all([
    import("maplibre-gl"),
    import("react-map-gl/maplibre"),
  ]);
  maplibre.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());
  return reactMapGL.Map;
}
