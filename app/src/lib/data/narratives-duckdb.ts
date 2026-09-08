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
 *    the word, so looking one up touches a few hundred kilobytes of a 70 MB
 *    file rather than all of it.
 *  - `narratives.parquet`, sorted by assessment_id in small row groups, is what
 *    a *result* reads — only for the assessments already matched, and only for
 *    the page being shown.
 *
 * Scanning the prose itself would be simpler, and is ~470 MB of text per query
 * over httpfs. The index is what makes this a search box rather than a job.
 */
import * as fs from "fs";
import * as path from "path";
import { getConn, parquetUri } from "./species-duckdb";
import { NARRATIVE_FIELDS, type NarrativeField } from "@/lib/redlist/narrative-fields";
import { queryTerms } from "@/lib/redlist/narrative-terms";

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
 * Local when the file is there, R2 otherwise — a narrower rule than
 * `parquetUri`, which decides for the whole sync by whether `assessed.parquet`
 * is on disk. These two are built on their own (`scripts/build-narratives.ts`,
 * against a local Postgres restore) long before a full sync is fetched, and a
 * developer with them in `data/` means to search them.
 */
function narrativeUri(name: string): string {
  const local = path.join(process.cwd(), "data", name);
  return fs.existsSync(local) ? local : parquetUri(name);
}

/** A string, safe to drop into SQL. */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The assessments whose narratives contain every one of these words.
 *
 * An AND across terms, as an INTERSECT of postings lists: each side prunes to
 * its own row groups, and DuckDB never reads a word it wasn't asked about. The
 * words need not be adjacent — a phrase search would need positions in the
 * index, which is a bigger index and a later question; `phrase` below filters
 * the page that comes back instead.
 */
export async function searchNarratives(opts: {
  query: string;
  limit?: number;
  offset?: number;
  /** Require the words adjacent, as typed. Filters the matched page only. */
  phrase?: boolean;
}): Promise<NarrativeSearchResult> {
  const terms = queryTerms(opts.query);
  if (terms.length === 0) return { hits: [], total: 0, terms };

  const conn = await getConn();
  const index = narrativeUri("narrative-index.parquet");
  const narratives = narrativeUri("narratives.parquet");
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);

  const postings = (term: string) =>
    `SELECT assessment_id FROM read_parquet(${lit(index)}) WHERE term = ${lit(term)}`;
  const matched = terms.map(postings).join("\n      INTERSECT\n      ");

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
    `)
  ).getRowObjects() as unknown as Record<string, unknown>[];

  const hits = rows.map((row) => {
    const found = firstMention(row, terms, opts.phrase ? opts.query : null);
    return {
      assessment_id: Number(row.assessment_id),
      sis_taxon_id: row.sis_taxon_id == null ? null : Number(row.sis_taxon_id),
      scientific_name: String(row.scientific_name ?? ""),
      field: found?.field ?? null,
      snippet: found?.snippet ?? null,
    };
  });

  const shown = opts.phrase ? hits.filter((h) => h.snippet != null) : hits;
  return { hits: shown, total: Number(total), terms };
}

/**
 * Where to show the reader the match.
 *
 * The index says an assessment mentions the word; it doesn't say where, because
 * storing that is a bigger index. So the field and the words around the mention
 * are found here, in the page's own text — twenty rows of prose, once the
 * search has already narrowed to them.
 */
function firstMention(
  row: Record<string, unknown>,
  terms: string[],
  phrase: string | null
): { field: NarrativeField; snippet: string } | null {
  const needle = phrase ? phrase.trim().toLowerCase() : null;
  for (const field of NARRATIVE_FIELDS) {
    const text = row[field] == null ? "" : String(row[field]);
    if (!text) continue;
    const hay = text.toLowerCase();
    const at = needle ? hay.indexOf(needle) : firstTermIndex(hay, terms);
    if (at < 0) continue;
    const from = Math.max(0, at - 90);
    const to = Math.min(text.length, at + (needle ? needle.length : 0) + 150);
    const snippet =
      (from > 0 ? "…" : "") + text.slice(from, to).trim() + (to < text.length ? "…" : "");
    return { field, snippet };
  }
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
