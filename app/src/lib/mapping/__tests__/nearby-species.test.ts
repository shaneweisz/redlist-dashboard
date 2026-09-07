import { describe, it, expect } from "vitest";
import {
  NEARBY_CATEGORIES,
  nearbyFacetUrl,
  nearbyGbifSiteUrl,
  groupNearbyFeatures,
} from "../nearby-species";
import { threatTags } from "../nearby-threats";
import { THREAT_TOP_LEVEL, THREAT_SUB_LEVEL, compareThreatCodes } from "../nearby-species";
import { THREAT_CATEGORIES } from "@/lib/filter-vocab";
import { COL_XR_CHECKLIST_KEY } from "@/lib/gbif";

describe("the GBIF query", () => {
  // The stored keys are Catalogue of Life ones and the v1 API still defaults to
  // the frozen 2023 backbone. A key from one taxonomy resolves to nothing in
  // the other and GBIF reports that as an empty facet rather than an error, so
  // dropping this parameter doesn't break the request — it silently matches
  // nothing. Measured on a first draft of this file: 0 of 205 species joined.
  it("names the checklist the stored keys belong to", () => {
    const url = new URL(nearbyFacetUrl({ lat: -0.5, lng: -77.5, radiusKm: 25 }));
    expect(url.searchParams.get("checklistKey")).toBe(COL_XR_CHECKLIST_KEY);
    expect(new URL(nearbyGbifSiteUrl({ lat: -0.5, lng: -77.5, radiusKm: 25 })).searchParams.get("checklistKey"))
      .toBe(COL_XR_CHECKLIST_KEY);
  });

  it("asks for the radius as a geoDistance, and for the species facet only", () => {
    const url = new URL(nearbyFacetUrl({ lat: -0.5, lng: -77.5, radiusKm: 50 }));
    expect(url.searchParams.get("geoDistance")).toBe("-0.5,-77.5,50km");
    expect(url.searchParams.get("facet")).toBe("speciesKey");
    // The records themselves are never read, only the facet over them.
    expect(url.searchParams.get("limit")).toBe("0");
  });

  // Records GBIF itself flags as positionally suspect would place species in a
  // radius they may have nothing to do with, which is the one thing this panel
  // must not do.
  it("excludes records with geospatial issues", () => {
    const url = new URL(nearbyFacetUrl({ lat: 0, lng: 0, radiusKm: 10 }));
    expect(url.searchParams.get("hasGeospatialIssue")).toBe("false");
    expect(url.searchParams.get("hasCoordinate")).toBe("true");
  });

  it("repeats iucnRedListCategory once per category, which is the form GBIF reads", () => {
    const url = new URL(nearbyFacetUrl({ lat: 0, lng: 0, radiusKm: 10 }));
    expect(url.searchParams.getAll("iucnRedListCategory")).toEqual([...NEARBY_CATEGORIES]);
  });
});

describe("the threat tags", () => {
  it("trims a leaf code to its sub-code", () => {
    expect(threatTags(["5.4.1"])).toEqual([{ code: "5.4", label: "Harvesting (Fishing & harvesting)" }]);
  });

  // 5.4.1, 5.4.2 and 5.4.3 are one pressure; three tags saying so would be
  // three ways of reading the same tick.
  it("collapses several leaves under one sub-code to a single tag", () => {
    expect(threatTags(["5.4.1", "5.4.2", "5.4.3"]).map((t) => t.code)).toEqual(["5.4"]);
  });

  it("keeps distinct sub-codes apart, in the order they were cited", () => {
    expect(threatTags(["2.1", "5.3", "2.2"]).map((t) => t.code)).toEqual(["2.1", "5.3", "2.2"]);
  });

  // A bare top-level code is already at the level the tags work at.
  it("passes a top-level code through", () => {
    expect(threatTags(["11"])).toEqual([{ code: "11", label: "Climate change" }]);
  });

  it("gives every tag a label rather than a bare number", () => {
    for (const t of threatTags(["1.1", "2.1", "8.1", "9.2"])) expect(t.label).not.toMatch(/^[\d.]+$/);
  });

  it("has nothing to show for a species with no threat codes", () => {
    expect(threatTags([])).toEqual([]);
  });
});

describe("the stack under a click", () => {
  const pt = (gbifID: number) => ({
    gbifID, lat: 0, lng: 0, species: null, eventDate: null, year: null, basis: null,
    recordedBy: null, identifiedBy: null, locality: null, countryCode: null,
    uncertaintyMetres: null, catalogNumber: null, datasetName: null, images: [],
  });
  const points = { A: { points: [pt(1), pt(2), pt(3)] }, B: { points: [pt(9)] } };
  const f = (nearbyKey: string, nearbyIndex: number) => ({ properties: { nearbyKey, nearbyIndex } });

  // The whole point: a locality collected from repeatedly stacks its dots, and
  // only the topmost was reachable before.
  it("returns every record under the pointer, in draw order", () => {
    expect(groupNearbyFeatures([f("A", 0), f("A", 2), f("B", 0)], points).map((p) => p.gbifID))
      .toEqual([1, 3, 9]);
  });

  // MapLibre hands the same feature back twice where tile boundaries overlap,
  // which would otherwise page you through the same record repeatedly.
  it("drops a record handed back more than once", () => {
    expect(groupNearbyFeatures([f("A", 0), f("A", 0), f("A", 1)], points).map((p) => p.gbifID))
      .toEqual([1, 2]);
  });

  it("ignores features whose species isn't drawn, or whose index is gone", () => {
    expect(groupNearbyFeatures([f("A", 99), f("Z", 0), { properties: {} }], points)).toEqual([]);
  });

  it("has nothing to show for a click that hit no dot", () => {
    expect(groupNearbyFeatures([], points)).toEqual([]);
  });
});

// The panel needs these labels in the browser, and lib/filter-vocab cannot go
// there. This is the pin that stops the copy drifting from the original.
describe("the top-level threat labels", () => {
  it("match lib/filter-vocab's, code for code", () => {
    expect(THREAT_TOP_LEVEL).toEqual(
      Object.fromEntries(THREAT_CATEGORIES.map((c) => [c.code, c.label]))
    );
  });

  it("carry every sub-level from the same source", () => {
    expect(THREAT_SUB_LEVEL).toEqual(
      Object.fromEntries(THREAT_CATEGORIES.flatMap((c) => c.children.map((s) => [s.code, s.label])))
    );
  });
});

describe("ordering threat codes", () => {
  // The whole reason this exists: as strings, 11 comes before 2.
  it("sorts numerically, not as text", () => {
    expect(["11.4", "2.1", "9.2"].sort(compareThreatCodes)).toEqual(["2.1", "9.2", "11.4"]);
  });

  it("orders deeper codes under their parent", () => {
    expect(["2.3", "2.1.3", "2.1"].sort(compareThreatCodes)).toEqual(["2.1", "2.1.3", "2.3"]);
  });

  // The API writes them with underscores and people write them with dots.
  it("reads either spelling", () => {
    expect(compareThreatCodes("2_1_3", "2.1.3")).toBe(0);
    expect(["5_3", "2_1_3"].sort(compareThreatCodes)).toEqual(["2_1_3", "5_3"]);
  });

  it("puts a bare parent before its own children", () => {
    expect(["5.4.1", "5"].sort(compareThreatCodes)).toEqual(["5", "5.4.1"]);
  });
});
