import { describe, it, expect } from "vitest";
import { parseParams, buildQs, mergeParamsIntoSearch, OWN_PARAM_NAMES, SPECIES_SCOPED_RESET } from "../useFilterParams";
import { ALL_HABITAT_SEASONS, ALL_HABITAT_IMPORTANCE, ALL_HABITAT_SUITABILITY } from "../../lib/habitat-filter";

describe("parseParams", () => {
  it("defaults viewMode to reassessments", () => {
    const result = parseParams("");
    expect(result.viewMode).toBe("reassessments");
  });

  it("parses view=new-assessments", () => {
    const result = parseParams("?view=new-assessments");
    expect(result.viewMode).toBe("new-assessments");
  });

  it("defaults unknown view values to reassessments", () => {
    const result = parseParams("?view=unknown");
    expect(result.viewMode).toBe("reassessments");
  });

  it("returns empty sets for empty search string", () => {
    const result = parseParams("");
    expect(result.taxa.size).toBe(0);
    expect(result.categories.size).toBe(0);
    expect(result.yearRanges.size).toBe(0);
    expect(result.countries.size).toBe(0);
    expect(result.search).toBe("");
    expect(result.sortField).toBe(null);
    expect(result.sortDirection).toBe("desc");
  });

  it("parses taxa from comma-separated list", () => {
    const result = parseParams("?taxa=mammals,birds");
    expect(result.taxa).toEqual(new Set(["mammals", "birds"]));
  });

  it("maps legacy vertebrate taxa IDs to current root ids (back-compat for old URLs)", () => {
    const result = parseParams("?taxa=mammalia,aves,reptilia,amphibia");
    expect(result.taxa).toEqual(new Set(["mammals", "birds", "reptiles", "amphibians"]));
    expect(result.subgroups.size).toBe(0);
  });

  it("expands legacy invertebrate taxa tokens to invertebrates + sub-group", () => {
    // arachnida/mollusca/crustacea map to groups stored under `invertebrates`, so a
    // single flat token expands to the root + its sub-group node.
    const result = parseParams("?taxa=arachnida,mollusca,crustacea");
    expect(result.taxa).toEqual(new Set(["invertebrates"]));
    expect(result.subgroups).toEqual(new Set(["inv-arachnids", "inv-molluscs", "inv-crustaceans"]));
  });

  it("dedupes roots, expands group tokens, and passes unknown tokens through", () => {
    // "beetles" was a static sub-node of Insects before Phase 8 retired it for
    // live order-level drilldown (dynamic-taxon.ts) — it no longer resolves to
    // a real node, so (like "unknownthing") it now passes through unexpanded
    // rather than 404ing; this is the accepted tradeoff for old shared/
    // bookmarked URLs referencing a retired static id.
    const result = parseParams("?taxa=mammalia,mammals,insecta,beetles,unknownthing");
    expect(result.taxa).toEqual(new Set(["mammals", "invertebrates", "beetles", "unknownthing"]));
    expect(result.subgroups).toEqual(new Set(["inv-insects"]));
  });

  it("expands a single flat group token (corals → invertebrates + inv-corals)", () => {
    const result = parseParams("?taxa=corals");
    expect(result.taxa).toEqual(new Set(["invertebrates"]));
    expect(result.subgroups).toEqual(new Set(["inv-corals"]));
  });

  it("maps legacy IDs in the subgroups param too", () => {
    const result = parseParams("?subgroups=mollusca,arachnida");
    expect(result.subgroups).toEqual(new Set(["molluscs", "arachnids"]));
  });

  it("maps legacy prefixed virtual-node IDs (e.g. inv-crustacea → inv-crustaceans)", () => {
    const result = parseParams("?taxa=invertebrates&subgroups=inv-crustacea,inv-mollusca,inv-arachnida");
    expect(result.taxa).toEqual(new Set(["invertebrates"])); // virtual root unchanged
    expect(result.subgroups).toEqual(new Set(["inv-crustaceans", "inv-molluscs", "inv-arachnids"]));
  });

  it("canonicalizes the base of a prefixed ID while preserving the prefix (inv-insecta → inv-insects); non-aliased pass through", () => {
    const result = parseParams("?subgroups=inv-insecta,inv-beetles");
    expect(result.subgroups).toEqual(new Set(["inv-insects", "inv-beetles"]));
  });

  it("parses categories", () => {
    const result = parseParams("?categories=CR,EN,VU");
    expect(result.categories).toEqual(new Set(["CR", "EN", "VU"]));
  });

  it("parses year ranges", () => {
    const result = parseParams("?years=%3C1+year,11-20+years");
    expect(result.yearRanges).toEqual(new Set(["<1 year", "11-20 years"]));
  });

  it("parses assessment years", () => {
    const result = parseParams("?assessmentYears=2023,2024");
    expect(result.assessmentYears).toEqual(new Set(["2023", "2024"]));
  });

  it("defaults assessmentYears to empty set when absent", () => {
    const result = parseParams("");
    expect(result.assessmentYears.size).toBe(0);
  });

  it("parses countries", () => {
    const result = parseParams("?countries=ZA,KE");
    expect(result.countries).toEqual(new Set(["ZA", "KE"]));
  });

  it("parses search term", () => {
    const result = parseParams("?search=elephant+shrew");
    expect(result.search).toBe("elephant shrew");
  });

  it("parses sort=totalGbif", () => {
    const result = parseParams("?sort=totalGbif");
    expect(result.sortField).toBe("totalGbif");
  });

  it("parses sort=newGbif", () => {
    const result = parseParams("?sort=newGbif");
    expect(result.sortField).toBe("newGbif");
  });

  it("parses sort=category", () => {
    const result = parseParams("?sort=category");
    expect(result.sortField).toBe("category");
  });

  it("parses sort=year", () => {
    const result = parseParams("?sort=year");
    expect(result.sortField).toBe("year");
  });

  it("defaults unknown sort values to null", () => {
    const result = parseParams("?sort=unknown");
    expect(result.sortField).toBe(null);
  });

  it("parses sort direction", () => {
    const result = parseParams("?dir=asc");
    expect(result.sortDirection).toBe("asc");
  });

  it("defaults sort direction to desc", () => {
    const result = parseParams("?dir=invalid");
    expect(result.sortDirection).toBe("desc");
  });

  it("parses a complex URL with multiple params", () => {
    const result = parseParams(
      "?taxa=mammals&categories=CR,EN&years=11-20+years&search=shrew&sort=year&dir=asc"
    );
    expect(result.taxa).toEqual(new Set(["mammals"]));
    expect(result.categories).toEqual(new Set(["CR", "EN"]));
    expect(result.yearRanges).toEqual(new Set(["11-20 years"]));
    expect(result.search).toBe("shrew");
    expect(result.sortField).toBe("year");
    expect(result.sortDirection).toBe("asc");
  });

  it("filters out empty strings from comma-split", () => {
    const result = parseParams("?taxa=,mammals,,birds,");
    expect(result.taxa).toEqual(new Set(["mammals", "birds"]));
  });

  it("parses single subgroup", () => {
    const result = parseParams("?subgroups=sharks-rays");
    expect(result.subgroups).toEqual(new Set(["sharks-rays"]));
  });

  it("parses multiple subgroups", () => {
    const result = parseParams("?subgroups=sharks-rays,ray-finned-fishes");
    expect(result.subgroups).toEqual(new Set(["sharks-rays", "ray-finned-fishes"]));
  });

  it("defaults subgroups to empty set when absent", () => {
    const result = parseParams("?taxa=fishes");
    expect(result.subgroups.size).toBe(0);
  });

  it("parses subgroups with other params", () => {
    const result = parseParams("?taxa=fishes&subgroups=ray-finned-fishes&categories=CR");
    expect(result.taxa).toEqual(new Set(["fishes"]));
    expect(result.subgroups).toEqual(new Set(["ray-finned-fishes"]));
    expect(result.categories).toEqual(new Set(["CR"]));
  });

  it("parses species param", () => {
    const result = parseParams("?species=sis-176168");
    expect(result.species).toBe("sis-176168");
  });

  it("defaults species to null when absent", () => {
    const result = parseParams("");
    expect(result.species).toBe(null);
  });

  it("parses tab param", () => {
    const result = parseParams("?species=sis-176168&tab=assessors");
    expect(result.tab).toBe("assessors");
  });

  it("defaults tab to null when absent", () => {
    const result = parseParams("");
    expect(result.tab).toBe(null);
  });

  it("parses the exact URL-only filters", () => {
    const result = parseParams(
      "?outdated=yes&minObs=100&maxObs=5000&minAssessmentYear=2010&maxAssessmentYear=2020&minDescribedYear=1990&maxDescribedYear=2000"
    );
    expect(result.outdated).toBe("yes");
    expect(result.minObs).toBe(100);
    expect(result.maxObs).toBe(5000);
    expect(result.minAssessmentYear).toBe(2010);
    expect(result.maxAssessmentYear).toBe(2020);
    expect(result.minDescribedYear).toBe(1990);
    expect(result.maxDescribedYear).toBe(2000);
  });

  it("defaults exact filters to null when absent / invalid", () => {
    const result = parseParams("?outdated=maybe&minObs=abc");
    expect(result.outdated).toBe(null);
    expect(result.minObs).toBe(null);
    expect(result.maxObs).toBe(null);
  });

  // The Threats chart's scope: threatened-only is the DEFAULT (IUCN's threat
  // coding is only reliable for CR/EN/VU), so the param is only ever present in
  // the URL for the opt-out — an old link with no param must land on the default.
  it("defaults threatsScope to threatened", () => {
    expect(parseParams("").threatsScope).toBe("threatened");
    expect(parseParams("?threats=11").threatsScope).toBe("threatened");
  });

  it("parses threatsScope=all, and treats an unrecognised value as the default", () => {
    expect(parseParams("?threatsScope=all").threatsScope).toBe("all");
    expect(parseParams("?threatsScope=nonsense").threatsScope).toBe("threatened");
  });

  it("expands a region param into its country codes (no separate region state)", () => {
    const result = parseParams("?region=Sub-Saharan+Africa");
    expect(result.countries.size).toBeGreaterThan(0);
  });

  it("unions region countries with an explicit countries param", () => {
    const result = parseParams("?countries=ZA&region=Europe");
    expect(result.countries.has("ZA")).toBe(true);
    expect(result.countries.size).toBeGreaterThan(1);
  });
});

