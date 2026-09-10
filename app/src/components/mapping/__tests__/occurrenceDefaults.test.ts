/**
 * What the occurrence viewer shows before anyone touches a filter.
 *
 * These defaults decide what an assessor sees first, so they are worth pinning
 * down: every record type bar the two that say where an individual ended up
 * rather than where the species lives, no cleaning check applied, and
 * preserved specimens following the taxon — the same rule the dashboard's own
 * GBIF counts use.
 */
import { describe, it, expect } from "vitest";
import { defaultCheckedTypes, defaultAppliedChecks } from "../OccurrenceMapRow";

describe("defaultCheckedTypes", () => {
  it("leaves living and fossil specimens off for every taxon", () => {
    for (const group of [undefined, "mammals", "beetles", "flowering_plants", "mushrooms"]) {
      const types = defaultCheckedTypes(group);
      expect(types.livingSpecimen).toBe(false);
      expect(types.fossilSpecimen).toBe(false);
    }
  });

  it("keeps citations, field observations and material samples on", () => {
    const types = defaultCheckedTypes("mammals");
    expect(types.materialCitation).toBe(true);
    expect(types.humanObservation).toBe(true);
    expect(types.machineObservation).toBe(true);
    expect(types.observation).toBe(true);
    expect(types.materialSample).toBe(true);
    expect(types.occurrence).toBe(true);
  });

  // The dashboard's counts for a plant include its herbarium sheets and an
  // animal's exclude its museum skins; the viewer has to open on the same set,
  // or the count that sent you here describes different records from the map.
  it("starts preserved specimens on for plants and fungi, off for animals", () => {
    expect(defaultCheckedTypes("flowering_plants").preservedSpecimen).toBe(true);
    expect(defaultCheckedTypes("mushrooms").preservedSpecimen).toBe(true);
    expect(defaultCheckedTypes("mammals").preservedSpecimen).toBe(false);
    expect(defaultCheckedTypes("beetles").preservedSpecimen).toBe(false);
    expect(defaultCheckedTypes(undefined).preservedSpecimen).toBe(false);
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
