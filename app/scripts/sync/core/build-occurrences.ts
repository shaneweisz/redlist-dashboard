/**
 * build-occurrences: GBIF record counts from the monthly snapshot, aggregated
 * per usage.
 *
 * GBIF publishes every occurrence record it holds as parquet once a month
 * (https://registry.opendata.aws/gbif/), keyed since October 2026 by the same
 * Catalogue of Life ids as taxa.parquet. A local mirror of it (pulled with
 * `aws s3 sync s3://gbif-open-data-eu-central-1/occurrence/<date>/
 * ~/Data/gbif/<date>/ --no-sign-request`) is read once, and every count the
 * dashboard shows comes from three small tables:
 *
 *   occurrence_counts     usage_key × year × georef × basis → n
 *   occurrence_dates      usage_key × year × month × event_date × georef × basis → n
 *   occurrence_countries  usage_key × countrycode × georef × basis → n
 *
 * occurrence_dates holds the records dated at least to the month (event_date
 * is NULL for those dated only to the month), so a since-assessment count can
 * start the day after the assessment rather than the year after it. Within the
 * assessment's own year a record dated to a later month counts, and one dated
 * only to the assessment's month, or only to its year, can't be placed and is
 * left out.
 *
 * usage_key is the record's taxonkey, the usage its name matched (a species,
 * a synonym, a subspecies). Which species a usage counts towards is
 * taxa.species_id, so totals, synonyms, subspecies, lumped species and
 * since-assessment counts are all one rule over these tables (counts.ts).
 *
 * georef is the API's hasCoordinate=true&hasGeospatialIssue=false; the rest
 * of a usage's records have no coordinates or a geospatial issue, and count
 * only towards its all-records numbers. The
 * snapshot has no hasGeospatialIssue column, so it is recomputed from the
 * issue list with GBIF's own set (GBIF_GEOSPATIAL_ISSUES).
 *
 * A snapshot is only exact if it is complete. From 2025-07 to 2026-10 every
 * mirror was missing one file in twenty (gbif/occurrence#609), so before
 * anything is read the file numbering must have no gaps and the files' footer
 * row counts must sum to the totalRecords of the download the snapshot was
 * made from.
 *
 * The aggregation runs in batches written to
 * ~/.cache/redlist-dashboard/occurrences/<date>/, so an interrupted run
 * resumes.
 *
 * Environment:
 *   GBIF_SNAPSHOT_ROOT  where mirrors live; default ~/Data/gbif
 *   GBIF_SNAPSHOT       pin a date (e.g. 2026-11-01); default the newest mirror
 *
 * Usage:  npx tsx scripts/sync/core/build-occurrences.ts [--out DIR]
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles } from "../../lib/utils";
import { gbifJson } from "../../../src/lib/gbif-fetch";
import { GBIF_GEOSPATIAL_ISSUES } from "../../../src/lib/gbif";
import { CACHE_ROOT, CORE_DIR, DUCKDB_TMP } from "../paths";

const SNAPSHOT_ROOT = process.env.GBIF_SNAPSHOT_ROOT ?? path.join(os.homedir(), "Data", "gbif");
/** The earliest snapshot keyed by Catalogue of Life rather than GBIF's old Backbone. */
const FIRST_COL_SNAPSHOT = "2026-10-01";
const FILES_PER_BATCH = 400;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface Snapshot {
  date: string;
  dir: string;
  citation: string;
  files: string[];
}

