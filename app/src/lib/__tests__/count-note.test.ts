import { describe, expect, it } from "vitest";
import { countNoteText, isCountNote } from "../count-note";

describe("countNoteText", () => {
  const versions = { col: "COL26.10 XR", snapshotCol: "COL26.6 XR" };

  it("says a new species' count may be low", () => {
    expect(countNoteText("new", versions)).toMatch(/under COL26.6 XR, which doesn't have this species yet, so its count may be low/);
  });

  it("reads without the release names", () => {
    expect(countNoteText("new", {})).toMatch(/under an earlier Catalogue of Life release, which/);
  });

  it("knows its notes", () => {
    expect(isCountNote("new")).toBe(true);
    expect(isCountNote("split")).toBe(false);
    expect(isCountNote(null)).toBe(false);
    expect(isCountNote("lumped")).toBe(false);
  });
});
