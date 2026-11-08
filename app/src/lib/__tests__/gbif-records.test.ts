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

import { emptyGbifRanges, gbifBucket, gbifMetricValue, gbifRangeMatches, matchesGbifRanges, parseGbifChartKey } from "../gbif-records";

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

  it("matches the triage scatter's even bins as well as the chart's buckets", () => {
    // Powers of ten, inclusive.
    expect(gbifRangeMatches("10-99", 10, "total")).toBe(true);
    expect(gbifRangeMatches("10-99", 99, "total")).toBe(true);
    expect(gbifRangeMatches("10-99", 100, "total")).toBe(false);
    expect(gbifRangeMatches("1000-9999", 5000, "new")).toBe(true);
    // 10% bins: the lower bound in, the upper out, except 100%.
    expect(gbifRangeMatches("20-30%", 20, "pctNew")).toBe(true);
    expect(gbifRangeMatches("20-30%", 30, "pctNew")).toBe(false);
    expect(gbifRangeMatches("90-100%", 100, "pctNew")).toBe(true);
    // A count range never matches a percentage, nor the other way round.
    expect(gbifRangeMatches("20-30", 25, "pctNew")).toBe(false);
    expect(gbifRangeMatches("20-30%", 25, "total")).toBe(false);
    // The chart's own buckets, as before (old links).
    expect(gbifRangeMatches("101-1K", 1000, "total")).toBe(true);
    expect(gbifRangeMatches("1K-10K", 1000, "total")).toBe(false);
    expect(gbifRangeMatches("0%", 0, "pctNew")).toBe(true);
    const r = emptyGbifRanges();
    r["new.all"] = new Set(["100-999"]);
    expect(matchesGbifRanges(sp, r)).toBe(true); // 500 new
    r["new.all"] = new Set(["1000-9999", "11-100"]);
    expect(matchesGbifRanges(sp, r)).toBe(false);
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
