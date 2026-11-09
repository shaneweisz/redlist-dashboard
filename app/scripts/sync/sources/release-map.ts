/**
 * Mapping one CoL XR's usage ids onto another's.
 *
 * snapshot_usages: the snapshot's usages (its keys are ids of the XR GBIF
 * indexed when it was made) onto the taxonomy's, CoL's newest. Occurrences are
 * read through it, so every count follows the newest taxonomy.
 * live_usages: the taxonomy's usages onto the XR GBIF's live index runs, for the
 * app's live GBIF queries (link/live-keys.ts).
 * snapshot_notes: the taxonomy's species the snapshot's XR has no name for, so
 * GBIF filed their records elsewhere until it re-indexes.
 *
 * All three are empty when the two XRs are the same, as they are whenever GBIF
 * has re-indexed against CoL's newest release.
 *
 * Built from: two taxa tables (sources/taxa.ts), one per XR.
 *
 * Columns (snapshot_usages, live_usages): only usages whose id changes
 *   from_key   the usage in the XR mapped from (the snapshot's; the taxonomy's
 *              for live_usages)
 *   to_key     the usage in the XR mapped onto; NULL when it has none (a
 *              snapshot record on it counts for nothing)
 *   how        'name' | 'name only' | 'species' (below)
 *
 * Columns (snapshot_notes):
 *   col_id     a species in the taxonomy
 *   note       'new': no usage in the snapshot's XR maps onto any of its names,
 *              so records carrying them were matched to something else
 *
 * Decisions:
 *   - A usage keeps its id when the newer XR has that id with the same name and
 *     rank; else it is the usage with the same name, rank and authorship; else
 *     the usages with the same name and rank, if all lead to one species
 *     ('name only': a duplicate an XR source added and the next release
 *     dropped, Anas americana "Gmelin, 1789" beside "J. F. Gmelin, 1789"). That
 *     is how GBIF's re-index treats the records: by the name they carry.
 *   - Failing those, its species' usage ('species'), so a renamed
 *     infraspecific's records stay with their species. Else nothing: 0.08% of
 *     records, COL26.6 XR onto COL26.10 XR, mostly genera and bacteria.
 *   - Lumps, renames and splits need no note. Each record sits on the usage
 *     its own name matched, and that usage follows its name into the newer
 *     release, as GBIF's re-index will file it: when COL26.10 raises Corvus
 *     corone cornix to Corvus cornix, the 1.38M records filed under the
 *     subspecies go to C. cornix, and those filed as Corvus corone stay.
 *   - A species new since the snapshot's XR does: records carrying its name
 *     were matched to something else (Agrotis sabine's to A. sabura) and move
 *     only when GBIF re-indexes. 40 assessed species, COL26.6 XR onto COL26.10 XR.
 */
import { type DuckDBConnection } from "@duckdb/node-api";
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

/** A taxa table, keyed for matching across releases. Authorship is '' rather than NULL so it joins by hash. */
const usages = (file: string) =>
  `SELECT col_id, scientific_name AS nm, rank, coalesce(authorship, '') AS au, species_id FROM ${parquet(file)}`;

