/**
 * Orthographic name variants: when do two spellings name the same species?
 *
 * The Red List and Catalogue of Life routinely publish the same species under
 * spellings that differ only in a Latin termination:
 *
 *   Ochotona pallasii    / Ochotona pallasi        (patronymic -ii vs -i)
 *   Sminthopsis fuliginosa / Sminthopsis fuliginosus (gender agreement)
 *   Allium lefkadensis   / Allium lefkadense       (third-declension gender)
 *   Acacia verricula     / Acacia verriculum
 *
 * Both codes treat these as the SAME name rather than as competing ones — ICZN
 * Art. 58 (species-group names differing only in specified terminations are
 * deemed identical) and ICN Art. 53.3 (names differing only in termination are
 * treated as homonyms, i.e. one name). So equating them is what the codes
 * prescribe, not a fuzzy-matching liberty.
 *
 * ── How this is used ──────────────────────────────────────────────────────
 *
 * build-matching indexes CoL by `normalisedKey` and looks our unmatched names up in
 * it, as passes 4-6 of the ladder — the same three lookups as passes 1-3, redone on
 * the normalised name.
 *
 * The obvious worry is that normalising creates collisions and lets a congener claim
 * an assessment. Measured against the current backbone, it does not: of 2,352,029
 * accepted species, 1,199 normalised keys carry more than one distinct accepted name
 * (0.10%), and none of them are cases of two real species — they are CoL holding ONE
 * species under two spellings as two accepted records:
 *
 *   Ascaltis lamarckii | Ascaltis lamarcki
 *   Raspailia rubra    | Raspailia rubrum
 *   Gerda vernale      | Gerda vernalis
 *
 * That is what the codes predict: two accepted species in one genus cannot
 * legitimately differ only by a termination, because such names ARE one name. So a
 * collision means CoL has a duplicate, not that we have found two candidates — and
 * build-matching refuses an ambiguous key outright rather than picking between two
 * records of the same thing. Across every Red List name currently unmatched, that
 * guard fires zero times; it is counted and logged rather than assumed away.
 *
 * Deliberately NOT handled, because each needs evidence this check doesn't have:
 *  - doubled consonants (Aframomum elliotii / elliottii, Annesorhiza burttii /
 *    burtii) — a correction of a misspelling, not a termination;
 *  - patronymic gender (Acrogomphus walshi / walshae) — legitimate under ICZN
 *    Art. 31.1.3, but -i/-ae is a bigger step than a termination and wants the
 *    original description to confirm it;
 *  - -er/-ra/-rum (ruber/rubra) — a real gender triple, but stripping "er" also
 *    strips the tail of ordinary epithets, so it needs its own stem test.
 * Those stay unmatched rather than being guessed at — on the names ALONE. Where
 * a second, independent source has already named a specific CoL record, the
 * first two become checkable rather than guessed: see orthographicKey at the
 * foot of this file, and pass 7 of the ladder. Patronymic gender stays refused
 * even then, because -i/-ae changes which person the name honours.
 */

// speciesNameParts / canonicalEpithet moved to src/lib/name-parts.ts, so the
// read layer can apply the same rule without importing from scripts/. Still
// re-exported here: this module's own ladder is built on them, and so are its
// callers and tests.
import { speciesNameParts, canonicalEpithet, isGenusMove } from "../src/lib/name-parts";
export { speciesNameParts, canonicalEpithet, isGenusMove };

/**
 * Do these two binomials name the same species, allowing only the termination
 * differences the codes deem identical?
 *
 * The genus must match exactly. A differing genus is a real taxonomic act — a
 * transfer, as in Agrochola kindermannii → Anchoscelis kindermanni — and belongs
 * to the synonym passes of the matching ladder, which have evidence for it. This
 * check has none, so it declines.
 */
export function sameSpeciesName(a: string, b: string): boolean {
  const left = normalisedKey(a);
  return left != null && left === normalisedKey(b);
}

/**
 * The index key two spellings of one species share: the genus verbatim, then the
 * epithet's stem. Null for anything that isn't a binomial.
 *
 * This is the form build-matching joins on. `sameSpeciesName` is the same rule
 * stated as a predicate, which is how the tests assert it.
 */
export function normalisedKey(name: string): string | null {
  const parts = speciesNameParts(name);
  return parts ? `${parts[0]} ${canonicalEpithet(parts[1])}` : null;
}

