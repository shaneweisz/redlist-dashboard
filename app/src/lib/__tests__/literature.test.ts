import { describe, expect, it } from "vitest";
import {
  emptyLiteratureRanges,
  hasLiteratureRanges,
  literatureBucket,
  literatureMetricValue,
  literatureSearchUrl,
  literatureWorks,
  literatureWorksSinceAssessment,
  matchesLiteratureRanges,
  parseLiteratureChartKey,
  parseLiteratureSource,
} from "../literature";

const species = { openalex_works: 42, openalex_works_since_assessment: 7, bhl_works: 0, bhl_works_since_assessment: null };

describe("literature source", () => {
  it("defaults to OpenAlex for anything but bhl", () => {
    expect(parseLiteratureSource(null)).toBe("openalex");
    expect(parseLiteratureSource("nonsense")).toBe("openalex");
    expect(parseLiteratureSource("bhl")).toBe("bhl");
  });

  it("reads each source's counts", () => {
    expect(literatureWorks(species, "openalex")).toBe(42);
    expect(literatureWorks(species, "bhl")).toBe(0);
    expect(literatureWorksSinceAssessment(species, "openalex")).toBe(7);
    expect(literatureWorksSinceAssessment(species, "bhl")).toBeNull();
  });
});

describe("literature search links", () => {
  it("searches OpenAlex titles and abstracts for the counted types, from a date for New", () => {
    const total = decodeURIComponent(literatureSearchUrl("openalex", "Panthera leo")!);
    expect(total).toContain('title_and_abstract.search:"Panthera leo"');
    expect(total).toContain("type:article|review|");
    expect(total).toContain("is_retracted:false");
    expect(total).not.toContain("from_publication_date");
    expect(decodeURIComponent(literatureSearchUrl("openalex", "Panthera leo", "2016-09-12")!)).toContain("from_publication_date:2016-09-12");
  });

  it("links BHL's page for the name, and nothing for New (BHL can't filter by date)", () => {
    expect(literatureSearchUrl("bhl", "Panthera leo")).toBe("https://www.biodiversitylibrary.org/name/Panthera_leo");
    expect(literatureSearchUrl("bhl", "Panthera leo", "2016-09-12")).toBeNull();
    expect(literatureSearchUrl("openalex", "  ")).toBeNull();
  });
});

describe("literature chart filters", () => {
  it("buckets counts, and gives no bucket to no value", () => {
    expect([0, 1, 5, 6, 20, 21, 100, 101, 1000, 1001].map(literatureBucket))
      .toEqual(["0", "1-5", "1-5", "6-20", "6-20", "21-100", "21-100", "101-1K", "101-1K", "1K+"]);
    expect(literatureBucket(null)).toBeNull();
  });

  it("values a species per key: Total counts a missing count as 0, New has none without a window", () => {
    expect(literatureMetricValue(species, "total.openalex")).toBe(42);
    expect(literatureMetricValue({}, "total.bhl")).toBe(0);
    expect(literatureMetricValue(species, "new.bhl")).toBeNull();
  });

  it("requires every selection to hold, except the chart's own", () => {
    const ranges = emptyLiteratureRanges();
    expect(hasLiteratureRanges(ranges)).toBe(false);
    expect(matchesLiteratureRanges(species, ranges)).toBe(true);
    ranges["total.openalex"] = new Set(["21-100"]);
    ranges["total.bhl"] = new Set(["0"]);
    expect(hasLiteratureRanges(ranges)).toBe(true);
    expect(matchesLiteratureRanges(species, ranges)).toBe(true);
    ranges["new.openalex"] = new Set(["0"]);
    expect(matchesLiteratureRanges(species, ranges)).toBe(false);
    expect(matchesLiteratureRanges(species, ranges, "new.openalex")).toBe(true);
    // No window, so no New bucket: a New selection excludes it.
    ranges["new.bhl"] = new Set(["0"]);
    expect(matchesLiteratureRanges(species, ranges, "new.openalex")).toBe(false);
  });

  it("parses the chart key, falling back to OpenAlex Total", () => {
    expect(parseLiteratureChartKey("new.bhl")).toBe("new.bhl");
    expect(parseLiteratureChartKey("bogus")).toBe("total.openalex");
  });
});
