import { describe, expect, it } from "vitest";
import { literatureSearchUrl, literatureWorks, literatureWorksSinceAssessment, parseLiteratureSource } from "../literature";

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
