/**
 * Searching what assessors wrote.
 *
 * The second half of issue #474: find the assessments that mention something —
 * a habitat type, a threat nobody has a code for, a place — and show where in
 * the text they mention it.
 *
 * Four parquets, built by `scripts/build-narratives.ts` and published once per
 * Red List release (see narrative-release.ts — they are not sync data):
 *
 *  - `narrative-index.parquet`, sorted by term, is what a search reads. Sorted,
 *    parquet's row-group statistics prune every group whose term range excludes
 *    the word, so looking one up touches a few hundred kilobytes of a 159 MB
 *    file rather than all of it — and a prefix, being a contiguous range of
 *    terms, costs the same. Each posting carries every position of that word in
 *    that assessment: phrase matching is a list intersection over those, and
 *    how many there are is the term frequency that ranks the results.
 *  - `narrative-terms.parquet`, 2 MB, is the word list and how many assessments
 *    use each word. It answers "how rare is this word" (ranking) and "what else
 *    looks like this word" (fuzzy, did-you-mean) without opening the index.
 *  - `narrative-lengths.parquet`, half a megabyte, is how long each assessment
 *    is — what keeps a long one from outranking a short one on wordcount.
 *  - `narratives.parquet`, sorted by assessment_id in small row groups, is what
 *    a *result* reads — only for the assessments already matched, and only for
 *    the page being shown, or one assessment when a reader expands it.
 *
 * Scanning the prose itself would be simpler, and is ~470 MB of text per query
 * over httpfs. The index is what makes this a search box rather than a job.
 */
import * as fs from "fs";
import * as path from "path";
import { getConn, parquetUri } from "./species-duckdb";
import { NARRATIVE_FIELDS, type NarrativeField } from "@/lib/redlist/narrative-fields";
import { narrativeKey } from "@/lib/redlist/narrative-release";
import { phrasePattern, wordPattern, prefixPattern } from "@/lib/redlist/narrative-terms";
import {
  parseQuery,
  highlightsOf,
  type Atom,
  type ParsedQuery,
} from "@/lib/redlist/narrative-query";

export interface NarrativeHit {
  assessment_id: number;
  sis_taxon_id: number | null;
  scientific_name: string;
  common_name: string | null;
  category: string | null;
  /** The IUCN Table 1a group, for the icon a species with no photo falls back to. */
  taxon_group: string | null;
  /** The field the search was answered in, and the words around the match. */
  field: NarrativeField | null;
  snippet: string | null;
}

/** A word the search stood in for, and what it stood in for. */
export interface WordSwap {
  from: string;
  to: string[];
}

export interface NarrativeSearchResult {
  hits: NarrativeHit[];
  /** How many assessments matched, before the page was taken off the front. */
  total: number;
  /** Whole words to mark in a snippet. */
  terms: string[];
  /** Word beginnings to mark in a snippet. */
  prefixes: string[];
  /** Where fuzzy matching widened a word (only when it was asked for). */
  expanded: WordSwap[];
  /** Words that matched nothing, and what was probably meant. */
  suggestions: WordSwap[];
  /** Pieces of the query that were not looked up, so nobody assumes they were. */
  ignored: string[];
}

/**
 * Where to read a narrative parquet from.
 *
 * Local when the file is there, R2 otherwise — and the R2 half is deliberately
 * NOT `parquetUri`. That resolves to the current sync's prefix, and these files
 * are not sync data: they are written once per Red List release to
 * `narratives/<release>/` and left there. Pointing them at the sync is what
 * produced a 404 on every preview deployment, since no sync has ever held them.
 *
 * The local check is its own rule too, not `USE_R2`: they are built on their
 * own (`scripts/build-narratives.ts`, against a restored release database) long
 * before a full sync is fetched, and a developer with them in `data/` means to
 * search them.
 */
