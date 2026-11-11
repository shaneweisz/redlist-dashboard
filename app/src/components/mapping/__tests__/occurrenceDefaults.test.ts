/**
 * What the occurrence viewer shows before anyone touches a filter.
 *
 * These defaults decide what an assessor sees first, so they are worth pinning
 * down: every record type on, for every taxon, and no cleaning check applied —
 * which records to trust is left to the assessor. (GBIF's own flagged-records
 * check is component state, off by default too; see OccurrenceMapRow.)
 */
import { describe, it, expect } from "vitest";
import { defaultCheckedTypes, defaultAppliedChecks } from "../OccurrenceMapRow";

describe("defaultCheckedTypes", () => {
  it("selects every record type", () => {
    const types = defaultCheckedTypes();
    expect(Object.values(types).every(Boolean)).toBe(true);
    expect(types.livingSpecimen).toBe(true);
    expect(types.fossilSpecimen).toBe(true);
    expect(types.preservedSpecimen).toBe(true);
  });
});

describe("defaultAppliedChecks", () => {
  it("applies no cleaning check at all", () => {
    expect(Object.values(defaultAppliedChecks()).some(Boolean)).toBe(false);
  });

  it("leaves even null island and duplicates opt-in", () => {
    const checks = defaultAppliedChecks();
    expect(checks.ZERO_COORDINATE).toBe(false);
    expect(checks.DUPLICATE).toBe(false);
    expect(checks.NEAR_CAPITAL).toBe(false);
    expect(checks.URBAN_AREA).toBe(false);
    expect(checks.OUTSIDE_REPORTED_COUNTRY).toBe(false);
  });
});
