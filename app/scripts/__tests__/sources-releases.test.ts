import { describe, expect, it } from "vitest";
import { sourcesMismatch } from "../sync/sources-releases";

describe("sourcesMismatch", () => {
  const built = { xr: "315557", checklist: "315448", snapshot: "2026-11-01" };

  it("lets a later stage reuse tables built from the same releases", () => {
    expect(sourcesMismatch(built, { ...built })).toBeNull();
  });

  // The case that happened: a --from link run resolved GBIF's newer XR.
  it("names each release that moved", () => {
    expect(sourcesMismatch(built, { ...built, xr: "316691" })).toBe("xr 315557 in the build, 316691 now");
    expect(sourcesMismatch(built, { xr: "316691", checklist: "316595", snapshot: "2026-12-01" })).toMatch(/xr .*; checklist .*; snapshot /);
  });

  it("refuses a build with no record of its releases", () => {
    expect(sourcesMismatch(null, built)).toMatch(/no record/);
  });
});