function narrativeUri(name: string): string {
  const local = path.join(process.cwd(), "data", name);
  if (fs.existsSync(local)) return local;
  return `s3://${process.env.R2_DATA_BUCKET_NAME}/${narrativeKey(name)}`;
}

/** A string, safe to drop into SQL. */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** A prefix, safe to drop into a LIKE. */
function likeLit(s: string): string {
  return lit(s.replace(/[%_\\]/g, "\\$&") + "%") + " ESCAPE '\\'";
}

/**
 * How many assessments there are, for weighing how rare a word is.
 *
 * Read from the parquet footer rather than counted, and once per warm
 * container: it changes when a release does, which is when the process is new
 * anyway.
 */
let totalPromise: Promise<number> | null = null;
function assessmentCount(): Promise<number> {
  if (!totalPromise) {
    totalPromise = (async () => {
      const conn = await getConn();
      const rows = (
        await conn.runAndReadAll(
          `SELECT count(*) AS n FROM read_parquet(${lit(narrativeUri("narratives.parquet"))})`
        )
      ).getRowObjects() as unknown as { n: bigint }[];
      return Number(rows[0].n);
    })().catch((e) => {
      totalPromise = null;
      throw e;
    });
  }
  return totalPromise;
}

/**
 * How much a word is worth finding.
 *
 * The standard inverse document frequency: a word in eight assessments says far
 * more about the ones it is in than a word in eighty thousand. Without it,
 * results come back in assessment_id order, which for a common word is an
 * arbitrary page of an enormous list.
 */
function idf(df: number, total: number): number {
  return Math.log(1 + total / Math.max(1, df));
}

/**
 * Which words to try when a word might be a typo.
 *
 * Only for words of five letters or more: at four, an edit away is a different
 * word ("cave" and "care"), and the neighbourhood is enormous. One edit only —
 * two is where a word list of 413,618 entries starts answering questions nobody
 * asked.
 *
 * Damerau rather than plain Levenshtein, because swapping two letters is the
 * typo people actually make and plain edit distance charges two for it:
 * "limestoen" is one transposition from "limestone" and two deletions-and-
 * insertions away, which was enough to suggest "limeston" instead.
 */
const FUZZY_MIN_LENGTH = 5;
const FUZZY_LIMIT = 8;

/**
 * How much more common a neighbour has to be before it is worth suggesting.
 *
 * A misspelling that happens to exist in the corpus still matches something, so
 * "did you mean" cannot key off finding nothing. Twenty times is a wide enough
 * gap to be a correction rather than a second opinion.
 */
const SUGGEST_RATIO = 20;

/**
 * The word list, held in memory for as long as the container lives.
 *
 * Two megabytes, read on every search otherwise — twice, for the ranking
 * weights and the near-misses — which over R2 was most of what a search cost:
 * 800 ms a query against 250 ms for the postings alone. As a temp table it is
 * fetched once and every later query reads it locally, the same bargain
 * `ensureNeHelpers` makes for the species side. Reset on failure so a
 * transient R2 error can retry rather than poisoning the container.
 */
let termTablePromise: Promise<void> | null = null;
function ensureTermTable(): Promise<void> {
  if (!termTablePromise) {
    termTablePromise = (async () => {
      const conn = await getConn();
      await conn.run(
        `CREATE TEMP TABLE IF NOT EXISTS narrative_terms AS
         SELECT term, df FROM read_parquet(${lit(narrativeUri("narrative-terms.parquet"))})`
      );
    })().catch((e) => {
      termTablePromise = null;
      throw e;
    });
  }
  return termTablePromise;
}

/**
 * How long each assessment is, and how long they are on average.
 *
 * Half a megabyte, loaded once for the same reason the word list is. Without
 * it, ranking is a popularity contest between long assessments: a thorough,
 * repetitive account of a well-studied species beats a short one squarely
 * about the thing being searched for, purely by saying the word more often.
 * The corpus makes that concrete — a median assessment is 175 indexed words
 * and the longest is 17,323.
 */
