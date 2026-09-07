/**
 * What the occurrence viewer shows before anyone touches a filter.
 *
 * These defaults decide what an assessor sees first, and the old ones hid most
 * of the evidence for everything but plants and fungi: specimens and citations
 * off, and cleaning checks trimming points on plausibility heuristics. The
 * viewer now opens on everything GBIF holds, for every kingdom, bar the two
 * record types that describe where an individual ended up rather than where the
 * species lives. Worth pinning down.
 */
import { describe, it, expect } from "vitest";
import { defaultCheckedTypes, defaultAppliedChecks } from "../OccurrenceMapRow";

describe("defaultCheckedTypes", () => {
  it("selects every record type but living and fossil specimens", () => {
    const types = defaultCheckedTypes();
    expect(types.livingSpecimen).toBe(false);
    expect(types.fossilSpecimen).toBe(false);
    const { livingSpecimen: _l, fossilSpecimen: _f, ...rest } = types;
    expect(Object.values(rest).every(Boolean)).toBe(true);
  });

  it("keeps specimens, citations and field observations on", () => {
    const types = defaultCheckedTypes();
    expect(types.preservedSpecimen).toBe(true);
    expect(types.materialCitation).toBe(true);
    expect(types.humanObservation).toBe(true);
    expect(types.machineObservation).toBe(true);
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
