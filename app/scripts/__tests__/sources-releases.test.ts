import { describe, expect, it } from "vitest";
import { sourcesMismatch } from "../sync/sources-releases";

describe("sourcesMismatch", () => {
  const built = { xr: "315557", checklist: "315448", snapshot: "2026-11-01", openalex: "2026-10-14", bhl: "2026-11-01T00:00:00.000Z" };

  it("lets a later stage reuse tables built from the same releases", () => {
    expect(sourcesMismatch(built, { ...built })).toBeNull();
  });

  // The case that happened: a --from link run resolved GBIF's newer XR.
  it("names each release that moved", () => {
    expect(sourcesMismatch(built, { ...built, xr: "316691" })).toBe("xr 315557 in the build, 316691 now");
    expect(sourcesMismatch(built, { ...built, xr: "316691", checklist: "316595", snapshot: "2026-12-01" })).toMatch(/xr .*; checklist .*; snapshot /);
  });

  // A new BHL export or OpenAlex release changes literature_mentions: reuse would mix them.
  it("names a literature release that moved, or a build from before it was recorded", () => {
    expect(sourcesMismatch(built, { ...built, bhl: "2026-12-01T00:00:00.000Z" })).toMatch(/^bhl /);
    const { openalex: _o, bhl: _b, ...old } = built;
    expect(sourcesMismatch(old as typeof built, built)).toMatch(/openalex unrecorded .*; bhl unrecorded/);
  });

  it("refuses a build with no record of its releases", () => {
    expect(sourcesMismatch(null, built)).toMatch(/no record/);
  });
});
