import { describe, expect, it } from "vitest";
import { sourcesMismatch } from "../sync/sources-releases";

describe("sourcesMismatch", () => {
  const built = { xr: "316691", checklist: "316595", snapshot: "2026-11-01", snapshotXr: "315557", liveXr: "316691" };

  it("lets a later stage reuse tables built from the same releases", () => {
    expect(sourcesMismatch(built, { ...built })).toBeNull();
  });

  // The case that happened: a --from link run resolved a newer XR than the build's taxa.
  it("names each release that moved", () => {
    expect(sourcesMismatch(built, { ...built, xr: "316999" })).toBe("xr 316691 in the build, 316999 now");
    expect(sourcesMismatch(built, { xr: "316999", checklist: "316998", snapshot: "2026-12-01", snapshotXr: "316691", liveXr: "316999" }))
      .toMatch(/xr .*; checklist .*; snapshot .*; snapshotXr .*; liveXr /);
  });

  it("notices GBIF's live index moving, which changes the live ids", () => {
    expect(sourcesMismatch(built, { ...built, liveXr: null })).toBe("liveXr 316691 in the build, null now");
  });

  it("refuses a build with no record of its releases", () => {
    expect(sourcesMismatch(null, built)).toMatch(/no record/);
  });
});
