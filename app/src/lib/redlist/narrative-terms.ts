/**
 * How assessment prose is cut into words — for the index, and for the query.
 *
 * One function, imported by both `scripts/build-narratives.ts` (which writes
 * the index) and the search route (which reads it). They were two functions
 * for an hour and had already drifted: the index dropped stop words and the
 * query didn't, so "guano mining in caves" looked up "in", found nothing, and
 * returned nothing — with no error anywhere to notice.
 *
 * Client-safe: no DuckDB, no `pg`, no `fs`.
 */

/**
 * Words too common to be worth indexing.
 *
 * Not a linguistic stop list — a size one. "The" is in essentially every
 * assessment, so its postings list is the whole corpus: 176k rows that can
 * never narrow a search and that nobody would search for alone. Anything a
 * reader might genuinely want ("fire", "road", "dam") is kept however common.
 */
export const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "has",
  "have", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the",
  "this", "to", "was", "were", "which", "with",
]);

/**
 * The words of a piece of text.
 *
 * Lowercased, split on anything that isn't a letter, digit or hyphen, and
 * trimmed to what a person would type: hyphens survive ("slash-and-burn"),
 * apostrophes don't. Numbers are kept — assessors write "1080 poison" and
 * "IUCN 2001" — but single characters are not.
 */
export function tokenise(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9À-ɏ-]+/)) {
    const word = raw.replace(/^-+|-+$/g, "");
    if (word.length < 2 || word.length > 40) continue;
    if (STOP_WORDS.has(word)) continue;
    out.push(word);
  }
  return out;
}

/** The distinct words of a narrative, as the index stores them. */
export function indexTerms(text: string): Set<string> {
  return new Set(tokenise(text));
}

/**
 * The words of a query, in order, deduped and capped.
 *
 * Six is enough for any question anyone types and bounds the INTERSECT the
 * search builds — each term is another pass over the index.
 */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const word of tokenise(q)) if (!out.includes(word)) out.push(word);
  return out.slice(0, 6);
}
