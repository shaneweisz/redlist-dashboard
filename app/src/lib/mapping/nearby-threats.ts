/**
 * The neighbours' threats, rolled up — kept apart from nearby-species.ts
 * because it is the half that can't cross to the browser.
 *
 * The IUCN threat vocabulary lives in lib/filter-vocab, which reaches
 * lib/data/vernacular-names and so imports node's `fs`. Pulling it into a module
 * a client component imports breaks the *build* of every page that renders the
 * map, with a module-not-found on "fs" rather than anything mentioning threats.
 * RedListView keeps its own copy of the same vocabulary for this reason; here
 * the summary simply runs where it was always going to run, in the API route,
 * and the labelled result is what crosses to the panel.
 */

import { threatDisplay } from "@/lib/filter-vocab";
import type { NearbySpecies, NearbyThreat } from "./nearby-species";

/**
 * Roll the neighbours' threat codes up to the twelve top-level IUCN categories.
 *
 * Rolled up rather than listed leaf by leaf because the leaves are too fine to
 * aggregate usefully — one assessor's 2.1.2 and another's 2.1.3 are the same
 * story about the same field, and shown separately they read as two threats
 * with one species each instead of one with two. The leaf codes stay on the
 * species rows, which is where they can be read in context.
 *
 * A species citing several leaves under one top-level code counts once for it:
 * the question is how many species face the pressure, not how many boxes each
 * assessor ticked.
 */
export function summariseThreats(
  species: readonly NearbySpecies[],
  maxExamples = 12
): NearbyThreat[] {
  const byCode = new Map<string, NearbyThreat["examples"]>();
  for (const s of species) {
    const tops = new Set(
      s.threat_codes.map((c) => c.split(".")[0]).filter(Boolean)
    );
    for (const code of tops) {
      const listed = byCode.get(code) ?? [];
      listed.push({
        key: s.gbif_species_key,
        name: s.scientific_name,
        assessmentId: s.assessment_id,
      });
      byCode.set(code, listed);
    }
  }
  return [...byCode.entries()]
    .map(([code, listed]) => ({
      code,
      label: threatDisplay(code),
      species: listed.length,
      examples: listed.slice(0, maxExamples),
    }))
    .sort((a, b) => b.species - a.species || a.code.localeCompare(b.code));
}
