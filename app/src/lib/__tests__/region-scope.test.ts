import { describe, expect, it } from "vitest";
import { parseRegion, withRegion } from "../region-scope";
import { parseParams } from "@/hooks/useFilterParams";

describe("region scope", () => {
  it("accepts IUCN's scope names and rejects anything else", () => {
    expect(parseRegion("Europe")).toBe("Europe");
    expect(parseRegion("S. Africa FW")).toBe("S. Africa FW");
    expect(parseRegion("Pan-Africa")).toBe("Pan-Africa");
    expect(parseRegion("")).toBeNull();
    expect(parseRegion(null)).toBeNull();
    expect(parseRegion("Europe'; DROP TABLE x")).toBeNull();
  });

  it("adds the scope to a URL only when there is one", () => {
    expect(withRegion("/api/redlist/species?taxon=birds", "S. Africa FW")).toBe("/api/redlist/species?taxon=birds&scope=S.%20Africa%20FW");
    expect(withRegion("/api/redlist/country-stats", "Europe")).toBe("/api/redlist/country-stats?scope=Europe");
    expect(withRegion("/api/redlist/country-stats", null)).toBe("/api/redlist/country-stats");
  });

  it("is read from the dashboard URL, separately from the countries' region= picker", () => {
    expect(parseParams("?scope=Europe").assessmentScope).toBe("Europe");
    expect(parseParams("?taxa=birds").assessmentScope).toBeNull();
  });
});
