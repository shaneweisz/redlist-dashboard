/**
 * How assessment prose is cut into words — for the index, and for the query.
 *
 * One module, imported by both `scripts/build-narratives.ts` (which writes the
 * index) and the search (which reads it). They were two functions for an hour
 * and had already drifted: the index dropped stop words and the query didn't,
 * so "guano mining in caves" looked up "in", found nothing, and returned
 * nothing — with no error anywhere to notice.
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
 *
 * They are dropped from the index but NOT from the count of positions — see
 * `tokenise`, which is what lets a phrase search hold them to their place.
 */
export const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "has",
  "have", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the",
  "this", "to", "was", "were", "which", "with",
]);

/** Characters a word is made of. Hyphens included: "slash-and-burn" is a word. */
const WORD_CHARS = "a-z0-9À-ɏ-";
/** What separates two words — the complement, and never a hyphen. */
const SEPARATOR = new RegExp(`([^${WORD_CHARS}]+)`);
/** The punctuation that ends a thought. A phrase never runs across one. */
const SENTENCE_END = /[.;:!?]/;
/** A separator that keeps two words in the same sentence. */
const SAME_SENTENCE = "[^a-z0-9À-ɏ.;:!?-]+";

/**
 * How many positions a full stop costs.
 *
 * Dropping stop words from the index leaves a hole in a phrase — "mining in
 * caves" is stored as "mining" and "caves" two places apart — and anything at
 * all can fill that hole. Mostly that is what you want: it is how "mining in
 * caves" also finds "mining of caves". But it let "guano mining. If caves are
 * left undisturbed" answer a search for "guano mining in caves", which is two
 * sentences pretending to be a phrase. Charging a sentence boundary more
 * positions than a query can spend keeps a phrase inside one sentence.
 */
export const SENTENCE_GAP = 32;

export interface Token {
  word: string;
  /**
   * Which word this is, counting from the start of the text.
   *
   * Counts EVERY word, including the stop words and the too-short ones that
   * never reach the index. That is the whole trick behind phrase search: the
   * index stores "caves is word 41", the query knows "caves is two words after
   * mining", and the two agree without the index having to store "in".
   */
  pos: number;
}

/**
 * The words of a piece of text, with their positions.
 *
 * Lowercased, split on anything that isn't a letter, digit or hyphen, and
 * trimmed to what a person would type: hyphens survive ("slash-and-burn"),
 * apostrophes don't. Numbers are kept — assessors write "1080 poison" and
 * "IUCN 2001" — but single characters are not.
 */
export function tokenise(text: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  // Split keeping the separators, which is how a full stop gets to be visible:
  // parts alternate word, separator, word, separator, …
  const parts = text.toLowerCase().split(SEPARATOR);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      if (SENTENCE_END.test(parts[i])) pos += SENTENCE_GAP;
      continue;
    }
    const word = parts[i].replace(/^-+|-+$/g, "");
    if (word.length === 0) continue;
    // Counted before the filters, not after: a dropped word still took up a
    // place in the sentence, and phrase matching is measured in places.
    const at = pos++;
    if (word.length < 2 || word.length > 40) continue;
    if (STOP_WORDS.has(word)) continue;
    out.push({ word, pos: at });
  }
  return out;
}

/**
 * How much of a gap to leave between one narrative field and the next.
 *
 * Positions run through all nine fields as one stream, so without a gap the
 * last word of the rationale sits right beside the first word of the range —
 * and a phrase search would match a "phrase" that spans the two, which no
 * reader would accept as a mention. Larger than a sentence break, which is
 * itself larger than anything a typed query can spend.
 */
export const FIELD_GAP = SENTENCE_GAP * 8;

/**
 * A narrative as the index stores it: each word, and everywhere it appears.
 *
 * Takes the fields in order, because the gap between them matters (above).
 * Positions ascending, which is what lets a phrase check be a list
 * intersection in SQL rather than a scan of the prose.
 */
export function indexPostings(fields: string[]): Map<string, number[]> {
  const postings = new Map<string, number[]>();
  let base = 0;
  for (const field of fields) {
    let last = -1;
    for (const { word, pos } of tokenise(field)) {
      const at = base + pos;
      last = pos;
      const seen = postings.get(word);
      if (seen) seen.push(at);
      else postings.set(word, [at]);
    }
    base += last + 1 + FIELD_GAP;
  }
  // Merged across fields in field order, so each list is already ascending.
  return postings;
}

/**
 * The words of a query, in order, with their positions relative to the first.
 *
 * Six is enough for any question anyone types and bounds the work a search
 * does — each term is another pass over the index. Duplicates are kept, so
 * "cave to cave" stays a three-word phrase with a word repeated.
 */
export function queryTokens(q: string): Token[] {
  const tokens = tokenise(q).slice(0, 6);
  if (tokens.length === 0) return [];
  const base = tokens[0].pos;
  return tokens.map(({ word, pos }) => ({ word, pos: pos - base }));
}

/** The distinct words of a query — what an all-the-words search looks up. */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const { word } of queryTokens(q)) if (!out.includes(word)) out.push(word);
  return out;
}

/**
 * A pattern that finds the phrase in the prose, exactly as the index matched it.
 *
 * The index says an assessment holds these words in these places; this finds
 * that spot in the text to quote it. It has to agree with the position rule or
 * a matched assessment shows no snippet: words are separated by anything that
 * isn't a word character, and a gap in the query's positions — the "in" of
 * "mining in caves" — is exactly that many words of anything in between.
 */
export function phrasePattern(tokens: Token[]): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = `[${WORD_CHARS}]+`;
  let src = esc(tokens[0].word);
  for (let i = 1; i < tokens.length; i++) {
    const gap = tokens[i].pos - tokens[i - 1].pos - 1;
    // A gap the size of a sentence break can only have come from the query
    // itself containing one, so the text is allowed one too; anything smaller
    // is that many words without a full stop among them, which is what the
    // positions in the index just asserted.
    src +=
      gap >= SENTENCE_GAP
        ? `[\\s\\S]{1,400}?`
        : SAME_SENTENCE + `(?:${word}${SAME_SENTENCE}){${gap}}`;
    src += esc(tokens[i].word);
  }
  return new RegExp(`(?<![${WORD_CHARS}])${src}(?![${WORD_CHARS}])`, "i");
}
