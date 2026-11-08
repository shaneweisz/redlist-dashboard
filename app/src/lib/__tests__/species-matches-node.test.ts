/**
 * Which species a node holds, in the browser (speciesMatchesNode) and on the
 * server (staticNodeSql): a Specialist Group's are the ones the sync put in it,
 * any other static node's those of its taxon groups, and a live drill-down
 * node's those its filter matches, through the same class and order aliases
 * the server's SQL uses.
 */
import { describe, it, expect } from "vitest";
import { speciesMatchesNode, matchesBreakdownName, staticNodeSql, isSpecialistGroup, SPECIALIST_GROUP_SECTIONS } from "@/lib/taxonomy-utils";

const row = (r: Partial<Parameters<typeof speciesMatchesNode>[0]> & { taxon_group: string }) =>
  ({ class_name: null, order_name: null, family: null, scientific_name: null, specialist_group: null, ...r });

describe("Specialist Groups", () => {
  it("are the children of the six layout sections", () => {
    expect(SPECIALIST_GROUP_SECTIONS).toHaveLength(6);
    expect(isSpecialistGroup("ssc-conifer")).toBe(true);
    expect(isSpecialistGroup("ssc-plant-groups")).toBe(false);
    expect(isSpecialistGroup("mammals")).toBe(false);
  });

  it("hold the species the sync put in them, whatever their names say", () => {
    // CoL files this juniper under Cupressales; the sync's remit (Pinales and its
    // aliases) put it in the Conifer SG, and the browser takes that answer.
    const juniper = row({ taxon_group: "gymnosperms", class_name: "Pinopsida", order_name: "Cupressales", specialist_group: "ssc-conifer" });
    expect(speciesMatchesNode(juniper, "ssc-conifer")).toBe(true);
    expect(speciesMatchesNode(juniper, "ssc-other-plants")).toBe(false);
    expect(speciesMatchesNode({ ...juniper, specialist_group: null }, "ssc-conifer")).toBe(false);
  });

  it("are a specialist_group predicate on the server", () => {
    expect(staticNodeSql("ssc-conifer")).toBe("specialist_group = 'ssc-conifer'");
  });
});

describe("IUCN groups and layout sections", () => {
  it("hold every species of their taxon groups", () => {
    const bison = row({ taxon_group: "mammals", class_name: "Mammalia", order_name: "Artiodactyla", scientific_name: "Bos bison" });
    expect(speciesMatchesNode(bison, "mammals")).toBe(true);
    expect(speciesMatchesNode(bison, "ssc-groups")).toBe(true);
    expect(speciesMatchesNode(bison, "birds")).toBe(false);
  });

  it("are a taxon_group predicate on the server", () => {
    expect(staticNodeSql("mammals")).toBe("taxon_group IN ('mammals')");
    expect(staticNodeSql("not-a-node")).toBeNull();
  });
});

describe("live drill-down nodes match through the class and order aliases", () => {
  it("hold CoL's Teleostei under the ray-finned fishes", () => {
    expect(speciesMatchesNode(row({ taxon_group: "fishes", class_name: "Teleostei" }), "fishes~class:actinopterygii")).toBe(true);
    expect(speciesMatchesNode(row({ taxon_group: "fishes", class_name: "Elasmobranchii" }), "fishes~class:actinopterygii")).toBe(false);
  });

  it("hold CoL's Cupressales under Pinales, and its whales under Artiodactyla", () => {
    expect(speciesMatchesNode(row({ taxon_group: "gymnosperms", order_name: "Cupressales" }), "gymnosperms~order:pinales")).toBe(true);
    expect(speciesMatchesNode(row({ taxon_group: "mammals", order_name: "Cetacea" }), "mammals~order:artiodactyla")).toBe(true);
  });

  it("narrow a breakdown row the same way", () => {
    expect(matchesBreakdownName(row({ taxon_group: "gymnosperms", order_name: "Araucariales" }), "order", "pinales")).toBe(true);
    expect(matchesBreakdownName(row({ taxon_group: "fishes", class_name: "Holostei" }), "class", "actinopterygii")).toBe(true);
    expect(matchesBreakdownName(row({ taxon_group: "gymnosperms", order_name: "Gnetales" }), "order", "pinales")).toBe(false);
  });
});
