import { describe, it, expect } from "vitest";
import { threatDisplay, THREAT_LABEL } from "@/lib/filter-vocab";

describe("threat labels", () => {
  it("renders human-readable labels", () => {
    expect(THREAT_LABEL["11"]).toBe("Climate change");
    // threat codes render with their top-level category for context; deep sub-codes
    // walk up to the nearest known label (no bare numbers)
    expect(threatDisplay("11.4")).toBe("Climate change (Storms & flooding)");
    expect(threatDisplay("5.4.1")).toBe("Harvesting (Fishing & harvesting)");
    expect(threatDisplay("11")).toBe("Climate change");
  });
});
