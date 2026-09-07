/**
 * Splitting a species name into the parts the nomenclatural codes compare on.
 *
 * Lifted out of scripts/name-variants.ts (which still re-exports it, and holds
 * everything built on top: normalisedKey, orthographicallySame, the matching
 * ladder) because the read layer needs the same rule and must not import from
 * scripts/ — nothing shipped does. The rule decides, among other things,
 * whether an accepted-name difference is a genus transfer or a different name
 * altogether, which the dashboard card and the SSC panel both report.
 */

/**
 * Terminations the codes deem variants of one another: the Latin gender triple
 * (-us / -um / -a), the third-declension pair (-is / -e), and the Greek pair
 * (-os / -on). Two-letter endings are listed first so a longer one is never
 * missed because a shorter suffix of it matched.
 *
 * "-ae" is absent on purpose. It would pair with "-a", which is not a gender
 * variant of it, and it is the ending that would quietly enable the -i/-ae
 * patronymic gender change this check declines to make.
 */
const GENDER_TERMINATIONS = ["us", "um", "is", "os", "on", "a", "e"];

/**
 * One species name → [genus, epithet], lowercased, with the notation that
 * carries no nomenclatural weight removed:
 *  - a parenthesised subgenus, which CoL prints and the Red List doesn't
 *    ("Ochotona (Pika) pallasi" → "ochotona pallasi");
 *  - the hybrid sign, which marks a nothospecies rather than changing the name
 *    ("Agave × peacockii" → "agave peacockii"). Only the Unicode × is stripped:
 *    a bare ASCII "x" is a normal letter and removing it would corrupt epithets.
 *
 * Returns null for anything that isn't a binomial — a monomial, or a trinomial
 * (a subspecies is a different rank, and this is only ever asked about species).
 */
export function speciesNameParts(name: string): [genus: string, epithet: string] | null {
  const tokens = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/×/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length !== 2) return null;
  return [tokens[0], tokens[1]];
}

/**
 * An epithet reduced to the stem the codes compare on: doubled terminal "i"
 * collapsed (pallasii → pallasi), then one gender termination removed
 * (fuliginosus / fuliginosa → fuligino).
 *
 * Order matters. The "i" collapse runs first so that a patronym keeps its "i"
 * and is not then read as a gender ending; "i" is deliberately absent from
 * GENDER_TERMINATIONS for the same reason.
 *
 * A termination is only removed when something is left behind — "Ovis ovis"-style
 * short epithets must not normalise to the empty string, which would make every
 * one of them equal to every other.
 */
export function canonicalEpithet(epithet: string): string {
  const collapsed = epithet.replace(/i{2,}$/, "i");
  for (const t of GENDER_TERMINATIONS) {
    if (collapsed.endsWith(t) && collapsed.length > t.length + 1) {
      return collapsed.slice(0, -t.length);
    }
  }
  return collapsed;
}

/**
 * Is the difference between these two names a genus transfer — the same species
 * epithet under another genus (Sorbus greenii -> Aria greenii)?
 *
 * A transfer keeps the epithet and changes the genus, canonically: the epithet's
 * ending usually shifts to agree with the new genus (Anolis wattsi -> Norops
 * wattsii), which is why the comparison runs on canonicalEpithet rather than on
 * the raw strings. Anything else — a different epithet, with or without a
 * different genus — is a different name, not a transfer.
 *
 * False for anything that isn't a pair of binomials: a subspecies is a different
 * rank, and this is only ever asked about species.
 */
export function isGenusMove(from: string, to: string): boolean {
  const mine = speciesNameParts(from), theirs = speciesNameParts(to);
  return mine != null && theirs != null
    && mine[0] !== theirs[0] && canonicalEpithet(mine[1]) === canonicalEpithet(theirs[1]);
}
