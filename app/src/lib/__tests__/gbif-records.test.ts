import { describe, it, expect } from "vitest";
import {
  gbifRecordCount, gbifRecordsSinceAssessment, applyGbifRecordMode, parseGbifRecordMode, sinceAssessmentStart,
} from "../gbif-records";
import { gbifOccurrenceParams } from "../gbif";

const s = {
  gbif_georeferenced_records_count: 73, gbif_all_records_count: 76,
  gbif_georeferenced_records_since_assessment: 14, gbif_all_records_since_assessment: null,
};

describe("gbif record modes", () => {
  it("reads the count for the mode", () => {
    expect(gbifRecordCount(s, "georeferenced")).toBe(73);
    expect(gbifRecordCount(s, "all")).toBe(76);
    expect(gbifRecordsSinceAssessment(s, "georeferenced")).toBe(14);
    expect(gbifRecordsSinceAssessment(s, "all")).toBeNull();
    expect(gbifRecordCount({}, "all")).toBeNull();
  });

  it("parses anything but 'all' as the default", () => {
    expect(parseGbifRecordMode("all")).toBe("all");
    expect(parseGbifRecordMode(null)).toBe("georeferenced");
    expect(parseGbifRecordMode("ALL")).toBe("georeferenced");
  });

  it("asks GBIF for coordinates and record types only when georeferenced", () => {
    const geo = applyGbifRecordMode(new URLSearchParams(), "georeferenced");
    expect(geo.get("hasCoordinate")).toBe("true");
    expect(geo.get("hasGeospatialIssue")).toBe("false");
    expect(geo.getAll("basisOfRecord")).toHaveLength(6);
    expect(applyGbifRecordMode(new URLSearchParams(), "all").toString()).toBe("");
    expect(gbifOccurrenceParams().get("hasCoordinate")).toBe("true");
  });

  it("starts the since window the day after the assessment", () => {
    expect(sinceAssessmentStart("2025-04-15")).toBe("2025-04-16");
    expect(sinceAssessmentStart("2024-12-31")).toBe("2025-01-01");
    expect(sinceAssessmentStart("2024-02-28")).toBe("2024-02-29");
    expect(sinceAssessmentStart(null)).toBeNull();
    expect(sinceAssessmentStart("2025")).toBeNull();
  });
});
