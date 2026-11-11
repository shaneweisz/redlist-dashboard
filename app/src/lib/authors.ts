/**
 * Author citations, compared. The one place the sync, and the app's live GBIF
 * lookups (gbif-live-keys.ts), decide whether two citations name the same author.
 *
 * Two questions, two strictnesses:
 *   - normaliseAuthorship: the same citation, written alike once brackets,
 *     punctuation and spacing are set aside. Strict on purpose: species-key.ts
 *     uses it where authorship has to *prove* two names are one organism, and
 *     two frogs from one paper share a citation verbatim.
 *   - compareAuthors: are these the same author, clearly other authors, or
 *     can't it be told? Formats vary too much between IUCN and CoL for equality
 *     ("Hook.f." / "Hook.fil.", "A.Shaw" / "Airy Shaw", "Silhavy" / "Šilhavý"),
 *     so it compares author words and years (the sync's link/accept-match.ts
 *     and link/assessment-link.ts, and gbif-live-keys.ts).
 */

/**
 * Authorship reduced to what is actually being compared: brackets, punctuation
 * and spacing vary between sources for the same citation.
 * "(Ledeb.) M.Roem." and "(Ledeb.)  M. Roem." are one author, not two.
 */
export function normaliseAuthorship(authorship?: string): string {
  return (authorship ?? "")
    .toLowerCase()
    .replace(/[()[\].,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type AuthorVerdict = "same" | "other" | "unclear";

// Letters NFD doesn't decompose ("Lægaard" is "Laegaard").
const LIGATURES: Record<string, string> = { "æ": "ae", "ø": "o", "œ": "oe", "ß": "ss", "ł": "l", "đ": "d", "þ": "th" };
const fold = (s: string) => s.toLowerCase().replace(/[æøœßłđþ]/g, (c) => LIGATURES[c])
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
/** Author words: diacritics folded, German transliteration aside ("Düben" / "Dueben"), connectives and initials dropped. */
const words = (s: string) => fold(s).replace(/([aou])e/g, "$1").split(/[^a-z]+/)
  .filter((w) => w.length >= 2 && !["ex", "in", "et", "de", "van", "von", "fil", "f"].includes(w));
const year = (s: string) => s.match(/\b(1[7-9]\d\d|20\d\d)\b/)?.[1];
/** Some word in common, where one may abbreviate the other ("Pit." / "Pitard") down to `min` letters. */
const shareWord = (a: string[], b: string[], min: number) =>
  a.some((x) => b.some((y) => x === y || (x.length >= min && y.startsWith(x)) || (y.length >= min && x.startsWith(y))));

/** One typo apart: a letter changed, added or dropped, or two neighbours swapped ("Kujit" / "Kuijt"). */
export function oneTypo(x: string, y: string): boolean {
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 4 || Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  if (x.length === y.length) {
    if (x.slice(i + 1) === y.slice(i + 1)) return true;
    return x[i] === y[i + 1] && x[i + 1] === y[i] && x.slice(i + 2) === y.slice(i + 2);
  }
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  return long.slice(i + 1) === short.slice(i);
}

/**
 * Same author: a word in common (abbreviations of three letters or more), the
 * same year where both give one, and, when both cite one in brackets, the
 * same original author.
 *
 * Other authors: no word in common, even abbreviations as short as "Bl." for
 * Blume or a word one typo off ("Tamaka" / "Tanaka"), no year in common, and
 * not the same author in brackets (one organism moved by different authors,
 * "(L.) Roth" / "(L.) Hoffm."). Looser
 * than "not same": a citation's year is often a year out ("Forster, 1781" /
 * "1780") and its names misspelled ("Milen-Edwards"), which is unclear, not other.
 *
 * Unclear: everything between, and a citation missing or with nothing beyond an
 * initial ("L.") against a different one.
 *
 * Two citations written alike, once brackets, punctuation and spacing are set
 * aside, are the same author whatever they hold: "L." and "L." are both
 * Linnaeus. Without this, no Linnaean name could ever be told from a homonym
 * (Quercus robur L., which CoL also holds as a provisional copy).
 */
/**
 * Whoever named the species first, where both citations say (the author in
 * brackets): "(Lindl.) Rchb.fil." and "(Rchb.f.) Kuntze" share Reichenbach,
 * but he combined Lindley's name in one and named the other: two types, two
 * orchids (Malaxis brachystachys). A citation without brackets often just
 * leaves them out ("Druce" / "(Hill) Druce"), so it is taken as agreeing, as
 * is a bracketed author one typo off ("(Pall.)" / "(Parl.)").
 */
function sameOriginal(a: string, b: string): boolean {
  const ba = a.match(/\(([^)]*)\)/)?.[1], bb = b.match(/\(([^)]*)\)/)?.[1];
  if (!ba || !bb) return true;
  const oa = words(ba), ob = words(bb);
  return oa.length === 0 || ob.length === 0 || shareWord(oa, ob, 2) || oa.some((x) => ob.some((y) => oneTypo(x, y)));
}

export function compareAuthors(a: string | null | undefined, b: string | null | undefined): AuthorVerdict {
  if (!a || !b) return "unclear";
  if (normaliseAuthorship(a) !== "" && normaliseAuthorship(a) === normaliseAuthorship(b)) return "same";
  const wa = words(a), wb = words(b);
  if (wa.length === 0 || wb.length === 0) return "unclear";
  const ya = year(a), yb = year(b);
  if (shareWord(wa, wb, 3)) return ya && yb && ya !== yb ? "unclear" : sameOriginal(a, b) ? "same" : "unclear";
  if (shareWord(wa, wb, 2) || wa.some((x) => wb.some((y) => oneTypo(x, y))) || (ya && ya === yb)) return "unclear";
  const basionym = (s: string) => s.match(/\(([^)]*)\)/)?.[1];
  const ba = basionym(a), bb = basionym(b);
  if (ba && bb) {
    const wba = words(ba), wbb = words(bb);
    if (wba.length === 0 || wbb.length === 0 || shareWord(wba, wbb, 2)) return "unclear";
  }
  return "other";
}