let lengthsPromise: Promise<number> | null = null;
function ensureLengths(): Promise<number> {
  if (!lengthsPromise) {
    lengthsPromise = (async () => {
      const conn = await getConn();
      await conn.run(
        `CREATE TEMP TABLE IF NOT EXISTS narrative_lengths AS
         SELECT assessment_id, n_words FROM read_parquet(${lit(narrativeUri("narrative-lengths.parquet"))})`
      );
      const rows = (
        await conn.runAndReadAll(`SELECT avg(n_words) AS avg FROM narrative_lengths`)
      ).getRowObjects() as unknown as { avg: number }[];
      return Number(rows[0].avg) || 1;
    })().catch((e) => {
      lengthsPromise = null;
      throw e;
    });
  }
  return lengthsPromise;
}

/**
 * The common name, category and taxon group of every assessed species.
 *
 * From the sync's `assessed.parquet` rather than the narratives, because that
 * is where those live — and as a temp table for the same reason as the word
 * list, since a result page needs ten rows of it and a scan per search would
 * be the most expensive part of a search. The two files come from different
 * places (a release, a sync) so the join is a LEFT one: a species the sync has
 * dropped still has narratives worth finding, just without a common name.
 */
let namesPromise: Promise<void> | null = null;
function ensureCommonNames(): Promise<void> {
  if (!namesPromise) {
    namesPromise = (async () => {
      const conn = await getConn();
      await conn.run(
        `CREATE TEMP TABLE IF NOT EXISTS narrative_species AS
         SELECT assessment_id, common_name, iucn_category AS category, taxon_group
         FROM read_parquet(${lit(parquetUri("assessed.parquet"))})
         WHERE assessment_id IS NOT NULL`
      );
    })().catch((e) => {
      namesPromise = null;
      throw e;
    });
  }
  return namesPromise;
}

/**
 * The two knobs of BM25, at the values everyone uses.
 *
 * `K1` is how fast repetition stops counting: the tenth mention of a word says
 * much less than the second. `B` is how hard length is held against a document
 * — 0.75 leaves a long assessment able to win, but only on merit rather than
 * on wordcount.
 */
const K1 = 1.2;
const B = 0.75;

/** What the dictionary knows about the words in a query. */
interface WordStats {
  /** Exact document frequency, 0 if the word is in no assessment. */
  df: Map<string, number>;
  /** Near-misses per word, most-used first. */
  near: Map<string, { word: string; df: number }[]>;
  /** Total df across the words a prefix covers, and how many words that is. */
  prefix: Map<string, { df: number; words: number }>;
}

/**
 * One trip to the word list for everything the query needs to know.
 *
 * A handful of milliseconds against the in-memory word list, which buys the
 * ranking weights, the fuzzy alternatives and the did-you-mean suggestions —
 * none of which would be worth doing if it meant opening the index.
 */
