/**
 * The all-records count is the georeferenced query with its coordinate filters
 * taken off, and nothing else changed. A query that kept hasCoordinate would
 * quietly return the georeferenced count under the all-records label; one that
 * also lost the record types or the checklist would count a different universe.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchFacets } from "../fetch-gbif-species";

function captureQuery(): { params: () => URLSearchParams } {
  let url = "";
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    url = u;
    return new Response(JSON.stringify({
      facets: [{ field: "SPECIES_KEY", counts: [{ name: "ABC", count: 7 }] }],
    }));
  }));
  return { params: () => new URL(url).searchParams };
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchFacets", () => {
  it("filters to trusted coordinates by default", async () => {
    const q = captureQuery();
    expect(await fetchFacets("ROOT")).toEqual([{ speciesKey: "ABC", count: 7 }]);
    expect(q.params().get("hasCoordinate")).toBe("true");
    expect(q.params().get("hasGeospatialIssue")).toBe("false");
  });

  it("drops only the coordinate filters for the all-records count", async () => {
    const q = captureQuery();
    await fetchFacets("ROOT", { georeferencedOnly: false, includePreservedSpecimens: true, yearRange: "2010,2026" });
    const p = q.params();
    expect(p.has("hasCoordinate")).toBe(false);
    expect(p.has("hasGeospatialIssue")).toBe(false);
    expect(p.get("taxonKey")).toBe("ROOT");
    expect(p.get("checklistKey")).toBeTruthy();
    expect(p.get("year")).toBe("2010,2026");
    expect(p.getAll("basisOfRecord")).toContain("PRESERVED_SPECIMEN");
  });
});
