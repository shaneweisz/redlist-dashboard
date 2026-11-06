import { describe, it, expect } from "vitest";
import { matchesSpeciesFilter, type FilterableSpecies } from "@/lib/species-filter";

function sp(overrides: Partial<FilterableSpecies> = {}): FilterableSpecies {
  return {
    category: "VU",
    countries: ["BR"],
    systems: ["Marine"],
    population_trend: "Decreasing",
    movement_pattern: null,
    threat_codes: ["11.4"],
    growth_forms: [],
    scientific_name: "Acropora cervicornis",
    common_name: "Staghorn coral",
    gbif_georeferenced_records_count: 50,
    assessment_date: "2018-06-01",
    ...overrides,
  };
}

describe("matchesSpeciesFilter", () => {
  it("matches everything with empty criteria", () => {
    expect(matchesSpeciesFilter(sp(), {})).toBe(true);
  });

  it("matches category exactly", () => {
    expect(matchesSpeciesFilter(sp({ category: "CR" }), { categories: new Set(["CR"]) })).toBe(true);
    expect(matchesSpeciesFilter(sp({ category: "EN" }), { categories: new Set(["CR"]) })).toBe(false);
  });

  it("matches threats by prefix", () => {
    expect(matchesSpeciesFilter(sp({ threat_codes: ["11.4"] }), { threats: new Set(["11"]) })).toBe(true);
    expect(matchesSpeciesFilter(sp({ threat_codes: ["11"] }), { threats: new Set(["11"]) })).toBe(true);
    expect(matchesSpeciesFilter(sp({ threat_codes: ["5.4"] }), { threats: new Set(["11"]) })).toBe(false);
    // prefix must be on a dot boundary, not a substring
    expect(matchesSpeciesFilter(sp({ threat_codes: ["110"] }), { threats: new Set(["11"]) })).toBe(false);
  });

  it("ORs multiple values within one filter", () => {
    const f = { threats: new Set(["11", "9"]) };
    expect(matchesSpeciesFilter(sp({ threat_codes: ["9.1"] }), f)).toBe(true);
    expect(matchesSpeciesFilter(sp({ threat_codes: ["11.2"] }), f)).toBe(true);
    expect(matchesSpeciesFilter(sp({ threat_codes: ["2.1"] }), f)).toBe(false);
  });

  it("ANDs across different filters", () => {
    const f = { threats: new Set(["11"]), categories: new Set(["CR"]) };
    expect(matchesSpeciesFilter(sp({ threat_codes: ["11.1"], category: "CR" }), f)).toBe(true);
    expect(matchesSpeciesFilter(sp({ threat_codes: ["11.1"], category: "EN" }), f)).toBe(false);
    expect(matchesSpeciesFilter(sp({ threat_codes: ["5.4"], category: "CR" }), f)).toBe(false);
  });

  it("matches countries (OR) and systems", () => {
    expect(matchesSpeciesFilter(sp({ countries: ["US", "MX"] }), { countries: new Set(["MX"]) })).toBe(true);
    expect(matchesSpeciesFilter(sp({ countries: ["US"] }), { countries: new Set(["MX"]) })).toBe(false);
    expect(matchesSpeciesFilter(sp({ systems: ["Freshwater"] }), { systems: new Set(["Marine"]) })).toBe(false);
  });

  it("matches population trend and movement", () => {
    expect(matchesSpeciesFilter(sp({ population_trend: "Decreasing" }), { populationTrends: new Set(["Decreasing"]) })).toBe(true);
    expect(matchesSpeciesFilter(sp({ population_trend: null }), { populationTrends: new Set(["Decreasing"]) })).toBe(false);
  });

  it("matches name search (scientific or common), needle pre-lowercased", () => {
    expect(matchesSpeciesFilter(sp(), { search: "acropora" })).toBe(true);
    expect(matchesSpeciesFilter(sp(), { search: "staghorn" })).toBe(true);
    expect(matchesSpeciesFilter(sp(), { search: "tiger" })).toBe(false);
    expect(matchesSpeciesFilter(sp({ common_name: null }), { search: "staghorn" })).toBe(false);
  });

  it("handles missing optional arrays safely", () => {
    expect(matchesSpeciesFilter(sp({ threat_codes: null }), { threats: new Set(["11"]) })).toBe(false);
    expect(matchesSpeciesFilter(sp({ systems: null }), { systems: new Set(["Marine"]) })).toBe(false);
  });

  it("matches GBIF observation bounds (null counts as 0)", () => {
    expect(matchesSpeciesFilter(sp({ gbif_georeferenced_records_count: 150 }), { minObs: 100 })).toBe(true);
    expect(matchesSpeciesFilter(sp({ gbif_georeferenced_records_count: 50 }), { minObs: 100 })).toBe(false);
    expect(matchesSpeciesFilter(sp({ gbif_georeferenced_records_count: null }), { minObs: 1 })).toBe(false);
    expect(matchesSpeciesFilter(sp({ gbif_georeferenced_records_count: 5 }), { maxObs: 10 })).toBe(true);
    expect(matchesSpeciesFilter(sp({ gbif_georeferenced_records_count: 500 }), { minObs: 100, maxObs: 1000 })).toBe(true);
  });

  it("matches assessment-year bounds (inclusive)", () => {
    expect(matchesSpeciesFilter(sp({ assessment_date: "2015-01-01" }), { minAssessmentYear: 2015 })).toBe(true);
    expect(matchesSpeciesFilter(sp({ assessment_date: "2014-12-31" }), { minAssessmentYear: 2015 })).toBe(false);
    expect(matchesSpeciesFilter(sp({ assessment_date: "2010-01-01" }), { maxAssessmentYear: 2012 })).toBe(true);
    expect(matchesSpeciesFilter(sp({ assessment_date: null }), { minAssessmentYear: 2000 })).toBe(false);
  });
});
