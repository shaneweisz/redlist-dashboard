/**
 * Snapshot completeness (scripts/sync/core/build-occurrences.ts): a gap in the
 * part-file numbering is what gbif/occurrence#609 looked like, so it must be
 * found, and a complete listing must pass.
 */
import { describe, it, expect } from "vitest";
import { missingFileNumbers } from "../sync/core/build-occurrences";

const files = (nums: number[]) => nums.map((n) => `/m/2026-11-01/occurrence.parquet/${String(n).padStart(6, "0")}`);

describe("missingFileNumbers", () => {
  it("finds every twentieth file missing, as in #609", () => {
    const present = Array.from({ length: 60 }, (_, i) => i + 1).filter((n) => n % 20 !== 0);
    expect(missingFileNumbers(files(present))).toEqual([20, 40]);
  });
  it("passes a complete listing, whatever its order", () => {
    expect(missingFileNumbers(files([3, 1, 2]))).toEqual([]);
    expect(missingFileNumbers([])).toEqual([]);
  });
});