/** The newest mirrored snapshot (or GBIF_SNAPSHOT), with its part files. */
export function resolveSnapshot(root = SNAPSHOT_ROOT): Snapshot {
  const pinned = process.env.GBIF_SNAPSHOT;
  const dates = pinned ? [pinned] : fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const date of dates) {
    const dir = path.join(root, date);
    const citation = path.join(dir, "citation.txt");
    if (!fs.existsSync(citation)) continue;
    if (date < FIRST_COL_SNAPSHOT) {
      throw new Error(`build-occurrences: ${date} predates GBIF's move to Catalogue of Life ids (${FIRST_COL_SNAPSHOT}).`);
    }
    const partsDir = path.join(dir, "occurrence.parquet");
    const files = fs.readdirSync(partsDir).filter((f) => /^\d+$/.test(f)).sort().map((f) => path.join(partsDir, f));
    return { date, dir, citation: fs.readFileSync(citation, "utf-8").trim(), files };
  }
  throw new Error(`build-occurrences: no mirrored snapshot with a citation.txt under ${root}`);
}

/** File numbers missing from a snapshot (GBIF numbers them 000001, 000002, …). */
export function missingFileNumbers(files: string[]): number[] {
  const nums = new Set(files.map((f) => Number(path.basename(f))));
  if (nums.size === 0) return [];
  const sorted = [...nums].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let n = sorted[0]; n <= sorted[sorted.length - 1]; n++) if (!nums.has(n)) missing.push(n);
  return missing;
}

async function downloadTotalRecords(citation: string): Promise<number> {
  const doi = citation.match(/10\.15468\/dl\.\w+/)?.[0];
  if (!doi) throw new Error(`build-occurrences: no download DOI in citation.txt: ${citation}`);
  const d = (await gbifJson(`https://api.gbif.org/v1/occurrence/download/${doi}`)) as { totalRecords?: number };
  if (typeof d.totalRecords !== "number") throw new Error(`build-occurrences: download ${doi} reports no totalRecords`);
  return d.totalRecords;
}

/** Refuse a snapshot that doesn't hold every record of its download. Returns the row total. */
export async function assertComplete(conn: DuckDBConnection, snap: Snapshot): Promise<number> {
  const missing = missingFileNumbers(snap.files);
  if (missing.length > 0) {
    throw new Error(`build-occurrences: ${snap.date} is missing ${missing.length} files ` +
      `(${missing.slice(0, 5).map((n) => String(n).padStart(6, "0")).join(", ")}…). Re-sync the mirror or pin GBIF_SNAPSHOT.`);
  }
  const expected = await downloadTotalRecords(snap.citation);
  const [r] = (await conn.runAndReadAll(
    `SELECT sum(num_rows) AS n FROM parquet_file_metadata([${snap.files.map(lit).join(", ")}])`)).getRowObjects();
  const actual = Number(r.n);
  if (actual !== expected) {
    throw new Error(`build-occurrences: ${snap.date} holds ${actual.toLocaleString()} records but its download ` +
      `holds ${expected.toLocaleString()} (${(100 * (1 - actual / expected)).toFixed(2)}% missing).`);
  }
  return actual;
}

/** What the cached aggregate holds; a change here rebuilds it rather than reusing it. */
const GRAIN = "year+month+day";

const GEOREF = `decimallatitude IS NOT NULL AND decimallongitude IS NOT NULL
  AND NOT list_has_any(coalesce(issue, []), [${[...GBIF_GEOSPATIAL_ISSUES].map(lit).join(", ")}])`;

