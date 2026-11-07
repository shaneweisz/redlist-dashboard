/**
 * The GBIF monthly snapshot: find the newest local mirror, refuse it unless it
 * is complete, and reduce it once to per-usage counts.
 *
 * GBIF publishes every occurrence record it holds as parquet once a month
 * (https://registry.opendata.aws/gbif/), keyed since October 2026 by Catalogue
 * of Life ids. A local mirror (pulled with `aws s3 sync
 * s3://gbif-open-data-eu-central-1/occurrence/<date>/ ~/Data/gbif/<date>/
 * --no-sign-request`) is read once per snapshot, in batches written to
 * ~/.cache/redlist-dashboard/occurrences/<date>/parts/, so an interrupted run
 * resumes and a re-run reads nothing.
 *
 * A snapshot is only exact if it is complete. From 2025-07 to 2026-10 every
 * mirror was missing one file in twenty (gbif/occurrence#609), so before
 * anything is read the file numbering must have no gaps and the files' footer
 * row counts must sum to the totalRecords of the download it was made from.
 *
 * georef is the API's hasCoordinate=true&hasGeospatialIssue=false. The snapshot
 * has no hasGeospatialIssue column, so it is recomputed from the issue list
 * with GBIF's own set (GBIF_GEOSPATIAL_ISSUES).
 *
 * Environment:
 *   GBIF_SNAPSHOT_ROOT  where mirrors live; default ~/Data/gbif
 *   GBIF_SNAPSHOT       pin a date (e.g. 2026-11-01); default the newest mirror
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type DuckDBConnection } from "@duckdb/node-api";
import { gbifJson } from "../../../src/lib/gbif-fetch";
import { GBIF_GEOSPATIAL_ISSUES } from "../../../src/lib/gbif";
import { CACHE_ROOT } from "../paths";
import { lit, openDuckDB } from "../sql";

const SNAPSHOT_ROOT = process.env.GBIF_SNAPSHOT_ROOT ?? path.join(os.homedir(), "Data", "gbif");
/** The earliest snapshot keyed by Catalogue of Life rather than GBIF's old Backbone. */
const FIRST_COL_SNAPSHOT = "2026-10-01";
const FILES_PER_BATCH = 400;


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
      throw new Error(`gbif-snapshot: ${date} predates GBIF's move to Catalogue of Life ids (${FIRST_COL_SNAPSHOT}).`);
    }
    const partsDir = path.join(dir, "occurrence.parquet");
    const files = fs.readdirSync(partsDir).filter((f) => /^\d+$/.test(f)).sort().map((f) => path.join(partsDir, f));
    return { date, dir, citation: fs.readFileSync(citation, "utf-8").trim(), files };
  }
  throw new Error(`gbif-snapshot: no mirrored snapshot with a citation.txt under ${root}`);
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
  if (!doi) throw new Error(`gbif-snapshot: no download DOI in citation.txt: ${citation}`);
  const d = (await gbifJson(`https://api.gbif.org/v1/occurrence/download/${doi}`)) as { totalRecords?: number };
  if (typeof d.totalRecords !== "number") throw new Error(`gbif-snapshot: download ${doi} reports no totalRecords`);
  return d.totalRecords;
}

/** Refuse a snapshot that doesn't hold every record of its download. Returns the row total. */
export async function assertComplete(conn: DuckDBConnection, snap: Snapshot): Promise<number> {
  const missing = missingFileNumbers(snap.files);
  if (missing.length > 0) {
    throw new Error(`gbif-snapshot: ${snap.date} is missing ${missing.length} files ` +
      `(${missing.slice(0, 5).map((n) => String(n).padStart(6, "0")).join(", ")}…). Re-sync the mirror or pin GBIF_SNAPSHOT.`);
  }
  const expected = await downloadTotalRecords(snap.citation);
  const [r] = (await conn.runAndReadAll(
    `SELECT sum(num_rows) AS n FROM parquet_file_metadata([${snap.files.map(lit).join(", ")}])`)).getRowObjects();
  const actual = Number(r.n);
  if (actual !== expected) {
    throw new Error(`gbif-snapshot: ${snap.date} holds ${actual.toLocaleString()} records but its download ` +
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

/** What sync.json records about the snapshot. */
export interface SnapshotSource {
  snapshot: string;
  citation: string;
  sourceRows: number;
}

/**
 * The snapshot reduced to counts, in parts files: counts-* (usage × year ×
 * georef × basis), dates-* (… × month × day, for records dated at least to the
 * month) and countries-* (usage × country × georef × basis). Built once per
 * snapshot; `dir` is where the parts are.
 */
export async function ensureSnapshotCounts(snap: Snapshot): Promise<SnapshotSource & { dir: string }> {
  const workDir = path.join(CACHE_ROOT, "occurrences", snap.date);
  const marker = path.join(workDir, "complete.json");
  // The aggregate bakes in which issues count as geospatial (GBIF changes its
  // own set) and what it is grouped by, so a change to either has to rebuild it
  // rather than reuse it.
  const done = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf-8")) : null;
  let sourceRows: number;
  if (done && done.georef === GEOREF && done.grain === GRAIN) {
    sourceRows = done.sourceRows;
  } else {
    const conn = await openDuckDB({ threads: "20", memory_limit: "96GB", preserve_insertion_order: "false" });
    fs.rmSync(path.join(workDir, "parts"), { recursive: true, force: true });
    sourceRows = await assertComplete(conn, snap);
    await aggregate(conn, snap, workDir);
    fs.writeFileSync(marker, JSON.stringify({ date: snap.date, citation: snap.citation, files: snap.files.length, sourceRows, georef: GEOREF, grain: GRAIN }, null, 2) + "\n");
  }
  return { snapshot: snap.date, citation: snap.citation, sourceRows, dir: path.join(workDir, "parts") };
}
