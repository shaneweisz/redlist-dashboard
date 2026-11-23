/**
 * The name functions docs/specs/matching.md is written against, and the only
 * library an implementation of that spec may use (checks/rebuild-check.ts
 * bundles this file alone). It imports only src/lib/authors.ts and
 * src/lib/name-parts.ts.
 *
 *   compareAuthors(a, b)        same | other | unclear (src/lib/authors.ts)
 *   normaliseAuthorship(a)      a citation with brackets, punctuation and spacing set aside
 *   orthographicallySame(a, b)  two binomials are one name under the codes' spelling rules
 *   orthographicKey(name)       the key orthographicallySame compares
 *   sameOrganism(a, b)          the spec's test for two names being one organism
 *   isCoLRespelling(syn, acc)   a CoL synonym that only respells the name it is filed under
 *   canonicalEpithet, epithetOf the epithet with its gender ending, or hybrid sign, set aside
 *
 * The spec's definitions (the same name, a gender ending, a respelling) are
 * here too, as sameName, genderEnding and respelling.
 */

import { compareAuthors, normaliseAuthorship, type AuthorVerdict } from "../../../src/lib/authors";
import { canonicalEpithet, speciesNameParts } from "../../../src/lib/name-parts";

export { compareAuthors, normaliseAuthorship, canonicalEpithet, type AuthorVerdict };

/** A name as the taxonomies give it: the binomial, and its author citation if known. */
export interface TaxonName {
  scientificName: string;
  authorship?: string | null;
}

/** The same name: equal lower-cased, without ×, whitespace (tabs too) collapsed. This is the key every name lookup uses. */
export function sameNameKey(name: string): string {
  return name.toLowerCase().replace(/×/g, "").replace(/\s+/g, " ").trim();
}

export const sameName = (a: string, b: string) => sameNameKey(a) === sameNameKey(b);

const genusOf = (scientificName: string) => scientificName.trim().toLowerCase().split(/\s+/)[0] ?? "";

/**
 * The species epithet, lower-cased, with the hybrid marker dropped: Solanum x
 * vallis-mexici and Solanum vallis-mexici are one plant.
 */
export function epithetOf(scientificName: string): string {
  const parts = scientificName.trim().toLowerCase().split(/\s+/);
  const raw = parts[1] ?? "";
  return raw.replace(/^[×x]$/, "") === "" ? (parts[2] ?? "") : raw.replace(/^×/, "");
}

/**
 * Orthographic variants the codes call one name (ICZN Art. 32.5, 58; ICN Art.
 * 60): diacritics and umlaut transliteration, i/y/j and Dutch ij, Greek
 * digraphs (th/t, ph/f, rh/r, ch/c), doubled letters, a personal name's
 * -i/-ii/-ei (not -ae, which honours someone else), hyphens and apostrophes,
 * and the epithet's gender ending (canonicalEpithet). Asked only of names
 * another source already put side by side; on its own it is too loose to
 * match on.
 */
export function orthographicKey(name: string): string | null {
  const parts = speciesNameParts(name);
  if (!parts) return null;
  const fold = (s: string) =>
    s
      // A diacritic is a mark, not a letter (ICN 60.6): decompose and drop the marks.
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z]/g, "")
      // Greek transliterated into Latin, digraphs first.
      .replace(/ph/g, "f")
      .replace(/th/g, "t")
      .replace(/rh/g, "r")
      .replace(/ch/g, "c")
      // Umlaut transliterations, before the i/y step.
      .replace(/ue/g, "u")
      .replace(/oe/g, "o")
      .replace(/ae/g, "a")
      .replace(/ij/g, "i")
      .replace(/y/g, "i")
      .replace(/j/g, "i")
      // A doubled letter is the same letter.
      .replace(/(.)\1+/g, "$1")
      // A personal name's -ei / -i (Rec. 60C.1, Art. 60.12); -ii folded above.
      .replace(/ei$/, "i");
  const genus = fold(parts[0]);
  const epithet = canonicalEpithet(fold(parts[1]));
  if (!genus || !epithet) return null;
  return `${genus} ${epithet}`;
}

