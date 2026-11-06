/**
 * Icons for each taxon group using react-icons.
 *
 * Canonical IDs are mapped once; prefixed duplicates (e.g. "inv-beetles",
 * "pl-flowering_plants", "fu-mushrooms") are resolved by stripping the
 * prefix before lookup.
 */

import React, { CSSProperties } from "react";
import { IconBaseProps } from "react-icons";
import { getAncestors } from "@/lib/taxonomy-utils";
import { parseDynamicNodeId } from "@/lib/dynamic-taxon";
import {
  FaPaw,
  FaDove,
  FaFish,
  FaFrog,
  FaLeaf,
  FaBug,
  FaGlobeAmericas,
} from "react-icons/fa";
import {
  GiAlgae,
  GiBat,
  GiBee,
  GiButterfly,
  GiCoral,
  GiCrab,
  GiCricket,
  GiCrocJaws,
  GiDeer,
  GiDragonfly,
  GiEarthWorm,
  GiFern,
  GiFlowers,
  GiFly,
  GiGorilla,
  GiHedgehog,
  GiHighGrass,
  GiHorseHead,
  GiKangaroo,
  GiMushroom,
  GiMushroomGills,
  GiMushrooms,
  GiNautilusShell,
  GiPangolin,
  GiPineTree,
  GiRabbit,
  GiRat,
  GiSalamander,
  GiScarabBeetle,
  GiSharkFin,
  GiSnake,
  GiSpermWhale,
  GiSpiderAlt,
  GiTurtle,
  GiWolfHead,
} from "react-icons/gi";

// ---------------------------------------------------------------------------
// Canonical taxon-id → icon mapping
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ComponentType<IconBaseProps>> = {
  // Top-level taxa
  all: FaGlobeAmericas,
  mammals: FaPaw,
  birds: FaDove,
  reptiles: GiSnake,
  amphibians: FaFrog,
  fishes: FaFish,
  invertebrates: FaBug,
  plantae: FaLeaf,
  fungi: GiMushroom,

  // Mammal subgroups
  rodents: GiRat,
  bats: GiBat,
  eulipotyphla: GiHedgehog,
  primates: GiGorilla,
  marsupials: GiKangaroo,
  carnivores: GiWolfHead,
  artiodactyls: GiDeer,
  "rabbits-hares": GiRabbit,
  sirenians: GiSpermWhale,
  "odd-toed-ungulates": GiHorseHead,
  pangolins: GiPangolin,
  "other-mammals": FaPaw,

  // Reptile subgroups
  squamates: GiSnake,
  "turtles-tortoises": GiTurtle,
  crocodilians: GiCrocJaws,
  tuataras: GiSnake,

  // Amphibian subgroups
  "frogs-toads": FaFrog,
  "salamanders-newts": GiSalamander,
  caecilians: FaFrog,

  // Fish subgroups
  "ray-finned-fishes": FaFish,
  "lobe-finned-fishes": FaFish,
  "sharks-rays": GiSharkFin,
  "jawless-fish": FaFish,

  // Insect subgroups
  insects: FaBug,
  beetles: GiScarabBeetle,
  "butterflies-moths": GiButterfly,
  "flies-mosquitoes": GiFly,
  "bees-wasps-ants": GiBee,
  "true-bugs": FaBug,
  "grasshoppers-crickets": GiCricket,
  "dragonflies-damselflies": GiDragonfly,
  "other-insects": FaBug,

  // Other invertebrate subgroups
  arachnids: GiSpiderAlt,
  molluscs: GiNautilusShell,
  crustaceans: GiCrab,
  corals: GiCoral,
  other_invertebrates: FaBug,
  velvet_worms: GiEarthWorm,
  horseshoe_crabs: GiCrab,

  // Plant Table 1a groups (leaves — no drill-down)
  flowering_plants: GiFlowers,
  gymnosperms: GiPineTree,
  ferns_and_allies: GiFern,
  mosses: GiHighGrass,
  green_algae: GiAlgae,
  red_algae: GiAlgae,
  brown_algae: GiAlgae,

  // Fungi subgroups
  mushrooms: GiMushroom,
  ascomycota: GiMushroomGills,
  "other-fungi": GiMushrooms,
};

