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

  it("defaults to all records; georeferenced only when asked", () => {
    expect(parseGbifRecordMode("georeferenced")).toBe("georeferenced");
    expect(parseGbifRecordMode(null)).toBe("all");
    expect(parseGbifRecordMode("all")).toBe("all");
    expect(parseGbifRecordMode("bogus")).toBe("all");
  });

  it("asks GBIF for coordinates only when georeferenced", () => {
    const geo = applyGbifRecordMode(new URLSearchParams(), "georeferenced");
    expect(geo.get("hasCoordinate")).toBe("true");
    expect(geo.get("hasGeospatialIssue")).toBe("false");
    expect(geo.has("basisOfRecord")).toBe(false);
    expect(applyGbifRecordMode(new URLSearchParams(), "all").toString()).toBe("");
    expect(gbifOccurrenceParams({}, { mode: "georeferenced" }).get("hasCoordinate")).toBe("true");
    expect(gbifOccurrenceParams().has("hasCoordinate")).toBe(false);
  });

  it("starts the since window the day after the assessment", () => {
    expect(sinceAssessmentStart("2025-04-15")).toBe("2025-04-16");
    expect(sinceAssessmentStart("2024-12-31")).toBe("2025-01-01");
    expect(sinceAssessmentStart("2024-02-28")).toBe("2024-02-29");
    expect(sinceAssessmentStart(null)).toBeNull();
    expect(sinceAssessmentStart("2025")).toBeNull();
  });
});

import { emptyGbifRanges, gbifBucket, gbifMetricValue, matchesGbifRanges, parseGbifChartKey } from "../gbif-records";

describe("GBIF Records chart filters", () => {
  // 20,000 records in all, 5,000 georeferenced; 500 and 50 of them new.
  const sp = {
    gbif_all_records_count: 20000, gbif_georeferenced_records_count: 5000,
    gbif_all_records_since_assessment: 500, gbif_georeferenced_records_since_assessment: 50,
  };

  it("reads each metric in each mode", () => {
    expect(gbifMetricValue(sp, "total.all")).toBe(20000);
    expect(gbifMetricValue(sp, "new.georeferenced")).toBe(50);
    expect(gbifMetricValue(sp, "pctNew.all")).toBe(2.5);
    expect(gbifMetricValue({ gbif_all_records_count: 0, gbif_all_records_since_assessment: 0 }, "pctNew.all")).toBeNull();
    expect(gbifMetricValue({ gbif_all_records_count: 3 }, "new.all")).toBeNull(); // no window
  });

  it("buckets counts and percentages", () => {
    expect(gbifBucket(0, "total")).toBe("0");
    expect(gbifBucket(10001, "new")).toBe("10K+");
    expect(gbifBucket(0, "pctNew")).toBe("0%");
    expect(gbifBucket(2.5, "pctNew")).toBe("<10%");
    expect(gbifBucket(50, "pctNew")).toBe("50%+");
    expect(gbifBucket(null, "total")).toBeNull();
  });

  it("combines selections across metrics and modes, like assessors and reviewers", () => {
    const r = emptyGbifRanges();
    r["total.all"] = new Set(["10K+"]);
    r["total.georeferenced"] = new Set(["1K-10K"]);
    expect(matchesGbifRanges(sp, r)).toBe(true);
    r["pctNew.georeferenced"] = new Set(["10-25%"]); // it is 1%
    expect(matchesGbifRanges(sp, r)).toBe(false);
    // The chart skips its own key, so its bars still show the alternatives.
    expect(matchesGbifRanges(sp, r, "pctNew.georeferenced")).toBe(true);
  });

  it("defaults the chart to all records' Total", () => {
    expect(parseGbifChartKey(null)).toBe("total.all");
    expect(parseGbifChartKey("pctNew.georeferenced")).toBe("pctNew.georeferenced");
    expect(parseGbifChartKey("bogus")).toBe("total.all");
  });
});
