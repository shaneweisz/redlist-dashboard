import { parseDynamicNodeId } from "@/lib/dynamic-taxon";

/**
 * A taxon's rank and scientific name, for the line under its name in the
 * taxon header above the view toggle ("Class Mammalia", "Order").
 *
 * Live drill-down nodes carry theirs in the id (`mammals~order:primates`).
 * The fixed top-level nodes filter by taxon group rather than by a named
 * clade, so they're mapped here by hand. Groups that aren't one clade (Fishes,
 * Invertebrates, an SSC specialist group) return null and show no rank line.
 */
const STATIC_NAMES: Record<string, { rank: string; name: string }> = {
  mammals: { rank: "Class", name: "Mammalia" },
  birds: { rank: "Class", name: "Aves" },
  reptiles: { rank: "Class", name: "Reptilia" },
  amphibians: { rank: "Class", name: "Amphibia" },
  insects: { rank: "Class", name: "Insecta" },
  arachnids: { rank: "Class", name: "Arachnida" },
  molluscs: { rank: "Phylum", name: "Mollusca" },
  crustaceans: { rank: "Subphylum", name: "Crustacea" },
  corals: { rank: "Class", name: "Anthozoa" },
  plantae: { rank: "Kingdom", name: "Plantae" },
  gymnosperms: { rank: "Division", name: "Pinophyta" },
  mosses: { rank: "Division", name: "Bryophyta" },
  fungi: { rank: "Kingdom", name: "Fungi" },
  mushrooms: { rank: "Class", name: "Agaricomycetes" },
};

export function taxonRankName(nodeId: string): { rank: string; name: string } | null {
  const dyn = parseDynamicNodeId(nodeId);
  if (dyn && dyn.segments.length > 0) {
    const last = dyn.segments[dyn.segments.length - 1];
    const name = last.value.charAt(0).toUpperCase() + last.value.slice(1);
    return { rank: last.rank.charAt(0).toUpperCase() + last.rank.slice(1), name };
  }
  return STATIC_NAMES[nodeId] ?? STATIC_NAMES[nodeId.replace(/^inv-/, "")] ?? null;
}
