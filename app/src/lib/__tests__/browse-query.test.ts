/**
 * runBrowseQuery — the shared query logic behind both /browse and the /api/mcp
 * tools. The DuckDB read layer is mocked so these stay hermetic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { querySpecies, searchSpecies } = vi.hoisted(() => ({ querySpecies: vi.fn(), searchSpecies: vi.fn() }));
vi.mock("@/lib/data/species-duckdb", () => ({ querySpecies, searchSpecies }));

import { runBrowseQuery } from "../browse-query";

function row(over: Record<string, unknown> = {}) {
  return {
    species_key: `sis-${Math.floor(Math.random() * 1e9)}`, scientific_name: "Acropora sp.", common_name: null,
    category: "EN", countries: ["AU"], systems: [], population_trend: null, movement_pattern: null,
    threat_codes: ["11.4"], growth_forms: [], gbif_georeferenced_records_count: 5,
    assessment_date: "2020-01-01", taxon_group: "corals", class_name: "anthozoa",
    order_name: "scleractinia", family: "acroporidae",
    latest_assessors: "Smith, J.A.", latest_reviewers: "Jones, B.", described_year: 2000, ...over,
  };
}

beforeEach(() => {
  querySpecies.mockReset(); searchSpecies.mockReset();
  querySpecies.mockResolvedValue({ species: [], truncated: false, tooLarge: false, neTotal: null });
  searchSpecies.mockResolvedValue([]);
});

describe("runBrowseQuery", () => {
  it("flags noSelector when no taxon or search is given", async () => {
    const r = await runBrowseQuery({});
    expect(r.noSelector).toBe(true);
    expect(querySpecies).not.toHaveBeenCalled();
  });

  it("browses a taxon: total, breakdown, and threats carry the parent category", async () => {
    querySpecies.mockResolvedValue({ species: [row(), row({ category: "VU" })], truncated: false, tooLarge: false, neTotal: null });
    const r = await runBrowseQuery({ taxa: ["corals"] });
    expect(querySpecies).toHaveBeenCalledWith(expect.objectContaining({ taxon: "corals" }));
    expect(r.total).toBe(2);
    expect(r.breakdown).toEqual({ EN: 1, VU: 1 });
    expect(r.species[0].threats[0]).toEqual({ code: "11.4", label: "Climate change (Storms & flooding)" });
  });

  it("applies a category filter", async () => {
    querySpecies.mockResolvedValue({ species: [row({ category: "EN" }), row({ category: "LC" })], truncated: false, tooLarge: false, neTotal: null });
    const r = await runBrowseQuery({ taxa: ["corals"], categories: ["EN"] });
    expect(r.total).toBe(1);
  });

  it("looks up a species via searchSpecies (synonym-aware)", async () => {
    searchSpecies.mockResolvedValue([
      { species_key: "sis-219", sis_taxon_id: 219, col_id: null, scientific_name: "Acinonyx jubatus", common_name: "Cheetah", taxon_id: "mammals",
        taxon_group: "mammals", category: "VU", gbif_species_key: null, assessment_id: null,
        assessment_date: "2021-01-01", countries: ["NA"], matched_synonym: "Felis jubata" },
    ]);
    const r = await runBrowseQuery({ search: "Felis jubata" });
    expect(querySpecies).not.toHaveBeenCalled();
    expect(r.species[0].scientific_name).toBe("Acinonyx jubatus");
    expect(r.species[0].matched_synonym).toBe("Felis jubata");
  });

  it("expands an IUCN region to its countries", async () => {
    const { iucnRegionCountries } = await import("@/lib/regions");
    const eu = iucnRegionCountries("Europe")[0];
    querySpecies.mockResolvedValue({ species: [row({ species_key: "sis-1", countries: [eu] }), row({ species_key: "sis-2", countries: ["ZZ"] })], truncated: false, tooLarge: false, neTotal: null });
    const r = await runBrowseQuery({ taxa: ["corals"], region: ["Europe"] });
    expect(r.total).toBe(1);
  });
  it("filters on contributor and on institution", async () => {
    const plants = [
      row({ species_key: "sis-1", scientific_name: "Aloe alpha", taxon_group: "flowering_plants", class_name: "magnoliopsida", order_name: "asparagales", family: "asphodelaceae",
            latest_contributors: "Roberts, D., Hines, H. & Meyer, E.", latest_institutions: "Royal Botanic Gardens, Kew" }),
      row({ species_key: "sis-2", scientific_name: "Aloe beta", taxon_group: "flowering_plants", class_name: "magnoliopsida", order_name: "asparagales", family: "asphodelaceae",
            latest_contributors: "Clarke, J.", latest_institutions: "NatureServe" }),
    ];

    querySpecies.mockResolvedValue({ species: plants, truncated: false, tooLarge: false, neTotal: null });
    const byContributor = await runBrowseQuery({ taxa: ["flowering_plants"], contributors: ["Hines"] });
    expect(byContributor.total).toBe(1);
    expect(byContributor.species[0].scientific_name).toBe("Aloe alpha");
    expect(byContributor.interpreted).toContain("Contributor: Hines");

    querySpecies.mockResolvedValue({ species: plants, truncated: false, tooLarge: false, neTotal: null });
    const byInstitution = await runBrowseQuery({ taxa: ["flowering_plants"], institutions: ["Kew"] });
    expect(byInstitution.total).toBe(1);
    expect(byInstitution.species[0].scientific_name).toBe("Aloe alpha");
    expect(byInstitution.interpreted).toContain("Institution: Kew");
  });

  // Institutions are split on " & " only, so a comma inside one organisation
  // name never becomes a second institution — searching the tail of such a name
  // still has to match the row it belongs to.
  it("matches an institution whose name contains a comma", async () => {
    const plants = [
      row({ species_key: "sis-1", scientific_name: "Aloe alpha", taxon_group: "flowering_plants", class_name: "magnoliopsida", order_name: "asparagales", family: "asphodelaceae",
            latest_institutions: "Royal Botanic Gardens, Kew & Botanic Gardens Conservation International" }),
    ];
    querySpecies.mockResolvedValue({ species: plants, truncated: false, tooLarge: false, neTotal: null });
    const res = await runBrowseQuery({ taxa: ["flowering_plants"], institutions: ["Royal Botanic Gardens, Kew"] });
    expect(res.total).toBe(1);
  });

  // The BirdLife case the facilitator filter exists for: every bird assessment
  // credits the organisation as assessor, so only the facilitator names a person.
  it("filters on facilitator, which assessor cannot reach for org-credited assessments", async () => {
    const birds = [
      row({ species_key: "sis-1", scientific_name: "Corvus alpha", taxon_group: "birds", class_name: "aves", order_name: "passeriformes", family: "corvidae",
            latest_assessors: "BirdLife International", latest_reviewers: "Jones, B.", latest_facilitators: "Rutherford, C.A." }),
      row({ species_key: "sis-2", scientific_name: "Corvus beta", taxon_group: "birds", class_name: "aves", order_name: "passeriformes", family: "corvidae",
            latest_assessors: "BirdLife International", latest_reviewers: "Jones, B.", latest_facilitators: "Hermes, C." }),
    ];
    querySpecies.mockResolvedValue({ species: birds, truncated: false, tooLarge: false, neTotal: null });

    const byFacilitator = await runBrowseQuery({ taxa: ["birds"], facilitators: ["Rutherford"] });
    expect(byFacilitator.total).toBe(1);
    expect(byFacilitator.species[0].scientific_name).toBe("Corvus alpha");
    expect(byFacilitator.interpreted).toContain("Facilitator: Rutherford");

    // The same query through the assessor filter can't separate them at all.
    querySpecies.mockResolvedValue({ species: birds, truncated: false, tooLarge: false, neTotal: null });
    const byAssessor = await runBrowseQuery({ taxa: ["birds"], assessors: ["BirdLife"] });
    expect(byAssessor.total).toBe(2);
  });

  it("leaves rows with no facilitator out when the filter is set", async () => {
    querySpecies.mockResolvedValue({
      species: [row({ species_key: "sis-3", latest_facilitators: null })],
      truncated: false, tooLarge: false, neTotal: null,
    });
    const r = await runBrowseQuery({ taxa: ["corals"], facilitators: ["Rutherford"] });
    expect(r.total).toBe(0);
  });
});
