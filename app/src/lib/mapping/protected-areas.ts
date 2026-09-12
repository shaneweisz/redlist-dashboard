/**
 * The World Database on Protected Areas (WDPA), UNEP-WCMC & IUCN — the dataset
 * behind protectedplanet.net.
 *
 * We draw it as a transparent raster from UNEP-WCMC's own ArcGIS MapServer, so
 * a click can't hit-test anything client-side. The same MapServer answers the
 * ArcGIS `identify` operation, which turns a clicked point back into the
 * protected areas under it — no API key, no proxy (it reflects any origin in
 * its CORS headers), and it's the same service the tiles came from, so what you
 * click is guaranteed to be what you saw drawn.
 *
 * The Protected Planet API itself is not an option: it requires a key issued by
 * request, and its terms exclude commercial use.
 */

const MAP_SERVER =
  "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer";

/**
 * The overlay's own symbology, applied to the service's own tiles.
 *
 * WDPA renders as green fills — near-invisible over the terrain basemap, which
 * is green, and not much better over satellite. This used to be fixed by asking
 * the MapServer to redraw the data via `dynamicLayers`, which stopped working:
 * that path reads the polygon source live, and UNEP-WCMC's connection to it now
 * fails most of the time. Measured over a block of twelve tiles it answered
 * three and returned `"Unable to connect to the data source for layer with
 * mapLayerId: 1"` for the other nine, in about 140 ms each — fast, intermittent,
 * and nothing to do with us. The service's pre-rendered tile cache answered all
 * twelve in about 70 ms, because it never touches that source.
 *
 * So the tiles now come from the cache and the recolouring happens in the
 * browser. The cache draws every site in one hue (100°, fully saturated), so
 * rotating it is exact rather than a compromise: HUE_ROTATION lands it on
 * PROTECTED_AREAS_COLOR. The same trick already draws the forest-loss layer.
 */

/** The single hue the cached tiles are drawn in. */
const CACHE_HUE_DEGREES = 100;

/** The colour the overlay draws in — shared with the legend and the highlight. */
export const PROTECTED_AREAS_COLOR = "#db2777";
export const PROTECTED_AREAS_OUTLINE_COLOR = "#9d174d";

/**
 * The overlay's tiles, from the service's pre-rendered cache.
 *
 * ArcGIS orders its cache path level/row/column, which is {z}/{y}/{x}.
 */
export const PROTECTED_AREAS_TILE_URL = `${MAP_SERVER}/tile/{z}/{y}/{x}`;

/**
 * The deepest level the cache holds. Level 15 is a 404, so without this
 * MapLibre would ask for tiles that don't exist and the overlay would vanish
 * exactly when you zoomed in far enough to need it. Below this it overzooms
 * level 14, which is what the boundary looked like anyway.
 */
export const PROTECTED_AREAS_MAX_ZOOM = 14;

/** The hue of a hex colour, in degrees. */
function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

/**
 * Degrees of hue rotation taking the cache's green to PROTECTED_AREAS_COLOR.
 *
 * Derived rather than written down, so changing the colour above changes what
 * the map draws — a hard-coded rotation would leave the legend and the overlay
 * disagreeing, which is the one thing this colour exists to prevent.
 */
export const PROTECTED_AREAS_HUE_ROTATION =
  (hueOf(PROTECTED_AREAS_COLOR) - CACHE_HUE_DEGREES + 360) % 360;

/**
 * Colours for the sites under one clicked point, in order.
 *
 * Protected areas overlap constantly — a national park inside a biosphere
 * reserve inside a Ramsar site — and the popup used to list all of them while
 * the map outlined only whichever you were pointing at. Two names and one
 * shape reads as one area with two labels, which is the opposite of true. Each
 * site now gets its own colour, drawn at the same time and shown as a swatch
 * on its row, so the count on the map matches the count in the list.
 *
 * Chosen to stay apart from each other and from the layer's own pink, and to
 * hold up over satellite imagery as well as paper basemaps. Sites past the
 * sixth reuse the ramp — six overlapping designations is already rare.
 */
export const PROTECTED_AREA_HIGHLIGHTS = [
  PROTECTED_AREAS_COLOR, // the layer's own pink, for the first site
  "#2563eb", // blue
  "#f59e0b", // amber
  "#059669", // emerald
  "#7c3aed", // violet
  "#0891b2", // cyan
];