async function statsFor(parsed: ParsedQuery): Promise<WordStats> {
  const words = new Set<string>();
  const prefixes = new Set<string>();
  const visit = (atom: Atom) => {
    if (atom.kind === "term") words.add(atom.word);
    else if (atom.kind === "prefix") prefixes.add(atom.word);
    else for (const t of atom.tokens) words.add(t.word);
  };
  for (const clause of parsed.required) clause.alternatives.forEach(visit);
  parsed.excluded.forEach(visit);

  const stats: WordStats = { df: new Map(), near: new Map(), prefix: new Map() };
  if (words.size === 0 && prefixes.size === 0) return stats;

  const conn = await getConn();
  await ensureTermTable();
  if (words.size > 0) {
    const list = [...words].map(lit).join(", ");
    const rows = (
      await conn.runAndReadAll(
        `SELECT term, df FROM narrative_terms WHERE term IN (${list})`
      )
    ).getRowObjects() as unknown as { term: string; df: number }[];
    for (const w of words) stats.df.set(w, 0);
    for (const r of rows) stats.df.set(String(r.term), Number(r.df));

    // Near-misses for every word, always — the same 2 MB scan answers "did you
    // mean" for a word that matched nothing and "also try" for fuzzy search, so
    // asking once is cheaper than deciding first and asking later.
    const fuzzyWords = [...words].filter((w) => w.length >= FUZZY_MIN_LENGTH);
    if (fuzzyWords.length > 0) {
      const scans = fuzzyWords.map(
        (w) => `SELECT ${lit(w)} AS src, term, df FROM narrative_terms
                WHERE length(term) BETWEEN ${w.length - 1} AND ${w.length + 1}
                  AND term <> ${lit(w)}
                  AND damerau_levenshtein(term, ${lit(w)}) <= 1`
      );
      const rows2 = (
        await conn.runAndReadAll(
          `SELECT src, term, df FROM (${scans.join(" UNION ALL ")})
           QUALIFY row_number() OVER (PARTITION BY src ORDER BY df DESC, term) <= ${FUZZY_LIMIT}`
        )
      ).getRowObjects() as unknown as { src: string; term: string; df: number }[];
      for (const r of rows2) {
        const list = stats.near.get(String(r.src)) ?? [];
        list.push({ word: String(r.term), df: Number(r.df) });
        stats.near.set(String(r.src), list);
      }
      for (const list of stats.near.values()) list.sort((a, b) => b.df - a.df);
    }
  }

  for (const p of prefixes) {
    const rows = (
      await conn.runAndReadAll(
        `SELECT coalesce(sum(df), 0)::BIGINT AS df, count(*)::BIGINT AS words
         FROM narrative_terms WHERE term LIKE ${likeLit(p)}`
      )
    ).getRowObjects() as unknown as { df: bigint; words: bigint }[];
    stats.prefix.set(p, { df: Number(rows[0].df), words: Number(rows[0].words) });
  }
  return stats;
}

/** Postings for one word: which assessments hold it, how often, and where. */
function termRows(index: string, word: string, weight: number, clause: number): string {
  return `SELECT assessment_id, ${clause} AS c, len(positions) AS tf, ${weight.toFixed(4)} AS w
          FROM read_parquet(${lit(index)}) WHERE term = ${lit(word)}`;
}

/**
 * Postings for a word and everything that starts with it.
 *
 * A contiguous range of a term-sorted file, which is why this costs what one
 * word costs. Occurrences are summed across the words it covers, so an
 * assessment that says "quarry", "quarries" and "quarrying" ranks above one
 * that says "quarried" once.
 */
function prefixRows(index: string, word: string, weight: number, clause: number): string {
  return `SELECT assessment_id, ${clause} AS c, sum(len(positions)) AS tf, ${weight.toFixed(4)} AS w
          FROM read_parquet(${lit(index)}) WHERE term LIKE ${likeLit(word)}
          GROUP BY assessment_id`;
}

/**
 * Postings for words that have to sit together.
 *
 * Each word's positions are shifted back by where it sits in the phrase, so two
 * words agree on a number exactly when they are the right distance apart in the
 * text — "mining" at 40 and "caves" at 42, asked for as "mining in caves", both
 * anchor to 40. The shared anchors are the phrase's occurrences, which is both
 * the test (are there any) and the weight (how many).
 */
function phraseRows(index: string, atom: Atom, weight: number, clause: number): string {
  if (atom.kind !== "phrase") throw new Error("not a phrase");
  const parts = atom.tokens.map((t, i) => {
    const shift = t.pos === 0 ? "positions" : `list_transform(positions, p -> p - ${t.pos})`;
    return `(SELECT assessment_id, ${shift} AS anchors FROM read_parquet(${lit(index)})
             WHERE term = ${lit(t.word)}) t${i}`;
  });
  const joins = parts
    .slice(1)
    .map((part, i) => `JOIN ${part} ON t${i + 1}.assessment_id = t0.assessment_id`)
    .join("\n            ");
  let shared = "t0.anchors";
  for (let i = 1; i < atom.tokens.length; i++) shared = `list_intersect(${shared}, t${i}.anchors)`;
  return `SELECT t0.assessment_id, ${clause} AS c, len(${shared}) AS tf, ${weight.toFixed(4)} AS w
          FROM ${parts[0]}
            ${joins}
          WHERE len(${shared}) > 0`;
}

