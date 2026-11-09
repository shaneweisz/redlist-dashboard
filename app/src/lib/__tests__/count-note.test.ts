import { describe, expect, it } from "vitest";
import { countNoteText, isCountNote } from "../count-note";

describe("countNoteText", () => {
  const versions = { col: "COL26.10 XR", snapshotCol: "COL26.6 XR" };

  it("names both releases for a split", () => {
    expect(countNoteText("split", versions)).toBe("GBIF's snapshot files its records under COL26.6 XR, which holds this species " +
      "together with another that COL26.10 XR separates, so its count may be high or low until GBIF re-indexes.");
  });

  it("says a new species' count may be low", () => {
    expect(countNoteText("new", versions)).toMatch(/under COL26.6 XR, which doesn't have this species yet, so its count may be low/);
  });

  it("reads without the release names", () => {
    expect(countNoteText("new", {})).toMatch(/under an earlier Catalogue of Life release, which/);
  });

  it("knows its notes", () => {
    expect(isCountNote("split")).toBe(true);
    expect(isCountNote(null)).toBe(false);
    expect(isCountNote("lumped")).toBe(false);
  });
});