export const highlightColour = (index: number) =>
  PROTECTED_AREA_HIGHLIGHTS[index % PROTECTED_AREA_HIGHLIGHTS.length];

export const PROTECTED_AREAS_ATTRIBUTION =
  '<a href="https://www.protectedplanet.net" target="_blank" rel="noopener noreferrer">WDPA</a> &copy; UNEP-WCMC &amp; IUCN';

/**
 * One designation covering the clicked point.
 *
 * `siteId` and `sitePid` are what the November 2025 WDPA/WD-OECM merge renamed
 * WDPAID and WDPA_PID to. A site with several parcels shares one `siteId` and
 * gives each parcel its own `sitePid` ("23_1"), which is why both are kept:
 * protectedplanet.net wants the id in the path and the parcel in the query.
 */
export interface ProtectedArea {
  siteId: string;
  sitePid: string;
  name: string;
  designation?: string;
  /** IUCN management category — Ia, Ib, II … VI, or "Not Reported". */
  iucnCategory?: string;
  status?: string;
  statusYear?: number | null;
  /** Whether WDPA holds this as a protected area or an OECM. */
  siteType?: string;
  /** Reported area in km², as the country declared it. */
  reportedAreaKm2?: number | null;
  /** The site's boundary, generalised to the zoom it was asked for, so the
   *  clicked area can be outlined on the map. Absent for point-only sites. */
  geometry?: GeoJSON.MultiPolygon | null;
}

/**
 * The page for one site on protectedplanet.net.
 *
 * It has to be `/<siteId>?site_pid=<sitePid>`: a bare `/<sitePid>` 500s for any
 * multi-parcel site, whose parcel ids look like "23_1" and aren't valid paths.
 */
export function protectedPlanetUrl(area: Pick<ProtectedArea, "siteId" | "sitePid">): string {
  return `https://www.protectedplanet.net/${encodeURIComponent(area.siteId)}?site_pid=${encodeURIComponent(area.sitePid)}`;
}

interface IdentifyRequest {
  lng: number;
  lat: number;
  /** The map's current bounds, west/south/east/north, in degrees. */
  bounds: [number, number, number, number];
  /** Canvas size in pixels — the tolerance below is measured against it. */
  width: number;
  height: number;
  /** Click slop in screen pixels. Derived from the zoom when not given. */
  tolerance?: number;
  /**
   * How coarsely the server may generalise the boundary it returns, in degrees.
   *
   * Defaults to a screen pixel's worth, which is right when the boundary is
   * only going to be drawn at the zoom it was asked from. It is wrong when the
   * boundary is going to be *used* — a narrow phone makes a pixel worth several
   * hundred metres, and at that offset Kruger came back not merely coarser but
   * structurally different: one 980-point outline on a desktop, and on a phone
   * a 518-point one accompanied by two zero-area slivers. Anything deciding
   * what to do with the shape should ask for a fixed offset so it gets the same
   * shape whoever is looking.
   */
  maxAllowableOffset?: number;
}

/**
 * How far off a click may be and still count as inside.
 *
 * ArcGIS measures its tolerance in screen pixels, which at a continental zoom
 * is tens of kilometres of ground — enough that clicking near a national park
 * reported the point as inside it. An assessor asking "is this record
 * protected?" needs that answered about the point, not its neighbourhood, so
 * the pixel tolerance is derived from what a pixel is currently worth: a few
 * metres of slop when zoomed in, exact containment when zoomed out, where a
 * park covers plenty of pixels anyway.
 */
const CLICK_SLOP_METRES = 250;

function toleranceFor({ lat, bounds, width }: IdentifyRequest): number {
  const metresPerPixel =
    (Math.abs(bounds[2] - bounds[0]) * 111320 * Math.cos((lat * Math.PI) / 180)) / Math.max(1, width);
  if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) return 0;
  return Math.min(5, Math.round(CLICK_SLOP_METRES / metresPerPixel));
}

