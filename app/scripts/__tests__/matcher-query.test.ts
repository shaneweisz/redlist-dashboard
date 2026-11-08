import { describe, expect, it } from "vitest";
import { matcherQuery } from "../sync/link/matches";

describe("matcherQuery", () => {
  const species = { scientific_name: "Melospiza melodia", authority: "(Wilson, 1810)", kingdom_name: "ANIMALIA", phylum_name: "CHORDATA",
    class_name: "AVES", order_name: "PASSERIFORMES", family: "PASSERELLIDAE" };

  // Asked with its authority, matching-ws prefers CoL's provisional duplicate with the
  // identical author string over the accepted "(A. Wilson, 1810)" the records are filed on.
  // The authority is compared after the match instead (accept-match.ts).
  it("sends no authority, under any parameter name", () => {
    const q: Record<string, unknown> = { ...matcherQuery(species) };
    expect(q.scientificNameAuthorship).toBeUndefined();
    expect(q.authorship).toBeUndefined();
    expect(Object.values(q)).not.toContain("(Wilson, 1810)");
  });

  it("sends the name, with IUCN's lineage as capitalised hints", () => {
    expect(matcherQuery(species)).toEqual({ scientificName: "Melospiza melodia", kingdom: "Animalia", phylum: "Chordata", class: "Aves",
      order: "Passeriformes", family: "Passerellidae" });
  });
});
