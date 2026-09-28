/**
 * The GPS uncertainty rings: which records get one, and how big it is.
 *
 * The rings exist to answer "can this point be believed" — the forest elephants
 * apparently swimming off Gabon whose records carry a 35km radius (#557) — so
 * the two things worth pinning down are that the radius is drawn to scale on the
 * ground, and that the records with nothing drawable are left out rather than
 * drawn wrong: no figure at all, and a figure so wide that offsetting degrees
 * about a centre stops meaning anything.
 */
import { describe, it, expect } from "vitest";
import { buildUncertaintyRings, UNCERTAINTY_RING_MAX_M } from "../OccurrenceMapRow";
import type { OccurrenceFeature } from "../OccurrenceListTable";

/** A record at a position, with whatever uncertainty the test is about. */
function record(
  gbifID: number,
  lon: number,
  lat: number,
  coordinateUncertaintyInMeters?: number | null
): OccurrenceFeature {
  return {
    type: "Feature",
    properties: { gbifID, species: "Loxodonta cyclotis", coordinateUncertaintyInMeters },
    geometry: { type: "Point", coordinates: [lon, lat] },
  };
}

/** Metres between two positions, close enough for a few-km circle. */
function metresApart(a: [number, number], b: [number, number]): number {
  const METRES_PER_DEGREE_LAT = 111_320;
  const dLat = (b[1] - a[1]) * METRES_PER_DEGREE_LAT;
  const dLon =
    (b[0] - a[0]) * METRES_PER_DEGREE_LAT * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

describe("buildUncertaintyRings", () => {
  it("draws one ring per record that states a radius", () => {
    const rings = buildUncertaintyRings([
      record(1, 9.5, 0.5, 35_000),
      record(2, 9.6, 0.6, 1_000),
    ]);
    expect(rings.features).toHaveLength(2);
    expect(rings.features.map((f) => f.properties?.gbifID)).toEqual([1, 2]);
  });

  it("draws the ring at the stated radius on the ground", () => {
    const centre: [number, number] = [9.5, 0.5];
    const [ring] = buildUncertaintyRings([record(1, centre[0], centre[1], 35_000)]).features;
    const coords = (ring.geometry as GeoJSON.Polygon).coordinates[0];
    for (const point of coords) {
      expect(metresApart(centre, point as [number, number])).toBeCloseTo(35_000, -2);
    }
  });

  it("closes the ring, so the outline comes back round rather than leaving a gap", () => {
    const [ring] = buildUncertaintyRings([record(1, 9.5, 0.5, 2_000)]).features;
    const coords = (ring.geometry as GeoJSON.Polygon).coordinates[0];
    expect(coords[0]).toEqual(coords[coords.length - 1]);
  });

  it("stays a circle on the ground away from the equator", () => {
    // The same radius at 60°N, where a degree of longitude is half a degree at
    // the equator: drawn in raw degrees this would come out as a flat ellipse.
    const centre: [number, number] = [10, 60];
    const [ring] = buildUncertaintyRings([record(1, centre[0], centre[1], 10_000)]).features;
    const coords = (ring.geometry as GeoJSON.Polygon).coordinates[0];
    for (const point of coords) {
      expect(metresApart(centre, point as [number, number])).toBeCloseTo(10_000, -2);
    }
  });

  it("leaves out records with no radius, rather than drawing them as precise", () => {
    expect(buildUncertaintyRings([record(1, 9.5, 0.5)]).features).toHaveLength(0);
    expect(buildUncertaintyRings([record(2, 9.5, 0.5, null)]).features).toHaveLength(0);
    // Zero isn't a precision anyone measured; it's a blank that arrived as a
    // number, and a ring of no radius is a ring that says the opposite.
    expect(buildUncertaintyRings([record(3, 9.5, 0.5, 0)]).features).toHaveLength(0);
  });

  it("leaves out a radius too wide to mean anything as a circle", () => {
    expect(
      buildUncertaintyRings([record(1, 9.5, 0.5, UNCERTAINTY_RING_MAX_M)]).features
    ).toHaveLength(1);
    expect(
      buildUncertaintyRings([record(2, 9.5, 0.5, UNCERTAINTY_RING_MAX_M + 1)]).features
    ).toHaveLength(0);
  });

  it("leaves out records GBIF has no coordinates for", () => {
    const noPosition: OccurrenceFeature = {
      type: "Feature",
      properties: { gbifID: 1, species: "Loxodonta cyclotis", coordinateUncertaintyInMeters: 500 },
      geometry: null,
    };
    expect(buildUncertaintyRings([noPosition]).features).toHaveLength(0);
  });
});
