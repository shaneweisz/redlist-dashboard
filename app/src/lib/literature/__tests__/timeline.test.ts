import { describe, it, expect } from "vitest";
import {
  assessmentSortStamp,
  countAroundAssessment,
  findMarkerPosition,
  paginate,
} from "../timeline";
import { toSortStamp } from "../normalize";
import type { LiteratureWork } from "../types";

/** Minimal work stub — only the fields the timeline layer reads. */
function work(title: string, date: string | null): LiteratureWork {
  const precision = date ? (date.length === 4 ? "year" : "day") : null;
  return {
    key: `k:${title}`,
    title,
    url: "https://example.org",
    doi: null,
    date,
    datePrecision: precision,
    year: date ? Number(date.slice(0, 4)) : null,
    sortStamp: toSortStamp(date, precision),
    authors: null,
    venue: null,
    citations: null,
    type: "article",
    openAccessUrl: null,
    abstract: null,
    sources: [{ id: "openalex", label: "OpenAlex", url: null }],
  };
}

/** Newest first, as the merge layer hands them over. */
const POOL = [
  work("2024 paper", "2024-06-01"),
  work("2023 paper", "2023-06-01"),
  work("2022 paper", "2022-06-01"),
  work("2019 paper", "2019-06-01"),
  work("2011 paper", "2011-06-01"),
];

describe("assessmentSortStamp", () => {
  it("uses the exact day when the assessment date is known", () => {
    expect(assessmentSortStamp("2021-03-14")).toBe("2021-03-14");
  });

  it("places a bare year mid-year, matching imprecise publication dates", () => {
    expect(assessmentSortStamp("2021")).toBe("2021-07-01");
    expect(assessmentSortStamp(2021)).toBe("2021-07-01");
    expect(assessmentSortStamp("2021-03")).toBe("2021-03-15");
  });

  it("returns null when there is nothing to mark", () => {
    // Not Evaluated species reach the component with no assessment at all;
    // 0 is the sentinel the old component used for "all time".
    expect(assessmentSortStamp(null)).toBeNull();
    expect(assessmentSortStamp(undefined)).toBeNull();
    expect(assessmentSortStamp("")).toBeNull();
    expect(assessmentSortStamp(0)).toBeNull();
    expect(assessmentSortStamp("not a date")).toBeNull();
  });
});

describe("findMarkerPosition", () => {
  it("points at the first work published before the assessment", () => {
    expect(findMarkerPosition(POOL, assessmentSortStamp("2021-03-14"))).toBe(3);
  });

  it("puts the marker at the top when every work postdates the assessment", () => {
    expect(findMarkerPosition(POOL, assessmentSortStamp("2005-01-01"))).toBe(5);
  });

  it("puts the marker at the very start when every work predates it", () => {
    expect(findMarkerPosition(POOL, assessmentSortStamp("2025-01-01"))).toBe(0);
  });

  it("places it before the undated tail, not after it", () => {
    const pool = [work("dated", "2024-01-01"), work("undated", null)];
    // Nothing dated predates the assessment, so the marker closes the dated
    // run — an undated work has no timeline position to sit after.
    expect(findMarkerPosition(pool, assessmentSortStamp("2000-01-01"))).toBe(1);
  });

  it("is null when there is no assessment date", () => {
    expect(findMarkerPosition(POOL, null)).toBeNull();
  });

  it("counts a work dated in the assessment year as after it", () => {
    // A year-only 2021 work sorts mid-2021, so a January 2021 assessment
    // precedes it.
    const pool = [work("year only", "2021")];
    expect(findMarkerPosition(pool, assessmentSortStamp("2021-01-05"))).toBe(1);
    expect(findMarkerPosition(pool, assessmentSortStamp("2021-12-05"))).toBe(0);
  });
});

describe("countAroundAssessment", () => {
  it("splits the pool at the assessment date", () => {
    expect(countAroundAssessment(POOL, assessmentSortStamp("2021-03-14"))).toEqual({
      afterAssessment: 3,
      beforeAssessment: 2,
      undated: 0,
    });
  });

  it("counts undated works separately", () => {
    const pool = [...POOL, work("undated", null)];
    expect(countAroundAssessment(pool, assessmentSortStamp("2021-03-14"))).toEqual({
      afterAssessment: 3,
      beforeAssessment: 2,
      undated: 1,
    });
  });

  it("treats everything dated as 'after' when there is no assessment", () => {
    expect(countAroundAssessment(POOL, null)).toEqual({
      afterAssessment: 5,
      beforeAssessment: 0,
      undated: 0,
    });
  });
});

describe("paginate", () => {
  it("slices the requested page", () => {
    const page = paginate(POOL, 2, 2, null);
    expect(page.items.map((w) => w.title)).toEqual(["2022 paper", "2019 paper"]);
    expect(page).toMatchObject({ page: 2, perPage: 2, total: 5, totalPages: 3 });
  });

  it("clamps an out-of-range page instead of returning nothing", () => {
    expect(paginate(POOL, 99, 2, null).page).toBe(3);
    expect(paginate(POOL, 0, 2, null).page).toBe(1);
    expect(paginate(POOL, NaN, 2, null).page).toBe(1);
  });

  it("puts the marker on exactly the page it falls on", () => {
    const marker = findMarkerPosition(POOL, assessmentSortStamp("2021-03-14")); // 3
    expect(paginate(POOL, 1, 2, marker).markerIndex).toBeNull();
    // Page 2 holds pool indices 2 and 3, so the marker renders before the second row.
    expect(paginate(POOL, 2, 2, marker).markerIndex).toBe(1);
    expect(paginate(POOL, 3, 2, marker).markerIndex).toBeNull();
  });

  it("renders a marker that falls past the end on the last page", () => {
    const marker = findMarkerPosition(POOL, assessmentSortStamp("2005-01-01")); // 5
    expect(paginate(POOL, 1, 2, marker).markerIndex).toBeNull();
    const last = paginate(POOL, 3, 2, marker);
    expect(last.markerIndex).toBe(last.items.length);
  });

  it("does not render a boundary marker twice", () => {
    // Marker at pool index 2 with two rows per page: it belongs at the top of
    // page 2, and must not also close page 1.
    const marker = 2;
    expect(paginate(POOL, 1, 2, marker).markerIndex).toBeNull();
    expect(paginate(POOL, 2, 2, marker).markerIndex).toBe(0);
  });

  it("survives an empty pool", () => {
    const page = paginate([], 1, 10, null);
    expect(page).toMatchObject({ items: [], page: 1, total: 0, totalPages: 1, markerIndex: null });
  });
});