describe("buildQs", () => {
  const emptyState = {
    viewMode: "reassessments" as const,
    taxa: new Set<string>(),
    categories: new Set<string>(),
    yearRanges: new Set<string>(),
    assessmentYears: new Set<string>(),
    describedYears: new Set<string>(),
    countries: new Set<string>(),
    obsRanges: new Set<string>(),
    assessmentCounts: new Set<string>(),
    systems: new Set<string>(),
    populationTrends: new Set<string>(),
    movementPatterns: new Set<string>(),
    threats: new Set<string>(),
    criteria: new Set<string>(),
    habitat: new Set<string>(),
    habitatBreadth: null,
    habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
    habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
    habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
    endemicsOnly: false,
    growthForms: new Set<string>(),
    assessors: new Set<string>(),
    reviewers: new Set<string>(),
    facilitators: new Set<string>(),
    contributors: new Set<string>(),
    institutions: new Set<string>(),
    search: "",
    subgroups: new Set<string>(),
    sortField: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortField2: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortDirection2: "desc" as const,
    sortDirection: "desc" as const,
    species: null as string | null,
    tab: null as "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "assessors" | null,
  };

  it("omits view param for reassessments (default)", () => {
    expect(buildQs(emptyState)).toBe("");
  });

  it("includes view=new-assessments", () => {
    const qs = buildQs({ ...emptyState, viewMode: "new-assessments" });
    const params = new URLSearchParams(qs);
    expect(params.get("view")).toBe("new-assessments");
  });

  it("returns empty string for default state", () => {
    expect(buildQs(emptyState)).toBe("");
  });

  // Only the opt-out is written: "threatened" is the default, so writing it would
  // put a param in every URL that says nothing, and (worse) a shared link would
  // pin the scope it happened to have rather than following the default.
  it("omits threatsScope for the default (threatened) scope, writes it for all", () => {
    expect(buildQs({ ...emptyState, threats: new Set(["11"]), threatsScope: "threatened" as const }))
      .not.toContain("threatsScope");
    expect(buildQs({ ...emptyState, threats: new Set(["11"]), threatsScope: "all" as const }))
      .toContain("threatsScope=all");
  });

  it("includes taxa when set", () => {
    const qs = buildQs({ ...emptyState, taxa: new Set(["mammals", "birds"]) });
    expect(qs).toContain("taxa=");
    // Both values present (order may vary)
    const params = new URLSearchParams(qs);
    const taxa = params.get("taxa")!.split(",");
    expect(taxa).toContain("mammals");
    expect(taxa).toContain("birds");
  });

  it("includes categories", () => {
    const qs = buildQs({ ...emptyState, categories: new Set(["CR", "EN"]) });
    const params = new URLSearchParams(qs);
    const cats = params.get("categories")!.split(",");
    expect(cats).toContain("CR");
    expect(cats).toContain("EN");
  });

  it("includes year ranges", () => {
    const qs = buildQs({ ...emptyState, yearRanges: new Set(["<1 year"]) });
    const params = new URLSearchParams(qs);
    expect(params.get("years")).toBe("<1 year");
  });

  it("includes assessment years", () => {
    const qs = buildQs({ ...emptyState, assessmentYears: new Set(["2023", "2024"]) });
    const params = new URLSearchParams(qs);
    const years = params.get("assessmentYears")!.split(",");
    expect(years).toContain("2023");
    expect(years).toContain("2024");
  });

  it("omits assessmentYears when empty", () => {
    const qs = buildQs({ ...emptyState, assessmentYears: new Set() });
    const params = new URLSearchParams(qs);
    expect(params.has("assessmentYears")).toBe(false);
  });

  it("includes search", () => {
    const qs = buildQs({ ...emptyState, search: "elephant" });
    const params = new URLSearchParams(qs);
    expect(params.get("search")).toBe("elephant");
  });

  it("round-trips the endemics-only filter", () => {
    const qs = buildQs({ ...emptyState, endemicsOnly: true });
    expect(new URLSearchParams(qs).get("endemics")).toBe("1");
    expect(parseParams(qs).endemicsOnly).toBe(true);
  });

  it("omits endemics when false", () => {
    const qs = buildQs({ ...emptyState, endemicsOnly: false });
    expect(new URLSearchParams(qs).has("endemics")).toBe(false);
  });

  it("collapses a sub-group into the flat taxa token (no subgroups param)", () => {
    const qs = buildQs({ ...emptyState, subgroups: new Set(["sharks-rays"]) });
    const params = new URLSearchParams(qs);
    expect(params.get("taxa")).toBe("sharks-rays");
    expect(params.has("subgroups")).toBe(false);
  });

  it("collapses multiple sub-groups into the flat taxa list", () => {
    const qs = buildQs({ ...emptyState, subgroups: new Set(["sharks-rays", "ray-finned-fishes"]) });
    const params = new URLSearchParams(qs);
    const t = params.get("taxa")!.split(",");
    expect(t).toContain("sharks-rays");
    expect(t).toContain("ray-finned-fishes");
    expect(params.has("subgroups")).toBe(false);
  });

  it("collapses root + sub-group to a single flat token (invertebrates + inv-corals → corals)", () => {
    const qs = buildQs({ ...emptyState, taxa: new Set(["invertebrates"]), subgroups: new Set(["inv-corals"]) });
    const params = new URLSearchParams(qs);
    expect(params.get("taxa")).toBe("corals");
    expect(params.has("subgroups")).toBe(false);
  });

  it("omits subgroups when empty", () => {
    const qs = buildQs({ ...emptyState, subgroups: new Set() });
    expect(qs).toBe("");
  });

  it("omits sort param for null sortField (default)", () => {
    const qs = buildQs({ ...emptyState, sortField: null });
    expect(qs).toBe("");
  });

  it("omits sort param for year sortField (same as default)", () => {
    const qs = buildQs({ ...emptyState, sortField: "year" });
    expect(qs).toBe("");
  });

  it("writes sort=category", () => {
    const qs = buildQs({ ...emptyState, sortField: "category" });
    const params = new URLSearchParams(qs);
    expect(params.get("sort")).toBe("category");
  });

  it("writes sort=totalGbif when explicitly set", () => {
    const qs = buildQs({ ...emptyState, sortField: "totalGbif" });
    const params = new URLSearchParams(qs);
    expect(params.get("sort")).toBe("totalGbif");
  });

  it("writes sort=newGbif when explicitly set", () => {
    const qs = buildQs({ ...emptyState, sortField: "newGbif" });
    const params = new URLSearchParams(qs);
    expect(params.get("sort")).toBe("newGbif");
  });

  it("writes dir=asc for non-default direction", () => {
    const qs = buildQs({ ...emptyState, sortDirection: "asc" });
    const params = new URLSearchParams(qs);
    expect(params.get("dir")).toBe("asc");
  });

  it("omits dir=desc for category sort (desc is default)", () => {
    const qs = buildQs({ ...emptyState, sortField: "category", sortDirection: "desc" });
    const params = new URLSearchParams(qs);
    expect(params.get("sort")).toBe("category");
    expect(params.has("dir")).toBe(false);
  });

  // Facilitator names carry commas ("Rutherford, C.A."), so the multi-select
  // delimiter is a pipe — same as assessors/reviewers.
  it("round-trips contributors and institutions through the pipe-delimited param", () => {
    const qs = buildQs({ ...emptyState, contributors: new Set(["Hines, H."]), institutions: new Set(["Royal Botanic Gardens, Kew", "NatureServe"]) });
    const p = new URLSearchParams(qs);
    expect(p.get("contributors")).toBe("Hines, H.");
    // Pipe-delimited, so a comma inside an institution name survives the round trip.
    expect(p.get("institutions")).toBe("Royal Botanic Gardens, Kew|NatureServe");
    expect([...parseParams(qs).contributors]).toEqual(["Hines, H."]);
    expect([...parseParams(qs).institutions]).toEqual(["Royal Botanic Gardens, Kew", "NatureServe"]);
  });

  it("round-trips facilitators through the pipe-delimited param", () => {
    const qs = buildQs({ ...emptyState, facilitators: new Set(["Rutherford, C.A.", "Hermes, C."]) });
    expect(new URLSearchParams(qs).get("facilitators")).toBe("Rutherford, C.A.|Hermes, C.");
    // buildQs already returns the leading "?", so qs is a complete query string.
    expect([...parseParams(qs).facilitators]).toEqual(["Rutherford, C.A.", "Hermes, C."]);
  });

  // Secondary sort — shift/cmd-click a second column header.
  it("round-trips a secondary sort through sort2/dir2", () => {
    const qs = buildQs({ ...emptyState, sortField: "year", sortDirection: "desc", sortField2: "newGbif", sortDirection2: "asc" });
    const p = new URLSearchParams(qs);
    expect(p.get("sort2")).toBe("newGbif");
    expect(p.get("dir2")).toBe("asc");
    const parsed = parseParams(qs);
    expect(parsed.sortField2).toBe("newGbif");
    expect(parsed.sortDirection2).toBe("asc");
  });

  it("omits dir2 when the secondary is the default desc", () => {
    const qs = buildQs({ ...emptyState, sortField: "category", sortField2: "newGbif", sortDirection2: "desc" });
    const p = new URLSearchParams(qs);
    expect(p.get("sort2")).toBe("newGbif");
    expect(p.has("dir2")).toBe(false);
  });

  it("omits a secondary that duplicates the primary — it would be a no-op tiebreaker", () => {
    const qs = buildQs({ ...emptyState, sortField: "newGbif", sortField2: "newGbif" });
    expect(new URLSearchParams(qs).has("sort2")).toBe(false);
  });

  it("omits a secondary that duplicates the implicit default primary (year)", () => {
    const qs = buildQs({ ...emptyState, sortField: null, sortField2: "year" });
    expect(new URLSearchParams(qs).has("sort2")).toBe(false);
  });

  it("ignores an unrecognised sort2 rather than trusting the URL", () => {
    expect(parseParams("?sort2=notAColumn").sortField2).toBeNull();
  });

  it("includes species when set", () => {
    const qs = buildQs({ ...emptyState, species: "sis-176168", tab: "gbif" });
    const params = new URLSearchParams(qs);
    expect(params.get("species")).toBe("sis-176168");
    // The namespace separator must survive URL encoding unmangled — see species-row-key.
    expect(qs).toContain("species=sis-176168");
  });

  it("omits species when null", () => {
    const qs = buildQs({ ...emptyState, species: null, tab: null });
    expect(qs).toBe("");
  });

  it("includes tab when species set and tab is non-default", () => {
    const qs = buildQs({ ...emptyState, species: "sis-176168", tab: "assessors" });
    const params = new URLSearchParams(qs);
    expect(params.get("tab")).toBe("assessors");
  });

  it("omits tab when it is gbif (default)", () => {
    const qs = buildQs({ ...emptyState, species: "sis-176168", tab: "gbif" });
    const params = new URLSearchParams(qs);
    expect(params.has("tab")).toBe(false);
  });

  it("includes the exact URL-only filters when set", () => {
    const qs = buildQs({
      ...emptyState,
      outdated: "yes", minObs: 100, maxObs: 5000,
      minAssessmentYear: 2010, maxAssessmentYear: 2020,
      minDescribedYear: 1990, maxDescribedYear: 2000,
    });
    const p = new URLSearchParams(qs);
    expect(p.get("outdated")).toBe("yes");
    expect(p.get("minObs")).toBe("100");
    expect(p.get("maxObs")).toBe("5000");
    expect(p.get("minAssessmentYear")).toBe("2010");
    expect(p.get("maxAssessmentYear")).toBe("2020");
    expect(p.get("minDescribedYear")).toBe("1990");
    expect(p.get("maxDescribedYear")).toBe("2000");
  });

  it("omits exact filters when null/absent", () => {
    const qs = buildQs({ ...emptyState, outdated: null, minObs: null });
    expect(qs).toBe("");
  });

  it("round-trips the exact filters through parseParams", () => {
    const qs = buildQs({
      ...emptyState,
      taxa: new Set(["mammals"]),
      outdated: "no", minObs: 1, maxObs: 9, minAssessmentYear: 2000,
    });
    const parsed = parseParams(qs);
    expect(parsed.outdated).toBe("no");
    expect(parsed.minObs).toBe(1);
    expect(parsed.maxObs).toBe(9);
    expect(parsed.minAssessmentYear).toBe(2000);
  });
});

