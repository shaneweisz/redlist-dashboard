/**
 * A species' threat codes as labelled tags — kept apart from nearby-species.ts
 * because it is the half that can't cross to the browser.
 *
 * The IUCN threat vocabulary lives in lib/filter-vocab, which reaches
 * lib/data/vernacular-names and so imports node's `fs`. Pulling it into a module
 * a client component imports breaks the *build* of every page that renders the
 * map, with a module-not-found on "fs" rather than anything mentioning threats.
 * RedListView keeps its own copy of the same vocabulary for this reason; here
 * the labelling simply runs where it was always going to run, in the API route,
 * and the labelled tags are what cross to the panel.
 */

import { threatDisplay } from "@/lib/filter-vocab";

/**
 * Threat codes trimmed to two levels, deduped, and labelled.
 *
 * Two levels because that is where a code is a thing you recognise — "5.4",
 * Fishing & harvesting — rather than a classification leaf, and because a
 * species citing 5.4.1, 5.4.2 and 5.4.3 would otherwise wear three tags all
 * saying the same thing. threatDisplay walks up to the nearest label it knows,
 * so a code the vocabulary doesn't carry still reads as something.
 */
export function threatTags(codes: readonly string[]): { code: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const raw of codes) {
    const code = raw.split(".").slice(0, 2).join(".");
    if (code && !seen.has(code)) seen.set(code, threatDisplay(code));
  }
  return [...seen.entries()].map(([code, label]) => ({ code, label }));
}