/** Two binomials are one name under the codes' spelling rules (pallasii / pallasi). */
export function orthographicallySame(a: string, b: string): boolean {
  const left = orthographicKey(a);
  return left != null && left === orthographicKey(b);
}

/** Levenshtein distance: insertions, deletions, substitutions. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** The typo limit: the one tuned number in the spec. */
export const MAX_TYPO_LETTERS = 2;

/** Both end in one of `endings` after a common, non-empty stem. */
const sameStem = (a: string, b: string, endings: string[]) =>
  endings.some((x) => a.endsWith(x) && a.length > x.length
    && endings.some((y) => b.endsWith(y) && b.length > y.length && a.slice(0, -x.length) === b.slice(0, -y.length)));

/** Epithets that differ only in a gender ending: canonicalEpithet, -er/-era/-erum/-ra/-rum (niger / nigrum), -tor/-trix. */
export function genderEnding(a: string, b: string): boolean {
  return canonicalEpithet(a) === canonicalEpithet(b)
    || sameStem(a, b, ["er", "era", "erum", "ra", "rum"])
    || sameStem(a, b, ["tor", "trix"]);
}

const GENITIVES = ["iarum", "iorum", "arum", "orum", "iae", "ae", "ii", "i"];
/** The epithet without its genitive ending, the longest that fits (jamesi / jamesorum). */
const genitiveStem = (e: string) => {
  for (const g of GENITIVES) if (e.endsWith(g) && e.length > g.length) return e.slice(0, -g.length);
  return e;
};

/**
 * A respelling: epithets orthographicallySame (both under `genus`), or
 * differing only in a gender ending, or only in a genitive ending, or by at
 * most MAX_TYPO_LETTERS letters. Asked only of names with the same citation.
 */
export function respelling(a: string, b: string, genus: string): boolean {
  return orthographicallySame(`${genus} ${a}`, `${genus} ${b}`)
    || genderEnding(a, b)
    || genitiveStem(a) === genitiveStem(b)
    || editDistance(a, b) <= MAX_TYPO_LETTERS;
}

/**
 * The same organism: the same name; or the same epithet (a genus transfer:
 * Hylatomus / Dryocopus pileatus); or different genera and epithets differing
 * only in a gender ending (Meiostemon tetrandrus / Combretum tetrandrum); or
 * equal authorships, both given, and epithets that are a respelling (Pica
 * nutalli / nuttallii, both Audubon, 1837). Authorship alone proves nothing:
 * two frogs from one paper share it verbatim (Pseudophilautus abundus /
 * procax).
 */
export function sameOrganism(a: TaxonName, b: TaxonName): boolean {
  if (sameName(a.scientificName, b.scientificName)) return true;
  const ea = epithetOf(a.scientificName), eb = epithetOf(b.scientificName);
  if (!ea || !eb) return false;
  if (ea === eb) return true;
  if (genusOf(a.scientificName) !== genusOf(b.scientificName) && genderEnding(ea, eb)) return true;
  const na = normaliseAuthorship(a.authorship ?? undefined), nb = normaliseAuthorship(b.authorship ?? undefined);
  if (!na || na !== nb) return false;
  return respelling(ea, eb, genusOf(a.scientificName));
}

/**
 * A CoL synonym that is only a respelling of the name it is filed under: one
 * genus, the same citation (f. = fil., diacritics ignored), two different
 * epithets that are a respelling (Meandrina danae / danai). CoL's two
 * citations are compared, so it holds where the Red List writes its own
 * differently.
 */
export function isCoLRespelling(synonym: TaxonName, accepted: TaxonName): boolean {
  if (genusOf(synonym.scientificName) !== genusOf(accepted.scientificName)) return false;
  const cite = (a?: string | null) => normaliseAuthorship(a ?? undefined).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\bfil\b/g, "f");
  const ca = cite(synonym.authorship);
  if (!ca || ca !== cite(accepted.authorship)) return false;
  const a = epithetOf(synonym.scientificName), b = epithetOf(accepted.scientificName);
  if (!a || !b || a === b) return false;
  return respelling(a, b, genusOf(synonym.scientificName));
}