async function mapUsages(conn: DuckDBConnection, from: string, to: string): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE f AS ${usages(from)}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE t AS ${usages(to)}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE direct AS
    WITH same AS (SELECT f.col_id, f.col_id AS to_key, 'id' AS how FROM f JOIN t USING (col_id) WHERE f.nm = t.nm AND f.rank = t.rank),
    by_name AS (
      SELECT f.col_id, any_value(t.col_id) AS to_key, 'name' AS how
      FROM (SELECT * FROM f ANTI JOIN same USING (col_id)) f JOIN t ON t.nm = f.nm AND t.rank = f.rank AND t.au = f.au
      GROUP BY 1 HAVING count(*) = 1),
    by_name_only AS (
      SELECT f.col_id, min(t.col_id) AS to_key, 'name only' AS how
      FROM (SELECT * FROM f ANTI JOIN same USING (col_id) ANTI JOIN by_name USING (col_id)) f
      JOIN t ON t.nm = f.nm AND t.rank = f.rank
      GROUP BY 1 HAVING count(DISTINCT coalesce(t.species_id, t.col_id)) = 1)
    SELECT * FROM same UNION ALL SELECT * FROM by_name UNION ALL SELECT * FROM by_name_only`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE mapped AS
    SELECT f.col_id AS from_key, coalesce(d.to_key, s.to_key) AS to_key,
           CASE WHEN d.how IS NOT NULL THEN d.how WHEN s.to_key IS NOT NULL THEN 'species' END AS how
    FROM f LEFT JOIN direct d ON d.col_id = f.col_id LEFT JOIN direct s ON s.col_id = f.species_id`);
}

const EMPTY_MAP = `SELECT NULL::VARCHAR AS from_key, NULL::VARCHAR AS to_key, NULL::VARCHAR AS how WHERE false`;
const EMPTY_NOTES = `SELECT NULL::VARCHAR AS col_id, NULL::VARCHAR AS note WHERE false`;

async function writeMap(conn: DuckDBConnection, mapped: boolean, out: string): Promise<number> {
  const sql = mapped ? `SELECT from_key, to_key, how FROM mapped WHERE how IS DISTINCT FROM 'id'` : EMPTY_MAP;
  await conn.run(`COPY (${sql} ORDER BY from_key) TO ${lit(output(out))} (FORMAT parquet, COMPRESSION zstd)`);
  const [r] = (await conn.runAndReadAll(`SELECT count(*)::INTEGER AS n FROM ${parquet(out)}`)).getRowObjects();
  return Number(r.n);
}

/** Map `from`'s usages onto `to`'s (live_usages). Null (the same XR) writes an empty map. */
export async function buildReleaseMap(inputs: { from: string; to: string } | null, out: string): Promise<number> {
  const conn = await openDuckDB();
  if (inputs) await mapUsages(conn, inputs.from, inputs.to);
  return writeMap(conn, Boolean(inputs), out);
}

/**
 * snapshot_usages and snapshot_notes: the snapshot's XR onto the taxonomy's,
 * and the species it has no name for. Null (the same XR) writes both empty.
 */
export async function buildSnapshotMap(
  inputs: { snapshotTaxa: string; taxa: string } | null,
  out: { usages: string; notes: string },
): Promise<{ changed: number; unmapped: number; new: number }> {
  const conn = await openDuckDB();
  if (inputs) await mapUsages(conn, inputs.snapshotTaxa, inputs.taxa);
  const changed = await writeMap(conn, Boolean(inputs), out.usages);
  // A species of the taxonomy's that no snapshot usage maps onto, by any route.
  const sql = !inputs ? EMPTY_NOTES : `
    WITH reached AS (
      SELECT DISTINCT t.species_id AS col_id FROM mapped m JOIN t ON t.col_id = m.to_key WHERE t.species_id IS NOT NULL)
    SELECT col_id, 'new' AS note FROM ${parquet(inputs.taxa)}
    WHERE rank = 'species' AND status IN ('accepted', 'provisionally accepted') AND species_id = col_id
      AND col_id NOT IN (SELECT col_id FROM reached)`;
  await conn.run(`COPY (${sql} ORDER BY col_id) TO ${lit(output(out.notes))} (FORMAT parquet, COMPRESSION zstd)`);
  const [r] = (await conn.runAndReadAll(`SELECT count(*)::INTEGER AS new FROM ${parquet(out.notes)}`)).getRowObjects();
  const [u] = (await conn.runAndReadAll(`SELECT count(*) FILTER (to_key IS NULL)::INTEGER AS n FROM ${parquet(out.usages)}`)).getRowObjects();
  return { changed, unmapped: Number(u.n), new: Number(r.new) };
}