/** The identify URL for a clicked point. Split out so it can be tested. */
export function identifyUrl(request: IdentifyRequest): string {
  const { lng, lat, bounds, width, height } = request;
  const tolerance = request.tolerance ?? toleranceFor(request);
  // Boundaries come back generalised to about a screen pixel. Full resolution
  // is not a nuance here: one Colombian national park is 3.7 MB of rings at
  // full detail and 15 KB at a pixel's worth of tolerance, and at the zoom you
  // asked from they draw identically.
  const degreesPerPixel =
    request.maxAllowableOffset ?? Math.abs(bounds[2] - bounds[0]) / Math.max(1, width);
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat }),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    tolerance: String(tolerance),
    mapExtent: bounds.join(","),
    imageDisplay: `${Math.round(width)},${Math.round(height)},96`,
    // `all` rather than the polygon sublayer alone: small sites are held only
    // as points (sublayer 0), and a polygon-only query drops them silently.
    layers: "all",
    returnGeometry: "true",
    maxAllowableOffset: degreesPerPixel.toPrecision(4),
    f: "json",
  });
  return `${MAP_SERVER}/identify?${params}`;
}

/**
 * Esri rings to a GeoJSON MultiPolygon.
 *
 * Esri puts every ring of a site in one flat list and distinguishes outer
 * rings from holes by winding order — clockwise encloses, anticlockwise cuts
 * out — where GeoJSON nests each polygon's holes inside it. Get this wrong and
 * a reserve with a town excised from it renders as solid.
 */
export function esriRingsToMultiPolygon(rings: unknown): GeoJSON.MultiPolygon | null {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const polygons: GeoJSON.Position[][][] = [];
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const coordinates = ring as GeoJSON.Position[];
    // Shoelace: positive means clockwise in lng/lat, i.e. an outer ring.
    let area = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
      area += (coordinates[i + 1][0] - coordinates[i][0]) * (coordinates[i + 1][1] + coordinates[i][1]);
    }
    if (area > 0 || polygons.length === 0) polygons.push([coordinates]);
    else polygons[polygons.length - 1].push(coordinates);
  }
  if (polygons.length === 0) return null;
  return { type: "MultiPolygon", coordinates: polygons };
}

function text(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  // ArcGIS writes these where a real value is missing; they aren't worth a line
  // of a popup.
  if (s === "" || s === "Null" || s === "N/A" || s === "Not Applicable" || s === "Not Reported") return undefined;
  return s;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads an ArcGIS identify response into designations.
 *
 * A single click routinely returns several — Yellowstone comes back as a
 * national park, a World Heritage site, a biosphere reserve and a recommended
 * wilderness — and they're all true at once, so all of them are kept. The order
 * ArcGIS returns them in carries no ranking, which is exactly why we can't just
 * take the first one.
 */
export function parseIdentifyResponse(json: unknown): ProtectedArea[] {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const areas: ProtectedArea[] = [];
  for (const result of results) {
    const attributes = (result as { attributes?: Record<string, unknown> })?.attributes;
    if (!attributes) continue;
    const siteId = text(attributes.SITE_ID) ?? text(attributes.WDPAID);
    const sitePid = text(attributes.SITE_PID) ?? text(attributes.WDPA_PID) ?? siteId;
    if (!siteId || !sitePid) continue;
    if (seen.has(sitePid)) continue;
    seen.add(sitePid);
    areas.push({
      siteId,
      sitePid,
      name:
        text(attributes.NAME_ENG) ??
        text(attributes.NAME) ??
        text((result as { value?: unknown }).value) ??
        "Protected area",
      designation: text(attributes.DESIG_ENG) ?? text(attributes.DESIG),
      iucnCategory: text(attributes.IUCN_CAT),
      status: text(attributes.STATUS),
      statusYear: num(attributes.STATUS_YR) || null,
      siteType: text(attributes.SITE_TYPE),
      reportedAreaKm2: num(attributes.REP_AREA),
      geometry: esriRingsToMultiPolygon((result as { geometry?: { rings?: unknown } })?.geometry?.rings),
    });
  }
  return areas;
}

/** Looks up the protected areas at a point. Throws on a failed request. */
export async function identifyProtectedAreas(
  request: IdentifyRequest,
  signal?: AbortSignal
): Promise<ProtectedArea[]> {
  const response = await fetch(identifyUrl(request), { signal });
  if (!response.ok) throw new Error(`WDPA identify failed: ${response.status}`);
  return parseIdentifyResponse(await response.json());
}