/**
 * ── Orthographic variants: a SECOND, deliberately more permissive rule ──────
 *
 * Everything above answers "do these two spellings name the same species, on the
 * strength of the names alone?", and declines wherever that evidence runs out —
 * doubled consonants, patronymic gender, and the rest listed in the header.
 *
 * This rule is for the case that list anticipated: evidence arriving from
 * somewhere else. GBIF's occurrence index is built on Catalogue of Life, so a
 * Red List name we failed to match still carries a gbif_species_key that IS a
 * col_id — an independent matcher's answer to the same question. Taking that on
 * faith is what #490 removed, and rightly: GBIF's matcher put `Agrotis sabine`
 * on `Agrotis sabura` Mabille, 1888, which is neither that name nor a spelling
 * of it.
 *
 * So neither signal is trusted alone. This rule asks only "are these two the
 * same name spelled differently?", and build-matching applies it ONLY to the
 * record GBIF already pointed at. Two weak independent signals agreeing; either
 * one by itself is refused.
 *
 * Refusing the col_id is NOT a verdict on the occurrence records keyed there,
 * and the two must not be conflated. species-key.ts has already applied its own
 * guard to that key — every candidate this rule refuses was reached by the
 * species' OWN canonical name, never by a Red List synonym, which is the
 * distinction that keeps a species from inheriting another's records (see
 * decideKey, and the Catapodium borgesii case behind it). Those counts are
 * GBIF's answer for this name, presented as GBIF's.
 *
 * The col_id carries a heavier load: WE author claims from it — the card's
 * flags, taxonomic placement, NE de-duplication, the described-species
 * denominator. Acrogomphus walshi / walshae is in the refused set, and linking
 * it would have us assert the assessment corresponds to a species named after a
 * different person. A higher bar for the col_id than for the record count is
 * the point, not an inconsistency.
 *
 * The variations folded here are the ones the codes themselves call orthographic
 * variants of one name rather than competing names:
 *
 *  - umlaut transliteration, ICZN 32.5.2.1 / ICN 60.6 — "ue" for u-diaeresis,
 *    and sources that drop the diaeresis instead (Puengeler / Pungeler, which is
 *    what makes Colostygia puengeleri / pungeleri two spellings of one moth);
 *  - i / y / consonantal j, ICN 60.7 and 60.9 (Gagea elliptica / ellyptica,
 *    Norrisia major / maior), and Dutch "ij" for y (Daphniphyllum teysmannii /
 *    teijsmannii);
 *  - Greek transliterated into Latin, ICN 60.4-60.6 — th/t, ph/f, rh/r, ch/c
 *    (Codia spatulata / spathulata, Xerocrassa rithymna / rhithymna);
 *  - doubled vs single consonants, ICN 60.1 (Inga vilosissima / villosissima);
 *  - doubled vs single i inside the epithet (Iva xanthifolia / xanthiifolia);
 *  - the termination of a personal-name epithet, Rec. 60C.1 with ICN 60.12 —
 *    -i / -ii / -ei all form one man's name (Chionanthus holdridgii /
 *    holdridgei), though NOT -ae, which honours someone else;
 *  - hyphens and apostrophes, ICN 60.11 / ICZN 32.5.2.4 (Solanum rudepannum /
 *    rude-pannum, Xylopia le-testui / letestui).
 *
 * Applied on its own this would be far too loose to match on. That is precisely
 * why it is never applied on its own.
 */
export function orthographicKey(name: string): string | null {
  const parts = speciesNameParts(name);
  if (!parts) return null;
  const fold = (s: string) =>
    s
      // A diacritic is a pronunciation mark, not a letter (ICN 60.6): the vowel
      // under it stays. Decompose and drop the marks — DELETING the character
      // instead loses a letter, which is what kept Tricholoma borgsjoeënse from
      // meeting CoL's borgsjoeense.
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Whatever is left that is not a letter: hyphens, apostrophes, periods.
      .replace(/[^a-z]/g, "")
      // Greek transliterated into Latin, ICN 60.4-60.6. Digraphs first, so "th"
      // is read as one letter before the vowel rules touch it.
      .replace(/ph/g, "f")
      .replace(/th/g, "t")
      .replace(/rh/g, "r")
      .replace(/ch/g, "c")
      // Umlaut transliterations, and sources that drop the diaeresis instead.
      // Before the i/y step, so "ue"/"oe"/"ae" read as one vowel, not two.
      .replace(/ue/g, "u")
      .replace(/oe/g, "o")
      .replace(/ae/g, "a")
      // "ij" is Dutch for y; y, i and consonantal j are then interchangeable
      // (ICN 60.7 for i/y, 60.9 for the j).
      .replace(/ij/g, "i")
      .replace(/y/g, "i")
      .replace(/j/g, "i")
      // A doubled letter is the same letter: covers the consonant and the -ii-
      // cases alike, and a run of three or more folds the same way.
      .replace(/(.)\1+/g, "$1")
      // The termination of a personal-name epithet. Rec. 60C.1 gives -i for a
      // name ending in a vowel or -er and -ii for one ending in a consonant, so
      // one person yields holdridgei / holdridgii and labillardierei /
      // labillardieri; ICN Art. 60.12 makes the wrong choice an error to be
      // CORRECTED, i.e. one name, not two. -ii has already folded to -i above,
      // so only -ei is left to fold.
      //
      // Stops at the masculine forms. Folding the trailing "i" away outright
      // would equate walshi with walshae — a change of which person the name
      // honours, which no code calls a spelling — and that guard is tested.
      .replace(/ei$/, "i");
  const genus = fold(parts[0]);
  // Terminations too, so this is a strict SUPERSET of normalisedKey rather than
  // a rule pointing at a different axis. Folding covers spelling and
  // canonicalEpithet covers endings, and a name can differ in both at once;
  // more importantly, pass 7 must never refuse a pair passes 4-6 would have
  // accepted, whatever order the ladder is later rearranged into. A test pins
  // the superset property, having first caught it not holding.
  const epithet = canonicalEpithet(fold(parts[1]));
  // Folding must never empty a part, or every short name would key alike.
  if (!genus || !epithet) return null;
  return `${genus} ${epithet}`;
}

/**
 * Are these two binomials the same name differently spelled?
 *
 * NEVER call this to decide a match on its own — see orthographicKey. It exists
 * to corroborate a candidate that some other source has already produced.
 */
export function orthographicallySame(a: string, b: string): boolean {
  const left = orthographicKey(a);
  return left != null && left === orthographicKey(b);
}