describe("parseParams ↔ buildQs round-trip", () => {
  it("round-trips a complex state", () => {
    const original = {
      viewMode: "reassessments" as const,
      taxa: new Set(["mammals"]),
      subgroups: new Set<string>(),
      categories: new Set(["CR", "EN"]),
      yearRanges: new Set(["11-20 years"]),
      assessmentYears: new Set(["2023", "2024"]),
      describedYears: new Set<string>(),
      countries: new Set(["ZA"]),
      obsRanges: new Set<string>(),
      assessmentCounts: new Set<string>(),
      systems: new Set<string>(),
      populationTrends: new Set<string>(),
      movementPatterns: new Set<string>(),
      threats: new Set<string>(),
      criteria: new Set<string>(),
      habitat: new Set<string>(),
      habitatBreadth: null,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
      endemicsOnly: false,
      growthForms: new Set<string>(),
      assessors: new Set<string>(),
      reviewers: new Set<string>(),
      facilitators: new Set<string>(),
      contributors: new Set<string>(),
      institutions: new Set<string>(),
      search: "shrew",
      sortField: "category" as const,
      sortDirection: "asc" as const,
      sortField2: "newGbif" as const,
      sortDirection2: "desc" as const,
      species: null,
      tab: null,
    };

    const qs = buildQs(original);
    const parsed = parseParams(qs);

    expect(parsed.taxa).toEqual(original.taxa);
    expect(parsed.categories).toEqual(original.categories);
    expect(parsed.yearRanges).toEqual(original.yearRanges);
    expect(parsed.assessmentYears).toEqual(original.assessmentYears);
    expect(parsed.countries).toEqual(original.countries);
    expect(parsed.search).toBe(original.search);
    expect(parsed.sortField).toBe(original.sortField);
    expect(parsed.sortDirection).toBe(original.sortDirection);
  });

  it("round-trips empty/default state", () => {
    const original = {
      viewMode: "reassessments" as const,
      taxa: new Set<string>(),
      subgroups: new Set<string>(),
      categories: new Set<string>(),
      yearRanges: new Set<string>(),
      assessmentYears: new Set<string>(),
      describedYears: new Set<string>(),
      countries: new Set<string>(),
      obsRanges: new Set<string>(),
      assessmentCounts: new Set<string>(),
      systems: new Set<string>(),
      populationTrends: new Set<string>(),
      movementPatterns: new Set<string>(),
      threats: new Set<string>(),
      criteria: new Set<string>(),
      habitat: new Set<string>(),
      habitatBreadth: null,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
      endemicsOnly: false,
      growthForms: new Set<string>(),
      assessors: new Set<string>(),
      reviewers: new Set<string>(),
      facilitators: new Set<string>(),
      contributors: new Set<string>(),
      institutions: new Set<string>(),
      search: "",
      sortField: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortField2: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortDirection2: "desc" as const,
      sortDirection: "desc" as const,
      species: null as string | null,
      tab: null as "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "assessors" | null,
    };

    const qs = buildQs(original);
    const parsed = parseParams(qs);

    expect(parsed.taxa.size).toBe(0);
    expect(parsed.categories.size).toBe(0);
    expect(parsed.search).toBe("");
    expect(parsed.sortField).toBe(null);
    expect(parsed.sortDirection).toBe("desc");
  });

  const baseHabitatDefaultsState = {
    viewMode: "reassessments" as const,
    taxa: new Set<string>(),
    subgroups: new Set<string>(),
    categories: new Set<string>(),
    yearRanges: new Set<string>(),
    assessmentYears: new Set<string>(),
    describedYears: new Set<string>(),
    countries: new Set<string>(),
    obsRanges: new Set<string>(),
    assessmentCounts: new Set<string>(),
    systems: new Set<string>(),
    populationTrends: new Set<string>(),
    movementPatterns: new Set<string>(),
    threats: new Set<string>(),
    criteria: new Set<string>(),
    habitat: new Set<string>(),
    habitatBreadth: null,
    endemicsOnly: false,
    growthForms: new Set<string>(),
    assessors: new Set<string>(),
    reviewers: new Set<string>(),
    facilitators: new Set<string>(),
    contributors: new Set<string>(),
    institutions: new Set<string>(),
    search: "",
    sortField: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortField2: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortDirection2: "desc" as const,
    sortDirection: "desc" as const,
    species: null as string | null,
    tab: null as "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "assessors" | null,
  };

  it("omits habitatImportance/habitatSeasons from the query string when at their default (everything checked)", () => {
    const qs = buildQs({
      ...baseHabitatDefaultsState,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
    });
    expect(qs).not.toContain("habitatImportance");
    expect(qs).not.toContain("habitatSeasons");
  });

  it("round-trips a restricted habitatImportance/habitatSeasons selection", () => {
    const original = {
      ...baseHabitatDefaultsState,
      habitatImportance: new Set(["Major"]),
      habitatSeasons: new Set(["Resident", "Passage"]),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
    };
    const qs = buildQs(original);
    const parsed = parseParams(qs);
    expect(parsed.habitatImportance).toEqual(new Set(["Major"]));
    expect(parsed.habitatSeasons).toEqual(new Set(["Resident", "Passage"]));
  });

  it("round-trips a fully-unchecked habitatImportance/habitatSeasons selection (not the same as default)", () => {
    const original = {
      ...baseHabitatDefaultsState,
      habitatImportance: new Set<string>(),
      habitatSeasons: new Set<string>(),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
    };
    const qs = buildQs(original);
    expect(qs).toContain("habitatImportance=");
    expect(qs).toContain("habitatSeasons=");
    const parsed = parseParams(qs);
    expect(parsed.habitatImportance.size).toBe(0);
    expect(parsed.habitatSeasons.size).toBe(0);
  });

  it("omits habitatSuitability from the query string when at its default (everything checked)", () => {
    const qs = buildQs({
      ...baseHabitatDefaultsState,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
    });
    expect(qs).not.toContain("habitatSuitability");
  });

  it("round-trips a restricted habitatSuitability selection", () => {
    const original = {
      ...baseHabitatDefaultsState,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set(["Suitable"]),
    };
    const qs = buildQs(original);
    const parsed = parseParams(qs);
    expect(parsed.habitatSuitability).toEqual(new Set(["Suitable"]));
  });

  it("round-trips a fully-unchecked habitatSuitability selection (not the same as default)", () => {
    const original = {
      ...baseHabitatDefaultsState,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set<string>(),
    };
    const qs = buildQs(original);
    expect(qs).toContain("habitatSuitability=");
    const parsed = parseParams(qs);
    expect(parsed.habitatSuitability.size).toBe(0);
  });

  it("round-trips subgroups", () => {
    // Fishes' static children (sharks-rays/ray-finned-fishes) were retired for
    // live class-level drilldown (Phase 8) — use the equivalent dynamic ids.
    const original = {
      viewMode: "reassessments" as const,
      taxa: new Set(["fishes"]),
      subgroups: new Set(["fishes~class:chondrichthyes", "fishes~class:actinopterygii"]),
      categories: new Set<string>(),
      yearRanges: new Set<string>(),
      assessmentYears: new Set<string>(),
      describedYears: new Set<string>(),
      countries: new Set<string>(),
      obsRanges: new Set<string>(),
      assessmentCounts: new Set<string>(),
      systems: new Set<string>(),
      populationTrends: new Set<string>(),
      movementPatterns: new Set<string>(),
      threats: new Set<string>(),
      criteria: new Set<string>(),
      habitat: new Set<string>(),
      habitatBreadth: null,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
      endemicsOnly: false,
      growthForms: new Set<string>(),
      assessors: new Set<string>(),
      reviewers: new Set<string>(),
      facilitators: new Set<string>(),
      contributors: new Set<string>(),
      institutions: new Set<string>(),
      search: "",
      sortField: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortField2: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortDirection2: "desc" as const,
      sortDirection: "desc" as const,
      species: null as string | null,
      tab: null as "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "assessors" | null,
    };

    const qs = buildQs(original);
    const parsed = parseParams(qs);
    expect(parsed.subgroups).toEqual(new Set(["fishes~class:chondrichthyes", "fishes~class:actinopterygii"]));
    expect(parsed.taxa).toEqual(new Set(["fishes"]));
  });

  it("round-trips empty subgroups", () => {
    const original = {
      viewMode: "reassessments" as const,
      taxa: new Set<string>(),
      subgroups: new Set<string>(),
      categories: new Set<string>(),
      yearRanges: new Set<string>(),
      assessmentYears: new Set<string>(),
      describedYears: new Set<string>(),
      countries: new Set<string>(),
      obsRanges: new Set<string>(),
      assessmentCounts: new Set<string>(),
      systems: new Set<string>(),
      populationTrends: new Set<string>(),
      movementPatterns: new Set<string>(),
      threats: new Set<string>(),
      criteria: new Set<string>(),
      habitat: new Set<string>(),
      habitatBreadth: null,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
      endemicsOnly: false,
      growthForms: new Set<string>(),
      assessors: new Set<string>(),
      reviewers: new Set<string>(),
      facilitators: new Set<string>(),
      contributors: new Set<string>(),
      institutions: new Set<string>(),
      search: "",
      sortField: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortField2: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | null,
    sortDirection2: "desc" as const,
      sortDirection: "desc" as const,
      species: null as string | null,
      tab: null as "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "assessors" | null,
    };

    const qs = buildQs(original);
    const parsed = parseParams(qs);
    expect(parsed.subgroups.size).toBe(0);
  });

  it("round-trips sort=newGbif", () => {
    const original = {
      viewMode: "reassessments" as const,
      taxa: new Set<string>(),
      subgroups: new Set<string>(),
      categories: new Set<string>(),
      yearRanges: new Set<string>(),
      assessmentYears: new Set<string>(),
      describedYears: new Set<string>(),
      countries: new Set<string>(),
      obsRanges: new Set<string>(),
      assessmentCounts: new Set<string>(),
      systems: new Set<string>(),
      populationTrends: new Set<string>(),
      movementPatterns: new Set<string>(),
      threats: new Set<string>(),
      criteria: new Set<string>(),
      habitat: new Set<string>(),
      habitatBreadth: null,
      habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
      habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
      habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
      endemicsOnly: false,
      growthForms: new Set<string>(),
      assessors: new Set<string>(),
      reviewers: new Set<string>(),
      facilitators: new Set<string>(),
      contributors: new Set<string>(),
      institutions: new Set<string>(),
      search: "",
      sortField: "newGbif" as const,
      sortDirection: "desc" as const,
      sortField2: null,
      sortDirection2: "desc" as const,
      species: null as string | null,
      tab: null as "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "assessors" | null,
    };

    const qs = buildQs(original);
    const parsed = parseParams(qs);
    expect(parsed.sortField).toBe("newGbif");
  });
});

