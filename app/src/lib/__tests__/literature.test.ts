import { describe, expect, it } from "vitest";
import { literatureLinkHref, literatureSearchUrl, literatureWorks, literatureWorksSinceAssessment, openAlexWorksUrl, parseLiteratureSource } from "../literature";

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

describe("links to the works counted", () => {
  it("filters OpenAlex to the works' ids, at most 100", () => {
    expect(decodeURIComponent(openAlexWorksUrl([123n, 456]))).toBe("https://openalex.org/works?filter=openalex:W123|W456");
    const many = Array.from({ length: 150 }, (_, i) => i + 1);
    expect(decodeURIComponent(openAlexWorksUrl(many)).split("|")).toHaveLength(100);
  });

  it("points at the app's route by sis id, else col id, with the name to fall back on and since for New", () => {
    expect(literatureLinkHref({ sis_taxon_id: 42, col_id: null, scientific_name: "Panthera leo" }))
      .toBe("/api/literature-link?sis=42&name=Panthera+leo");
    expect(literatureLinkHref({ sis_taxon_id: null, col_id: "ABC12", scientific_name: "Eumops chiribaya" }, "2020-01-02"))
      .toBe("/api/literature-link?col=ABC12&name=Eumops+chiribaya&since=2020-01-02");
    expect(literatureLinkHref({ sis_taxon_id: null, col_id: null, scientific_name: "X y" })).toBeNull();
  });
});
