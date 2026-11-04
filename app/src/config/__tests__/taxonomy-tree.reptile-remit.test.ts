import { describe, expect, it } from "vitest";
import { findNode, speciesMatchesNode } from "@/lib/taxonomy-utils";
import remit from "./fixtures/gra-reptile-remit.json";

// The reptile SSC nodes must reproduce the "Specialist Group" column of the
// IUCN Global Reptile Assessment master list. The fixture is a family -> group
// table derived from that list (Elapidae, the only family it splits, is given
// per genus), plus one real species per family to test with. It holds no
// assessment data. Regenerate it from a new master list rather than editing
// it by hand.

const reptileGroupIds = (findNode("ssc-reptile-groups")?.children ?? []).map((c) => c.id);

function claimedBy(family: string, scientificName: string): string[] {
  const row = { class_name: "Reptilia", order_name: "Squamata", family, scientific_name: scientificName, taxon_group: "reptiles" };
  return reptileGroupIds.filter((id) => speciesMatchesNode(row, id));
}

describe("reptile SSC remits match the GRA master list", () => {
  it("every group named in the fixture is a real node", () => {
    const named = new Set([...Object.values(remit.families), ...Object.values(remit.elapidaeGenera)]);
    named.delete("split");
    for (const id of named) expect(reptileGroupIds, id).toContain(id);
  });

  it.each(remit.examples as [string, string][])("%s (%s) is claimed by exactly its GRA group", (family, name) => {
    expect(claimedBy(family, name)).toEqual([(remit.families as Record<string, string>)[family]]);
  });

  it.each(Object.entries(remit.elapidaeGenera))("Elapidae genus %s belongs to %s only", (genus, group) => {
    expect(claimedBy("elapidae", `${genus} sp`)).toEqual([group]);
  });
});