describe("param suffixing (compare mode)", () => {
  const emptyState = {
    viewMode: "reassessments" as const,
    taxa: new Set<string>(),
    categories: new Set<string>(),
    yearRanges: new Set<string>(),
    assessmentYears: new Set<string>(),
    describedYears: new Set<string>(),
    countries: new Set<string>(),
    obsRanges: new Set<string>(),
    assessmentCounts: new Set<string>(),
    systems: new Set<string>(),
    populationTrends: new Set<string>(),
    movementPatterns: new Set<string>(),
    threats: new Set<string>(),
    criteria: new Set<string>(),
    habitat: new Set<string>(),
    habitatBreadth: null,
    habitatImportance: new Set<string>(ALL_HABITAT_IMPORTANCE),
    habitatSeasons: new Set<string>(ALL_HABITAT_SEASONS),
    habitatSuitability: new Set<string>(ALL_HABITAT_SUITABILITY),
    endemicsOnly: false,
    growthForms: new Set<string>(),
    assessors: new Set<string>(),
    reviewers: new Set<string>(),
    facilitators: new Set<string>(),
    contributors: new Set<string>(),
    institutions: new Set<string>(),
    search: "",
    subgroups: new Set<string>(),
    sortField: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | "describedYear" | null,
    sortDirection: "desc" as const,
    sortField2: null as "year" | "category" | "totalGbif" | "newGbif" | "pctNewGbif" | "describedYear" | null,
    sortDirection2: "desc" as const,
    species: null as string | null,
    tab: null as "gbif" | "literature" | "redlist" | "wikipedia" | "cites" | "assessors" | "reviewers" | "col" | "eol" | null,
  };

  describe("parseParams with a suffix", () => {
    it("reads the suffixed key, not the bare one", () => {
      const result = parseParams("?taxa_b=reptiles", "_b");
      expect(result.taxa).toEqual(new Set(["reptiles"]));
    });

    it("ignores the bare key when a suffix is given", () => {
      const result = parseParams("?taxa=birds", "_b");
      expect(result.taxa.size).toBe(0);
    });

    it("each suffix only sees its own slice of a combined query string", () => {
      const search = "?taxa=birds&taxa_b=reptiles";
      expect(parseParams(search, "").taxa).toEqual(new Set(["birds"]));
      expect(parseParams(search, "_b").taxa).toEqual(new Set(["reptiles"]));
    });

    it("suffixes categories, search, and sort too, not just taxa", () => {
      const result = parseParams("?categories_b=CR,EN&search_b=shrew&sort_b=category&dir_b=asc", "_b");
      expect(result.categories).toEqual(new Set(["CR", "EN"]));
      expect(result.search).toBe("shrew");
      expect(result.sortField).toBe("category");
      expect(result.sortDirection).toBe("asc");
    });
  });

  describe("buildQs with a suffix", () => {
    it("writes the suffixed key", () => {
      const qs = buildQs({ ...emptyState, taxa: new Set(["reptiles"]) }, "_b");
      expect(qs).toBe("?taxa_b=reptiles");
    });

    it("round-trips through parseParams with the same suffix", () => {
      const qs = buildQs({ ...emptyState, taxa: new Set(["reptiles"]), categories: new Set(["CR"]) }, "_b");
      const parsed = parseParams(qs, "_b");
      expect(parsed.taxa).toEqual(new Set(["reptiles"]));
      expect(parsed.categories).toEqual(new Set(["CR"]));
    });

    it("defaults to no suffix, matching pre-compare-mode behavior", () => {
      const qs = buildQs({ ...emptyState, taxa: new Set(["birds"]) });
      expect(qs).toBe("?taxa=birds");
    });
  });

  describe("mergeParamsIntoSearch", () => {
    it("adds this panel's params without touching an existing different-suffix panel's params", () => {
      const currentSearch = "?taxa_b=reptiles&categories_b=CR";
      const qs = mergeParamsIntoSearch(currentSearch, { ...emptyState, taxa: new Set(["birds"]) }, "");
      const params = new URLSearchParams(qs);
      expect(params.get("taxa")).toBe("birds");
      expect(params.get("taxa_b")).toBe("reptiles");
      expect(params.get("categories_b")).toBe("CR");
    });

    it("replaces this panel's own previous value rather than accumulating it", () => {
      const qs = mergeParamsIntoSearch("?taxa=birds", { ...emptyState, taxa: new Set(["mammals"]) }, "");
      const params = new URLSearchParams(qs);
      expect(params.getAll("taxa")).toEqual(["mammals"]);
    });

    it("preserves query params outside this hook's own vocabulary (e.g. utm tracking)", () => {
      const currentSearch = "?taxa_b=reptiles&utm_source=newsletter";
      const qs = mergeParamsIntoSearch(currentSearch, { ...emptyState, taxa: new Set(["birds"]) }, "");
      const params = new URLSearchParams(qs);
      expect(params.get("utm_source")).toBe("newsletter");
    });

    it("clears this panel's own params (e.g. returning to the landing page) without touching the other panel's", () => {
      const currentSearch = "?taxa=birds&taxa_b=reptiles";
      const qs = mergeParamsIntoSearch(currentSearch, { ...emptyState, taxa: new Set() }, "");
      const params = new URLSearchParams(qs);
      expect(params.has("taxa")).toBe(false);
      expect(params.get("taxa_b")).toBe("reptiles");
    });

    it("with no existing foreign params, matches buildQs's own output exactly (backward compatible)", () => {
      const state = { ...emptyState, taxa: new Set(["birds"]), categories: new Set(["CR", "EN"]) };
      expect(mergeParamsIntoSearch("", state, "")).toBe(buildQs(state));
    });
  });
});

