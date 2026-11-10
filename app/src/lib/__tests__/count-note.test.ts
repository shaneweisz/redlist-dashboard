import { describe, it, expect } from "vitest";
import { countNoteText, isCountNote } from "@/lib/count-note";

describe("countNoteText", () => {
  it("says an unlinked species counts nothing, naming the release", () => {
    expect(countNoteText("unlinked", { col: "COL26.6 XR" }))
      .toMatch(/^Not yet linked to a species in COL26.6 XR, so none of its GBIF records are counted/);
    expect(countNoteText("unlinked", {})).toMatch(/^Not yet linked to a species in Catalogue of Life/);
  });

  it("knows its notes", () => {
    expect(isCountNote("unlinked")).toBe(true);
    expect(isCountNote("new")).toBe(false);
    expect(isCountNote(null)).toBe(false);
  });
});
