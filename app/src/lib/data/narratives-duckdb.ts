/**
 * Searching what assessors wrote.
 *
 * The second half of issue #474: find the assessments that mention a phrase —
 * a habitat type, a threat nobody has a code for, a place — and show where in
 * the text they mention it.
 *
 * Two parquets, built by `scripts/build-narratives.ts`:
 *
 *  - `narrative-index.parquet`, sorted by term, is what a search reads. Sorted,
 *    parquet's row-group statistics prune every group whose term range excludes
 *    the word, so looking one up touches a few hundred kilobytes of a 144 MB
 *    file rather than all of it. Each posting carries every position that word
 *    appears at, in its own column — the phrase search is a list intersection
 *    over those, and an all-the-words search never reads the column at all.
 *  - `narratives.parquet`, sorted by assessment_id in small row groups, is what
 *    a *result* reads — only for the assessments already matched, and only for
 *    the page being shown.
 *
 * Scanning the prose itself would be simpler, and is ~470 MB of text per query
 * over httpfs. The index is what makes this a search box rather than a job.
 *
 * Neither file belongs to a sync — they are published per Red List release,
 * see narrative-release.ts.
 */
import * as fs from "fs";
import * as path from "path";
import { getConn } from "./species-duckdb";
import { NARRATIVE_FIELDS, type NarrativeField } from "@/lib/redlist/narrative-fields";
import { narrativeKey } from "@/lib/redlist/narrative-release";
import { phrasePattern, queryTerms, queryTokens, type Token } from "@/lib/redlist/narrative-terms";

export interface NarrativeHit {
  assessment_id: number;
  sis_taxon_id: number | null;
  scientific_name: string;
  /** The field the phrase was found in, and the words around it. */
  field: NarrativeField | null;
  snippet: string | null;
}

export interface NarrativeSearchResult {
  hits: NarrativeHit[];
  /** How many assessments matched, before the page was taken off the front. */
  total: number;
  /** The words actually looked up, after stop words and punctuation. */
  terms: string[];
}

/**
 * Where to read a narrative parquet from.
 *
 * Local when the file is there, R2 otherwise — and the R2 half is deliberately
 * NOT `parquetUri`. That resolves to the current sync's prefix, and these two
 * files are not sync data: they are written once per Red List release to
 * `narratives/<release>/` (see narrative-release.ts) and left there. Pointing
 * them at the sync is what produced a 404 on every preview deployment, since
 * no sync has ever contained them.
 *
 * The local check is its own rule too, not `USE_R2`: the parquets are built
 * on their own (`scripts/build-narratives.ts`, against a restored release
 * database) long before a full sync is fetched, and a developer with them in
 * `data/` means to search them.
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

/**
 * The postings for one word: which assessments hold it, and where.
 *
 * `anchors` shifts every position back by where the word sits in the query, so
 * that two words of a phrase agree on a number exactly when they are the right
 * distance apart in the text. "mining" at 40 and "caves" at 42, asked for as
 * "mining in caves", both anchor to 40.
 */
function postings(index: string, term: string, offset: number): string {
  const shift = offset === 0 ? "positions" : `list_transform(positions, p -> p - ${offset})`;
  return `SELECT assessment_id, ${shift} AS anchors FROM read_parquet(${lit(index)}) WHERE term = ${lit(term)}`;
}

/**
 * The assessments whose narratives hold every one of these words, anywhere.
 *
 * An AND across terms, as an INTERSECT of postings lists: each side prunes to
 * its own row groups, and DuckDB never reads a word it wasn't asked about.
 * `positions` is never named here, so the columnar read never fetches it.
 */
function anyOrderSql(index: string, terms: string[]): string {
  const one = (term: string) =>
    `SELECT assessment_id FROM read_parquet(${lit(index)}) WHERE term = ${lit(term)}`;
  return terms.map(one).join("\n      INTERSECT\n      ");
}

/**
 * The assessments whose narratives hold these words together, as typed.
 *
 * A true phrase match, not a filter over a page of results: the index stores
 * every position of every word, so "are these words adjacent" is a question
 * about two sorted integer lists, and DuckDB answers it inside the join. That
 * makes the count exact and the paging honest — the earlier version could only
 * narrow the twenty rows it had already fetched, so it reported 553 above a
 * list of one.
 */