describe("OWN_PARAM_NAMES stays in sync with buildQs", () => {
  it("every key buildQs can write is in OWN_PARAM_NAMES", () => {
    // mergeParamsIntoSearch/syncUrl only ever delete this instance's OWN_PARAM_NAMES
    // keys before re-setting from buildQs's output — if a param were ever added to
    // buildQs without adding it here too, its stale value would survive every
    // future write instead of being replaced, and (worse) it'd never get a suffix,
    // so it would leak across compare-mode panels. This "kitchen sink" state
    // populates every field with a non-default value so buildQs emits every key it
    // knows how to write, then asserts each one is accounted for.
    const kitchenSink = {
      viewMode: "new-assessments" as const,
      layoutMode: "table1a" as const,
      originLayout: "ssc" as const,
      taxa: new Set(["mammals"]),
      subgroups: new Set<string>(),
      categories: new Set(["CR"]),
      yearRanges: new Set(["<1 year"]),
      assessmentYears: new Set(["2023"]),
      describedYears: new Set(["2000-2009"]),
      countries: new Set(["ZA"]),
      obsRanges: new Set(["1-10"]),
      assessmentCounts: new Set(["2"]),
      systems: new Set(["Terrestrial"]),
      populationTrends: new Set(["Decreasing"]),
      movementPatterns: new Set(["Migratory"]),
      threats: new Set(["Agriculture"]),
      threatsScope: "all" as const,
      criteria: new Set(["B1"]),
      habitat: new Set(["5.1"]),
      habitatBreadth: "specialist" as const,
      habitatImportance: new Set(["Major"]),
      habitatSeasons: new Set(["Resident"]),
      habitatSuitability: new Set(["Suitable"]),
      breakdown: { nodeId: "n1", rank: "order" as const, name: "Test" },
      endemicsOnly: true,
      growthForms: new Set(["Tree"]),
      assessors: new Set(["Someone"]),
      reviewers: new Set(["Someone Else"]),
      facilitators: new Set<string>(),
      contributors: new Set<string>(),
      institutions: new Set<string>(),
      search: "shrew",
      outdated: "yes" as const,
      minObs: 1,
      maxObs: 9,
      minAssessmentYear: 2000,
      maxAssessmentYear: 2020,
      minDescribedYear: 1990,
      maxDescribedYear: 2010,
      sortField: "category" as const,
      sortDirection: "asc" as const,
      sortField2: "newGbif" as const,
      sortDirection2: "desc" as const,
      mapViewMode: "list" as const,
      mapSortKey: "outdated" as const,
      mapSortDirection: "asc" as const,
      species: "sis-12345",
      tab: "literature" as const,
    };

    const qs = buildQs(kitchenSink, "_test");
    const writtenKeys = [...new URLSearchParams(qs).keys()].map((k) => k.replace(/_test$/, ""));
    // Sanity check the fixture itself is actually exercising things, so this test
    // can't silently pass by writing nothing.
    expect(writtenKeys.length).toBeGreaterThan(20);

    const ownNames = new Set(OWN_PARAM_NAMES);
    const missing = writtenKeys.filter((k) => !ownNames.has(k));
    expect(missing).toEqual([]);
  });
});

