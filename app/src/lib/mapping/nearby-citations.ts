/**
 * Turning the in-text citations in an assessment's prose into things you can
 * open.
 *
 * A threats narrative is dense with them — "(Ferguson-Lees and Christie 2001,
 * Global Forest Watch 2023)" — and the reference each one points at is sitting
 * right there in the same assessment's bibliography. Without this the reader has
 * a name and a year and nowhere to take them; with it, the citation is the
 * lookup.
 *
 * Matching is deliberately conservative: a citation only becomes clickable when
 * its first surname and its year both agree with a reference. Everything else
 * stays plain text, because a citation that opens the wrong reference is worse
 * than one that opens nothing.
 */

/** One entry of an assessment's bibliography, as the IUCN API returns it. */
export interface AssessmentReference {
  citation: string;
  year?: string | null;
  title?: string | null;
  author?: string | null;
}

/** A run of narrative: plain prose, or a citation that resolved to a reference. */
export interface NarrativeSegment {
  text: string;
  reference?: AssessmentReference;
}

/**
 * Candidate citations: a run of name-ish words then a four-digit year.
 *
 * The run has to be able to cross the lowercase joiners a citation is written
 * with — "Márquez and Delgado 2010", "Fjeldså & Krabbe 1990" — or the capture
 * stops at the last surname and "Delgado 2010" goes looking for a reference
 * filed under Márquez. "et al." and the in-litt./pers-comm. forms are allowed
 * to trail the name for the same reason.
 *
 * Deliberately loose on the name and strict on the year: the year is what makes
 * something a citation rather than a capitalised noun, and findReference is what
 * decides whether a candidate really was one.
 */
const NAME_WORD = String.raw`(?:[A-ZÀ-Þ][^\s(),;]*|and|&|de|del|van|von|da|dos)`;
const TRAILER = String.raw`(?:et al\.?|and others|in litt\.?|pers\.? comm\.?|unpubl\.? data)`;
const CITATION = new RegExp(
  String.raw`((?:${NAME_WORD}\s+)*?[A-ZÀ-Þ][^\s(),;]*\s+(?:${TRAILER}\s+)?)(\d{4}[a-z]?)`,
  "g"
);

/** Lower-cased, punctuation-stripped, for comparing a name to a name. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,;:'’"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The surname a reference would be cited by.
 *
 * IUCN writes authors as "Ferguson-Lees, J. and Christie, D.A." — everything up
 * to the first comma is the first author's surname. A corporate author
 * ("Global Forest Watch") has no comma and is cited whole.
 */
function citedSurname(author: string): string {
  const upToComma = author.split(",")[0].trim();
  return fold(upToComma);
}

/**
 * The reference a citation names, or undefined when nothing matches confidently.
 *
 * The year must be exact. The name matches when the citation's leading surname
 * is the reference's, or when one begins the other — which is what lets
 * "Global Forest Watch 2023" find "Global Forest Watch. 2023. ..." while
 * keeping "Márquez and Delgado 2010" off a Delgado-only reference.
 */
export function findReference(
  name: string,
  year: string,
  references: readonly AssessmentReference[]
): AssessmentReference | undefined {
  const cited = fold(name.replace(/\b(?:et al\.?|and others|in litt\.?|pers\.? comm\.?)\b/gi, ""));
  if (!cited) return undefined;
  // Initials in the running text ("C. Márquez in litt. 2014") are not part of
  // the surname the bibliography is ordered by.
  const surname = cited.replace(/^(?:[a-z]\s)+/, "");
  const first = surname.split(" and ")[0].split(" ")[0];

  return references.find((r) => {
    if ((r.year ?? "").trim() !== year.replace(/[a-z]$/, "")) return false;
    const refName = citedSurname(r.author ?? "");
    if (!refName) return false;
    return (
      refName === surname ||
      refName.startsWith(surname) ||
      surname.startsWith(refName) ||
      refName.split(" ")[0] === first
    );
  });
}

/**
 * Split narrative prose into runs, marking the citations that resolved.
 *
 * Returns the text unchanged as a single segment when there is nothing to link,
 * so a caller can render the result the same way either way.
 */
export function linkCitations(
  text: string,
  references: readonly AssessmentReference[]
): NarrativeSegment[] {
  if (!text) return [];
  if (references.length === 0) return [{ text }];

  const out: NarrativeSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(CITATION)) {
    const [whole, name, year] = m;
    const reference = findReference(name, year, references);
    if (!reference) continue;
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: whole, reference });
    last = start + whole.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