/** The rows one alternative contributes, weighted by how rare it is. */
function atomRows(
  index: string,
  atom: Atom,
  clause: number,
  stats: WordStats,
  total: number,
  fuzzy: boolean
): string[] {
  if (atom.kind === "prefix") {
    const p = stats.prefix.get(atom.word);
    return [prefixRows(index, atom.word, idf(p?.df ?? 1, total), clause)];
  }
  if (atom.kind === "phrase") {
    // A phrase is at most as common as its rarest word, and usually far rarer;
    // that bound is the honest weight without counting phrases at build time.
    const dfs = atom.tokens.map((t) => stats.df.get(t.word) ?? 0);
    return [phraseRows(index, atom, idf(Math.min(...dfs), total), clause)];
  }
  const words = [atom.word, ...(fuzzy ? (stats.near.get(atom.word) ?? []).map((n) => n.word) : [])];
  return words.map((w) => termRows(index, w, idf(stats.df.get(w) ?? 1, total), clause));
}

/** Just the assessments an atom matches — for the words a query rules out. */
function atomDocs(index: string, atom: Atom, stats: WordStats): string {
  if (atom.kind === "prefix")
    return `SELECT assessment_id FROM read_parquet(${lit(index)}) WHERE term LIKE ${likeLit(atom.word)}`;
  if (atom.kind === "phrase")
    return `SELECT assessment_id FROM (${phraseRows(index, atom, 1, 0)})`;
  void stats;
  return `SELECT assessment_id FROM read_parquet(${lit(index)}) WHERE term = ${lit(atom.word)}`;
}

/**
 * The assessments matching a query, best first.
 *
 * One pass: the clauses' postings are unioned, grouped by assessment, and a
 * group survives only if it was hit by every clause — which is the AND, with
 * the OR falling out for free (alternatives share a clause number). The score
 * is the sum of what each match was worth, and `count(*) OVER ()` carries the
 * total out alongside the page so the count isn't a second query.
 */