describe("query-string readability (prettifyQs)", () => {
  // Base off parseParams("") rather than a hand-written literal: it returns a
  // complete default state by construction, so a field added to buildQs later
  // can't make these tests fail for an unrelated reason.
  const stateWith = (over: Record<string, unknown>) =>
    buildQs({ ...parseParams(""), ...over } as unknown as Parameters<typeof buildQs>[0]);

  // URLSearchParams form-encodes ~ : and , even though RFC 3986 allows them bare in
  // a query. Leaving them encoded is most of why a drilled-in URL reads badly.
  it("writes ~ : and , bare rather than percent-encoded", () => {
    const qs = stateWith({
      subgroups: new Set(["pl-flowering_plants~order:dioscoreales~family:dioscoreaceae"]),
      countries: new Set(["BR", "PE"]),
    });
    expect(qs).toContain("taxa=flowering_plants~dioscoreales~dioscoreaceae");
    expect(qs).toContain("countries=BR,PE");
    expect(qs).not.toContain("%7E");
    expect(qs).not.toContain("%3A");
    expect(qs).not.toContain("%2C");
  });

  // The whole point is that this is cosmetic — every value must survive unchanged.
  it.each([
    "a+b",            // literal plus: decoding %2B would silently become a space
    "a&b=c",          // delimiters must stay encoded
    "Müller's shrew", // multi-byte UTF-8: per-escape decodeURIComponent would throw
    "50–60 years",
    "100%",
    "a,b:c~d",
  ])("round-trips the search value %j unchanged", (value) => {
    const qs = stateWith({ search: value });
    expect(new URLSearchParams(qs).get("search")).toBe(value);
  });

  it("is left alone by the browser's own URL parser", () => {
    const qs = stateWith({
      subgroups: new Set(["mammals~order:rodentia~family:muridae"]),
      countries: new Set(["BR", "PE"]),
    });
    expect(new URL(`https://x.test/${qs}`).search).toBe(qs);
  });
});

