/**
 * What someone typed into the search box, as something the index can answer.
 *
 * The box used to be one field and a checkbox, which meant the checkbox had to
 * describe the whole query: everything was a phrase, or nothing was. The
 * conventions people already know from every other search box say it per-word
 * instead — quote a phrase, minus a word to drop it, OR between alternatives,
 * a star for "and whatever follows".
 *
 *   limestone quarrying           both words, anywhere in the assessment
 *   "limestone quarrying"         those words together, in that order
 *   guano OR "bat dung"           either
 *   caves -bats                   caves, but not the ones about bats
 *   quarr*                        quarry, quarries, quarrying, quarried
 *
 * Client-safe: no DuckDB, no `fs`. The page imports it to explain itself.
 */
import { queryTokens, type Token } from "./narrative-terms";

/** One thing to look up in the index. */
export type Atom =
  | { kind: "term"; word: string }
  /** A word and everything that starts with it. */
  | { kind: "prefix"; word: string }
  /** Words that have to sit together, in this order, in one sentence. */
  | { kind: "phrase"; tokens: Token[]; text: string };

/** Alternatives, any of which satisfies this part of the query. */
export interface Clause {
  alternatives: Atom[];
}

export interface ParsedQuery {
  /** Every one of these has to match. */
  required: Clause[];
  /** None of these may. */
  excluded: Atom[];
  /** What could not be made sense of, to say so rather than silently drop it. */
  ignored: string[];
}

/**
 * The shortest prefix worth allowing.
 *
 * `s*` is 35,774 words and 2.4 million postings — the whole point of the index
 * is not reading that. Four characters keeps a prefix to a few row groups
 * (`quarr*` is ten words, `car*` is 1,816 and still under a second over R2).
 */
export const MIN_PREFIX = 4;

/** How many things one query may look up. Each is another pass over the index. */
export const MAX_ATOMS = 8;

/**
 * Split a query into its pieces, keeping quoted runs whole.
 *
 * Deliberately forgiving: an unclosed quote quotes the rest of the line, which
 * is what someone typing "limestone quarrying mid-sentence means, rather than
 * an error message about their punctuation.
 */
function pieces(query: string): { text: string; quoted: boolean; negated: boolean }[] {
  const out: { text: string; quoted: boolean; negated: boolean }[] = [];
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    if (m[2] !== undefined) out.push({ text: m[2], quoted: true, negated: m[1] === "-" });
    else {
      const raw = m[3];
      const negated = raw.startsWith("-") && raw.length > 1;
      out.push({ text: negated ? raw.slice(1) : raw, quoted: false, negated });
    }
  }
  return out;
}

/** One piece of a query, as something to look up — or nothing, if it was noise. */
function toAtom(text: string, quoted: boolean): Atom | null {
  if (quoted) {
    const tokens = queryTokens(text);
    if (tokens.length === 0) return null;
    // A "phrase" of one word is just that word, and the cheaper query for it.
    if (tokens.length === 1) return { kind: "term", word: tokens[0].word };
    return { kind: "phrase", tokens, text };
  }
  const star = text.endsWith("*");
  const tokens = queryTokens(star ? text.slice(0, -1) : text);
  if (tokens.length === 0) return null;
  const word = tokens[0].word;
  // An unquoted run that tokenises to several words (someone typed a hyphenless
  // compound, or punctuation glued two together) is treated as a phrase, which
  // is what the spacing said.
  if (tokens.length > 1) return { kind: "phrase", tokens, text };
  if (star && word.length >= MIN_PREFIX) return { kind: "prefix", word };
  return { kind: "term", word };
}

/**
 * The query, parsed.
 *
 * `OR` binds the alternative to the clause before it, so "guano OR dung mining"
 * is (guano or dung) and mining — the reading every other search box has.
 */
export function parseQuery(query: string): ParsedQuery {
  const required: Clause[] = [];
  const excluded: Atom[] = [];
  const ignored: string[] = [];
  let orPending = false;
  let atoms = 0;

  for (const piece of pieces(query)) {
    if (!piece.quoted && /^(or|\|\|?)$/i.test(piece.text)) {
      // An OR with nothing before it is just noise; with nothing after it, the
      // loop ends and it stays noise. Either way it never becomes a clause.
      orPending = required.length > 0;
      continue;
    }
    if (atoms >= MAX_ATOMS) {
      ignored.push(piece.text);
      continue;
    }
    const atom = toAtom(piece.text, piece.quoted);
    if (!atom) {
      // Stop words and stray punctuation reach here. Silently dropping a word
      // someone typed is how a search quietly answers a different question.
      if (piece.text.trim()) ignored.push(piece.text);
      continue;
    }
    atoms += 1;
    if (piece.negated) excluded.push(atom);
    else if (orPending) required[required.length - 1].alternatives.push(atom);
    else required.push({ alternatives: [atom] });
    orPending = false;
  }

  return { required, excluded, ignored };
}

/** Every word this query looks up, for marking them in a snippet. */
export function highlightsOf(parsed: ParsedQuery): { terms: string[]; prefixes: string[] } {
  const terms = new Set<string>();
  const prefixes = new Set<string>();
  for (const clause of parsed.required) {
    for (const atom of clause.alternatives) {
      if (atom.kind === "term") terms.add(atom.word);
      else if (atom.kind === "prefix") prefixes.add(atom.word);
      else for (const t of atom.tokens) terms.add(t.word);
    }
  }
  return { terms: [...terms], prefixes: [...prefixes] };
}