async function aggregate(conn: DuckDBConnection, snap: Snapshot, workDir: string): Promise<void> {
  const parts = path.join(workDir, "parts");
  fs.mkdirSync(parts, { recursive: true });
  const batches: string[][] = [];
  for (let i = 0; i < snap.files.length; i += FILES_PER_BATCH) batches.push(snap.files.slice(i, i + FILES_PER_BATCH));
  const start = Date.now();
  for (let b = 0; b < batches.length; b++) {
    const tag = String(b).padStart(4, "0");
    const done = path.join(parts, `${tag}.done`);
    if (fs.existsSync(done)) continue;
    await conn.run(`CREATE OR REPLACE TEMP TABLE batch AS
      SELECT taxonkey AS usage_key, CAST(year AS SMALLINT) AS year, basisofrecord AS basis,
             ${GEOREF} AS georef, countrycode, CAST(month AS TINYINT) AS month,
             -- try_cast: a malformed date (31 February) is undated, not an error
             CASE WHEN day IS NOT NULL AND month IS NOT NULL AND year IS NOT NULL
                  THEN TRY_CAST(printf('%04d-%02d-%02d', year, month, day) AS DATE) END AS event_date
      FROM read_parquet([${batches[b].map(lit).join(", ")}])
      WHERE taxonkey IS NOT NULL`);
    await conn.run(`COPY (SELECT usage_key, year, georef, basis, count(*) AS n FROM batch GROUP BY ALL)
      TO ${lit(path.join(parts, `counts-${tag}.parquet`))} (FORMAT parquet)`);
    await conn.run(`COPY (SELECT usage_key, year, month, event_date, georef, basis, count(*) AS n FROM batch
      WHERE year IS NOT NULL AND month BETWEEN 1 AND 12 GROUP BY ALL)
      TO ${lit(path.join(parts, `dates-${tag}.parquet`))} (FORMAT parquet)`);
    await conn.run(`COPY (SELECT usage_key, countrycode, georef, basis, count(*) AS n FROM batch WHERE countrycode IS NOT NULL GROUP BY ALL)
      TO ${lit(path.join(parts, `countries-${tag}.parquet`))} (FORMAT parquet)`);
    fs.writeFileSync(done, "");
    const mins = (Date.now() - start) / 60000;
    console.log(`  batch ${b + 1}/${batches.length} (${mins.toFixed(1)} min)`);
  }
  await conn.run(`DROP TABLE IF EXISTS batch`);
}

/**
 * The snapshot's keys must be the taxonomy's ids. A snapshot is keyed by the
 * XR GBIF indexed when it was made, but build-taxa takes the XR GBIF indexes
 * now: run between GBIF moving to a new XR and the next snapshot (COL26.10 XR
 * went live after the 1 November 2026 snapshot), the two disagree on ~2% of
 * ids and their records silently count for nothing. A matching pair leaves a
 * few hundred records out of billions (976 of 3.9 billion, 2026-11-01).
 */
export const MAX_UNKNOWN_KEY_SHARE = 0.001;

async function assertKeysFitTaxonomy(conn: DuckDBConnection, coreDir: string): Promise<void> {
  const taxa = path.join(coreDir, "taxa.parquet");
  if (!fs.existsSync(taxa)) return;
  const [r] = (await conn.runAndReadAll(`
    WITH k AS (SELECT usage_key, sum(n) AS n FROM read_parquet(${lit(path.join(coreDir, "occurrence_counts.parquet"))}) GROUP BY 1)
    SELECT sum(n) AS total, coalesce(sum(n) FILTER (t.col_id IS NULL), 0) AS unknown
    FROM k LEFT JOIN read_parquet(${lit(taxa)}) t ON t.col_id = k.usage_key`)).getRowObjects();
  const share = Number(r.unknown) / Math.max(1, Number(r.total));
  if (share > MAX_UNKNOWN_KEY_SHARE) {
    throw new Error(`build-occurrences: ${Number(r.unknown).toLocaleString()} records (${(share * 100).toFixed(2)}%) have keys the taxonomy ` +
      `doesn't hold. The snapshot was indexed against another XR than taxa.parquet; set COL_XR_DATASET to the XR GBIF used ` +
      `when the snapshot was made, or wait for the next snapshot.`);
  }
}

/** What sync.json records about the snapshot. */
export interface OccurrenceSource {
  snapshot: string;
  citation: string;
  sourceRows: number;
}

