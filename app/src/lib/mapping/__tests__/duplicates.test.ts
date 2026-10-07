import { describe, it, expect } from "vitest";
import { duplicatesByPrimary, keepRecord } from "../duplicates";
import { duplicateOf, duplicateOfReason, type Exclusion } from "../georeferences";

const STAMP = { excludedAt: "2026-08-27T00:00:00.000Z", excludedBy: "a@example.org" };
const ALL = [1, 2, 3, 4, 5];

/** The exclusions as a readable map of id → what it says. */
const shape = (exclusions: Record<number, Exclusion>) =>
  Object.fromEntries(
    Object.entries(exclusions).map(([id, e]) => [id, duplicateOf(e) ?? e.justification])
  );

const duplicateOfRecord = (of: number): Exclusion => ({
  gbifID: 0,
  justification: duplicateOfReason(of),
  duplicateOf: of,
  excludedAt: STAMP.excludedAt,
});

const keep = (exclusions: Record<number, Exclusion>, primaryGbifID: number, alsoDuplicates?: number[]) =>
  keepRecord({ exclusions, gbifIDs: ALL, primaryGbifID, alsoDuplicates, stamp: STAMP });

describe("keepRecord", () => {
  it("sets the others aside as duplicates of the one kept", () => {
    expect(shape(keep({}, 1, [2, 3]))).toEqual({ 2: 1, 3: 1 });
  });

  it("counts the record kept, whatever it was before", () => {
    // The bug that emptied a locality: "keep this one" on a record that was
    // itself a duplicate left every record in the group excluded.
    const before = { 2: duplicateOfRecord(1) };
    const after = keep(before, 2);
    expect(after[2]).toBeUndefined();
    expect(shape(after)).toEqual({ 1: 2 });
  });

  it("brings the group with it when the record kept was a duplicate", () => {
    const before = { 2: duplicateOfRecord(1), 3: duplicateOfRecord(1) };
    // 3 takes over: 1 and 2 become duplicates of it, not of each other.
    expect(shape(keep(before, 3))).toEqual({ 1: 3, 2: 3 });
  });

  it("flattens a chain rather than nesting it", () => {
    // 2 was a duplicate of 1; now 1 is a duplicate of 3, so 2 is too.
    const before = { 2: duplicateOfRecord(1) };
    expect(shape(keep(before, 3, [1]))).toEqual({ 1: 3, 2: 3 });
  });

  it("folds in a whole group dropped onto another record", () => {
    const before = { 2: duplicateOfRecord(1), 3: duplicateOfRecord(2) };
    expect(shape(keep(before, 4, [1]))).toEqual({ 1: 4, 2: 4, 3: 4 });
  });

  it("leaves records outside the group alone", () => {
    const before = { 4: { gbifID: 4, justification: "Cultivated", excludedAt: STAMP.excludedAt } };
    expect(shape(keep(before, 1, [2]))).toEqual({ 2: 1, 4: "Cultivated" });
  });

  it("writes the link as a field, with the reason alongside it", () => {
    expect(keep({}, 1, [2])[2]).toMatchObject({
      gbifID: 2,
      duplicateOf: 1,
      justification: duplicateOfReason(1),
    });
  });

  it("is idempotent — saying it twice says it once", () => {
    const once = keep({}, 1, [2, 3]);
    expect(shape(keep(once, 1, [2, 3]))).toEqual(shape(once));
  });
});

describe("excluding the record a group was kept for", () => {
  /**
   * A primary struck out for its own reason keeps its duplicates: they point
   * at it by id, and nothing about that changes. The group is intact for as
   * long as the exclusion lasts, and putting the record back restores it whole.
   */
  const group = { 2: duplicateOfRecord(1), 3: duplicateOfRecord(1) };
  const primaryExcluded: Record<number, Exclusion> = {
    ...group,
    1: { gbifID: 1, justification: "Cultivated", excludedAt: STAMP.excludedAt },
  };

  it("keeps the duplicates pointing at it", () => {
    const groups = duplicatesByPrimary([1, 2, 3], (id) => id, primaryExcluded);
    expect(groups.get(1)).toEqual([2, 3]);
  });

  it("doesn't promote a duplicate to take its place", () => {
    // Nothing in the group is counted while the record kept is excluded —
    // which is the honest state: you excluded the one you had chosen.
    expect(duplicateOf(primaryExcluded[2])).toBe(1);
    expect(duplicateOf(primaryExcluded[3])).toBe(1);
  });

  it("restores the group when the record is put back", () => {
    const putBack = { ...primaryExcluded };
    delete putBack[1];
    expect(shape(putBack)).toEqual({ 2: 1, 3: 1 });
    expect(duplicatesByPrimary([1, 2, 3], (id) => id, putBack).get(1)).toEqual([2, 3]);
  });

  it("still lets one of its duplicates take over", () => {
    const after = keep(primaryExcluded, 2);
    // 2 is counted, 1 and 3 are duplicates of it — and 1's own reason is
    // replaced, since it is now part of the group rather than set aside for
    // a reason of its own.
    expect(after[2]).toBeUndefined();
    expect(shape(after)).toEqual({ 1: 2, 3: 2 });
  });
});

describe("duplicatesByPrimary", () => {
  it("groups by the head of the chain, not the record written against", () => {
    const chained = { 2: duplicateOfRecord(1), 3: duplicateOfRecord(2) };
    const groups = duplicatesByPrimary([1, 2, 3], (id) => id, chained);
    expect(groups.get(1)).toEqual([2, 3]);
    expect(groups.has(2)).toBe(false);
  });

  it("ignores an exclusion that isn't a duplicate", () => {
    const groups = duplicatesByPrimary([1, 2], (id) => id, { 2: { justification: "Misidentified" } });
    expect(groups.size).toBe(0);
  });

  it("survives a cycle rather than hanging", () => {
    const cycle = { 1: duplicateOfRecord(2), 2: duplicateOfRecord(1) };
    expect(() => duplicatesByPrimary([1, 2], (id) => id, cycle)).not.toThrow();
  });
});
