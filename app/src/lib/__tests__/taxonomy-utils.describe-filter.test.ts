import { describe, it, expect } from "vitest";
import { describeFilter, breakdownHref, colAliasNote, graNameNote, graDisplayNames } from "../taxonomy-utils";

// Regression coverage for a bug that shipped and got silently reverted once
// already in this same PR (35f10ce fixed it, a35ff0f's diff accidentally
// undid it without anyone noticing until a user reported the symptom): once a
// node's breakdown table loaded, describeFilter used to drop EVERY set
// dimension (not just the one the table itself renders), wiping a dynamic
// node's whole ancestor breadcrumb (e.g. "Order: Rodentia; Family:
// Heteromyidae; Genus: Chaetodipus") the instant the popover finished
// loading. describeFilter no longer takes a "hide" flag at all — it always
// includes every set dimension.
describe("describeFilter", () => {
  it("includes every set dimension, unconditionally (no hideBreakdownRank escape hatch)", () => {
    const segs = describeFilter({ taxonGroups: ["mammals"], orderNames: ["rodentia"], families: ["heteromyidae"], genera: ["chaetodipus"] });
    const text = segs.map((s) => s.text).join("");
    expect(text).toBe("Order: Rodentia; Family: Heteromyidae; Genus: Chaetodipus");
  });

  it("links a name resolvable in the static COL_TAXON_IDS snapshot", () => {
    const segs = describeFilter({ taxonGroups: ["fishes"], families: ["acipenseridae"] });
    const linked = segs.find((s) => s.text === "Acipenseridae");
    expect(linked?.href).toContain("TAXON_ID=KTYZ7");
  });

  it("falls back to liveColIds for a name the static snapshot doesn't cover", () => {
    const segs = describeFilter(
      { taxonGroups: ["mammals"], genera: ["chaetodipus"] },
      undefined,
      { "genus:chaetodipus": "3LLS" }
    );
    const linked = segs.find((s) => s.text === "Chaetodipus");
    expect(linked?.href).toContain("TAXON_ID=3LLS");
  });

  it("leaves a name unlinked when neither the static snapshot nor liveColIds resolve it", () => {
    const segs = describeFilter({ taxonGroups: ["mammals"], genera: ["nonexistentgenusxyz"] });
    const seg = segs.find((s) => s.text === "Nonexistentgenusxyz");
    expect(seg?.href).toBeUndefined();
  });
});

describe("breakdownHref", () => {
  // CoL leaves extinct unset for some sources' living species (all of the
  // Reptile Database's), so the link must ask for unset as well as false.
  it("asks CoL for species not marked extinct, whether false or unset", () => {
    const href = new URL(breakdownHref("family", "acrochordidae")!);
    expect(href.searchParams.getAll("extinct")).toEqual(["0", "_NULL"]);
    expect(href.searchParams.get("status")).toBe("accepted");
  });

  it("prefers the static snapshot over liveColIds when both resolve the same name", () => {
    const href = breakdownHref("family", "acipenseridae", { "family:acipenseridae": "OTHERID" });
    expect(href).toContain("TAXON_ID=KTYZ7");
  });

  it("uses liveColIds when the static snapshot has nothing for this name", () => {
    const href = breakdownHref("genus", "chaetodipus", { "genus:chaetodipus": "3LLS" });
    expect(href).toContain("TAXON_ID=3LLS");
  });

  it("returns undefined when neither source resolves the name", () => {
    expect(breakdownHref("genus", "nonexistentgenusxyz")).toBeUndefined();
  });
});

describe("names CoL files differently", () => {
  it("puts the link on CoL's name, not the tree's, for a family CoL ranks as a subfamily", () => {
    const segs = describeFilter({ taxonGroups: ["reptiles"], families: ["calamariidae"] });
    expect(segs.map((s) => s.text).join("")).toBe("Family: Calamariidae (Calamariinae on CoL)");
    expect(segs.find((s) => s.text === "Calamariidae")?.href).toBeUndefined();
    expect(segs.find((s) => s.text === "Calamariinae")?.href).toContain("TAXON_ID=");
  });

  it("keeps the link on the name itself when CoL only changes the rank", () => {
    const segs = describeFilter({ taxonGroups: ["fishes"], classNames: ["chondrichthyes"] });
    expect(segs.map((s) => s.text).join("")).toBe("Class: Chondrichthyes (a parvphylum on CoL)");
    expect(segs.find((s) => s.text === "Chondrichthyes")?.href).toContain("TAXON_ID=");
  });

  it("follows CoL's synonym record for a species", () => {
    expect(colAliasNote("species", "palaemonetes antrorum")).toBe("Palaemon antrorum on CoL");
    expect(breakdownHref("species", "palaemonetes antrorum")).toBeDefined();
  });

  it("names the rank when CoL keeps the name but not the rank", () => {
    expect(colAliasNote("class", "chondrichthyes")).toBe("a parvphylum on CoL");
  });

  it("adds nothing for a name CoL accepts as is", () => {
    expect(colAliasNote("family", "acipenseridae")).toBeUndefined();
  });
});

describe("names the GRA master list writes differently", () => {
  it("labels a CoL or Red List spelling with the GRA's, and a CoL split with the GRA family it sits in", () => {
    expect(graNameNote("family", "trogonophidae")).toBe("Trogonophiidae in the GRA list");
    expect(graNameNote("family", "leiocephalidae")).toBe("part of Tropiduridae in the GRA list");
    expect(graNameNote("family", "teiidae")).toBeUndefined();
  });

  it("puts the GRA label in the tooltip text after the name", () => {
    const segs = describeFilter({ taxonGroups: ["reptiles"], families: ["leiocephalidae"] });
    expect(segs.map((s) => s.text).join("")).toBe("Family: Leiocephalidae (part of Tropiduridae in the GRA list)");
  });

  it("gives a GRA reader the GRA's names: spellings swapped, splits and duplicates dropped", () => {
    const names = ["tropiduridae", "trogonophiidae", "trogonophidae", "leiocephalidae", "atractaspididae"];
    const cap = (n: string) => n[0].toUpperCase() + n.slice(1);
    expect(graDisplayNames("family", names, cap)).toEqual(["Tropiduridae", "Trogonophiidae", "Atractaspidae"]);
  });
});