export async function searchNarratives(opts: {
  query: string;
  limit?: number;
  offset?: number;
  /** Also match words a letter away from the ones typed. */
  fuzzy?: boolean;
}): Promise<NarrativeSearchResult> {
  const parsed = parseQuery(opts.query);
  const { terms, prefixes } = highlightsOf(parsed);
  const empty: NarrativeSearchResult = {
    hits: [],
    total: 0,
    terms,
    prefixes,
    expanded: [],
    suggestions: [],
    ignored: parsed.ignored,
  };
  if (parsed.required.length === 0) return empty;

  const conn = await getConn();
  const index = narrativeUri("narrative-index.parquet");
  const narratives = narrativeUri("narratives.parquet");
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const [stats, total, avgLength] = await Promise.all([
    statsFor(parsed),
    assessmentCount(),
    ensureLengths(),
    ensureCommonNames(),
  ]);
  const fuzzy = opts.fuzzy === true;

  // What the search silently did, or would have done, to a word — said out
  // loud, because a result the reader can't account for reads as a bug.
  const expanded: WordSwap[] = [];
  const suggestions: WordSwap[] = [];
  for (const word of new Set(terms)) {
    const near = stats.near.get(word) ?? [];
    if (near.length === 0) continue;
    if (fuzzy) {
      expanded.push({ from: word, to: near.map((n) => n.word) });
      continue;
    }
    // Offering a correction for a word that matched nothing is obvious. The
    // case that matters more here is a word that matched almost nothing:
    // "limstone" is a real word in this corpus, because an assessor typed it,
    // and it finds their one assessment while 6,664 others say "limestone".
    // A neighbour that common is a question worth asking.
    const df = stats.df.get(word) ?? 0;
    const better = near.filter((n) => n.df > Math.max(df, 1) * SUGGEST_RATIO || df === 0);
    if (df === 0 || better.length > 0) {
      suggestions.push({ from: word, to: (better.length > 0 ? better : near).map((n) => n.word) });
    }
  }

  const rows: string[] = [];
  parsed.required.forEach((clause, i) => {
    for (const atom of clause.alternatives) {
      rows.push(...atomRows(index, atom, i, stats, total, fuzzy));
    }
  });
  const excludeSql = parsed.excluded
    .map((a) => atomDocs(index, a, stats))
    .join("\n      UNION\n      ");
  // BM25: each match is worth how rare its word is, damped by how often this
  // assessment repeats it and by how long the assessment is. The length join is
  // a LEFT one — an assessment with no indexed words cannot be in the postings
  // at all, but a scoring query is the wrong place to discover that.
  const norm = `(${K1} * (${1 - B} + ${B} * coalesce(l.n_words, ${avgLength.toFixed(1)}) / ${avgLength.toFixed(1)}))`;
  const matched = `
    SELECT m.assessment_id, sum(m.w * (m.tf * ${(K1 + 1).toFixed(1)}) / (m.tf + ${norm})) AS score
    FROM (${rows.join("\n      UNION ALL\n      ")}) m
    LEFT JOIN narrative_lengths l ON l.assessment_id = m.assessment_id
    ${excludeSql ? `WHERE m.assessment_id NOT IN (${excludeSql})` : ""}
    GROUP BY m.assessment_id
    HAVING count(DISTINCT m.c) = ${parsed.required.length}
  `;

  const page = (
    await conn.runAndReadAll(`
      SELECT assessment_id, count(*) OVER () AS total
      FROM (${matched})
      ORDER BY score DESC, assessment_id
      LIMIT ${limit} OFFSET ${offset}
    `)
  ).getRowObjects() as unknown as { assessment_id: bigint; total: bigint }[];

  if (page.length === 0) {
    // No page can mean no matches, or a page past the end — and only the first
    // is worth a count of its own.
    const counted =
      offset === 0
        ? 0
        : Number(
            (
              (await conn.runAndReadAll(`SELECT count(*) AS n FROM (${matched})`)).getRowObjects() as unknown as { n: bigint }[]
            )[0].n
          );
    return { ...empty, total: counted, expanded, suggestions };
  }

  const order = new Map(page.map((r, i) => [Number(r.assessment_id), i]));
  const idList = [...order.keys()].join(",");
  const prose = (
    await conn.runAndReadAll(`
      SELECT n.assessment_id, n.sis_taxon_id, n.scientific_name,
             s.common_name, s.category, s.taxon_group,
             ${NARRATIVE_FIELDS.map((f) => `n.${f}`).join(", ")}
      FROM read_parquet(${lit(narratives)}) n
      LEFT JOIN narrative_species s ON s.assessment_id = n.assessment_id
      WHERE n.assessment_id IN (${idList})
    `)
  ).getRowObjects() as unknown as Record<string, unknown>[];

  const matchers = matchersFor(parsed, fuzzy ? stats : null);
  const hits = prose
    .map((row) => {
      const found = bestMention(row, matchers);
      return {
        assessment_id: Number(row.assessment_id),
        sis_taxon_id: row.sis_taxon_id == null ? null : Number(row.sis_taxon_id),
        scientific_name: String(row.scientific_name ?? ""),
        common_name: row.common_name == null ? null : String(row.common_name),
        category: row.category == null ? null : String(row.category),
        taxon_group: row.taxon_group == null ? null : String(row.taxon_group),
        field: found?.field ?? null,
        snippet: found?.snippet ?? null,
      };
    })
    // The prose came back in file order; the ranking is the point, so put it back.
    .sort((a, b) => (order.get(a.assessment_id) ?? 0) - (order.get(b.assessment_id) ?? 0));

  return {
    hits,
    total: Number(page[0].total),
    terms: fuzzy ? [...new Set([...terms, ...expanded.flatMap((e) => e.to)])] : terms,
    prefixes,
    expanded,
    suggestions,
    ignored: parsed.ignored,
  };
}

