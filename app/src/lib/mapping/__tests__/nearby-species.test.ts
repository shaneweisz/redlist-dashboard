import { describe, it, expect } from "vitest";
import {
  NEARBY_CATEGORIES,
  nearbyFacetUrl,
  nearbyGbifSiteUrl,
  type NearbySpecies,
} from "../nearby-species";
import { summariseThreats } from "../nearby-threats";
import { COL_XR_CHECKLIST_KEY } from "@/lib/gbif";

/** A neighbour, with only the fields the summary reads spelled out. */
function species(name: string, threat_codes: string[], over: Partial<NearbySpecies> = {}): NearbySpecies {
  return {
    gbif_species_key: name.replace(/\s/g, ""),
    scientific_name: name,
    common_name: null,
    category: "EN",
    criteria: null,
    taxon_group: "amphibians",
    class_name: "amphibia",
    threat_codes,
    assessment_year: 2020,
    assessment_id: 1,
    records: 1,
    sis_taxon_id: 1,
    dashboard_row_key: null,
    ...over,
  };
}

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

describe("the threat summary", () => {
  it("rolls leaf codes up to their top-level category", () => {
    const threats = summariseThreats([species("Aus bus", ["2.1.2", "5.3"])]);
    expect(threats.map((t) => t.code)).toEqual(["2", "5"]);
  });

  // Two assessors writing 2.1.2 and 2.1.3 are describing the same field. Counted
  // per leaf, that one species would report as two facing agriculture.
  it("counts a species once per top-level threat, however many leaves it cites", () => {
    const threats = summariseThreats([species("Aus bus", ["2.1.2", "2.1.3", "2.3"])]);
    expect(threats).toHaveLength(1);
    expect(threats[0]).toMatchObject({ code: "2", species: 1 });
  });

  it("orders by how many species cite it, and names them", () => {
    const threats = summariseThreats([
      species("Aus bus", ["2.1"]),
      species("Cus dus", ["2.1", "5.1"]),
      species("Eus fus", ["2.1"]),
    ]);
    expect(threats[0]).toMatchObject({ code: "2", species: 3 });
    expect(threats[0].examples.map((e) => e.name)).toEqual(["Aus bus", "Cus dus", "Eus fus"]);
    expect(threats[1]).toMatchObject({ code: "5", species: 1 });
  });

  it("gives each threat a label rather than a bare number", () => {
    expect(summariseThreats([species("Aus bus", ["2.1"])])[0].label).toBe("Agriculture");
  });

  // A species with no threats recorded is still a neighbour worth listing; it
  // just has nothing to contribute to the summary.
  it("ignores species with no threat codes", () => {
    expect(summariseThreats([species("Aus bus", [])])).toEqual([]);
  });

  // Each listed species carries the assessment behind it, because the row can
  // be opened to read what that assessment actually says about threats.
  it("carries each listed species' key and assessment id", () => {
    const [t] = summariseThreats([species("Aus bus", ["2.1"], { assessment_id: 4242 })]);
    expect(t.examples[0]).toEqual({ key: "Ausbus", name: "Aus bus", assessmentId: 4242 });
  });

  it("caps the named examples but keeps the full count", () => {
    const many = Array.from({ length: 20 }, (_, i) => species(`Sp ${i}`, ["2.1"]));
    const [agriculture] = summariseThreats(many, 3);
    expect(agriculture.species).toBe(20);
    expect(agriculture.examples).toHaveLength(3);
  });
});
