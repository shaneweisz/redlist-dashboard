/**
 * occurrences: one row per usage × georeferenced × date, at whatever precision
 * the records are dated to, with how many GBIF records there are.
 * occurrence_countries: one row per usage × country × georeferenced.
 *
 * Built from: the GBIF snapshot, reduced once per snapshot
 * (inputs/gbif-snapshot.ts); snapshot_usages, to read its keys as the
 * taxonomy's ids (sources/release-map.ts); taxa, to check them.
 *
 * Columns (occurrences):
 *   usage_key    the record's taxonkey, the CoL usage its name matched (a
 *                species, a synonym, a subspecies, a BIN), as a taxa.col_id
 *   year         NULL for an undated record
 *   month        NULL for a record dated only to the year (or undated)
 *   event_date   NULL for a record dated only to the month (or coarser)
 *   georef       has coordinates and none of GBIF's geospatial issues (the
 *                API's hasCoordinate=true&hasGeospatialIssue=false)
 *   n            records
 *
 * Columns (occurrence_countries): usage_key, countrycode, georef, n. A record's
 * country is its countrycode, which GBIF fills from the coordinates or from
 * what the publisher wrote.
 *
 * Decisions:
 *   - Every record type counts (specimens, observations, fossils, literature),
 *     for every kingdom, as on gbif.org; nothing here filters by it.
 *   - One table at the finest date each record has, rather than a yearly table
 *     and a dated one: every count is a sum over it, and a since-assessment
 *     count can start the day after the assessment.
 *
 *   - The snapshot's keys are ids of the XR GBIF indexed when it was made,
 *     often older than the taxonomy's. Read through snapshot_usages, a record
 *     counts where the newer release puts its name; one whose usage has no
 *     counterpart counts for nothing (0.08% of records, COL26.6 XR onto
 *     COL26.10 XR).
 *
 * Checks: every snapshot record is in the table or dropped by the map; at most
 * 0.5% are dropped; at most 0.1% of the rest have keys taxa doesn't hold (a map
 * built from the wrong XR).
 */

import * as path from "path";
import { type DuckDBConnection } from "@duckdb/node-api";
import { output, parquet } from "../paths";
import { lit, openDuckDB } from "../sql";

/**
 * After mapping, the keys must be the taxonomy's ids. The wrong XR leaves ~2% of
 * records on ids taxa doesn't hold; the right one a few hundred of billions (976
 * of 3.9 billion, 2026-11-01).
 */
export const MAX_UNKNOWN_KEY_SHARE = 0.001;
/** Records whose usage the newer release has no counterpart for. */
export const MAX_DROPPED_SHARE = 0.005;

async function assertKeysFitTaxonomy(conn: DuckDBConnection, occurrencesFile: string, taxaFile: string): Promise<void> {
  const [r] = (await conn.runAndReadAll(`
    WITH k AS (SELECT usage_key, sum(n) AS n FROM ${parquet(occurrencesFile)} GROUP BY 1)
    SELECT sum(n) AS total, coalesce(sum(n) FILTER (t.col_id IS NULL), 0) AS unknown
    FROM k LEFT JOIN ${parquet(taxaFile)} t ON t.col_id = k.usage_key`)).getRowObjects();
  const share = Number(r.unknown) / Math.max(1, Number(r.total));
  if (share > MAX_UNKNOWN_KEY_SHARE) {
    throw new Error(`occurrences: ${Number(r.unknown).toLocaleString()} records (${(share * 100).toFixed(2)}%) have keys the taxonomy ` +
      `doesn't hold. The snapshot's usages were mapped from another XR than the one it is keyed by (inputs/snapshot-xr.ts; ` +
      `GBIF_SNAPSHOT_XR names it).`);
  }
}

