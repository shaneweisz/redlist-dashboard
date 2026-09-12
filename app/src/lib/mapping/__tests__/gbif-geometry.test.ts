/**
 * The geometry that goes to GBIF has to be valid, wound the right way and short
 * enough, and every one of those failed differently while this was written.
 * The offline suite pins the rules; the live suite at the bottom checks that
 * GBIF still agrees with them.
 */
import { describe, it, expect } from "vitest";
import { geometryForGbif, isPolygonWkt, GBIF_URL_BUDGET } from "@/lib/mapping/gbif-geometry";
import { esriRingsToMultiPolygon } from "@/lib/mapping/protected-areas";

/** A closed ring for a rectangle, listed clockwise as Esri writes an exterior. */
function box(west: number, south: number, east: number, north: number): GeoJSON.Position[] {
  return [
    [west, south],
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

/** Twice the signed area. Positive is counter-clockwise. */
function signedArea(ring: GeoJSON.Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum;
}

/** A circle of `n` vertices, clockwise, for making something big on purpose. */
function circle(n: number, cx: number, cy: number, r: number): GeoJSON.Position[] {
  const points: GeoJSON.Position[] = [];
  for (let i = 0; i < n; i++) {
    const t = (-2 * Math.PI * i) / n;
    points.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  points.push(points[0]);
  return points;
}

const mp = (coordinates: GeoJSON.Position[][][]): GeoJSON.MultiPolygon => ({
  type: "MultiPolygon",
  coordinates,
});

describe("geometryForGbif", () => {
  it("turns an exterior ring counter-clockwise, whichever way it came", () => {
    // This is the one that fails silently rather than loudly: GBIF reads a
    // clockwise exterior as everywhere *except* the polygon, so the wrong
    // winding doesn't error, it answers about the rest of the planet.
    const clockwise = geometryForGbif(mp([[box(18.35, -34.35, 18.47, -33.93)]]))!;
    expect(signedArea(clockwise.geometry.coordinates[0][0])).toBeGreaterThan(0);

    const alreadyCcw = mp([[[...box(18.35, -34.35, 18.47, -33.93)].reverse()]]);
    expect(signedArea(geometryForGbif(alreadyCcw)!.geometry.coordinates[0][0])).toBeGreaterThan(0);
  });

  it("winds a hole the other way from its shell", () => {
    const shell = box(0, 0, 10, 10);
    const hole = [...box(4, 4, 6, 6)].reverse(); // Esri cuts holes anticlockwise
    const out = geometryForGbif(mp([[shell, hole]]))!;
    const [exterior, cut] = out.geometry.coordinates[0];
    expect(signedArea(exterior)).toBeGreaterThan(0);
    expect(signedArea(cut)).toBeLessThan(0);
  });

  it("leaves a small boundary alone", () => {
    const out = geometryForGbif(mp([[box(0, 0, 1, 1)]]))!;
    expect(out.simplified).toBe(false);
    expect(out.polygons).toBe(1);
    expect(out.sourcePolygons).toBe(1);
    expect(isPolygonWkt(out.wkt)).toBe(true);
    expect(out.wkt.startsWith("POLYGON(")).toBe(true);
  });

  it("writes several parcels as a MULTIPOLYGON", () => {
    const out = geometryForGbif(mp([[box(0, 0, 1, 1)], [box(5, 5, 6, 6)]]))!;
    expect(out.wkt.startsWith("MULTIPOLYGON(")).toBe(true);
    expect(out.polygons).toBe(2);
  });

  it("keeps the encoded query inside the budget, and says it simplified", () => {
    // 4,000 vertices is far past what GBIF will take in a URL — it rejects
    // anything much over 4 KB, whatever the geometry is.
    const out = geometryForGbif(mp([[circle(4000, 18.4, -33.98, 0.2)]]))!;
    expect(encodeURIComponent(out.wkt).length).toBeLessThanOrEqual(GBIF_URL_BUDGET);
    expect(out.simplified).toBe(true);
    expect(out.vertices).toBeLessThan(out.sourceVertices);
  });

  it("leaves room for the rest of the query string", () => {
    const out = geometryForGbif(mp([[circle(4000, 18.4, -33.98, 0.2)]]), { baseUrlBytes: 3000 })!;
    expect(encodeURIComponent(out.wkt).length).toBeLessThanOrEqual(GBIF_URL_BUDGET - 3000);
  });

  it("searches the parcel you clicked when the whole site won't fit", () => {
    // Two parcels far apart, each too detailed for the two of them to fit.
    const clicked = circle(900, 30, 10, 0.1);
    const elsewhere = circle(900, -70, -20, 0.5); // much larger, so it sorts first
    const out = geometryForGbif(mp([[elsewhere], [clicked]]), {
      budget: 400,
      focus: [30, 10],
    })!;
    expect(out.polygons).toBe(1);
    expect(out.sourcePolygons).toBe(2);
    expect(out.simplified).toBe(true);
    // The kept parcel is the one around the click, not the bigger one.
    const [x, y] = out.geometry.coordinates[0][0][0];
    expect(Math.abs(x - 30)).toBeLessThan(1);
    expect(Math.abs(y - 10)).toBeLessThan(1);
  });

  it("skips a parcel that won't fit rather than giving up on the site", () => {
    // The largest parcel is the intricate one, which is the usual shape of the
    // problem: stopping at the first misfit returned nothing at all for sites
    // whose biggest block was also their most detailed.
    const awkward = circle(900, -70, -20, 3);
    const plain = box(30, 10, 31, 11);
    const out = geometryForGbif(mp([[awkward], [plain]]), { budget: 420 })!;
    expect(out.polygons).toBe(1);
    expect(out.sourcePolygons).toBe(2);
    const [x] = out.geometry.coordinates[0][0][0];
    expect(Math.abs(x - 30)).toBeLessThan(2);
  });

  it("drops a hole that doesn't sit inside its shell", () => {
    // GBIF refuses "Hole lies outside shell" as firmly as a self-intersection,
    // and nothing crosses anything in that case, so a crossing test alone
    // misses it. It happens for real when simplifying a detailed shell pulls it
    // in past a hole that was hard against the edge — seen on a Cape Floral
    // Region parcel. Stated here as the invariant it is: a hole that isn't
    // inside its shell is dropped, and searching slightly too much ground beats
    // a query GBIF won't run.
    const shell = box(0, 0, 10, 10);
    const outside = [...box(20, 20, 21, 21)].reverse();
    const out = geometryForGbif(mp([[shell, outside]]))!;
    expect(out.geometry.coordinates[0].length).toBe(1);

    // …and one that genuinely is inside is kept.
    const inside = [...box(4, 4, 6, 6)].reverse();
    expect(geometryForGbif(mp([[shell, inside]]))!.geometry.coordinates[0].length).toBe(2);
  });

  it("returns null for a geometry with nothing usable in it", () => {
    expect(geometryForGbif(mp([]))).toBeNull();
    expect(geometryForGbif(mp([[[[0, 0], [1, 1]]]]))).toBeNull();
  });

  it("reads Esri rings straight through", () => {
    // The shape the WDPA identify response actually arrives in: one flat list
    // of rings, exterior clockwise, holes anticlockwise.
    const rings = [box(0, 0, 10, 10), [...box(4, 4, 6, 6)].reverse()];
    const out = geometryForGbif(esriRingsToMultiPolygon(rings)!)!;
    expect(out.polygons).toBe(1);
    expect(out.geometry.coordinates[0].length).toBe(2);
    expect(signedArea(out.geometry.coordinates[0][0])).toBeGreaterThan(0);
    expect(signedArea(out.geometry.coordinates[0][1])).toBeLessThan(0);
  });
});

describe("isPolygonWkt", () => {
  it("accepts what this module writes and rejects what it doesn't", () => {
    expect(isPolygonWkt("POLYGON((0 0,1 0,1 1,0 0))")).toBe(true);
    expect(isPolygonWkt("MULTIPOLYGON(((0 0,1 0,1 1,0 0)))")).toBe(true);
    expect(isPolygonWkt("  polygon((0 0,1 0,1 1,0 0))")).toBe(true);
    expect(isPolygonWkt("POINT(0 0)")).toBe(false);
    expect(isPolygonWkt("18.4,-33.9,10km")).toBe(false);
    expect(isPolygonWkt("")).toBe(false);
  });
});

/**
 * The rules above are ours; this checks they're still GBIF's.
 *
 * Every assertion here failed at least once during development, each with its
 * own error: "Too few distinct points", "Self-intersection", "Hole lies outside
 * shell", and a bare Tomcat 400 when the URL was too long. Network-gated, so a
 * machine without one skips rather than fails.
 */
describe("live GBIF", () => {
  const MAP_SERVER =
    "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer";

  async function wdpaAt(lng: number, lat: number) {
    const params = new URLSearchParams({
      geometry: JSON.stringify({ x: lng, y: lat }),
      geometryType: "esriGeometryPoint",
      sr: "4326",
      tolerance: "2",
      mapExtent: `${lng - 0.2},${lat - 0.3},${lng + 0.2},${lat + 0.3}`,
      imageDisplay: "1400,520,96",
      layers: "all",
      returnGeometry: "true",
      maxAllowableOffset: "0.0002857",
      f: "json",
    });
    const response = await fetch(`${MAP_SERVER}/identify?${params}`);
    return (await response.json())?.results ?? [];
  }

  const sites: [string, number, number][] = [
    ["Table Mountain, South Africa", 18.4, -33.98],
    ["Serengeti, Tanzania", 34.83, -2.33],
    ["Yellowstone, USA", -110.58, 44.6],
  ];

  for (const [label, lng, lat] of sites) {
    it(
      `${label}: every designation there is a query GBIF accepts`,
      async ({ skip }) => {
        let results: { attributes?: Record<string, unknown>; geometry?: { rings?: unknown } }[];
        try {
          results = await wdpaAt(lng, lat);
        } catch {
          skip();
          return;
        }
        expect(results.length).toBeGreaterThan(0);
        for (const result of results) {
          const multiPolygon = esriRingsToMultiPolygon(result.geometry?.rings);
          if (!multiPolygon) continue;
          const geometry = geometryForGbif(multiPolygon, { baseUrlBytes: 300, focus: [lng, lat] });
          expect(geometry).not.toBeNull();

          const params = new URLSearchParams({
            geometry: geometry!.wkt,
            hasCoordinate: "true",
            hasGeospatialIssue: "false",
            limit: "0",
          });
          const url = `https://api.gbif.org/v1/occurrence/search?${params}`;
          expect(url.length).toBeLessThan(3860);
          const response = await fetch(url);
          const body = await response.text();
          expect(`${result.attributes?.NAME}: ${response.status} ${body.slice(0, 200)}`).toContain(" 200 ");
          // Counter-clockwise or the count is the whole world minus the park.
          expect(JSON.parse(body).count).toBeLessThan(5_000_000);
        }
      },
      120_000
    );
  }
});