// Live drill-down nodes are named by their scientific rank value
// ("mammals~order:primates"), so map the ones that have a curated icon above
// onto it. Anything not listed takes its nearest ancestor's icon instead.
const RANK_VALUE_ALIASES: Record<string, string> = {
  rodentia: "rodents",
  chiroptera: "bats",
  eulipotyphla: "eulipotyphla",
  primates: "primates",
  diprotodontia: "marsupials",
  didelphimorphia: "marsupials",
  dasyuromorphia: "marsupials",
  peramelemorphia: "marsupials",
  carnivora: "carnivores",
  artiodactyla: "artiodactyls",
  cetartiodactyla: "artiodactyls",
  lagomorpha: "rabbits-hares",
  sirenia: "sirenians",
  perissodactyla: "odd-toed-ungulates",
  pholidota: "pangolins",
  squamata: "squamates",
  testudines: "turtles-tortoises",
  crocodylia: "crocodilians",
  rhynchocephalia: "tuataras",
  anura: "frogs-toads",
  caudata: "salamanders-newts",
  gymnophiona: "caecilians",
  actinopterygii: "ray-finned-fishes",
  sarcopterygii: "lobe-finned-fishes",
  chondrichthyes: "sharks-rays",
  elasmobranchii: "sharks-rays",
  myxini: "jawless-fish",
  petromyzonti: "jawless-fish",
  insecta: "insects",
  coleoptera: "beetles",
  lepidoptera: "butterflies-moths",
  diptera: "flies-mosquitoes",
  hymenoptera: "bees-wasps-ants",
  hemiptera: "true-bugs",
  orthoptera: "grasshoppers-crickets",
  odonata: "dragonflies-damselflies",
  arachnida: "arachnids",
  gastropoda: "molluscs",
  bivalvia: "molluscs",
  cephalopoda: "molluscs",
  malacostraca: "crustaceans",
  anthozoa: "corals",
};

// Prefixes applied to subgroup IDs to disambiguate across parent taxa
const KNOWN_PREFIXES = ["inv-", "pl-", "fu-"];

function resolveOwnIcon(
  taxonId: string,
): React.ComponentType<IconBaseProps> | undefined {
  // Try exact match first
  const exact = ICON_MAP[taxonId];
  if (exact) return exact;

  // Strip known prefix and try again
  for (const prefix of KNOWN_PREFIXES) {
    if (taxonId.startsWith(prefix)) {
      return ICON_MAP[taxonId.slice(prefix.length)];
    }
  }

  return undefined;
}

/**
 * The node's own icon, else its nearest ancestor's, so a drill-down row
 * (Hominidae, Passeriformes) shows its group's icon rather than the generic
 * leaf. For a live drill-down id the walk is its rank segments, deepest
 * first, then the root. The "all" globe is never inherited.
 */
function resolveIcon(
  taxonId: string,
): React.ComponentType<IconBaseProps> | undefined {
  const own = resolveOwnIcon(taxonId);
  if (own) return own;
  const dyn = parseDynamicNodeId(taxonId);
  if (dyn) {
    for (const seg of [...dyn.segments].reverse()) {
      const alias = RANK_VALUE_ALIASES[seg.value.toLowerCase()];
      if (alias && ICON_MAP[alias]) return ICON_MAP[alias];
    }
    const rootIcon = resolveIcon(dyn.rootId);
    if (rootIcon) return rootIcon;
  }
  for (const ancestor of getAncestors(taxonId)) {
    if (ancestor === "all") continue;
    const icon = resolveOwnIcon(ancestor);
    if (icon) return icon;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TaxaIconProps {
  taxonId: string;
  className?: string;
  size?: number;
  style?: CSSProperties;
}

export default function TaxaIcon({
  taxonId,
  className = "",
  size = 16,
  style,
}: TaxaIconProps) {
  const iconProps = { size, className, style };
  return React.createElement(resolveIcon(taxonId) ?? FaLeaf, iconProps);
}