describe("view mode inferred from the species key", () => {
  // A col- key is a Not Evaluated species by construction (assessed rows always key
  // on sis-), so a link carrying one but no `view` can only have meant the NE list.
  it("infers new-assessments from a col- species key when view is absent", () => {
    expect(parseParams("?species=col-35VNR").viewMode).toBe("new-assessments");
  });

  it("leaves a sis- key in the assessed view", () => {
    expect(parseParams("?species=sis-15951").viewMode).toBe("reassessments");
  });

  it("still defaults to reassessments with no species at all", () => {
    expect(parseParams("?taxa=mammals").viewMode).toBe("reassessments");
  });

  // `view` is the list's own mode and stays authoritative — it has to work with no
  // species selected at all, which is the common case.
  it("lets an explicit view win over the inference", () => {
    expect(parseParams("?species=col-35VNR&view=reassessments").viewMode).toBe("reassessments");
    expect(parseParams("?view=new-assessments").viewMode).toBe("new-assessments");
  });

  it("does not infer from a legacy bare-number species param", () => {
    expect(parseParams("?species=15951").viewMode).toBe("reassessments");
  });
});

describe("bd= breakdown param", () => {
  const bd = (v: string) => parseParams(`?bd=${encodeURIComponent(v)}`).breakdown;

  it("parses a static node id", () => {
    expect(bd("ssc-small-mammal:order:rodentia")).toEqual({
      nodeId: "ssc-small-mammal", rank: "order", name: "rodentia",
    });
  });

  // A live-drilldown node id contains the delimiter, so splitting left-to-right made
  // nodeId="mammals~order" and rank="rodentia" — not a rank, so the whole param was
  // rejected and the breakdown narrowing silently vanished, showing the full node
  // list instead of the one row that was clicked.
  it.each([
    ["mammals~order:rodentia:family:Muridae", "mammals~order:rodentia", "family", "Muridae"],
    ["inv-molluscs~class:gastropoda~order:stylommatophora:family:Helicidae",
     "inv-molluscs~class:gastropoda~order:stylommatophora", "family", "Helicidae"],
  ])("parses a dynamic node id whose own id contains colons: %s", (raw, nodeId, rank, name) => {
    expect(bd(raw)).toEqual({ nodeId, rank, name });
  });

  it.each([
    ["ssc-small-mammal:order:rodentia:only:1,2,3", { nodeId: "ssc-small-mammal", rank: "order", name: "rodentia", onlyIds: [1, 2, 3] }],
    ["mammals~order:rodentia:family:Muridae:excl:4,5", { nodeId: "mammals~order:rodentia", rank: "family", name: "Muridae", excludeIds: [4, 5] }],
  ])("keeps the only/excl id-list suffix: %s", (raw, expected) => {
    expect(bd(raw)).toEqual(expected);
  });

  it.each([
    "mammals~order:rodentia:notarank:Muridae",
    "justonefield",
    "nodeid:order",
  ])("rejects a malformed value rather than half-applying it: %s", (raw) => {
    expect(bd(raw)).toBeNull();
  });

  // The three-field form must not mistake its own rank for an only/excl mode.
  it("does not treat a 3-field value's rank as a mode", () => {
    expect(bd("ssc-small-mammal:order:only")).toEqual({
      nodeId: "ssc-small-mammal", rank: "order", name: "only",
    });
  });

  it.each([
    { nodeId: "ssc-small-mammal", rank: "order" as const, name: "rodentia" },
    { nodeId: "mammals~order:rodentia", rank: "family" as const, name: "Muridae" },
    { nodeId: "mammals~order:rodentia", rank: "family" as const, name: "Muridae", onlyIds: [7, 8] },
  ])("round-trips through buildQs: %j", (breakdown) => {
    const qs = buildQs({ ...parseParams(""), breakdown } as unknown as Parameters<typeof buildQs>[0]);
    expect(parseParams(qs).breakdown).toEqual(breakdown);
  });
});

