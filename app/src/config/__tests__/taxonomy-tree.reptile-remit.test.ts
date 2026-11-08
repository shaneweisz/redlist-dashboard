import { describe, expect, it } from "vitest";
import { findNode } from "@/lib/taxonomy-utils";
import { groupsOf } from "./helpers/specialist-groups";
import remit from "./fixtures/gra-reptile-remit.json";

// The reptile SSC nodes must reproduce the "Specialist Group" column of the
// IUCN Global Reptile Assessment master list. The fixture is a family -> group
// table derived from that list (Elapidae, the only family it splits, is given
// per genus), plus one real species per family to test with. It holds no
// assessment data. Regenerate it from a new master list rather than editing
// it by hand.

const reptileGroupIds = (findNode("ssc-reptile-groups")?.children ?? []).map((c) => c.id);

// The Specialist Groups the sync puts a species of this family in.
async function claimedBy(family: string, scientificName: string): Promise<string[]> {
  const row = { class_name: "Reptilia", order_name: "Squamata", family, scientific_name: scientificName, taxon_group: "reptiles" };
  return (await groupsOf([row]))[0].filter((id) => reptileGroupIds.includes(id));
}

describe("reptile SSC remits match the GRA master list", () => {
  it("every group named in the fixture is a real node", () => {
    const named = new Set([...Object.values(remit.families), ...Object.values(remit.elapidaeGenera)]);
    named.delete("split");
    for (const id of named) expect(reptileGroupIds, id).toContain(id);
  });

  it.each(remit.examples as [string, string][])("%s (%s) is claimed by exactly its GRA group", async (family, name) => {
    expect(await claimedBy(family, name)).toEqual([(remit.families as Record<string, string>)[family]]);
  });

  it.each(Object.entries(remit.elapidaeGenera))("Elapidae genus %s belongs to %s only", async (genus, group) => {
    expect(await claimedBy("elapidae", `${genus} sp`)).toEqual([group]);
  });
});

// Our Catalogue of Life species carry CoL's family names, which the GRA list
// doesn't use: a spelling variant, or a split the GRA doesn't make. Each must
// still land in the group its GRA counterpart is in, or that family's CoL
// species silently move group (Bolyeriidae once fell to the lizard RLA).
describe("CoL-only reptile family names follow their GRA counterpart", () => {
  it.each([
    ["bolyeriidae", "Bolyeria multocarinata", "ssc-snake"],          // GRA: Bolyeridae
    ["trogonophidae", "Agamodon anguliceps", "ssc-lizard-tuatara-rla"], // GRA: Trogonophiidae
    ["leiocephalidae", "Leiocephalus altavelensis", "ssc-lizard-tuatara-rla"], // GRA: within Tropiduridae
  ])("%s (%s) is claimed by %s only", async (family, name, group) => {
    expect(await claimedBy(family, name)).toEqual([group]);
  });
});