/** One assessment's narratives, for a reader who wants the rest of the section. */
export async function getNarrative(assessmentId: number): Promise<{
  assessment_id: number;
  sis_taxon_id: number | null;
  scientific_name: string;
  fields: { field: NarrativeField; text: string }[];
} | null> {
  const conn = await getConn();
  const rows = (
    await conn.runAndReadAll(`
      SELECT assessment_id, sis_taxon_id, scientific_name, ${NARRATIVE_FIELDS.join(", ")}
      FROM read_parquet(${lit(narrativeUri("narratives.parquet"))})
      WHERE assessment_id = ${Math.trunc(assessmentId)}
    `)
  ).getRowObjects() as unknown as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    assessment_id: Number(row.assessment_id),
    sis_taxon_id: row.sis_taxon_id == null ? null : Number(row.sis_taxon_id),
    scientific_name: String(row.scientific_name ?? ""),
    fields: NARRATIVE_FIELDS.map((field) => ({
      field,
      text: row[field] == null ? "" : String(row[field]),
    })).filter((f) => f.text.length > 0),
  };
}

/**
 * How to find, in the prose, what the index matched.
 *
 * One pattern per thing the query asked for, phrases first: the quote a reader
 * wants to see is the one that answers their most specific term.
 */
function matchersFor(parsed: ParsedQuery, stats: WordStats | null): RegExp[] {
  const phrases: RegExp[] = [];
  const words: RegExp[] = [];
  for (const clause of parsed.required) {
    for (const atom of clause.alternatives) {
      if (atom.kind === "phrase") phrases.push(phrasePattern(atom.tokens));
      else if (atom.kind === "prefix") words.push(prefixPattern(atom.word));
      else {
        words.push(wordPattern(atom.word));
        for (const near of stats?.near.get(atom.word) ?? []) words.push(wordPattern(near.word));
      }
    }
  }
  return [...phrases, ...words];
}

/**
 * The field to quote, and the sentence to quote from it.
 *
 * The index says an assessment matches; it does not say which of the nine
 * fields the words landed in. The field that satisfies the most of the query
 * wins — a threats section that says both words beats a range section that
 * happens to hold one.
 */
function bestMention(
  row: Record<string, unknown>,
  matchers: RegExp[]
): { field: NarrativeField; snippet: string } | null {
  let best: { field: NarrativeField; at: number; length: number; hits: number } | null = null;
  for (const field of NARRATIVE_FIELDS) {
    const text = row[field] == null ? "" : String(row[field]);
    if (!text) continue;
    let hits = 0;
    let at = -1;
    let length = 0;
    for (const matcher of matchers) {
      const m = matcher.exec(text);
      if (!m) continue;
      hits += 1;
      // Anchor on the first pattern that matched here — phrases come first, so
      // a phrase wins the quote whenever the field contains one.
      if (at < 0) {
        at = m.index;
        length = m[0].length;
      }
    }
    if (hits > 0 && (best === null || hits > best.hits)) best = { field, at, length, hits };
  }
  if (!best) return null;
  const text = String(row[best.field]);
  const from = Math.max(0, best.at - 90);
  const to = Math.min(text.length, best.at + best.length + 150);
  return {
    field: best.field,
    snippet:
      (from > 0 ? "…" : "") + text.slice(from, to).trim() + (to < text.length ? "…" : ""),
  };
}