// A taxa / sub-group navigation is a fresh browse: everything scoped to the
// species you were previously looking at goes with it, in the same atomic state
// update. Before this, clicking another taxa row from a species search kept
// `species=`/`search=` in the URL, so the new taxon's table came up narrowed to
// (and expanded on) a species that isn't even in it.
describe("SPECIES_SCOPED_RESET", () => {
  // The header search bar's own URL push: one species, its detail panel open,
  // the taxon it sits in selected, and its name left in `search=`.
  const searched = "?taxa=mammals~family:Felidae&search=Panthera+leo&species=sis-15951&tab=redlist";

  it("names exactly the species-scoped fields", () => {
    expect(Object.keys(SPECIES_SCOPED_RESET).sort()).toEqual(["breakdown", "search", "species", "tab"]);
  });

  it("drops species, tab, search and bd= from a searched-species URL", () => {
    const next = { ...parseParams(searched), taxa: new Set(["birds"]), subgroups: new Set<string>(), ...SPECIES_SCOPED_RESET };
    const params = new URLSearchParams(buildQs(next as unknown as Parameters<typeof buildQs>[0]));
    expect(params.get("species")).toBeNull();
    expect(params.get("tab")).toBeNull();
    expect(params.get("search")).toBeNull();
    expect(params.get("bd")).toBeNull();
    expect(params.get("taxa")).toBe("birds");
  });

  it("removes those params from the live URL, not just from the new state", () => {
    const next = { ...parseParams(searched), taxa: new Set(["birds"]), subgroups: new Set<string>(), ...SPECIES_SCOPED_RESET };
    const qs = mergeParamsIntoSearch(searched, next as unknown as Parameters<typeof buildQs>[0], "");
    expect(qs).not.toContain("species=");
    expect(qs).not.toContain("search=");
    expect(qs).not.toContain("tab=");
  });

  it("leaves the rest of the filter state alone", () => {
    const withFilters = parseParams(searched + "&categories=CR,EN&sort=totalGbif");
    const next = { ...withFilters, taxa: new Set(["birds"]), subgroups: new Set<string>(), ...SPECIES_SCOPED_RESET };
    const parsed = parseParams(buildQs(next as unknown as Parameters<typeof buildQs>[0]));
    expect(parsed.categories).toEqual(new Set(["CR", "EN"]));
    expect(parsed.sortField).toBe("totalGbif");
  });

  it("clears the species drill-down on its own, keeping the taxon and sub-group", () => {
    // What clearSpeciesDrilldown does — re-clicking the group you're already in.
    const next = { ...parseParams(searched), ...SPECIES_SCOPED_RESET };
    const parsed = parseParams(buildQs(next as unknown as Parameters<typeof buildQs>[0]));
    expect(parsed.species).toBeNull();
    expect(parsed.search).toBe("");
    expect(parsed.taxa).toEqual(new Set(["mammals"]));
    expect(parsed.subgroups).toEqual(new Set(["mammals~family:Felidae"]));
  });

  it("leaves the landing page's own empty state at the landing page", () => {
    // "All Species" from a drill-down: taxa cleared AND the species drill-down
    // with it, so the URL is bare — exactly what a fresh visit produces.
    const next = { ...parseParams(searched), taxa: new Set<string>(), subgroups: new Set<string>(), ...SPECIES_SCOPED_RESET };
    expect(buildQs(next as unknown as Parameters<typeof buildQs>[0])).toBe("");
  });
});
