import { describe, it, expect } from "vitest";
import { inTriageBox, triageAxes, triagePlotX, triagePlotY } from "../PriorityScatter";

describe("triage scatter axes", () => {
  it("caps x at the 99th-percentile age, rounded up to 5, with a band past it", () => {
    const a = triageAxes(30.4, 12.3, 1e6, "log");
    expect(a.xCap).toBe(15);
    expect(a.xMax).toBeCloseTo(16.8); // a 12% band
    expect(a.yMax).toBe(7); // 1,000,000 → log10(1e6 + 1) rounds up to 7
    // Up to the cap, the age itself; past it, inside the band, in order of age.
    expect(triagePlotX(9, a)).toBe(9);
    const older = triagePlotX(20, a), oldest = triagePlotX(30.4, a);
    expect(older).toBeGreaterThan(15);
    expect(oldest).toBeGreaterThan(older);
    expect(oldest).toBeLessThanOrEqual(a.xMax);
  });

  it("has no band when nothing is older than the cap", () => {
    const a = triageAxes(9, 8, 100, "pct");
    expect(a.xCap).toBe(10);
    expect(a.xMax).toBe(10);
    expect(a.yMax).toBe(100);
  });

  it("places a dot the same way for drawing and for a box, jitter included", () => {
    const a = triageAxes(20, 18, 1e4, "log");
    const y = triagePlotY(0, "sis-123", a);
    expect(Math.abs(y)).toBeLessThan(0.1); // the 0 row, give or take ±3px of jitter
    // A box reaching just below the axis takes in a 0-record species; one starting above it doesn't.
    expect(inTriageBox({ x0: 0, x1: 20, y0: -0.2, y1: 1 }, 5, 0, "sis-123", a)).toBe(true);
    expect(inTriageBox({ x0: 0, x1: 20, y0: 0.5, y1: 1 }, 5, 0, "sis-123", a)).toBe(false);
  });
});
