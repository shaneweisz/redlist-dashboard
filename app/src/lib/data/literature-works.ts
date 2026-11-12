/**
 * The OpenAlex works behind a species' literature count (the sync's
 * paper_works, lists/literature-works.parquet), newest first.
 */
import { getConn, parquetUri } from "./species-duckdb";

export interface LiteratureWorksQuery {
  /** The assessed species, or else the unassessed CoL species. */
  sisTaxonId?: number;
  colId?: string;
  /** The day after the assessment (YYYY-MM-DD): only the works counted as New. */
  since?: string;
  limit: number;
}

/**
 * Up to `limit` work numbers (W123 → 123), newest first, and how many there are
 * in all. "Since" is decided as the count decides it: by date where a work has
 * one, else by year (a work dated only to the assessment's year isn't new).
 */
export async function getLiteratureWorks(q: LiteratureWorksQuery): Promise<{ works: bigint[]; total: number }> {
  const conn = await getConn();
  const where = [q.sisTaxonId != null ? "sis_taxon_id = $sis" : "col_id = $col"];
  const params: Record<string, string | number> = q.sisTaxonId != null ? { sis: q.sisTaxonId } : { col: q.colId! };
  if (q.since) {
    where.push(`CASE WHEN publication_date IS NOT NULL
                  THEN publication_date >= CAST($since AS DATE) AND publication_date <= current_date
                  ELSE publication_year > year(CAST($since AS DATE) - INTERVAL 1 DAY) AND publication_year <= year(current_date) END`);
    params.since = q.since;
  }
  const rows = (await conn.runAndReadAll(`
    SELECT work, publication_date, publication_year, count(*) OVER () AS total
    FROM (SELECT DISTINCT work, publication_date, publication_year FROM '${parquetUri("literature-works.parquet")}' WHERE ${where.join(" AND ")})
    ORDER BY publication_date DESC NULLS LAST, publication_year DESC, work DESC
    LIMIT ${Math.max(1, Math.floor(q.limit))}`, params)).getRowObjects();
  return { works: rows.map((r) => BigInt(r.work as bigint)), total: Number(rows[0]?.total ?? 0) };
}
