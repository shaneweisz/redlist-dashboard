import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import {
  ALL_TAXON_GROUPS,
  TAXON_GROUP_NAMES,
  TAXONOMY_TREE,
  type TaxonomyNode,
} from "../taxonomy-tree";
import {
  NODE_INDEX,
  PARENT_INDEX,
  findNode,
  getAncestors,
  hasChildren,
  getNodePath,
  matchesFilter,
  speciesMatchesNode,
  getNodeDef,
  getTaxonGroupsForNode,
} from "@/lib/taxonomy-utils";
import { TAXONOMY_VIEWS } from "../taxonomy-views";
import { isLiveDrilldownNode } from "@/lib/dynamic-taxon";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Collect all nodes in the tree (flat). */
function collectNodes(node: TaxonomyNode): TaxonomyNode[] {
  const result = [node];
  if (node.children) {
    for (const child of node.children) {
      result.push(...collectNodes(child));
    }
  }
  return result;
}

const allNodes = collectNodes(TAXONOMY_TREE);

// =============================================================================
// Tree integrity
// =============================================================================

describe("Taxonomy tree integrity", () => {
  it("root node is 'all'", () => {
    expect(TAXONOMY_TREE.id).toBe("all");
    expect(TAXONOMY_TREE.name).toBe("All Species");
  });

  it("every node has a unique ID", () => {
    const ids = allNodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every node has a non-empty name", () => {
    for (const node of allNodes) {
      expect(node.name.length, `${node.id} missing name`).toBeGreaterThan(0);
    }
  });

  // taxonGroups is the parquet partition predicate (`taxon_group IN (…)` — see
  // taxonomy-sql), so a parent that doesn't cover everything its children claim
  // prunes away its own descendants' rows: the child's node lists species the
  // parent's node silently omits. Nothing else catches that — the counts just
  // come back wrong. Verified to hold for all 139 nodes when written, so a
  // failure here means a new group was added to a child and not to its ancestors
  // (the likely path: extending ALL_INSECT_GROUPS or a virtual root's list).
  //
  // Deliberately a CHECK rather than a derivation. Deriving a node's groups from
  // its children would let 65 of the 139 declarations be deleted, but it makes a
  // node's partition scope non-local — you'd have to walk the tree to see why
  // ssc-otter is [mammals] — in the one config file where being explicit and
  // greppable is worth more than being short.
  it("every node's taxonGroups covers the union of its children's", () => {
    for (const node of allNodes) {
      if (!node.children?.length) continue;
      const own = new Set(node.filter.taxonGroups);
      for (const child of node.children) {
        for (const group of child.filter.taxonGroups) {
          expect(
            own.has(group),
            `${node.id} is missing taxonGroup "${group}" claimed by its child ${child.id}`
          ).toBe(true);
        }
      }
    }
  });

  it("every node has at least one taxonGroup in its filter", () => {
    for (const node of allNodes) {
      expect(
        node.filter.taxonGroups.length,
        `${node.id} has no taxonGroups`
      ).toBeGreaterThan(0);
    }
  });

  it("every node with estimatedDescribed has a source", () => {
    for (const node of allNodes) {
      if (node.estimatedDescribed && node.estimatedDescribed > 0) {
        expect(
          node.estimatedSource?.length,
          `${node.id} missing estimatedSource`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("no filter has both orderNames and excludeOrders set", () => {
    for (const node of allNodes) {
      const hasInclude = node.filter.orderNames && node.filter.orderNames.length > 0;
      const hasExclude = node.filter.excludeOrders && node.filter.excludeOrders.length > 0;
      expect(
        !!(hasInclude && hasExclude),
        `${node.id} has both orderNames and excludeOrders`
      ).toBe(false);
    }
  });

  it("NODE_INDEX contains all nodes", () => {
    expect(NODE_INDEX.size).toBe(allNodes.length);
    for (const node of allNodes) {
      expect(NODE_INDEX.has(node.id)).toBe(true);
    }
  });

  it("PARENT_INDEX has entries for all non-root nodes", () => {
    for (const node of allNodes) {
      if (node.id === "all") continue;
      expect(PARENT_INDEX.has(node.id), `${node.id} missing from PARENT_INDEX`).toBe(true);
    }
  });
});

// =============================================================================
// Default view contains expected top-level taxa
// =============================================================================

describe("Default view roots", () => {
  const defaultRoots = ["mammals", "birds", "reptiles", "amphibians", "fishes", "invertebrates", "plantae", "fungi"];

  it("all default view roots exist in the tree", () => {
    for (const id of defaultRoots) {
      expect(findNode(id), `${id} not found in tree`).toBeDefined();
    }
  });

  it("all default view roots have colors", () => {
    for (const id of defaultRoots) {
      const node = findNode(id)!;
      expect(node.color, `${id} missing color`).toBeTruthy();
    }
  });
});

// =============================================================================
// Table 1a groups exist
// =============================================================================

describe("Table 1a groups", () => {
  const table1aGroups = [
    "mammals", "birds", "reptiles", "amphibians", "fishes",
    "insects", "arachnids", "molluscs", "crustaceans", "corals",
    "other_invertebrates", "velvet_worms", "horseshoe_crabs",
    "flowering_plants", "gymnosperms", "ferns_and_allies", "mosses",
    "green_algae", "red_algae",
    "mushrooms", "brown_algae",
  ];

  it("all 21 Table 1a group nodes exist (Insects is one node aggregating 8 order groups)", () => {
    for (const id of table1aGroups) {
      expect(findNode(id), `${id} not found`).toBeDefined();
    }
  });
});

// =============================================================================
// Mammal subgroups (new)
// =============================================================================

// Static order/class-level children for Mammals/Reptiles/Amphibians/Fishes/
// Insects (formerly tested here as "New mammal subgroups" / "Aves is a leaf" /
// "Existing subgroups preserved") were retired in Phase 8 — all 5 roots are
// DYNAMIC_DRILLDOWN_ROOTS now (dynamic-taxon.ts), replaced by live
// order/class-level DuckDB enumeration. Equivalent regression coverage lives
// in src/lib/__tests__/dynamic-taxon.test.ts (id round-trip, nextDynamicRank,
// dynamicNodeFilter, speciesMatchesNode-with-dynamic-id) and
// src/lib/__tests__/taxonomy-sql.test.ts (order/class alias expansion +
// GROUP BY canonicalization for the label-split bugs found along the way).

describe("Birds/Mammals/Reptiles/Amphibians/Fishes gained live drilldown (Phase 8)", () => {
  it("all 5 are DYNAMIC_DRILLDOWN_ROOTS and have no static children left", () => {
    for (const id of ["mammals", "birds", "reptiles", "amphibians", "fishes"]) {
      expect(isLiveDrilldownNode(id), `${id} should be a live drilldown root`).toBe(true);
      expect(findNode(id)?.children, `${id} should have no static children left`).toBeUndefined();
    }
  });
});

// =============================================================================
// Utility functions
// =============================================================================

describe("findNode", () => {
  it("returns node for known id", () => {
    const node = findNode("inv-corals");
    expect(node).toBeDefined();
    expect(node!.name).toBe("Corals & Cnidarians");
  });

  it("returns undefined for unknown id", () => {
    expect(findNode("nonexistent")).toBeUndefined();
  });
});

describe("getNodeDef", () => {
  it("returns node + parentId for known child", () => {
    const result = getNodeDef("inv-corals");
    expect(result).not.toBeNull();
    expect(result!.node.name).toBe("Corals & Cnidarians");
    expect(result!.parentId).toBe("invertebrates");
  });

  it("returns null for unknown id", () => {
    expect(getNodeDef("nonexistent")).toBeNull();
  });

  it("returns null for root (no parent)", () => {
    expect(getNodeDef("all")).toBeNull();
  });
});

describe("hasChildren", () => {
  it("returns true for expandable nodes (virtual grouping nodes still have real static children)", () => {
    expect(hasChildren("invertebrates")).toBe(true);
    expect(hasChildren("plantae")).toBe(true);
    expect(hasChildren("fungi")).toBe(true);
  });

  it("returns false for leaf nodes, including the 5 roots that retired their static children for live drilldown (Phase 8)", () => {
    expect(hasChildren("birds")).toBe(false);
    expect(hasChildren("mammals")).toBe(false);
    expect(hasChildren("reptiles")).toBe(false);
    expect(hasChildren("insects")).toBe(false);
    expect(hasChildren("arachnids")).toBe(false);
    expect(hasChildren("velvet_worms")).toBe(false);
    expect(hasChildren("horseshoe_crabs")).toBe(false);
  });
});

describe("getAncestors", () => {
  it("returns ancestors for deeply nested node", () => {
    const ancestors = getAncestors("inv-corals");
    expect(ancestors).toContain("invertebrates");
    expect(ancestors).toContain("all");
  });

  it("returns empty array for root", () => {
    expect(getAncestors("all")).toEqual([]);
  });
});

describe("getNodePath", () => {
  it("returns full path from root to node", () => {
    const path = getNodePath("inv-corals");
    expect(path[0]).toBe("all");
    expect(path[path.length - 1]).toBe("inv-corals");
    expect(path).toContain("invertebrates");
  });
});

describe("getTaxonGroupsForNode", () => {
  it("returns single group for Table 1a leaf node", () => {
    expect(getTaxonGroupsForNode("mammals")).toEqual(["mammals"]);
    expect(getTaxonGroupsForNode("beetles")).toEqual(["beetles"]);
  });

  it("returns the 8 order groups for the insects parent node", () => {
    const groups = getTaxonGroupsForNode("insects");
    expect(groups).toContain("beetles");
    expect(groups).toContain("other_insects");
    expect(groups.length).toBe(8);
  });

  it("returns multiple groups for virtual node", () => {
    const groups = getTaxonGroupsForNode("invertebrates");
    expect(groups).toContain("beetles");
    expect(groups).toContain("molluscs");
    expect(groups).toContain("crustaceans");
  });

  it("returns all 28 groups for 'all'", () => {
    expect(getTaxonGroupsForNode("all").length).toBe(28);
  });
});

// =============================================================================
// speciesMatchesNode — orderNames/classNames filter, mammal/insect subgroups,
// and the order_name-empty class_name fallback (Reptiles' squamates/
// turtles-tortoises, Fishes' ray-finned-fishes/sharks-rays, Mammals' rodents/
// bats/artiodactyls/other-mammals, Insects' per-CSV-group subgroups) were all
// retired with their static nodes in Phase 8. matchesFilter's underlying
// order/class/family/genus/case-insensitive/empty-order-falls-back-to-class
// matching logic is unchanged and still exercised below (families/
// excludeClasses/genera/speciesNames) and via dynamic-taxon.test.ts's
// speciesMatchesNode-with-a-dynamic-id regression suite, which covers the
// same ground (order rejection, taxonGroup scoping, family narrowing) against
// the live mechanism that replaced these nodes.
// =============================================================================

describe("speciesMatchesNode – edge cases", () => {
  it("returns true for a genuinely unknown, non-dynamic node id (no filtering)", () => {
    const species = { taxon_group: "reptiles", class_name: null, order_name: null };
    expect(speciesMatchesNode(species, "nonexistent-subgroup")).toBe(true);
  });
});

// =============================================================================
// matchesFilter — families filter (new for cetaceans)
// =============================================================================

describe("matchesFilter – families filter", () => {
  it("matches species with family in include list", () => {
    const row = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Delphinidae" };
    const filter = { taxonGroups: ["mammals"], orderNames: ["artiodactyla", "sirenia"], families: ["delphinidae", "trichechidae", "dugongidae"] };
    expect(matchesFilter(row, filter)).toBe(true);
  });

  it("rejects species with family not in include list", () => {
    const row = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae" };
    const filter = { taxonGroups: ["mammals"], orderNames: ["artiodactyla", "sirenia"], families: ["delphinidae", "trichechidae", "dugongidae"] };
    expect(matchesFilter(row, filter)).toBe(false);
  });

  it("excludeFamilies rejects matching family", () => {
    const row = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Delphinidae" };
    const filter = { taxonGroups: ["mammals"], orderNames: ["artiodactyla"], excludeFamilies: ["delphinidae", "ziphiidae"] };
    expect(matchesFilter(row, filter)).toBe(false);
  });

  it("excludeFamilies passes non-matching family", () => {
    const row = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae" };
    const filter = { taxonGroups: ["mammals"], orderNames: ["artiodactyla"], excludeFamilies: ["delphinidae", "ziphiidae"] };
    expect(matchesFilter(row, filter)).toBe(true);
  });
});

// =============================================================================
// matchesFilter — excludeClasses filter (new for other_invertebrates catch-all)
// =============================================================================

describe("matchesFilter – excludeClasses filter", () => {
  it("excludes species with class in exclude list", () => {
    const row = { class_name: "Echinoidea", order_name: null };
    const filter = { taxonGroups: ["other_invertebrates"], excludeClasses: ["asteroidea", "echinoidea", "holothuroidea"] };
    expect(matchesFilter(row, filter)).toBe(false);
  });

  it("passes species with class not in exclude list", () => {
    const row = { class_name: "Bivalvia", order_name: null };
    const filter = { taxonGroups: ["other_invertebrates"], excludeClasses: ["asteroidea", "echinoidea", "holothuroidea"] };
    expect(matchesFilter(row, filter)).toBe(true);
  });

  it("passes species with null class_name", () => {
    const row = { class_name: null, order_name: null };
    const filter = { taxonGroups: ["other_invertebrates"], excludeClasses: ["asteroidea", "echinoidea"] };
    expect(matchesFilter(row, filter)).toBe(true);
  });
});

// =============================================================================
// matchesFilter — genera / speciesNames filters (SSC Specialist Groups)
// =============================================================================

describe("matchesFilter – genera filter", () => {
  it("matches species with genus (first token of scientific_name) in include list", () => {
    const row = { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae", scientific_name: "Ursus arctos" };
    const filter = { taxonGroups: ["mammals"], genera: ["ursus", "helarctos"] };
    expect(matchesFilter(row, filter)).toBe(true);
  });

  it("rejects species with genus not in include list", () => {
    const row = { class_name: "Mammalia", order_name: "Carnivora", family: "Felidae", scientific_name: "Panthera leo" };
    const filter = { taxonGroups: ["mammals"], genera: ["ursus", "helarctos"] };
    expect(matchesFilter(row, filter)).toBe(false);
  });

  it("excludeGenera rejects matching genus", () => {
    const row = { class_name: "Mammalia", order_name: "Carnivora", family: "Mustelidae", scientific_name: "Lutra lutra" };
    const filter = { taxonGroups: ["mammals"], families: ["mustelidae"], excludeGenera: ["lutra", "pteronura"] };
    expect(matchesFilter(row, filter)).toBe(false);
  });

  it("excludeGenera passes non-matching genus", () => {
    const row = { class_name: "Mammalia", order_name: "Carnivora", family: "Mustelidae", scientific_name: "Mustela nivalis" };
    const filter = { taxonGroups: ["mammals"], families: ["mustelidae"], excludeGenera: ["lutra", "pteronura"] };
    expect(matchesFilter(row, filter)).toBe(true);
  });

  it("treats a missing scientific_name as no genus (fails an include filter)", () => {
    const row = { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae" };
    const filter = { taxonGroups: ["mammals"], genera: ["ursus"] };
    expect(matchesFilter(row, filter)).toBe(false);
  });
});

describe("matchesFilter – speciesNames filter", () => {
  it("matches species with scientific_name in include list (case-insensitive)", () => {
    const row = { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae", scientific_name: "Ursus Maritimus" };
    const filter = { taxonGroups: ["mammals"], speciesNames: ["ursus maritimus"] };
    expect(matchesFilter(row, filter)).toBe(true);
  });

  it("rejects species with scientific_name not in include list", () => {
    const row = { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae", scientific_name: "Ursus arctos" };
    const filter = { taxonGroups: ["mammals"], speciesNames: ["ursus maritimus"] };
    expect(matchesFilter(row, filter)).toBe(false);
  });

  it("excludeSpeciesNames carves a single species out of a family-level filter", () => {
    const polarBear = { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae", scientific_name: "Ursus maritimus" };
    const brownBear = { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae", scientific_name: "Ursus arctos" };
    const filter = { taxonGroups: ["mammals"], families: ["ursidae"], excludeSpeciesNames: ["ursus maritimus"] };
    expect(matchesFilter(polarBear, filter)).toBe(false);
    expect(matchesFilter(brownBear, filter)).toBe(true);
  });
});

// =============================================================================
// SSC Specialist Groups (pilot: mammals)
// =============================================================================

describe("SSC Specialist Groups tree", () => {
  const sscNode = findNode("ssc-groups");

  it("ssc-groups exists, is not part of the default view, and has 36 children (35 pilot groups + remainder)", () => {
    expect(sscNode).toBeDefined();
    expect(sscNode?.children?.length).toBe(36);
    expect(TAXONOMY_VIEWS.default.roots).not.toContain("ssc-groups");
  });

  it("ssc-other-mammals (the remainder row) doesn't overlap any of the 35 named groups", () => {
    // Species that should land in each named group's scope must NOT also match
    // the remainder filter — otherwise the remainder double-counts them.
    const cases: Array<{ class_name: string; order_name: string; family: string; scientific_name: string }> = [
      { class_name: "Mammalia", order_name: "Chiroptera", family: "Pteropodidae", scientific_name: "Pteropus vampyrus" },
      { class_name: "Mammalia", order_name: "Carnivora", family: "Felidae", scientific_name: "Panthera tigris" },
      { class_name: "Mammalia", order_name: "Artiodactyla", family: "Delphinidae", scientific_name: "Tursiops truncatus" },
      { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Bison bison" },
      { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Gazella dorcas" },
      { class_name: "Mammalia", order_name: "Proboscidea", family: "Elephantidae", scientific_name: "Loxodonta africana" },
      { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae", scientific_name: "Ursus maritimus" },
      { class_name: "Mammalia", order_name: "Carnivora", family: "Mustelidae", scientific_name: "Lutra lutra" },
      { class_name: "Mammalia", order_name: "Carnivora", family: "Mustelidae", scientific_name: "Mustela nivalis" },
      { class_name: "Mammalia", order_name: "Artiodactyla", family: "Camelidae", scientific_name: "Vicugna vicugna" },
      // extraSpeciesNames additions (Antelope SG) and the Ailuridae addition
      // (Small Carnivore SG) — must not double-count into the remainder either.
      { class_name: "Mammalia", order_name: "Artiodactyla", family: "Antilocapridae", scientific_name: "Antilocapra americana" },
      { class_name: "Mammalia", order_name: "Artiodactyla", family: "Tragulidae", scientific_name: "Hyemoschus aquaticus" },
      { class_name: "Mammalia", order_name: "Artiodactyla", family: "Camelidae", scientific_name: "Camelus ferus" },
      { class_name: "Mammalia", order_name: "Carnivora", family: "Ailuridae", scientific_name: "Ailurus fulgens" },
    ];
    for (const row of cases) {
      expect(speciesMatchesNode({ ...row, taxon_group: "mammals" }, "ssc-other-mammals"), row.scientific_name).toBe(false);
    }
  });

  it("ssc-other-mammals catches a genuinely uncovered species (colugo, no dedicated SSC group)", () => {
    const colugo = { class_name: "Mammalia", order_name: "Dermoptera", family: "Cynocephalidae", scientific_name: "Galeopterus variegatus", taxon_group: "mammals" };
    expect(speciesMatchesNode(colugo, "ssc-other-mammals")).toBe(true);
  });

  it("Deer SG's real remit extends to musk deer (Moschidae) and chevrotains (Tragulidae), not just true deer", () => {
    const muskDeer = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Moschidae", scientific_name: "Moschus moschiferus", taxon_group: "mammals" };
    const chevrotain = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Tragulidae", scientific_name: "Tragulus javanicus", taxon_group: "mammals" };
    expect(speciesMatchesNode(muskDeer, "ssc-deer")).toBe(true);
    expect(speciesMatchesNode(chevrotain, "ssc-deer")).toBe(true);
    expect(speciesMatchesNode(muskDeer, "ssc-other-mammals")).toBe(false);
    // Water Chevrotain stays with Antelope SG (its own stated remit), not Deer SG.
    const waterChevrotain = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Tragulidae", scientific_name: "Hyemoschus aquaticus", taxon_group: "mammals" };
    expect(speciesMatchesNode(waterChevrotain, "ssc-deer")).toBe(false);
    expect(speciesMatchesNode(waterChevrotain, "ssc-antelope")).toBe(true);
  });

  it("Caprinae SG includes Arabian Tahr and Bharal, not Antelope SG", () => {
    const tahr = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Arabitragus jayakari", taxon_group: "mammals" };
    const bharal = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Pseudois nayaur", taxon_group: "mammals" };
    expect(speciesMatchesNode(tahr, "ssc-caprinae")).toBe(true);
    expect(speciesMatchesNode(bharal, "ssc-caprinae")).toBe(true);
    expect(speciesMatchesNode(tahr, "ssc-antelope")).toBe(false);
    expect(speciesMatchesNode(bharal, "ssc-antelope")).toBe(false);
  });

  it("Antelope SG's extraSpeciesNames pulls in Pronghorn, Water Chevrotain, and Wild Camel despite them not being Bovidae", () => {
    const pronghorn = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Antilocapridae", scientific_name: "Antilocapra americana", taxon_group: "mammals" };
    const chevrotain = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Tragulidae", scientific_name: "Hyemoschus aquaticus", taxon_group: "mammals" };
    const camel = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Camelidae", scientific_name: "Camelus ferus", taxon_group: "mammals" };
    expect(speciesMatchesNode(pronghorn, "ssc-antelope")).toBe(true);
    expect(speciesMatchesNode(chevrotain, "ssc-antelope")).toBe(true);
    expect(speciesMatchesNode(camel, "ssc-antelope")).toBe(true);
    // Wild Camel is still correctly excluded from Wild Camelid SG (South American
    // camelids only — Lama/Vicugna) despite now belonging to Antelope SG.
    expect(speciesMatchesNode(camel, "ssc-wild-camelid")).toBe(false);
    // A South American camelid must NOT be pulled into Antelope SG by the same
    // escape hatch — extraSpeciesNames is a specific named list, not a rank filter.
    const guanaco = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Camelidae", scientific_name: "Lama guanicoe", taxon_group: "mammals" };
    expect(speciesMatchesNode(guanaco, "ssc-antelope")).toBe(false);
    expect(speciesMatchesNode(guanaco, "ssc-wild-camelid")).toBe(true);
  });

  it("Small Carnivore SG includes red pandas (Ailuridae), confirmed via the group's own site", () => {
    const redPanda = { class_name: "Mammalia", order_name: "Carnivora", family: "Ailuridae", scientific_name: "Ailurus fulgens", taxon_group: "mammals" };
    expect(speciesMatchesNode(redPanda, "ssc-small-carnivore")).toBe(true);
  });

  it("all SSC group children use the mammals taxonGroup and have a unique id", () => {
    const ids = new Set<string>();
    for (const child of sscNode?.children ?? []) {
      expect(child.filter.taxonGroups).toEqual(["mammals"]);
      expect(ids.has(child.id), `duplicate id ${child.id}`).toBe(false);
      ids.add(child.id);
    }
  });

  it("does not add any new children to the real 'mammals' node", () => {
    const mammalNode = findNode("mammals");
    const mammalChildIds = new Set(mammalNode?.children?.map(c => c.id) ?? []);
    for (const child of sscNode?.children ?? []) {
      expect(mammalChildIds.has(child.id)).toBe(false);
    }
  });

  it("Bear SG and Polar Bear SG partition Ursidae without overlap", () => {
    const polarBear = { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae", scientific_name: "Ursus maritimus" };
    const brownBear = { class_name: "Mammalia", order_name: "Carnivora", family: "Ursidae", scientific_name: "Ursus arctos" };
    expect(speciesMatchesNode({ ...polarBear, taxon_group: "mammals" }, "ssc-bear")).toBe(false);
    expect(speciesMatchesNode({ ...polarBear, taxon_group: "mammals" }, "ssc-polar-bear")).toBe(true);
    expect(speciesMatchesNode({ ...brownBear, taxon_group: "mammals" }, "ssc-bear")).toBe(true);
    expect(speciesMatchesNode({ ...brownBear, taxon_group: "mammals" }, "ssc-polar-bear")).toBe(false);
  });

  it("Otter SG and Small Carnivore SG partition Mustelidae without overlap", () => {
    const otter = { class_name: "Mammalia", order_name: "Carnivora", family: "Mustelidae", scientific_name: "Lutra lutra", taxon_group: "mammals" };
    const weasel = { class_name: "Mammalia", order_name: "Carnivora", family: "Mustelidae", scientific_name: "Mustela nivalis", taxon_group: "mammals" };
    expect(speciesMatchesNode(otter, "ssc-otter")).toBe(true);
    expect(speciesMatchesNode(otter, "ssc-small-carnivore")).toBe(false);
    expect(speciesMatchesNode(weasel, "ssc-otter")).toBe(false);
    expect(speciesMatchesNode(weasel, "ssc-small-carnivore")).toBe(true);
  });

  it("Antelope SG excludes Caprinae, Bison and Wild Cattle genera within Bovidae", () => {
    const gazelle = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Gazella dorcas", taxon_group: "mammals" };
    const ibex = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Capra ibex", taxon_group: "mammals" };
    const bison = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Bison bison", taxon_group: "mammals" };
    const gaur = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Bos gaurus", taxon_group: "mammals" };
    expect(speciesMatchesNode(gazelle, "ssc-antelope")).toBe(true);
    expect(speciesMatchesNode(ibex, "ssc-antelope")).toBe(false);
    expect(speciesMatchesNode(ibex, "ssc-caprinae")).toBe(true);
    expect(speciesMatchesNode(bison, "ssc-antelope")).toBe(false);
    expect(speciesMatchesNode(bison, "ssc-bison")).toBe(true);
    expect(speciesMatchesNode(gaur, "ssc-antelope")).toBe(false);
    expect(speciesMatchesNode(gaur, "ssc-afro-asian-wild-cattle")).toBe(true);
  });

  it("African buffalo (Syncerus) stays under Antelope SG, not Wild Cattle SG", () => {
    const buffalo = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Syncerus caffer", taxon_group: "mammals" };
    expect(speciesMatchesNode(buffalo, "ssc-antelope")).toBe(true);
    expect(speciesMatchesNode(buffalo, "ssc-afro-asian-wild-cattle")).toBe(false);
  });

  it("Bos primigenius (extinct aurochs) is excluded from Asian Wild Cattle SG despite genus match — not one of its stated 9 species", () => {
    const aurochs = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Bovidae", scientific_name: "Bos primigenius", taxon_group: "mammals" };
    expect(speciesMatchesNode(aurochs, "ssc-afro-asian-wild-cattle")).toBe(false);
    expect(speciesMatchesNode(aurochs, "ssc-other-mammals")).toBe(true);
  });

  it("Cetacean SG matches by family since cetaceans share Artiodactyla's order_name", () => {
    const dolphin = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Delphinidae", scientific_name: "Tursiops truncatus", taxon_group: "mammals" };
    const deer = { class_name: "Mammalia", order_name: "Artiodactyla", family: "Cervidae", scientific_name: "Cervus elaphus", taxon_group: "mammals" };
    expect(speciesMatchesNode(dolphin, "ssc-cetacean")).toBe(true);
    expect(speciesMatchesNode(deer, "ssc-cetacean")).toBe(false);
    expect(speciesMatchesNode(deer, "ssc-deer")).toBe(true);
  });
});

describe("SSC Specialist Groups tree (reptiles)", () => {
  const sscReptileNode = findNode("ssc-reptile-groups");

  it("ssc-reptile-groups exists, is not part of the default view, and has 13 children (12 pilot groups + Snake and Lizard RLA)", () => {
    expect(sscReptileNode).toBeDefined();
    expect(sscReptileNode?.children?.length).toBe(13);
    expect(TAXONOMY_VIEWS.default.roots).not.toContain("ssc-reptile-groups");
  });

  it("ssc-snake-lizard-rla (the residual RLA) doesn't overlap any of the 12 named groups", () => {
    const cases: Array<{ class_name: string; order_name: string; family: string; scientific_name: string }> = [
      { class_name: "Reptilia", order_name: "Crocodylia", family: "Crocodylidae", scientific_name: "Crocodylus niloticus" },
      { class_name: "Reptilia", order_name: "Testudines", family: "Testudinidae", scientific_name: "Chelonoidis nigra" },
      { class_name: "Reptilia", order_name: "Testudines", family: "Cheloniidae", scientific_name: "Chelonia mydas" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Scincidae", scientific_name: "Tiliqua scincoides" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Chamaeleonidae", scientific_name: "Chamaeleo calyptratus" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Varanidae", scientific_name: "Varanus komodoensis" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Lanthanotidae", scientific_name: "Lanthanotus borneensis" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Iguanidae", scientific_name: "Iguana iguana" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Dactyloidae", scientific_name: "Anolis carolinensis" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Viperidae", scientific_name: "Vipera berus" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Elapidae", scientific_name: "Hydrophis platurus" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Homalopsidae", scientific_name: "Cerberus rynchops" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Acrochordidae", scientific_name: "Acrochordus javanicus" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Boidae", scientific_name: "Boa constrictor" },
      { class_name: "Reptilia", order_name: "Squamata", family: "Pythonidae", scientific_name: "Python bivittatus" },
      // The tuatara — claimed by the RLA itself via extraSpeciesNames, must not
      // also match the RLA's own base (exclude-everything-else) filter twice.
      { class_name: "Reptilia", order_name: "Rhynchocephalia", family: "Sphenodontidae", scientific_name: "Sphenodon punctatus" },
    ];
    for (const row of cases) {
      const isTuatara = row.scientific_name === "Sphenodon punctatus";
      const named = ["ssc-crocodile", "ssc-tortoise-freshwater-turtle", "ssc-marine-turtle", "ssc-skink", "ssc-chameleon", "ssc-monitor-lizard", "ssc-iguana", "ssc-anoline-lizard", "ssc-gekkota", "ssc-viper", "ssc-sea-snake", "ssc-boa-python"];
      const matchesNamed = named.some((id) => speciesMatchesNode({ ...row, taxon_group: "reptiles" }, id));
      expect(matchesNamed, row.scientific_name).toBe(!isTuatara);
      // The RLA only claims the tuatara (via extraSpeciesNames) among these
      // cases — everything else here is already claimed by a named group, so
      // the RLA's exclude-everything-else base filter must not also match it.
      expect(speciesMatchesNode({ ...row, taxon_group: "reptiles" }, "ssc-snake-lizard-rla")).toBe(isTuatara);
    }
  });

  it("ssc-snake-lizard-rla catches a genuinely uncovered species (whiptail lizard, no dedicated SSC group among the 12)", () => {
    const whiptail = { class_name: "Reptilia", order_name: "Squamata", family: "Teiidae", scientific_name: "Ameiva ameiva", taxon_group: "reptiles" };
    expect(speciesMatchesNode(whiptail, "ssc-snake-lizard-rla")).toBe(true);
  });

  it("Gekkota Lizard SG covers all 7 gecko families, not the Snake and Lizard RLA", () => {
    const gecko = { class_name: "Reptilia", order_name: "Squamata", family: "Gekkonidae", scientific_name: "Gekko gecko", taxon_group: "reptiles" };
    const legless = { class_name: "Reptilia", order_name: "Squamata", family: "Pygopodidae", scientific_name: "Lialis burtonis", taxon_group: "reptiles" };
    expect(speciesMatchesNode(gecko, "ssc-gekkota")).toBe(true);
    expect(speciesMatchesNode(legless, "ssc-gekkota")).toBe(true);
    expect(speciesMatchesNode(gecko, "ssc-snake-lizard-rla")).toBe(false);
  });

  it("ssc-snake-lizard-rla explicitly claims the tuatara via extraSpeciesNames despite it not being Squamata", () => {
    const tuatara = { class_name: "Reptilia", order_name: "Rhynchocephalia", family: "Sphenodontidae", scientific_name: "Sphenodon punctatus", taxon_group: "reptiles" };
    expect(speciesMatchesNode(tuatara, "ssc-snake-lizard-rla")).toBe(true);
  });

  it("Anoline Lizard SG is genus-scoped to Anolis, correctly excluding the related genus Polychrus despite sharing a family-label lineage", () => {
    const anole = { class_name: "Reptilia", order_name: "Squamata", family: "Dactyloidae", scientific_name: "Anolis carolinensis", taxon_group: "reptiles" };
    const anole2 = { class_name: "Reptilia", order_name: "Squamata", family: "Anolidae", scientific_name: "Anolis sagrei", taxon_group: "reptiles" };
    const bushAnole = { class_name: "Reptilia", order_name: "Squamata", family: "Polychrotidae", scientific_name: "Polychrus marmoratus", taxon_group: "reptiles" };
    expect(speciesMatchesNode(anole, "ssc-anoline-lizard")).toBe(true);
    expect(speciesMatchesNode(anole2, "ssc-anoline-lizard")).toBe(true);
    expect(speciesMatchesNode(bushAnole, "ssc-anoline-lizard")).toBe(false);
    expect(speciesMatchesNode(bushAnole, "ssc-snake-lizard-rla")).toBe(true);
  });

  it("Sea Snake SG's genus-level Elapidae filter excludes terrestrial elapids (cobras, mambas, coral snakes)", () => {
    const seaSnake = { class_name: "Reptilia", order_name: "Squamata", family: "Elapidae", scientific_name: "Hydrophis platurus", taxon_group: "reptiles" };
    const seaKrait = { class_name: "Reptilia", order_name: "Squamata", family: "Elapidae", scientific_name: "Laticauda colubrina", taxon_group: "reptiles" };
    const cobra = { class_name: "Reptilia", order_name: "Squamata", family: "Elapidae", scientific_name: "Naja naja", taxon_group: "reptiles" };
    const mamba = { class_name: "Reptilia", order_name: "Squamata", family: "Elapidae", scientific_name: "Dendroaspis polylepis", taxon_group: "reptiles" };
    expect(speciesMatchesNode(seaSnake, "ssc-sea-snake")).toBe(true);
    expect(speciesMatchesNode(seaKrait, "ssc-sea-snake")).toBe(true);
    expect(speciesMatchesNode(cobra, "ssc-sea-snake")).toBe(false);
    expect(speciesMatchesNode(cobra, "ssc-snake-lizard-rla")).toBe(true);
    expect(speciesMatchesNode(mamba, "ssc-sea-snake")).toBe(false);
    expect(speciesMatchesNode(mamba, "ssc-snake-lizard-rla")).toBe(true);
  });

  it("Sea Snake SG also claims all of Homalopsidae (mud snakes) and Acrochordidae (file snakes), unrelated families to Elapidae", () => {
    const mudSnake = { class_name: "Reptilia", order_name: "Squamata", family: "Homalopsidae", scientific_name: "Cerberus rynchops", taxon_group: "reptiles" };
    const fileSnake = { class_name: "Reptilia", order_name: "Squamata", family: "Acrochordidae", scientific_name: "Acrochordus javanicus", taxon_group: "reptiles" };
    expect(speciesMatchesNode(mudSnake, "ssc-sea-snake")).toBe(true);
    expect(speciesMatchesNode(fileSnake, "ssc-sea-snake")).toBe(true);
  });

  it("Sea Snake SG's Homalopsidae genus list includes Karnsophis (a monotypic genus missing from an earlier draft, found via a live CoL cross-check)", () => {
    const karnsophis = { class_name: "Reptilia", order_name: "Squamata", family: "Homalopsidae", scientific_name: "Karnsophis siantaris", taxon_group: "reptiles" };
    expect(speciesMatchesNode(karnsophis, "ssc-sea-snake")).toBe(true);
    expect(speciesMatchesNode(karnsophis, "ssc-snake-lizard-rla")).toBe(false);
  });

  it("Monitor Lizard SG includes Lanthanotidae (earless monitor lizard) alongside Varanidae, per the group's own site", () => {
    const komodo = { class_name: "Reptilia", order_name: "Squamata", family: "Varanidae", scientific_name: "Varanus komodoensis", taxon_group: "reptiles" };
    const earless = { class_name: "Reptilia", order_name: "Squamata", family: "Lanthanotidae", scientific_name: "Lanthanotus borneensis", taxon_group: "reptiles" };
    expect(speciesMatchesNode(komodo, "ssc-monitor-lizard")).toBe(true);
    expect(speciesMatchesNode(earless, "ssc-monitor-lizard")).toBe(true);
  });

  it("Marine Turtle SG and Tortoise/Freshwater Turtle SG partition Testudines without overlap", () => {
    const seaTurtle = { class_name: "Reptilia", order_name: "Testudines", family: "Cheloniidae", scientific_name: "Chelonia mydas", taxon_group: "reptiles" };
    const leatherback = { class_name: "Reptilia", order_name: "Testudines", family: "Dermochelyidae", scientific_name: "Dermochelys coriacea", taxon_group: "reptiles" };
    const tortoise = { class_name: "Reptilia", order_name: "Testudines", family: "Testudinidae", scientific_name: "Chelonoidis nigra", taxon_group: "reptiles" };
    expect(speciesMatchesNode(seaTurtle, "ssc-marine-turtle")).toBe(true);
    expect(speciesMatchesNode(seaTurtle, "ssc-tortoise-freshwater-turtle")).toBe(false);
    expect(speciesMatchesNode(leatherback, "ssc-marine-turtle")).toBe(true);
    expect(speciesMatchesNode(leatherback, "ssc-tortoise-freshwater-turtle")).toBe(false);
    expect(speciesMatchesNode(tortoise, "ssc-marine-turtle")).toBe(false);
    expect(speciesMatchesNode(tortoise, "ssc-tortoise-freshwater-turtle")).toBe(true);
  });

  it("Boa and Python SG covers modern Boidae splits (sand boas etc.) but not the ~10 more distant relict families left to the RLA", () => {
    const boa = { class_name: "Reptilia", order_name: "Squamata", family: "Boidae", scientific_name: "Boa constrictor", taxon_group: "reptiles" };
    const python = { class_name: "Reptilia", order_name: "Squamata", family: "Pythonidae", scientific_name: "Python bivittatus", taxon_group: "reptiles" };
    const sandBoa = { class_name: "Reptilia", order_name: "Squamata", family: "Erycidae", scientific_name: "Eryx johnii", taxon_group: "reptiles" };
    const shieldTail = { class_name: "Reptilia", order_name: "Squamata", family: "Uropeltidae", scientific_name: "Uropeltis melanogaster", taxon_group: "reptiles" };
    expect(speciesMatchesNode(boa, "ssc-boa-python")).toBe(true);
    expect(speciesMatchesNode(python, "ssc-boa-python")).toBe(true);
    expect(speciesMatchesNode(sandBoa, "ssc-boa-python")).toBe(true);
    expect(speciesMatchesNode(shieldTail, "ssc-boa-python")).toBe(false);
    expect(speciesMatchesNode(shieldTail, "ssc-snake-lizard-rla")).toBe(true);
  });

  it("all ssc-reptile-groups children use the reptiles taxonGroup and have a unique id", () => {
    const ids = new Set<string>();
    for (const child of sscReptileNode?.children ?? []) {
      expect(child.filter.taxonGroups).toEqual(["reptiles"]);
      expect(ids.has(child.id), `duplicate id ${child.id}`).toBe(false);
      ids.add(child.id);
    }
  });

  it("does not add any new children to the real 'reptiles' node", () => {
    const reptilesNode = findNode("reptiles");
    const reptileChildIds = new Set(reptilesNode?.children?.map(c => c.id) ?? []);
    for (const child of sscReptileNode?.children ?? []) {
      expect(reptileChildIds.has(child.id)).toBe(false);
    }
  });
});

describe("SSC Specialist Groups tree (fishes)", () => {
  const sscFishNode = findNode("ssc-fish-groups");

  it("ssc-fish-groups exists, is not part of the default view, and has 10 children (9 pilot groups + remainder)", () => {
    expect(sscFishNode).toBeDefined();
    expect(sscFishNode?.children?.length).toBe(10);
    expect(TAXONOMY_VIEWS.default.roots).not.toContain("ssc-fish-groups");
  });

  it("ssc-other-fish (the remainder row) doesn't overlap any of the 9 named groups", () => {
    const cases: Array<{ class_name: string; order_name: string; family: string; scientific_name: string }> = [
      { class_name: "Chondrichthyes", order_name: "Carcharhiniformes", family: "Carcharhinidae", scientific_name: "Carcharhinus leucas" },
      { class_name: "Chondrichthyes", order_name: "Chimaeriformes", family: "Chimaeridae", scientific_name: "Chimaera monstrosa" },
      { class_name: "Actinopterygii", order_name: "Perciformes", family: "Serranidae", scientific_name: "Epinephelus marginatus" },
      { class_name: "Actinopterygii", order_name: "Perciformes", family: "Labridae", scientific_name: "Cheilinus undulatus" },
      { class_name: "Actinopterygii", order_name: "Perciformes", family: "Lutjanidae", scientific_name: "Lutjanus campechanus" },
      { class_name: "Actinopterygii", order_name: "Perciformes", family: "Sparidae", scientific_name: "Sparus aurata" },
      { class_name: "Actinopterygii", order_name: "Syngnathiformes", family: "Syngnathidae", scientific_name: "Hippocampus kuda" },
      { class_name: "Actinopterygii", order_name: "Syngnathiformes", family: "Solenostomidae", scientific_name: "Solenostomus paradoxus" },
      { class_name: "Actinopterygii", order_name: "Acanthuriformes", family: "Sciaenidae", scientific_name: "Argyrosomus regius" },
      { class_name: "Actinopterygii", order_name: "Salmoniformes", family: "Salmonidae", scientific_name: "Salmo salar" },
      { class_name: "Actinopterygii", order_name: "Scombriformes", family: "Scombridae", scientific_name: "Thunnus albacares" },
      { class_name: "Actinopterygii", order_name: "Istiophoriformes", family: "Istiophoridae", scientific_name: "Makaira nigricans" },
      { class_name: "Actinopterygii", order_name: "Acipenseriformes", family: "Acipenseridae", scientific_name: "Acipenser sturio" },
      { class_name: "Actinopterygii", order_name: "Acipenseriformes", family: "Polyodontidae", scientific_name: "Polyodon spathula" },
      { class_name: "Actinopterygii", order_name: "Anguilliformes", family: "Anguillidae", scientific_name: "Anguilla anguilla" },
    ];
    for (const row of cases) {
      expect(speciesMatchesNode({ ...row, taxon_group: "fishes" }, "ssc-other-fish"), row.scientific_name).toBe(false);
    }
  });

  it("ssc-other-fish catches a genuinely uncovered species (a cyprinid, no dedicated SSC group among the 9)", () => {
    const carp = { class_name: "Actinopterygii", order_name: "Cypriniformes", family: "Cyprinidae", scientific_name: "Cyprinus carpio", taxon_group: "fishes" };
    expect(speciesMatchesNode(carp, "ssc-other-fish")).toBe(true);
  });

  it("ssc-other-fish also catches marine gobies etc. despite the Freshwater Fish SG's own remit claiming 'all freshwater fishes' — that group is deliberately not built (habitat data unavailable for unassessed species)", () => {
    const goby = { class_name: "Actinopterygii", order_name: "Gobiiformes", family: "Gobiidae", scientific_name: "Gobius niger", taxon_group: "fishes" };
    expect(speciesMatchesNode(goby, "ssc-other-fish")).toBe(true);
    expect(findNode("ssc-freshwater-fish")).toBeUndefined();
  });

  it("Shark SG matches by class (Chondrichthyes), covering sharks, rays, skates, AND chimaeras", () => {
    const shark = { class_name: "Chondrichthyes", order_name: "Carcharhiniformes", family: "Carcharhinidae", scientific_name: "Carcharhinus leucas", taxon_group: "fishes" };
    const ray = { class_name: "Chondrichthyes", order_name: "Myliobatiformes", family: "Dasyatidae", scientific_name: "Dasyatis pastinaca", taxon_group: "fishes" };
    const chimaera = { class_name: "Chondrichthyes", order_name: "Chimaeriformes", family: "Chimaeridae", scientific_name: "Chimaera monstrosa", taxon_group: "fishes" };
    expect(speciesMatchesNode(shark, "ssc-shark")).toBe(true);
    expect(speciesMatchesNode(ray, "ssc-shark")).toBe(true);
    expect(speciesMatchesNode(chimaera, "ssc-shark")).toBe(true);
  });

  it("Shark SG also matches unassessed sharks/rays, which carry 'elasmobranchii'/'holocephali' as class_name instead of 'chondrichthyes' (assessed-only label)", () => {
    const unassessedShark = { class_name: "Elasmobranchii", order_name: "Carcharhiniformes", family: "Carcharhinidae", scientific_name: "Carcharhinus obscurior", taxon_group: "fishes" };
    const unassessedChimaera = { class_name: "Holocephali", order_name: "Chimaeriformes", family: "Chimaeridae", scientific_name: "Chimaera bahamaensis", taxon_group: "fishes" };
    expect(speciesMatchesNode(unassessedShark, "ssc-shark")).toBe(true);
    expect(speciesMatchesNode(unassessedChimaera, "ssc-shark")).toBe(true);
    expect(speciesMatchesNode(unassessedShark, "ssc-other-fish")).toBe(false);
  });

  it("Shark SG excludes extinct fossil species and unresolved-name placeholders found in the unassessed data", () => {
    const fossil1 = { class_name: "Elasmobranchii", order_name: "Lamniformes", family: "Lamnidae", scientific_name: "Isurus desori", taxon_group: "fishes" };
    const fossil2 = { class_name: "Elasmobranchii", order_name: "Lamniformes", family: "Lamnidae", scientific_name: "Oxyrhina hastalis", taxon_group: "fishes" };
    const placeholder = { class_name: "Elasmobranchii", order_name: "Carcharhiniformes", family: "Carcharhinidae", scientific_name: "Carcharhinus spec", taxon_group: "fishes" };
    for (const row of [fossil1, fossil2, placeholder]) {
      expect(speciesMatchesNode(row, "ssc-shark"), row.scientific_name).toBe(false);
      // Also excluded from the catch-all — these aren't real extant species
      // that should appear anywhere in the dashboard.
      expect(speciesMatchesNode(row, "ssc-other-fish"), row.scientific_name).toBe(false);
    }
  });

  it("Grouper and Wrasse SG covers both grouper family labels (Serranidae and Epinephelidae) plus wrasses and parrotfishes", () => {
    const grouper1 = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Serranidae", scientific_name: "Epinephelus marginatus", taxon_group: "fishes" };
    const grouper2 = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Epinephelidae", scientific_name: "Epinephelus itajara", taxon_group: "fishes" };
    const wrasse = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Labridae", scientific_name: "Cheilinus undulatus", taxon_group: "fishes" };
    const parrotfish = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Scaridae", scientific_name: "Scarus vetula", taxon_group: "fishes" };
    expect(speciesMatchesNode(grouper1, "ssc-grouper-wrasse")).toBe(true);
    expect(speciesMatchesNode(grouper2, "ssc-grouper-wrasse")).toBe(true);
    expect(speciesMatchesNode(wrasse, "ssc-grouper-wrasse")).toBe(true);
    expect(speciesMatchesNode(parrotfish, "ssc-grouper-wrasse")).toBe(true);
  });

  it("Snapper, Seabream and Grunt SG covers all 6 families named in its own scope statement, not just the 3 in its name", () => {
    const snapper = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Lutjanidae", scientific_name: "Lutjanus campechanus", taxon_group: "fishes" };
    const threadfinBream = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Nemipteridae", scientific_name: "Nemipterus japonicus", taxon_group: "fishes" };
    const emperor = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Lethrinidae", scientific_name: "Lethrinus nebulosus", taxon_group: "fishes" };
    const fusilier = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Caesionidae", scientific_name: "Caesio cuning", taxon_group: "fishes" };
    // Mojarras (Gerreidae) are a similar reef-fish family but NOT named in the
    // group's own scope statement — deliberately excluded, falls to the catch-all.
    const mojarra = { class_name: "Actinopterygii", order_name: "Perciformes", family: "Gerreidae", scientific_name: "Gerres cinereus", taxon_group: "fishes" };
    expect(speciesMatchesNode(snapper, "ssc-snapper-seabream-grunt")).toBe(true);
    expect(speciesMatchesNode(threadfinBream, "ssc-snapper-seabream-grunt")).toBe(true);
    expect(speciesMatchesNode(emperor, "ssc-snapper-seabream-grunt")).toBe(true);
    expect(speciesMatchesNode(fusilier, "ssc-snapper-seabream-grunt")).toBe(true);
    expect(speciesMatchesNode(mojarra, "ssc-snapper-seabream-grunt")).toBe(false);
    expect(speciesMatchesNode(mojarra, "ssc-other-fish")).toBe(true);
  });

  it("Seahorse, Pipefish and Seadragon SG covers the whole order Syngnathiformes (5 families), not just Syngnathidae", () => {
    const seahorse = { class_name: "Actinopterygii", order_name: "Syngnathiformes", family: "Syngnathidae", scientific_name: "Hippocampus kuda", taxon_group: "fishes" };
    const ghostPipefish = { class_name: "Actinopterygii", order_name: "Syngnathiformes", family: "Solenostomidae", scientific_name: "Solenostomus paradoxus", taxon_group: "fishes" };
    const trumpetfish = { class_name: "Actinopterygii", order_name: "Syngnathiformes", family: "Aulostomidae", scientific_name: "Aulostomus chinensis", taxon_group: "fishes" };
    expect(speciesMatchesNode(seahorse, "ssc-seahorse-pipefish-seadragon")).toBe(true);
    expect(speciesMatchesNode(ghostPipefish, "ssc-seahorse-pipefish-seadragon")).toBe(true);
    expect(speciesMatchesNode(trumpetfish, "ssc-seahorse-pipefish-seadragon")).toBe(true);
  });

  it("Tuna and Billfish SG covers the whole family Scombridae (mackerels/bonitos too, not just tuna genera) plus both billfish families", () => {
    const tuna = { class_name: "Actinopterygii", order_name: "Scombriformes", family: "Scombridae", scientific_name: "Thunnus albacares", taxon_group: "fishes" };
    const mackerel = { class_name: "Actinopterygii", order_name: "Scombriformes", family: "Scombridae", scientific_name: "Scomber scombrus", taxon_group: "fishes" };
    const marlin = { class_name: "Actinopterygii", order_name: "Istiophoriformes", family: "Istiophoridae", scientific_name: "Makaira nigricans", taxon_group: "fishes" };
    const swordfish = { class_name: "Actinopterygii", order_name: "Istiophoriformes", family: "Xiphiidae", scientific_name: "Xiphias gladius", taxon_group: "fishes" };
    expect(speciesMatchesNode(tuna, "ssc-tuna-billfish")).toBe(true);
    expect(speciesMatchesNode(mackerel, "ssc-tuna-billfish")).toBe(true);
    expect(speciesMatchesNode(marlin, "ssc-tuna-billfish")).toBe(true);
    expect(speciesMatchesNode(swordfish, "ssc-tuna-billfish")).toBe(true);
  });

  it("Sturgeon SG covers both families of order Acipenseriformes (sturgeons and paddlefish), not sturgeons alone", () => {
    const sturgeon = { class_name: "Actinopterygii", order_name: "Acipenseriformes", family: "Acipenseridae", scientific_name: "Acipenser sturio", taxon_group: "fishes" };
    const paddlefish = { class_name: "Actinopterygii", order_name: "Acipenseriformes", family: "Polyodontidae", scientific_name: "Polyodon spathula", taxon_group: "fishes" };
    expect(speciesMatchesNode(sturgeon, "ssc-sturgeon")).toBe(true);
    expect(speciesMatchesNode(paddlefish, "ssc-sturgeon")).toBe(true);
  });

  it("all ssc-fish-groups children use the fishes taxonGroup and have a unique id", () => {
    const ids = new Set<string>();
    for (const child of sscFishNode?.children ?? []) {
      expect(child.filter.taxonGroups).toEqual(["fishes"]);
      expect(ids.has(child.id), `duplicate id ${child.id}`).toBe(false);
      ids.add(child.id);
    }
  });

  it("does not add any new children to the real 'fishes' node", () => {
    const fishesNode = findNode("fishes");
    const fishChildIds = new Set(fishesNode?.children?.map(c => c.id) ?? []);
    for (const child of sscFishNode?.children ?? []) {
      expect(fishChildIds.has(child.id)).toBe(false);
    }
  });
});

describe("SSC Specialist Groups tree (invertebrates)", () => {
  const sscInvertNode = findNode("ssc-invertebrate-groups");

  it("ssc-invertebrate-groups exists, is not part of the default view, and has 18 children (17 pilot groups + remainder)", () => {
    expect(sscInvertNode).toBeDefined();
    expect(sscInvertNode?.children?.length).toBe(18);
    expect(TAXONOMY_VIEWS.default.roots).not.toContain("ssc-invertebrate-groups");
  });

  it("ssc-other-invertebrates (the remainder row) doesn't overlap any of the 17 named groups", () => {
    const cases: Array<{ class_name: string; order_name: string; family: string; scientific_name: string; taxon_group: string }> = [
      { class_name: "Gastropoda", order_name: "Stylommatophora", family: "Helicidae", scientific_name: "Helix pomatia", taxon_group: "molluscs" },
      { class_name: "Cephalopoda", order_name: "Octopoda", family: "Octopodidae", scientific_name: "Octopus vulgaris", taxon_group: "molluscs" },
      { class_name: "Arachnida", order_name: "Araneae", family: "Theraphosidae", scientific_name: "Theraphosa blondi", taxon_group: "arachnids" },
      { class_name: "Arachnida", order_name: "Scorpiones", family: "Buthidae", scientific_name: "Androctonus australis", taxon_group: "arachnids" },
      { class_name: "Insecta", order_name: "Lepidoptera", family: "Nymphalidae", scientific_name: "Danaus plexippus", taxon_group: "butterflies_and_moths" },
      { class_name: "Insecta", order_name: "Lepidoptera", family: "Saturniidae", scientific_name: "Attacus atlas", taxon_group: "butterflies_and_moths" },
      { class_name: "Insecta", order_name: "Orthoptera", family: "Acrididae", scientific_name: "Schistocerca gregaria", taxon_group: "grasshoppers_crickets_locusts" },
      { class_name: "Insecta", order_name: "Mantodea", family: "Mantidae", scientific_name: "Mantis religiosa", taxon_group: "other_insects" },
      { class_name: "Insecta", order_name: "Phasmida", family: "Phasmatidae", scientific_name: "Extatosoma tiaratum", taxon_group: "other_insects" },
      { class_name: "Insecta", order_name: "Hymenoptera", family: "Apidae", scientific_name: "Apis mellifera", taxon_group: "bees_wasps_and_ants" },
      { class_name: "Insecta", order_name: "Hymenoptera", family: "Formicidae", scientific_name: "Atta cephalotes", taxon_group: "bees_wasps_and_ants" },
      { class_name: "Insecta", order_name: "Ephemeroptera", family: "Baetidae", scientific_name: "Baetis rhodani", taxon_group: "other_insects" },
      { class_name: "Insecta", order_name: "Odonata", family: "Libellulidae", scientific_name: "Libellula depressa", taxon_group: "dragonflies_and_damselflies" },
      { class_name: "Malacostraca", order_name: "Decapoda", family: "Astacidae", scientific_name: "Astacus astacus", taxon_group: "crustaceans" },
      { class_name: "Insecta", order_name: "Diptera", family: "Syrphidae", scientific_name: "Episyrphus balteatus", taxon_group: "flies_and_mosquitoes" },
      { class_name: "Anthozoa", order_name: "Scleractinia", family: "Acroporidae", scientific_name: "Acropora palmata", taxon_group: "corals" },
      { class_name: "Insecta", order_name: "Coleoptera", family: "Lampyridae", scientific_name: "Photinus pyralis", taxon_group: "beetles" },
      { class_name: "Insecta", order_name: "Coleoptera", family: "Geotrupidae", scientific_name: "Geotrupes stercorarius", taxon_group: "beetles" },
      { class_name: "Merostomata", order_name: "Xiphosura", family: "Limulidae", scientific_name: "Limulus polyphemus", taxon_group: "horseshoe_crabs" },
      { class_name: "Holothuroidea", order_name: "Holothuriida", family: "Holothuriidae", scientific_name: "Holothuria edulis", taxon_group: "other_invertebrates" },
      { class_name: "Clitellata", order_name: "Crassiclitellata", family: "Lumbricidae", scientific_name: "Lumbricus terrestris", taxon_group: "other_invertebrates" },
      { class_name: "Demospongiae", order_name: "Dictyoceratida", family: "Spongiidae", scientific_name: "Spongia officinalis", taxon_group: "other_invertebrates" },
    ];
    for (const row of cases) {
      expect(speciesMatchesNode(row, "ssc-other-invertebrates"), row.scientific_name).toBe(false);
    }
  });

  it("ssc-earthworm covers Crassiclitellata + Moniligastrida, not leeches or aquatic oligochaetes", () => {
    const earthworm = { class_name: "Clitellata", order_name: "Crassiclitellata", family: "Lumbricidae", scientific_name: "Lumbricus terrestris", taxon_group: "other_invertebrates" };
    const asianEarthworm = { class_name: "Clitellata", order_name: "Moniligastrida", family: "Moniligastridae", scientific_name: "Moniligaster deshayesi", taxon_group: "other_invertebrates" };
    const leech = { class_name: "Clitellata", order_name: "Arhynchobdellida", family: "Hirudinidae", scientific_name: "Hirudo medicinalis", taxon_group: "other_invertebrates" };
    expect(speciesMatchesNode(earthworm, "ssc-earthworm")).toBe(true);
    expect(speciesMatchesNode(asianEarthworm, "ssc-earthworm")).toBe(true);
    expect(speciesMatchesNode(leech, "ssc-earthworm")).toBe(false);
    expect(speciesMatchesNode(leech, "ssc-other-invertebrates")).toBe(true);
  });

  it("ssc-sponge covers Demospongiae/Hexactinellida/Calcarea, not other other_invertebrates classes", () => {
    const sponge = { class_name: "Demospongiae", order_name: "Dictyoceratida", family: "Spongiidae", scientific_name: "Spongia officinalis", taxon_group: "other_invertebrates" };
    const glassSponge = { class_name: "Hexactinellida", order_name: "Lyssacinosida", family: "Euplectellidae", scientific_name: "Euplectella aspergillum", taxon_group: "other_invertebrates" };
    const seaStar = { class_name: "Asteroidea", order_name: "Valvatida", family: "Oreasteridae", scientific_name: "Culcita novaeguineae", taxon_group: "other_invertebrates" };
    expect(speciesMatchesNode(sponge, "ssc-sponge")).toBe(true);
    expect(speciesMatchesNode(glassSponge, "ssc-sponge")).toBe(true);
    expect(speciesMatchesNode(seaStar, "ssc-sponge")).toBe(false);
  });

  it("ssc-sea-cucumber claims class Holothuroidea, not shared with the mixed 'other_invertebrates' catch-all", () => {
    const seaCucumber = { class_name: "Holothuroidea", order_name: "Holothuriida", family: "Holothuriidae", scientific_name: "Holothuria edulis", taxon_group: "other_invertebrates" };
    const seaStar = { class_name: "Asteroidea", order_name: "Valvatida", family: "Oreasteridae", scientific_name: "Culcita novaeguineae", taxon_group: "other_invertebrates" };
    expect(speciesMatchesNode(seaCucumber, "ssc-sea-cucumber")).toBe(true);
    expect(speciesMatchesNode(seaStar, "ssc-sea-cucumber")).toBe(false);
    expect(speciesMatchesNode(seaStar, "ssc-other-invertebrates")).toBe(true);
  });

  it("ssc-other-invertebrates catches genuinely uncovered species, including ones that would belong to the excluded habitat-based RLAs in reality", () => {
    // Would belong to Cave Invertebrate SG / TIRLA / MIRLA in reality, but those
    // are deliberately not built (see the exclusion note in taxonomy-tree.ts).
    const trueBug = { class_name: "Insecta", order_name: "Hemiptera", family: "Cicadidae", scientific_name: "Magicicada septendecim", taxon_group: "true_bugs" };
    const mite = { class_name: "Arachnida", order_name: "Sarcoptiformes", family: "Oribatidae", scientific_name: "Oribatula tibialis", taxon_group: "arachnids" };
    const seaAnemone = { class_name: "Anthozoa", order_name: "Actiniaria", family: "Actiniidae", scientific_name: "Actinia equina", taxon_group: "corals" };
    const marineCrab = { class_name: "Malacostraca", order_name: "Decapoda", family: "Portunidae", scientific_name: "Callinectes sapidus", taxon_group: "crustaceans" };
    const velvetWorm = { class_name: "Chilopoda", order_name: "Onychophora", family: "Peripatidae", scientific_name: "Epiperipatus biolleyi", taxon_group: "velvet_worms" };
    for (const row of [trueBug, mite, seaAnemone, marineCrab, velvetWorm]) {
      expect(speciesMatchesNode(row, "ssc-other-invertebrates"), row.scientific_name).toBe(true);
    }
  });

  it("Mollusc SG covers the whole phylum, including cephalopods", () => {
    const snail = { class_name: "Gastropoda", order_name: "Stylommatophora", family: "Helicidae", scientific_name: "Helix pomatia", taxon_group: "molluscs" };
    const octopus = { class_name: "Cephalopoda", order_name: "Octopoda", family: "Octopodidae", scientific_name: "Octopus vulgaris", taxon_group: "molluscs" };
    const bivalve = { class_name: "Bivalvia", order_name: "Mytilida", family: "Mytilidae", scientific_name: "Mytilus edulis", taxon_group: "molluscs" };
    expect(speciesMatchesNode(snail, "ssc-mollusc")).toBe(true);
    expect(speciesMatchesNode(octopus, "ssc-mollusc")).toBe(true);
    expect(speciesMatchesNode(bivalve, "ssc-mollusc")).toBe(true);
  });

  it("Spider and Scorpion SG is scoped to Araneae + Scorpiones, excluding other arachnid orders (mites, harvestmen)", () => {
    const spider = { class_name: "Arachnida", order_name: "Araneae", family: "Theraphosidae", scientific_name: "Theraphosa blondi", taxon_group: "arachnids" };
    const scorpion = { class_name: "Arachnida", order_name: "Scorpiones", family: "Buthidae", scientific_name: "Androctonus australis", taxon_group: "arachnids" };
    const harvestman = { class_name: "Arachnida", order_name: "Opiliones", family: "Phalangiidae", scientific_name: "Phalangium opilio", taxon_group: "arachnids" };
    const mite = { class_name: "Arachnida", order_name: "Sarcoptiformes", family: "Oribatidae", scientific_name: "Oribatula tibialis", taxon_group: "arachnids" };
    expect(speciesMatchesNode(spider, "ssc-spider-scorpion")).toBe(true);
    expect(speciesMatchesNode(scorpion, "ssc-spider-scorpion")).toBe(true);
    expect(speciesMatchesNode(harvestman, "ssc-spider-scorpion")).toBe(false);
    expect(speciesMatchesNode(mite, "ssc-spider-scorpion")).toBe(false);
    expect(speciesMatchesNode(harvestman, "ssc-other-invertebrates")).toBe(true);
  });

  it("Butterfly SG covers Papilionoidea (6 families) + Hedylidae + Saturniidae, but not other moth families despite the group's own broader 'butterflies and moths' mission", () => {
    const monarch = { class_name: "Insecta", order_name: "Lepidoptera", family: "Nymphalidae", scientific_name: "Danaus plexippus", taxon_group: "butterflies_and_moths" };
    const emperorMoth = { class_name: "Insecta", order_name: "Lepidoptera", family: "Saturniidae", scientific_name: "Attacus atlas", taxon_group: "butterflies_and_moths" };
    const geometrid = { class_name: "Insecta", order_name: "Lepidoptera", family: "Geometridae", scientific_name: "Biston betularia", taxon_group: "butterflies_and_moths" };
    expect(speciesMatchesNode(monarch, "ssc-butterfly")).toBe(true);
    expect(speciesMatchesNode(emperorMoth, "ssc-butterfly")).toBe(true);
    expect(speciesMatchesNode(geometrid, "ssc-butterfly")).toBe(false);
    expect(speciesMatchesNode(geometrid, "ssc-other-invertebrates")).toBe(true);
  });

  it("Grasshopper SG spans 3 orders (Orthoptera, Phasmida, Mantodea), broader than its name suggests", () => {
    const locust = { class_name: "Insecta", order_name: "Orthoptera", family: "Acrididae", scientific_name: "Schistocerca gregaria", taxon_group: "grasshoppers_crickets_locusts" };
    const cricket = { class_name: "Insecta", order_name: "Orthoptera", family: "Gryllidae", scientific_name: "Acheta domesticus", taxon_group: "grasshoppers_crickets_locusts" };
    const mantis = { class_name: "Insecta", order_name: "Mantodea", family: "Mantidae", scientific_name: "Mantis religiosa", taxon_group: "other_insects" };
    const stickInsect = { class_name: "Insecta", order_name: "Phasmida", family: "Phasmatidae", scientific_name: "Extatosoma tiaratum", taxon_group: "other_insects" };
    expect(speciesMatchesNode(locust, "ssc-grasshopper")).toBe(true);
    expect(speciesMatchesNode(cricket, "ssc-grasshopper")).toBe(true);
    expect(speciesMatchesNode(mantis, "ssc-grasshopper")).toBe(true);
    expect(speciesMatchesNode(stickInsect, "ssc-grasshopper")).toBe(true);
  });

  it("Wild Bee SG (still named Bumblebee and Wild Bee SG in our data) covers all 7 bee families, not just Bombus", () => {
    const honeybee = { class_name: "Insecta", order_name: "Hymenoptera", family: "Apidae", scientific_name: "Apis mellifera", taxon_group: "bees_wasps_and_ants" };
    const miningBee = { class_name: "Insecta", order_name: "Hymenoptera", family: "Andrenidae", scientific_name: "Andrena fulva", taxon_group: "bees_wasps_and_ants" };
    const ant = { class_name: "Insecta", order_name: "Hymenoptera", family: "Formicidae", scientific_name: "Atta cephalotes", taxon_group: "bees_wasps_and_ants" };
    expect(speciesMatchesNode(honeybee, "ssc-wild-bee")).toBe(true);
    expect(speciesMatchesNode(miningBee, "ssc-wild-bee")).toBe(true);
    expect(speciesMatchesNode(ant, "ssc-wild-bee")).toBe(false);
    expect(speciesMatchesNode(ant, "ssc-ant")).toBe(true);
  });

  it("Dung Beetle SG covers Geotrupidae + Scarabaeinae, excluding other Scarabaeidae subfamilies like rhinoceros beetles (Dynastinae)", () => {
    const trueDungBeetle = { class_name: "Insecta", order_name: "Coleoptera", family: "Geotrupidae", scientific_name: "Geotrupes stercorarius", taxon_group: "beetles" };
    const rhinocerosBeetle = { class_name: "Insecta", order_name: "Coleoptera", family: "Scarabaeidae", scientific_name: "Dynastes hercules", taxon_group: "beetles" };
    expect(speciesMatchesNode(trueDungBeetle, "ssc-dung-beetle")).toBe(true);
    expect(speciesMatchesNode(rhinocerosBeetle, "ssc-dung-beetle")).toBe(false);
    expect(speciesMatchesNode(rhinocerosBeetle, "ssc-other-invertebrates")).toBe(true);
  });

  it("Dung Beetle SG's Geotrupidae genus list includes genera the live CoL backbone splits into family Bolboceratidae, and 4 genera absent from our own redlist/unassessed data", () => {
    // CoL classifies this genus under "Bolboceratidae", not "geotrupidae" —
    // family-only exclusion on the catch-all would have double-counted it.
    const bolboceratid = { class_name: "Insecta", order_name: "Coleoptera", family: "Bolboceratidae", scientific_name: "Athyreus armatus", taxon_group: "beetles" };
    // A genus present only in CoL's broader backbone (Baraudia), not in our
    // own redlist/unassessed data — matches by genus regardless.
    const colOnlyGenus = { class_name: "Insecta", order_name: "Coleoptera", family: "Geotrupidae", scientific_name: "Baraudia geminata", taxon_group: "beetles" };
    expect(speciesMatchesNode(bolboceratid, "ssc-dung-beetle")).toBe(true);
    expect(speciesMatchesNode(bolboceratid, "ssc-other-invertebrates")).toBe(false);
    expect(speciesMatchesNode(colOnlyGenus, "ssc-dung-beetle")).toBe(true);
  });

  it("Coral SG is scoped to Scleractinia (reef-building corals), excluding other Anthozoa like sea anemones", () => {
    const stonyCoral = { class_name: "Anthozoa", order_name: "Scleractinia", family: "Acroporidae", scientific_name: "Acropora palmata", taxon_group: "corals" };
    const seaAnemone = { class_name: "Anthozoa", order_name: "Actiniaria", family: "Actiniidae", scientific_name: "Actinia equina", taxon_group: "corals" };
    expect(speciesMatchesNode(stonyCoral, "ssc-coral")).toBe(true);
    expect(speciesMatchesNode(seaAnemone, "ssc-coral")).toBe(false);
    expect(speciesMatchesNode(seaAnemone, "ssc-other-invertebrates")).toBe(true);
  });

  it("Freshwater Crustacean SG covers crayfish, freshwater crabs, and land crabs, but deliberately excludes the mixed marine/freshwater family Palaemonidae by default", () => {
    const crayfish = { class_name: "Malacostraca", order_name: "Decapoda", family: "Astacidae", scientific_name: "Astacus astacus", taxon_group: "crustaceans" };
    const freshwaterCrab = { class_name: "Malacostraca", order_name: "Decapoda", family: "Potamidae", scientific_name: "Potamon fluviatile", taxon_group: "crustaceans" };
    const landCrab = { class_name: "Malacostraca", order_name: "Decapoda", family: "Gecarcinidae", scientific_name: "Gecarcinus quadratus", taxon_group: "crustaceans" };
    // A marine/brackish Palaemonidae genus not in the freshwater-tagged
    // extraSpeciesNames list — correctly stays excluded.
    const marineShrimp = { class_name: "Malacostraca", order_name: "Decapoda", family: "Palaemonidae", scientific_name: "Palaemon serratus", taxon_group: "crustaceans" };
    expect(speciesMatchesNode(crayfish, "ssc-freshwater-crustacean")).toBe(true);
    expect(speciesMatchesNode(freshwaterCrab, "ssc-freshwater-crustacean")).toBe(true);
    expect(speciesMatchesNode(landCrab, "ssc-freshwater-crustacean")).toBe(true);
    expect(speciesMatchesNode(marineShrimp, "ssc-freshwater-crustacean")).toBe(false);
    expect(speciesMatchesNode(marineShrimp, "ssc-other-invertebrates")).toBe(true);
  });

  it("Freshwater Crustacean SG includes freshwater-tagged Palaemonidae species (dominated by Macrobrachium) via extraSpeciesNames, since the family itself is mixed marine/freshwater", () => {
    const riverPrawn = { class_name: "Malacostraca", order_name: "Decapoda", family: "Palaemonidae", scientific_name: "Macrobrachium rosenbergii", taxon_group: "crustaceans" };
    expect(speciesMatchesNode(riverPrawn, "ssc-freshwater-crustacean")).toBe(true);
    expect(speciesMatchesNode(riverPrawn, "ssc-other-invertebrates")).toBe(false);
  });

  it("Horseshoe Crab SG matches its whole dedicated taxon group", () => {
    const horseshoeCrab = { class_name: "Merostomata", order_name: "Xiphosura", family: "Limulidae", scientific_name: "Limulus polyphemus", taxon_group: "horseshoe_crabs" };
    expect(speciesMatchesNode(horseshoeCrab, "ssc-horseshoe-crab")).toBe(true);
  });

  it("all ssc-invertebrate-groups children have a unique id", () => {
    const ids = new Set<string>();
    for (const child of sscInvertNode?.children ?? []) {
      expect(ids.has(child.id), `duplicate id ${child.id}`).toBe(false);
      ids.add(child.id);
    }
  });

  it("does not add any new children to the real 'invertebrates' virtual grouping node", () => {
    const invertNode = findNode("invertebrates");
    const invertChildIds = new Set(invertNode?.children?.map(c => c.id) ?? []);
    for (const child of sscInvertNode?.children ?? []) {
      expect(invertChildIds.has(child.id)).toBe(false);
    }
  });
});

describe("SSC Specialist Groups tree (plants)", () => {
  const sscPlantNode = findNode("ssc-plant-groups");

  it("ssc-plant-groups exists, is not part of the default view, and has 9 children (8 pilot groups + remainder)", () => {
    expect(sscPlantNode).toBeDefined();
    expect(sscPlantNode?.children?.length).toBe(9);
    expect(TAXONOMY_VIEWS.default.roots).not.toContain("ssc-plant-groups");
  });

  it("ssc-other-plants (the remainder row) doesn't overlap any of the 8 named groups", () => {
    const cases: Array<{ class_name: string; order_name: string; family: string; scientific_name: string; taxon_group: string }> = [
      { class_name: "Liliopsida", order_name: "Asparagales", family: "Orchidaceae", scientific_name: "Vanilla planifolia", taxon_group: "flowering_plants" },
      { class_name: "Bryopsida", order_name: "Hypnales", family: "Hypnaceae", scientific_name: "Hypnum cupressiforme", taxon_group: "mosses" },
      { class_name: "Magnoliopsida", order_name: "Caryophyllales", family: "Cactaceae", scientific_name: "Carnegiea gigantea", taxon_group: "flowering_plants" },
      { class_name: "Liliopsida", order_name: "Arecales", family: "Arecaceae", scientific_name: "Elaeis guineensis", taxon_group: "flowering_plants" },
      { class_name: "Magnoliopsida", order_name: "Caryophyllales", family: "Droseraceae", scientific_name: "Dionaea muscipula", taxon_group: "flowering_plants" },
      { class_name: "Pinopsida", order_name: "Pinales", family: "Pinaceae", scientific_name: "Pinus sylvestris", taxon_group: "gymnosperms" },
      { class_name: "Cycadopsida", order_name: "Cycadales", family: "Zamiaceae", scientific_name: "Zamia furfuracea", taxon_group: "gymnosperms" },
      { class_name: "Liliopsida", order_name: "Alismatales", family: "Zosteraceae", scientific_name: "Zostera marina", taxon_group: "flowering_plants" },
    ];
    for (const row of cases) {
      expect(speciesMatchesNode(row, "ssc-other-plants"), row.scientific_name).toBe(false);
    }
  });

  it("ssc-other-plants catches genuinely uncovered species, including ones that would belong to the excluded functional/growth-form-based groups in reality", () => {
    // Would belong to Global Trees SG (any tree species) / Crop Wild Relative SG
    // (wild relatives of crops) / Medicinal Plant SG in reality, but those are
    // deliberately not built — see the exclusion note in taxonomy-tree.ts.
    const oakTree = { class_name: "Magnoliopsida", order_name: "Fagales", family: "Fagaceae", scientific_name: "Quercus robur", taxon_group: "flowering_plants" };
    const wildWheat = { class_name: "Liliopsida", order_name: "Poales", family: "Poaceae", scientific_name: "Aegilops tauschii", taxon_group: "flowering_plants" };
    // Ginkgo — a genuine open gap: not claimed by Conifer SG (Pinales only)
    // or any other group in this pilot.
    const ginkgo = { class_name: "Ginkgoopsida", order_name: "Ginkgoales", family: "Ginkgoaceae", scientific_name: "Ginkgo biloba", taxon_group: "gymnosperms" };
    // A freshwater (non-seagrass) genus within the same family Seagrass SG
    // partially claims — must NOT be swept in by a whole-family filter.
    const freshwaterHydrocharitaceae = { class_name: "Liliopsida", order_name: "Alismatales", family: "Hydrocharitaceae", scientific_name: "Elodea canadensis", taxon_group: "flowering_plants" };
    for (const row of [oakTree, wildWheat, ginkgo, freshwaterHydrocharitaceae]) {
      expect(speciesMatchesNode(row, "ssc-other-plants"), row.scientific_name).toBe(true);
    }
  });

  it("Bryophyte SG matches its whole dedicated taxon group (mosses, liverworts, and hornworts together)", () => {
    const moss = { class_name: "Bryopsida", order_name: "Hypnales", family: "Hypnaceae", scientific_name: "Hypnum cupressiforme", taxon_group: "mosses" };
    const liverwort = { class_name: "Jungermanniopsida", order_name: "Jungermanniales", family: "Lepidoziaceae", scientific_name: "Bazzania trilobata", taxon_group: "mosses" };
    expect(speciesMatchesNode(moss, "ssc-bryophyte")).toBe(true);
    expect(speciesMatchesNode(liverwort, "ssc-bryophyte")).toBe(true);
  });

  it("Cactus and Succulent SG covers Cactaceae and Didiereaceae, but not other succulent-containing families it can't safely isolate", () => {
    const cactus = { class_name: "Magnoliopsida", order_name: "Caryophyllales", family: "Cactaceae", scientific_name: "Carnegiea gigantea", taxon_group: "flowering_plants" };
    const octopusTree = { class_name: "Magnoliopsida", order_name: "Caryophyllales", family: "Didiereaceae", scientific_name: "Alluaudia procera", taxon_group: "flowering_plants" };
    const succulentSpurge = { class_name: "Magnoliopsida", order_name: "Malpighiales", family: "Euphorbiaceae", scientific_name: "Euphorbia obesa", taxon_group: "flowering_plants" };
    expect(speciesMatchesNode(cactus, "ssc-cactus-succulent")).toBe(true);
    expect(speciesMatchesNode(octopusTree, "ssc-cactus-succulent")).toBe(true);
    expect(speciesMatchesNode(succulentSpurge, "ssc-cactus-succulent")).toBe(false);
    expect(speciesMatchesNode(succulentSpurge, "ssc-other-plants")).toBe(true);
  });

  it("Conifer SG covers order Pinales but not Ginkgo or the gnetophytes", () => {
    const pine = { class_name: "Pinopsida", order_name: "Pinales", family: "Pinaceae", scientific_name: "Pinus sylvestris", taxon_group: "gymnosperms" };
    const ginkgo = { class_name: "Ginkgoopsida", order_name: "Ginkgoales", family: "Ginkgoaceae", scientific_name: "Ginkgo biloba", taxon_group: "gymnosperms" };
    expect(speciesMatchesNode(pine, "ssc-conifer")).toBe(true);
    expect(speciesMatchesNode(ginkgo, "ssc-conifer")).toBe(false);
    expect(speciesMatchesNode(ginkgo, "ssc-other-plants")).toBe(true);
  });

  it("Cycad SG covers order Cycadales (both families)", () => {
    const cycad1 = { class_name: "Cycadopsida", order_name: "Cycadales", family: "Zamiaceae", scientific_name: "Zamia furfuracea", taxon_group: "gymnosperms" };
    const cycad2 = { class_name: "Cycadopsida", order_name: "Cycadales", family: "Cycadaceae", scientific_name: "Cycas revoluta", taxon_group: "gymnosperms" };
    expect(speciesMatchesNode(cycad1, "ssc-cycad")).toBe(true);
    expect(speciesMatchesNode(cycad2, "ssc-cycad")).toBe(true);
  });

  it("Seagrass SG covers 4 whole marine families plus only the 3 marine genera within the mostly-freshwater family Hydrocharitaceae", () => {
    const trueSeagrass = { class_name: "Liliopsida", order_name: "Alismatales", family: "Zosteraceae", scientific_name: "Zostera marina", taxon_group: "flowering_plants" };
    const marineHydrocharitaceae = { class_name: "Liliopsida", order_name: "Alismatales", family: "Hydrocharitaceae", scientific_name: "Halophila ovalis", taxon_group: "flowering_plants" };
    const freshwaterHydrocharitaceae = { class_name: "Liliopsida", order_name: "Alismatales", family: "Hydrocharitaceae", scientific_name: "Elodea canadensis", taxon_group: "flowering_plants" };
    expect(speciesMatchesNode(trueSeagrass, "ssc-seagrass")).toBe(true);
    expect(speciesMatchesNode(marineHydrocharitaceae, "ssc-seagrass")).toBe(true);
    expect(speciesMatchesNode(freshwaterHydrocharitaceae, "ssc-seagrass")).toBe(false);
    expect(speciesMatchesNode(freshwaterHydrocharitaceae, "ssc-other-plants")).toBe(true);
  });

  it("all ssc-plant-groups children have a unique id", () => {
    const ids = new Set<string>();
    for (const child of sscPlantNode?.children ?? []) {
      expect(ids.has(child.id), `duplicate id ${child.id}`).toBe(false);
      ids.add(child.id);
    }
  });

  it("does not add any new children to the real 'plantae' virtual grouping node", () => {
    const plantaeNode = findNode("plantae");
    const plantaeChildIds = new Set(plantaeNode?.children?.map(c => c.id) ?? []);
    for (const child of sscPlantNode?.children ?? []) {
      expect(plantaeChildIds.has(child.id)).toBe(false);
    }
  });
});

describe("SSC Specialist Groups tree (fungi)", () => {
  const sscFungiNode = findNode("ssc-fungi-groups");

  it("ssc-fungi-groups exists, is not part of the default view, and has 6 children (5 pilot groups + remainder)", () => {
    expect(sscFungiNode).toBeDefined();
    expect(sscFungiNode?.children?.length).toBe(6);
    expect(TAXONOMY_VIEWS.default.roots).not.toContain("ssc-fungi-groups");
  });

  it("ssc-other-fungi (the remainder row) doesn't overlap Cup-fungus, Truffle and Ally SG", () => {
    const cupFungus = { class_name: "Pezizomycetes", order_name: "Pezizales", family: "Pezizaceae", scientific_name: "Peziza vesiculosa", taxon_group: "mushrooms" };
    const truffle = { class_name: "Pezizomycetes", order_name: "Pezizales", family: "Tuberaceae", scientific_name: "Tuber melanosporum", taxon_group: "mushrooms" };
    expect(speciesMatchesNode(cupFungus, "ssc-other-fungi")).toBe(false);
    expect(speciesMatchesNode(truffle, "ssc-other-fungi")).toBe(false);
  });

  it("ssc-other-fungi catches a genuinely uncovered species (no dedicated SSC group among the 5)", () => {
    const deadMansFingers = { class_name: "Sordariomycetes", order_name: "Xylariales", family: "Xylariaceae", scientific_name: "Xylaria polymorpha", taxon_group: "mushrooms" };
    expect(speciesMatchesNode(deadMansFingers, "ssc-other-fungi")).toBe(true);
  });

  it("Lichen SG is scoped to class Lecanoromycetes, not the whole mushrooms group", () => {
    const lichen = { class_name: "Lecanoromycetes", order_name: "Lecanorales", family: "Parmeliaceae", scientific_name: "Lobaria pulmonaria", taxon_group: "mushrooms" };
    expect(speciesMatchesNode(lichen, "ssc-lichen")).toBe(true);
    expect(speciesMatchesNode(lichen, "ssc-other-fungi")).toBe(false);
  });

  it("Mushroom, Bracket and Puffball SG is scoped to class Agaricomycetes", () => {
    const mushroom = { class_name: "Agaricomycetes", order_name: "Agaricales", family: "Amanitaceae", scientific_name: "Amanita muscaria", taxon_group: "mushrooms" };
    expect(speciesMatchesNode(mushroom, "ssc-mushroom-bracket-puffball")).toBe(true);
    expect(speciesMatchesNode(mushroom, "ssc-other-fungi")).toBe(false);
  });

  it("Rusts and Smuts SG covers order Pucciniales (rusts) and the real orders within Ustilaginomycetes/Exobasidiomycetes (smuts)", () => {
    const rust = { class_name: "Pucciniomycetes", order_name: "Pucciniales", family: "Pucciniaceae", scientific_name: "Puccinia graminis", taxon_group: "mushrooms" };
    const smut = { class_name: "Ustilaginomycetes", order_name: "Ustilaginales", family: "Ustilaginaceae", scientific_name: "Ustilago maydis", taxon_group: "mushrooms" };
    // A non-rust order within the same Pucciniomycetes class — correctly
    // excluded (encoded by order, not the whole class).
    const nonRustPucciniomycete = { class_name: "Pucciniomycetes", order_name: "Helicobasidiales", family: "Helicobasidiaceae", scientific_name: "Helicobasidium purpureum", taxon_group: "mushrooms" };
    expect(speciesMatchesNode(rust, "ssc-rust-smut")).toBe(true);
    expect(speciesMatchesNode(smut, "ssc-rust-smut")).toBe(true);
    expect(speciesMatchesNode(nonRustPucciniomycete, "ssc-rust-smut")).toBe(false);
    expect(speciesMatchesNode(nonRustPucciniomycete, "ssc-other-fungi")).toBe(true);
  });

  it("Cup-fungus, Truffle and Ally SG is scoped to order Pezizales", () => {
    const cupFungus = { class_name: "Pezizomycetes", order_name: "Pezizales", family: "Pezizaceae", scientific_name: "Peziza vesiculosa", taxon_group: "mushrooms" };
    const truffle = { class_name: "Pezizomycetes", order_name: "Pezizales", family: "Tuberaceae", scientific_name: "Tuber melanosporum", taxon_group: "mushrooms" };
    const morel = { class_name: "Pezizomycetes", order_name: "Pezizales", family: "Morchellaceae", scientific_name: "Morchella esculenta", taxon_group: "mushrooms" };
    // A real assessed species credited to this group but outside Pezizales
    // (order Hypocreales) — deliberately NOT covered by our conservative
    // Pezizales-only encoding; falls to the catch-all instead of being
    // guessed at via a broader "non-lichenized Ascomycota" filter.
    const caterpillarFungus = { class_name: "Sordariomycetes", order_name: "Hypocreales", family: "Ophiocordycipitaceae", scientific_name: "Ophiocordyceps sinensis", taxon_group: "mushrooms" };
    expect(speciesMatchesNode(cupFungus, "ssc-cup-fungus-truffle")).toBe(true);
    expect(speciesMatchesNode(truffle, "ssc-cup-fungus-truffle")).toBe(true);
    expect(speciesMatchesNode(morel, "ssc-cup-fungus-truffle")).toBe(true);
    expect(speciesMatchesNode(caterpillarFungus, "ssc-cup-fungus-truffle")).toBe(false);
    expect(speciesMatchesNode(caterpillarFungus, "ssc-other-fungi")).toBe(true);
  });

  it("Chytrid, Zygomycete, Downy Mildew and Slime Mould SG's filter is well-formed even though it currently matches nothing in our data", () => {
    const chytridNode = findNode("ssc-chytrid-zygomycete-downy-mildew-myxomycete");
    expect(chytridNode).toBeDefined();
    expect(chytridNode?.filter.classNames).toEqual(["chytridiomycetes", "mucoromycetes", "zoopagomycetes", "oomycetes", "myxomycetes"]);
    const hypotheticalChytrid = { class_name: "Chytridiomycetes", order_name: "Chytridiales", family: "Chytridiaceae", scientific_name: "Chytridium olla", taxon_group: "mushrooms" };
    expect(speciesMatchesNode(hypotheticalChytrid, "ssc-chytrid-zygomycete-downy-mildew-myxomycete")).toBe(true);
    expect(speciesMatchesNode(hypotheticalChytrid, "ssc-other-fungi")).toBe(false);
  });

  it("all ssc-fungi-groups children use the mushrooms taxonGroup and have a unique id", () => {
    const ids = new Set<string>();
    for (const child of sscFungiNode?.children ?? []) {
      expect(child.filter.taxonGroups).toEqual(["mushrooms"]);
      expect(ids.has(child.id), `duplicate id ${child.id}`).toBe(false);
      ids.add(child.id);
    }
  });

  it("does not add any new children to the real 'mushrooms' node", () => {
    const mushroomsNode = findNode("mushrooms");
    const mushroomChildIds = new Set(mushroomsNode?.children?.map(c => c.id) ?? []);
    for (const child of sscFungiNode?.children ?? []) {
      expect(mushroomChildIds.has(child.id)).toBe(false);
    }
  });
});

// =============================================================================
// Partition coverage
// =============================================================================

// Reptiles'/Amphibians'/Fishes'/Insects'/Fungi's (mushrooms) static
// order/class-level partition tests were retired along with their static
// nodes in Phase 8 — the equivalent invariant (siblings enumerate distinct,
// non-overlapping values) is now enforced at query time by getLiveRankChildren
// (one GROUP BY per rank, no possibility of a value appearing in two buckets)
// rather than needing a hand-maintained partition check.
describe("Subgroup partition coverage", () => {
  it("all plant Table 1a groups have no STATIC children (they get live order-level drilldown instead — see dynamic-taxon.ts)", () => {
    const plantGroups = [
      "flowering_plants", "gymnosperms", "ferns_and_allies",
      "mosses", "green_algae", "red_algae",
    ];
    for (const id of plantGroups) {
      const node = findNode(id)!;
      expect(node, `${id} not found`).toBeDefined();
      expect(node.children, `${id} should have no static children`).toBeUndefined();
    }
  });

  it("every plant Table 1a group has a described-species estimate", () => {
    const plantGroups = [
      "flowering_plants", "gymnosperms", "ferns_and_allies",
      "mosses", "green_algae", "red_algae",
    ];
    for (const id of plantGroups) {
      const node = findNode(id)!;
      expect(node.estimatedDescribed, `${id} missing estimatedDescribed`).toBeGreaterThan(0);
    }
  });

  // Molluscs/Crustaceans/Other Invertebrates' static phylum-by-class splits
  // (Other Invertebrates only had one; Molluscs/Crustaceans were already
  // leaves) were retired 2026-07-22 once class-name aliasing (COL_CLASS_ALIASES:
  // copepoda/thecostraca/hoplonemertea) closed the real CoL order_name gap that
  // held them back from live drilldown — see dynamic-taxon.ts's
  // DYNAMIC_DRILLDOWN_ROOTS/ROOT_RANK_ORDER comments.
  it("Molluscs/Crustaceans/Other Invertebrates have no STATIC children (they get live class-level drilldown instead)", () => {
    for (const id of ["molluscs", "crustaceans", "other_invertebrates"]) {
      const node = findNode(id)!;
      expect(node, `${id} not found`).toBeDefined();
      expect(node.children, `${id} should have no static children`).toBeUndefined();
    }
  });

});

// ─── Default view: no double counting ────────────────────────────────

describe("default view taxon group coverage", () => {
  const defaultRoots = TAXONOMY_VIEWS.default.roots;

  it("no taxon group appears in multiple default view roots", () => {
    const seen = new Map<string, string>(); // taxonGroup → rootId
    for (const rootId of defaultRoots) {
      const node = findNode(rootId)!;
      for (const csv of node.filter.taxonGroups) {
        expect(seen.has(csv), `"${csv}" is in both "${seen.get(csv)}" and "${rootId}"`).toBe(false);
        seen.set(csv, rootId);
      }
    }
  });

  it("all 28 Table 1a taxon groups are covered by exactly one default view root", () => {
    const allTaxonGroups = new Set<string>();
    for (const rootId of defaultRoots) {
      for (const group of findNode(rootId)!.filter.taxonGroups) {
        allTaxonGroups.add(group);
      }
    }
    expect(allTaxonGroups.size).toBe(28);
  });

  it("brown_algae is in fungi, not plantae", () => {
    expect(findNode("fungi")!.filter.taxonGroups).toContain("brown_algae");
    expect(findNode("plantae")!.filter.taxonGroups).not.toContain("brown_algae");
  });
});

// ─── prefixTree: virtual nodes mirror canonical nodes ─────────────────

describe("prefixTree virtual nodes", () => {
  const prefixPairs: [string, string][] = [
    ["insects", "inv-insects"],
    ["molluscs", "inv-molluscs"],
    ["flowering_plants", "pl-flowering_plants"],
    ["mushrooms", "fu-mushrooms"],
    ["brown_algae", "fu-brown_algae"],
  ];

  for (const [canonicalId, prefixedId] of prefixPairs) {
    it(`${prefixedId} mirrors ${canonicalId}`, () => {
      const canonical = findNode(canonicalId)!;
      const prefixed = findNode(prefixedId)!;
      expect(prefixed.name).toBe(canonical.name);
      expect(prefixed.filter).toEqual(canonical.filter);
      expect(prefixed.estimatedDescribed).toBe(canonical.estimatedDescribed);
    });
  }


  it("prefixed nodes are in NODE_INDEX", () => {
    expect(NODE_INDEX.has("inv-insects")).toBe(true);
    expect(NODE_INDEX.has("pl-flowering_plants")).toBe(true);
    expect(NODE_INDEX.has("fu-mushrooms")).toBe(true);
  });
});

// ─── Table 1a click-through: every group maps to a view root child ────

describe("Table 1a → default view mapping", () => {
  const defaultRoots = new Set(TAXONOMY_VIEWS.default.roots);
  const table1aGroups = TAXONOMY_VIEWS.table1a.roots;

  const stripPrefix = (id: string) => id.replace(/^(inv-|pl-|fu-)/, "");

  for (const group of table1aGroups) {
    it(`${group} maps to a default view root or its child`, () => {
      if (defaultRoots.has(group)) return; // direct root, fine

      let found = false;
      for (const rootId of defaultRoots) {
        const rootNode = findNode(rootId)!;
        // Mirror TaxaSummary navigation: match by node id (aggregating parents
        // like "insects"), then by single taxon group, then by CSV-group membership.
        const match =
          rootNode.children?.find(c => stripPrefix(c.id) === group)
          ?? rootNode.children?.find(c =>
            c.filter.taxonGroups.length === 1 && c.filter.taxonGroups[0] === group
          )
          ?? rootNode.children?.find(c =>
            c.filter.taxonGroups.includes(group)
          );
        if (match) { found = true; break; }
      }
      expect(found, `${group} has no matching child under any default view root`).toBe(true);
    });
  }
});

// ─── Precomputed summaries structure ──────────────────────────────────

describe("table1a-children-summaries.json + ssc-group-children-summaries.json", () => {
  // Merged the same way species-store.ts's getPrecomputedChildrenSummaries
  // does — the two files are a plain split (by "ssc-" id prefix) of what used
  // to be one node-children-summaries.json, so every check below still
  // applies to their union.
  const data = {
    ...JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "data/table1a-children-summaries.json"),
        "utf-8"
      )
    ),
    ...JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "data/ssc-group-children-summaries.json"),
        "utf-8"
      )
    ),
  };

  it("has entries for all parent nodes in the tree, except 'all' (deliberately excluded — see build-taxa-summary.ts)", () => {
    for (const [id] of NODE_INDEX) {
      if (!hasChildren(id) || id === "all") continue;
      expect(data[id], `missing precomputed entry for parent "${id}"`).toBeDefined();
    }
    expect(data["all"]).toBeUndefined();
  });

  it("child IDs match the tree structure", () => {
    for (const [id, node] of NODE_INDEX) {
      if (!node.children || id === "all") continue;
      const treeChildIds = node.children.map(c => c.id);
      const dataChildIds = (data[id] ?? []).map((c: { id: string }) => c.id);
      expect(dataChildIds).toEqual(treeChildIds);
    }
  });

  it("summaries have valid shapes", () => {
    for (const children of Object.values(data) as Array<Array<Record<string, unknown>>>) {
      for (const child of children) {
        expect(typeof child.id).toBe("string");
        expect(typeof child.totalAssessed).toBe("number");
        expect(typeof child.outdated).toBe("number");
        expect(typeof child.gbifNeSpeciesCount).toBe("number");
        expect((child.totalAssessed as number)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ─── Flat taxa-token URL mapping (the single-`taxa`-param invariant) ────────

import {
  stripNodePrefix,
  expandTaxaToken,
  collapseTaxaToTokens,
  getViewRootForNode,
} from "@/lib/taxonomy-utils";

describe("flat taxa-token mapping is a bijection over the default view", () => {
  // Every default-view node (a display root or a node under one) must round-trip
  // through its flat URL token. If a future tree change makes two nodes share a
  // token, this fails in CI instead of silently emitting a wrong-taxon URL.
  it("each default-view node round-trips: node → token → node", () => {
    const collisions: string[] = [];
    for (const id of NODE_INDEX.keys()) {
      if (!getViewRootForNode(id)) continue; // skip nodes outside the default view
      const { taxa, subgroup } = expandTaxaToken(stripNodePrefix(id));
      const resolved = subgroup ?? taxa;
      if (resolved !== id) collisions.push(`${id} → '${stripNodePrefix(id)}' → ${resolved}`);
    }
    expect(collisions).toEqual([]);
  });

  it("collapse ∘ expand is identity for a root + sub-group selection", () => {
    // Sample a few representative pairs across the prefixed roots.
    const cases: Array<[string, string]> = [
      ["invertebrates", "inv-corals"],
      ["invertebrates", "ssc-mollusc"], // Molluscs/Crustaceans/Other Invertebrates lost their last static children 2026-07-22; SSC groups are still a real static sub-group
      ["fishes", "ssc-shark"], // Fishes lost its static children in Phase 8; SSC groups are still a real static sub-group
      ["plantae", "pl-flowering_plants"],
      ["fungi", "fu-mushrooms"],
      ["mammals", "ssc-bear"],
    ];
    for (const [root, sg] of cases) {
      const tokens = collapseTaxaToTokens([root], [sg]);
      expect(tokens).toEqual([stripNodePrefix(sg)]);
      const { taxa, subgroup } = expandTaxaToken(tokens[0]);
      expect(taxa).toBe(root);
      expect(subgroup).toBe(sg);
    }
  });

  it("an SSC group survives a URL round-trip as a mammals sub-group (regression: ssc-groups sits outside the default view)", () => {
    // onNavigateToSubgroup("mammals", "ssc-bear") is how the SSC groups mode
    // click-through selects a group; the URL must reconstruct the same pair,
    // not silently widen back out to all of mammals.
    expect(getViewRootForNode("ssc-bear")).toBe("mammals");
    const tokens = collapseTaxaToTokens(["mammals"], ["ssc-bear"]);
    expect(tokens).toEqual(["ssc-bear"]);
    const { taxa, subgroup } = expandTaxaToken(tokens[0]);
    expect(taxa).toBe("mammals");
    expect(subgroup).toBe("ssc-bear");
  });
});

describe("every taxon group has a name to print", () => {
  it("resolves to a node's name or to TAXON_GROUP_NAMES", () => {
    for (const group of ALL_TAXON_GROUPS) {
      const name = findNode(group)?.name ?? TAXON_GROUP_NAMES[group];
      expect(name, `no display name for "${group}"`).toBeTruthy();
      // Capitalised, and without the underscores of the id it came from:
      // these are printed in tables beside scientific names.
      expect(name).toMatch(/^[A-Z]/);
      expect(name).not.toContain("_");
    }
  });
});
