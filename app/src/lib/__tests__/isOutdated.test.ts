import { describe, it, expect } from "vitest";
import { isOutdated, outdatedCutoffDate, yearsSince, yearsMonthsSince } from "../outdated";

describe("isOutdated", () => {
  // Fixed reference point so tests don't depend on wall-clock time.
  const now = new Date("2026-07-16T00:00:00Z");

  it("returns true when assessment_date is null", () => {
    expect(isOutdated(null, now)).toBe(true);
  });

  it("returns true when assessment_date is empty string", () => {
    expect(isOutdated("", now)).toBe(true);
  });

  it("returns true when assessment_date is not parseable", () => {
    expect(isOutdated("unknown", now)).toBe(true);
  });

  it("returns true when assessment is >10 years old", () => {
    expect(isOutdated("2015-06-15", now)).toBe(true);
    expect(isOutdated("2010-01-01", now)).toBe(true);
    expect(isOutdated("2000-12-31", now)).toBe(true);
  });

  it("returns false when assessment is exactly 10 years old", () => {
    expect(isOutdated("2016-07-16", now)).toBe(false);
  });

  it("returns true just after the 10-year mark", () => {
    expect(isOutdated("2016-07-15", now)).toBe(true);
  });

  it("returns false when assessment is <10 years old", () => {
    expect(isOutdated("2017-01-01", now)).toBe(false);
    expect(isOutdated("2025-12-31", now)).toBe(false);
    expect(isOutdated("2026-01-01", now)).toBe(false);
  });

  it("returns false for recent assessment", () => {
    expect(isOutdated("2024-08-20", now)).toBe(false);
  });

  it("handles year-only strings", () => {
    expect(isOutdated("2015", now)).toBe(true);
    expect(isOutdated("2020", now)).toBe(false);
  });

  it("is precise to the day, not just the calendar year", () => {
    // Old calendar-year math treated every 2016 date alike (2026 - 2016 = 10,
    // not outdated). Precise elapsed time correctly flags an early-2016 date
    // as outdated (already >10 years by `now`), while a mid-2016 date right
    // at the actual 10-year mark is not.
    expect(isOutdated("2016-01-01", now)).toBe(true);
    expect(isOutdated("2016-07-16", now)).toBe(false);
  });
});

describe("outdatedCutoffDate", () => {
  it("is the day before the date 10 calendar years ago", () => {
    const now = new Date("2026-07-16T00:00:00Z");
    expect(outdatedCutoffDate(now).toISOString()).toBe("2016-07-15T00:00:00.000Z");
  });

  it("ignores the time of day", () => {
    expect(outdatedCutoffDate(new Date("2026-07-16T18:30:00Z")).toISOString()).toBe("2016-07-15T00:00:00.000Z");
  });

  it("agrees with isOutdated at the boundary", () => {
    const now = new Date("2026-07-16T00:00:00Z");
    const cutoff = outdatedCutoffDate(now);
    expect(isOutdated(cutoff.toISOString(), now)).toBe(true);
    const dayAfter = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);
    expect(isOutdated(dayAfter.toISOString(), now)).toBe(false);
  });
});

describe("yearsSince", () => {
  const now = new Date("2026-11-07T15:00:00Z");

  it("is a whole number on the anniversary, whatever the time of day", () => {
    expect(yearsSince("2016-11-07", now)).toBe(10);
  });

  it("is just under on the day before the anniversary", () => {
    const y = yearsSince("2016-11-08", now);
    expect(y).toBeLessThan(10);
    expect(y).toBeGreaterThan(9.99);
  });

  it("counts leap years by the calendar, not an average", () => {
    // 365.25-day years put 2016-11-07 at 9.9986 years on 2026-11-07.
    expect(yearsSince("2016-11-07", new Date("2026-11-07T00:00:00Z"))).toBe(10);
    expect(yearsSince("2024-02-29", new Date("2025-03-01T00:00:00Z"))).toBe(1);
  });

  it("is halfway through a year at its midpoint", () => {
    expect(yearsSince("2025-01-01", new Date("2025-07-02T12:00:00Z"))).toBeCloseTo(0.5, 2);
  });
});

describe("yearsMonthsSince", () => {
  const now = new Date("2026-11-07T00:00:00Z");

  it("counts whole calendar months", () => {
    expect(yearsMonthsSince("2016-08-07", now)).toEqual({ years: 10, months: 3 });
    expect(yearsMonthsSince("2016-08-08", now)).toEqual({ years: 10, months: 2 });
  });

  it("is zero for today", () => {
    expect(yearsMonthsSince("2026-11-07", now)).toEqual({ years: 0, months: 0 });
  });
});