export async function buildOccurrences(
  inputs: { snapshotCounts: string; sourceRows: number; snapshotUsages: string; taxa: string },
  out: { occurrences: string; occurrenceCountries: string },
): Promise<void> {
  const conn = await openDuckDB();
  const raw = (p: string) => `read_parquet(${lit(path.join(inputs.snapshotCounts, `${p}-*.parquet`))})`;
  // A part's rows with the taxonomy's ids, dropping those the map has nowhere for.
  const parts = (p: string) => `(SELECT r.* EXCLUDE (usage_key), coalesce(m.to_key, r.usage_key) AS usage_key FROM ${raw(p)} r
    LEFT JOIN ${parquet(inputs.snapshotUsages)} m ON m.from_key = r.usage_key WHERE m.from_key IS NULL OR m.to_key IS NOT NULL)`;
  // The cache holds a yearly table of every record and a dated one of those
  // dated at least to the month. Their difference per usage, year and georef is
  // the records dated only to the year (or not at all), which become rows with
  // no month.
  await conn.run(`COPY (
    WITH dated AS (
      SELECT usage_key, year, month, event_date, georef, sum(n)::BIGINT AS n FROM ${parts("dates")} GROUP BY ALL),
    yearly AS (
      SELECT usage_key, year, georef, sum(n)::BIGINT AS n FROM ${parts("counts")} GROUP BY ALL),
    dated_per_year AS (
      SELECT usage_key, year, georef, sum(n)::BIGINT AS n FROM dated GROUP BY ALL)
    SELECT usage_key, year, month, event_date, georef, n FROM dated
    UNION ALL
    SELECT y.usage_key, y.year, NULL::TINYINT, NULL::DATE, y.georef, (y.n - coalesce(d.n, 0))::BIGINT
    FROM yearly y LEFT JOIN dated_per_year d
      ON d.usage_key = y.usage_key AND d.year = y.year AND d.georef = y.georef
    WHERE y.n > coalesce(d.n, 0)
    ORDER BY usage_key, year, month, event_date
  ) TO ${lit(output(out.occurrences))} (FORMAT parquet, COMPRESSION zstd)`);
  await conn.run(`COPY (
    SELECT usage_key, countrycode, georef, sum(n)::BIGINT AS n FROM ${parts("countries")}
    GROUP BY ALL ORDER BY usage_key, countrycode
  ) TO ${lit(output(out.occurrenceCountries))} (FORMAT parquet, COMPRESSION zstd)`);

  // The dated table can't hold more of a year's records than the yearly one,
  // and nothing can hold more than the snapshot.
  const [s] = (await conn.runAndReadAll(`
    SELECT (SELECT sum(n) FROM ${raw("counts")}) AS snapshot,
           (SELECT sum(n) FROM ${parts("counts")}) AS yearly,
           (SELECT sum(n) FROM ${parquet(out.occurrences)}) AS total,
           (SELECT count(*) FROM ${parquet(out.occurrences)}) AS rows`)).getRowObjects();
  if (Number(s.total) !== Number(s.yearly)) {
    throw new Error(`occurrences: ${s.total} records in the table but ${s.yearly} in the snapshot's yearly counts`);
  }
  const dropped = Number(s.snapshot) - Number(s.yearly);
  if (dropped > MAX_DROPPED_SHARE * Number(s.snapshot)) {
    throw new Error(`occurrences: ${dropped.toLocaleString()} records (${(100 * dropped / Number(s.snapshot)).toFixed(2)}%) are on usages ` +
      `the taxonomy's XR has no counterpart for (snapshot_usages)`);
  }
  if (dropped > 0) console.log(`   ${dropped.toLocaleString()} records on snapshot usages the taxonomy's XR has no counterpart for`);
  if (Number(s.total) > inputs.sourceRows) throw new Error(`occurrences: ${s.total} records from a ${inputs.sourceRows}-record snapshot`);
  await assertKeysFitTaxonomy(conn, out.occurrences, inputs.taxa);
  console.log(`   ${Number(s.rows).toLocaleString()} rows covering ${Number(s.total).toLocaleString()} of ` +
    `${inputs.sourceRows.toLocaleString()} records`);
}
