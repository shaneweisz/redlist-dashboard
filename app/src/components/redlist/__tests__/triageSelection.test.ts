import { describe, it, expect } from "vitest";
import { inTriageSelection, inTriageRect, triageTest } from "../PriorityScatter";

describe("triage selection membership", () => {
  const box = { x0: 10, x1: 20, y0: 2, y1: 4 }; // log10(count + 1) from 2 to 4: ~99 to ~9,999

  it("tests a dot's plotted place against a box, in plot units", () => {
    expect(inTriageRect(15, 999, box, "log")).toBe(true);
    expect(inTriageRect(15, 50, box, "log")).toBe(false);
    expect(inTriageRect(9.9, 999, box, "log")).toBe(false);
    expect(inTriageRect(15, 3, { x0: 10, x1: 20, y0: 0, y1: 5 }, "pct")).toBe(true);
  });

  it("takes boxes, adds ⌘-clicked dots, and excludes ⌘-clicked-out ones", () => {
    const t = triageTest({ rects: [box], add: ["far"], del: ["inside-but-out"] });
    expect(inTriageSelection(t, "a", 15, 999, "log")).toBe(true);
    expect(inTriageSelection(t, "b", 5, 999, "log")).toBe(false);
    expect(inTriageSelection(t, "far", 1, 0, "log")).toBe(true);
    expect(inTriageSelection(t, "inside-but-out", 15, 999, "log")).toBe(false);
  });

  it("holds an added dot with no plotted place", () => {
    const t = triageTest({ rects: [], add: ["x"], del: [] });
    expect(inTriageSelection(t, "x", NaN, NaN, "log")).toBe(true);
    expect(inTriageSelection(t, "y", NaN, NaN, "log")).toBe(false);
  });
});
