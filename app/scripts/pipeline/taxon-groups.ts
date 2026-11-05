/**
 * CoL lineage → IUCN Table 1a group: the one rule for every species not
 * assessed (assessed species keep IUCN's own classification, so Table 1a stays
 * exact).
 *
 * Per Table 1a's footnote definitions: crustaceans = note 6's classes (with
 * Maxillopoda split into CoL's copepoda/thecostraca/hexanauplia/ichthyostraca);
 * corals = Octocorallia + orders Antipatharia/Corallimorpharia/Scleractinia;
 * mosses = note 8; ferns & allies = note 9; brown algae = Phaeophyceae (the
 * brown seaweeds, not all Ochrophytina, which includes diatoms). Evaluated top
 * down: specific groups before the animalia/kingdom catch-alls. Anything
 * outside the 28 groups is 'other' and isn't surfaced.
 *
 * Expects lowercased lineage columns kingdom, phylum, class_name, order_name.
 */
export const TAXON_GROUP_CASE = `
  CASE
    WHEN class_name = 'mammalia' THEN 'mammals'
    WHEN class_name = 'aves' THEN 'birds'
    WHEN class_name = 'reptilia' THEN 'reptiles'
    WHEN class_name = 'amphibia' THEN 'amphibians'
    WHEN class_name IN ('teleostei','elasmobranchii','holocephali','myxini','petromyzonti','chondrostei','cladistii','holostei','dipneusti','coelacanthi') THEN 'fishes'
    WHEN order_name = 'coleoptera' THEN 'beetles'
    WHEN order_name = 'lepidoptera' THEN 'butterflies_and_moths'
    WHEN order_name = 'diptera' THEN 'flies_and_mosquitoes'
    WHEN order_name = 'hymenoptera' THEN 'bees_wasps_and_ants'
    WHEN order_name = 'hemiptera' THEN 'true_bugs'
    WHEN order_name = 'orthoptera' THEN 'grasshoppers_crickets_locusts'
    WHEN order_name = 'odonata' THEN 'dragonflies_and_damselflies'
    WHEN class_name = 'insecta' THEN 'other_insects'
    WHEN class_name = 'arachnida' THEN 'arachnids'
    WHEN phylum = 'mollusca' THEN 'molluscs'
    WHEN class_name IN ('malacostraca','branchiopoda','ostracoda','copepoda','thecostraca','hexanauplia','ichthyostraca','remipedia','cephalocarida','mystacocarida','tantulocarida') THEN 'crustaceans'
    WHEN class_name = 'octocorallia' OR order_name IN ('scleractinia','antipatharia','corallimorpharia') THEN 'corals'
    WHEN phylum = 'onychophora' THEN 'velvet_worms'
    WHEN class_name = 'merostomata' THEN 'horseshoe_crabs'
    WHEN kingdom = 'animalia' THEN 'other_invertebrates'
    WHEN class_name IN ('magnoliopsida','liliopsida') THEN 'flowering_plants'
    WHEN class_name IN ('pinopsida','cycadopsida','ginkgoopsida','gnetopsida') THEN 'gymnosperms'
    WHEN class_name IN ('polypodiopsida','lycopodiopsida','isoetopsida','equisetopsida','marattiopsida','psilotopsida') THEN 'ferns_and_allies'
    WHEN phylum IN ('bryophyta','marchantiophyta','anthocerotophyta') THEN 'mosses'
    WHEN phylum IN ('chlorophyta','charophyta') THEN 'green_algae'
    WHEN phylum = 'rhodophyta' THEN 'red_algae'
    WHEN kingdom = 'fungi' THEN 'mushrooms'
    WHEN class_name = 'phaeophyceae' THEN 'brown_algae'
    ELSE 'other'
  END`;

/**
 * Species CoL accepts that the Not Evaluated list leaves out, by lowercased
 * name. Domestic forms have a wild sibling that is counted (and usually
 * assessed) on its own; humans aren't a Red List subject.
 *
 * One list, replacing the two that disagreed (GBIF keys in
 * taxonomy-constants.ts, names in col-described-overrides.ts). build-taxa
 * fails if a name isn't an accepted species in the release: if CoL ever lumps
 * a domestic form into its wild sibling, the wild species would absorb its
 * records, and that needs a person to look at it.
 *
 * The domestic pigeon is deliberately absent: IUCN's "Columba domestica" is a
 * synonym of the assessed Rock Dove, Columba livia, in CoL.
 */
export const NE_EXCLUDED: Record<string, "domesticated" | "human"> = {
  "bos taurus": "domesticated",        // cattle; wild: Bos primigenius (extinct)
  "bos frontalis": "domesticated",     // gayal; wild: Bos gaurus
  "bos grunniens": "domesticated",     // yak; wild: Bos mutus
  "bubalus bubalis": "domesticated",   // water buffalo; wild: Bubalus arnee
  "camelus bactrianus": "domesticated", // Bactrian camel; wild: Camelus ferus
  "camelus dromedarius": "domesticated", // dromedary
  "canis familiaris": "domesticated",  // dog; wild: Canis lupus
  "capra hircus": "domesticated",      // goat; wild: Capra aegagrus
  "cavia porcellus": "domesticated",   // guinea pig; wild: Cavia tschudii
  "equus asinus": "domesticated",      // donkey; wild: Equus africanus
  "equus caballus": "domesticated",    // horse; wild: Equus ferus
  "felis catus": "domesticated",       // cat; wild: Felis silvestris
  "lama glama": "domesticated",        // llama; wild: Lama guanicoe
  "ovis aries": "domesticated",        // sheep; wild: Ovis gmelini
  "sus domesticus": "domesticated",    // pig; wild: Sus scrofa
  "vicugna pacos": "domesticated",     // alpaca; wild: Vicugna vicugna
  "homo sapiens": "human",
};
