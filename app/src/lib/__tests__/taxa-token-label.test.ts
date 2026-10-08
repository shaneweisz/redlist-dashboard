/**
 * The reader-facing half of a `taxa=` token: what the narrative search calls
 * the group it is filtering by, including one it was handed rather than one
 * picked from its own dropdown.
 */
import { describe, it, expect } from "vitest";
import { taxaTokenLabel } from "@/lib/taxa-token-label";

describe("taxaTokenLabel", () => {
  it("names a display root", () => {
    expect(taxaTokenLabel("mammals")).toBe("Mammals");
    expect(taxaTokenLabel("plantae")).toBe("Plants");
  });

  it("names a sub-group by the sub-group, not its root", () => {
    // Not "Invertebrates" — the token is the narrower of the two things
    // expandTaxaToken hands back, and it is the one that was asked for.
    expect(taxaTokenLabel("corals")).toBe("Corals & Cnidarians");
  });

  it("names a live-drilldown token by its deepest rank", () => {
    expect(taxaTokenLabel("flowering_plants~dioscoreales~dioscoreaceae")).toBe("Dioscoreaceae");
  });

  it("capitalizes a name that is outside the tree altogether", () => {
    expect(taxaTokenLabel("panthera")).toBe("Panthera");
  });

  it("has nothing to say about an empty token", () => {
    expect(taxaTokenLabel("")).toBe("");
  });
});
