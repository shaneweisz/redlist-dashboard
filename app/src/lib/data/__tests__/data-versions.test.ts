import { describe, expect, it } from "vitest";
import { parseDataVersions } from "../data-versions";

describe("parseDataVersions", () => {
  it("names each release the way the footer credits it", () => {
    expect(parseDataVersions(JSON.stringify({ redlist: "redlist_2026_1", gbifSnapshot: "2026-11-01", col: "COL26.10 XR",
      snapshotCol: "COL26.6 XR" })))
      .toEqual({ redlist: "2026-1", gbifSnapshot: "1 November 2026", col: "COL26.10 XR", snapshotCol: "COL26.6 XR" });
  });

  it("leaves out what it can't read rather than guessing", () => {
    expect(parseDataVersions(JSON.stringify({ redlist: "redlist_latest", gbifSnapshot: "2026-13-01" }))).toEqual({});
    expect(parseDataVersions(undefined)).toEqual({});
    expect(parseDataVersions("not json")).toEqual({});
  });
});