function phraseSql(index: string, tokens: Token[]): string {
  const parts = tokens.map((t, i) => `(${postings(index, t.word, t.pos)}) t${i}`);
  const joins = parts
    .slice(1)
    .map((part, i) => `JOIN ${part} ON t${i + 1}.assessment_id = t0.assessment_id`)
    .join("\n      ");
  if (tokens.length === 1) return `SELECT assessment_id FROM ${parts[0]}`;
  // Folded rather than pairwise: every word has to share one anchor, not just
  // agree with its neighbour. "cave roost cave" is three words in a row.
  let shared = "t0.anchors";
  for (let i = 1; i < tokens.length; i++) shared = `list_intersect(${shared}, t${i}.anchors)`;
  return `SELECT t0.assessment_id FROM ${parts[0]}\n      ${joins}\n      WHERE len(${shared}) > 0`;
}

/**
 * The assessments matching a query, and where each one says it.
 *
 * `phrase` asks for the words together in that order; without it, every word
 * has to appear somewhere in the assessment, in any order.
 */
export async function searchNarratives(opts: {
  query: string;
  limit?: number;
  offset?: number;
  /** Require the words together, as typed. */
  phrase?: boolean;
}): Promise<NarrativeSearchResult> {
  const tokens = queryTokens(opts.query);
  const terms = queryTerms(opts.query);
  if (tokens.length === 0) return { hits: [], total: 0, terms };

  const conn = await getConn();
  const index = narrativeUri("narrative-index.parquet");
  const narratives = narrativeUri("narratives.parquet");
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const matched = opts.phrase ? phraseSql(index, tokens) : anyOrderSql(index, terms);

  const [{ total }] = (
    await conn.runAndReadAll(`SELECT count(*) AS total FROM (${matched})`)
  ).getRowObjects() as unknown as { total: bigint }[];

  // The page's ids first, then one read of the prose for those ids alone. The
  // narratives are sorted by assessment_id, so a page of them touches a handful
  // of small row groups instead of the file.
  const ids = (
    await conn.runAndReadAll(
      `SELECT assessment_id FROM (${matched}) ORDER BY assessment_id LIMIT ${limit} OFFSET ${offset}`
    )
  ).getRowObjects() as unknown as { assessment_id: bigint }[];
  if (ids.length === 0) return { hits: [], total: Number(total), terms };

  const idList = ids.map((r) => Number(r.assessment_id)).join(",");
  const rows = (
    await conn.runAndReadAll(`
      SELECT assessment_id, sis_taxon_id, scientific_name,
             ${NARRATIVE_FIELDS.join(", ")}
      FROM read_parquet(${lit(narratives)})
      WHERE assessment_id IN (${idList})
      ORDER BY assessment_id
    `)
  ).getRowObjects() as unknown as Record<string, unknown>[];

  const pattern = opts.phrase ? phrasePattern(tokens) : null;
  const hits = rows.map((row) => {
    const found = firstMention(row, terms, pattern);
    return {
      assessment_id: Number(row.assessment_id),
      sis_taxon_id: row.sis_taxon_id == null ? null : Number(row.sis_taxon_id),
      scientific_name: String(row.scientific_name ?? ""),
      field: found?.field ?? null,
      snippet: found?.snippet ?? null,
    };
  });

  return { hits, total: Number(total), terms };
}

/**
 * Where to show the reader the match.
 *
 * The index knows which assessment mentions the words and at which word of it;
 * it does not know which of the nine fields that word landed in, or what the
 * sentence around it says. Both are found here, in the page's own text —
 * twenty rows of prose, once the search has already narrowed to them.
 */
function firstMention(
  row: Record<string, unknown>,
  terms: string[],
  phrase: RegExp | null
): { field: NarrativeField; snippet: string } | null {
  for (const field of NARRATIVE_FIELDS) {
    const text = row[field] == null ? "" : String(row[field]);
    if (!text) continue;
    const match = phrase ? phrase.exec(text) : null;
    // Falls back to the first word rather than showing nothing: the index has
    // already said this assessment matches, and a hit with an approximate
    // quote is better than a row with no quote at all.
    const at = phrase ? (match ? match.index : -1) : firstTermIndex(text.toLowerCase(), terms);
    if (at < 0) continue;
    const from = Math.max(0, at - 90);
    const to = Math.min(text.length, at + (match ? match[0].length : 0) + 150);
    const snippet =
      (from > 0 ? "…" : "") + text.slice(from, to).trim() + (to < text.length ? "…" : "");
    return { field, snippet };
  }
  if (phrase) return firstMention(row, terms, null);
  return null;
}

/** The earliest place any of the words appears, as a whole word. */
function firstTermIndex(hay: string, terms: string[]): number {
  let best = -1;
  for (const term of terms) {
    const at = hay.search(new RegExp(`(^|[^a-z0-9-])${escapeRegExp(term)}([^a-z0-9-]|$)`));
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