export async function buildOccurrences(conn: DuckDBConnection, snap: Snapshot, coreDir: string): Promise<OccurrenceSource> {
  const workDir = path.join(CACHE_ROOT, "occurrences", snap.date);
  const marker = path.join(workDir, "complete.json");
  let sourceRows: number;
  // The aggregate bakes in which issues count as geospatial (GBIF changes its
  // own set) and what it is grouped by, so a change to either has to rebuild it
  // rather than reuse it.
  const done = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf-8")) : null;
  if (done && done.georef === GEOREF && done.grain === GRAIN) {
    sourceRows = done.sourceRows;
  } else {
    fs.rmSync(path.join(workDir, "parts"), { recursive: true, force: true });
    sourceRows = await assertComplete(conn, snap);
    await aggregate(conn, snap, workDir);
    fs.writeFileSync(marker, JSON.stringify({ date: snap.date, citation: snap.citation, files: snap.files.length, sourceRows, georef: GEOREF, grain: GRAIN }, null, 2) + "\n");
  }

  fs.mkdirSync(coreDir, { recursive: true });
  const parts = (p: string) => lit(path.join(workDir, "parts", `${p}-*.parquet`));
  await conn.run(`COPY (SELECT usage_key, year, georef, basis, sum(n)::BIGINT AS n FROM read_parquet(${parts("counts")}) GROUP BY ALL ORDER BY usage_key, year)
    TO ${lit(path.join(coreDir, "occurrence_counts.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);
  await conn.run(`COPY (SELECT usage_key, year, month, event_date, georef, basis, sum(n)::BIGINT AS n FROM read_parquet(${parts("dates")})
    GROUP BY ALL ORDER BY usage_key, year, month, event_date)
    TO ${lit(path.join(coreDir, "occurrence_dates.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);
  await conn.run(`COPY (SELECT usage_key, countrycode, georef, basis, sum(n)::BIGINT AS n FROM read_parquet(${parts("countries")}) GROUP BY ALL ORDER BY usage_key, countrycode)
    TO ${lit(path.join(coreDir, "occurrence_countries.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);

  // Every record with a usage is in the aggregate, so its total can't fall short of the source.
  const [s] = (await conn.runAndReadAll(`SELECT sum(n) AS n FROM read_parquet(${lit(path.join(coreDir, "occurrence_counts.parquet"))})`)).getRowObjects();
  if (Number(s.n) > sourceRows) throw new Error(`build-occurrences: aggregated ${s.n} records from a ${sourceRows}-record snapshot`);
  await assertKeysFitTaxonomy(conn, coreDir);
  return { snapshot: snap.date, citation: snap.citation, sourceRows };
}

export async function run(opts: { out?: string } = {}): Promise<OccurrenceSource> {
  const snap = resolveSnapshot();
  console.log(`build-occurrences: ${snap.date} (${snap.files.length} files) — ${snap.citation}`);
  const conn = await (await DuckDBInstance.create(":memory:", {
    threads: "20", memory_limit: "96GB", temp_directory: DUCKDB_TMP, preserve_insertion_order: "false",
  })).connect();
  const source = await buildOccurrences(conn, snap, opts.out ?? CORE_DIR);
  const { sourceRows } = source;
  const [s] = (await conn.runAndReadAll(`SELECT count(*) AS rows, sum(n) AS records, sum(n) FILTER (georef) AS georef
    FROM read_parquet(${lit(path.join(opts.out ?? CORE_DIR, "occurrence_counts.parquet"))})`)).getRowObjects();
  console.log(`occurrence_counts: ${Number(s.rows).toLocaleString()} rows covering ${Number(s.records).toLocaleString()} ` +
    `of ${sourceRows.toLocaleString()} records (${Number(s.georef).toLocaleString()} georeferenced)`);
  return source;
}

const isDirectRun = process.argv[1]?.endsWith("core/build-occurrences.ts") || process.argv[1]?.endsWith("core/build-occurrences.js");
if (isDirectRun) {
  loadEnvFiles();
  const i = process.argv.indexOf("--out");
  run({ out: i >= 0 ? process.argv[i + 1] : undefined }).catch((e) => { console.error(e); process.exit(1); });
}
