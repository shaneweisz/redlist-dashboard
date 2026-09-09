/**
 * build-narratives (#474): the assessment narratives, as something searchable.
 *
 * The other half of issue #474 — "search across existing red list assessments
 * for keywords ... eg habitat type specific words". The text itself is in the
 * IUCN database and in nothing this app ships: `assessment_documentations` is
 * 367k rows and 735 MB, and the sync has never touched it.
 *
 * Two parquets come out of here, and the split is the whole design:
 *
 *  - narratives.parquet — one row per latest assessment, the nine narrative
 *      fields as they were written, sorted by assessment_id and cut into small
 *      row groups. This is what a result reads to show its snippet, and it is
 *      only ever read for the handful of assessments a search matched.
 *  - narrative-index.parquet — one row per (term, assessment) with every
 *      position that word appears at, sorted by term. This is what a search
 *      reads. Sorted, so DuckDB's row-group statistics
 *      prune every group whose term range excludes the word being looked for:
 *      a query touches a few hundred kilobytes of a file that indexes half a
 *      gigabyte of prose.
 *
 * Scanning the prose directly would be simpler and is the obvious first thing
 * to try. It is also ~470 MB of text per query over httpfs from R2, which is
 * not a search box, it is a batch job. The index is what makes this a feature.
 *
 *   npx tsx scripts/build-narratives.ts
 */
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR } from "./utils";
import { indexPostings } from "../src/lib/redlist/narrative-terms";

/** The narrative fields, in the order the Red List website reads them. */
export const NARRATIVE_FIELDS = [
  "rationale",
  "range",
  "population",
  "habitats",
  "threats",
  "measures",
  "use_trade",
  "trend_justification",
  "taxonomic_notes",
] as const;

/**
 * Strip the HTML the narratives are stored with, for indexing and snippets.
 *
 * Numeric entities decoded as well as named ones: the narratives are full of
 * `&#160;` (a non-breaking space, from pasting out of Word), and left in place
 * they end up in the snippet a reader is shown — "affected by&#160;quarrying".
 */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Non-breaking and other unicode spaces, now that the entities are decoded.
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function run(): Promise<void> {
  loadEnvFiles();
  const narrativesOut = path.join(DATA_DIR, "narratives.parquet");
  const indexOut = path.join(DATA_DIR, "narrative-index.parquet");
  const scratch = path.join(DATA_DIR, "narrative-scratch");
  fs.mkdirSync(scratch, { recursive: true });

  const pg = new Client({
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5433,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await pg.connect();
  console.log("Connected to the IUCN database");

  /**
   * Latest global assessments only.
   *
   * The same universe the species list is built from — `t.latest`, `a.latest`,
   * global scope (15), no infraspecies or subpopulations — so every row here
   * has a species in `assessed.parquet` to belong to. Superseded assessments
   * are a different feature: this searches what the Red List says now.
   */
  const sql = `
    SELECT
      a.id            AS assessment_id,
      t.sis_id        AS sis_taxon_id,
      t.scientific_name,
      ${NARRATIVE_FIELDS.map((f) => `d.${f === "range" ? '"range"' : f}`).join(",\n      ")}
    FROM assessment_documentations d
    JOIN assessments a ON a.id = d.assessment_id
    JOIN taxons t ON t.id = a.taxon_id
    JOIN assessment_scopes ascope ON ascope.assessment_id = a.id
    WHERE t.latest = true
      AND a.latest = true
      AND a.suppress = false
      AND ascope.scope_lookup_id = 15
      AND t.infra_name IS NULL
      AND t.subpopulation_name IS NULL
  `;

  // Streamed rather than collected: the result set is ~470 MB of text, and
  // holding it and its parsed terms in one process at once is how a build
  // machine runs out of memory.
  const rowsCsv = path.join(scratch, "narratives.csv");
  const indexCsv = path.join(scratch, "index.csv");
  const rowsFile = fs.createWriteStream(rowsCsv);
  const indexFile = fs.createWriteStream(indexCsv);
  rowsFile.write(
    ["assessment_id", "sis_taxon_id", "scientific_name", ...NARRATIVE_FIELDS].join(",") + "\n"
  );
  indexFile.write("term,assessment_id,positions\n");

  const csv = (v: string | number | null): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  let rows = 0;
  let postings = 0;
  type Row = Record<string, string | number | null>;
  const Cursor = (await import("pg-cursor")).default;
  const cursor = pg.query(new Cursor(sql));
  for (;;) {
    const batch: Row[] = await new Promise((resolve, reject) =>
      cursor.read(500, (err, result) => (err ? reject(err) : resolve(result as Row[])))
    );
    if (batch.length === 0) break;
    for (const row of batch) {
      const id = Number(row.assessment_id);
      const fields = NARRATIVE_FIELDS.map((f) =>
        row[f] == null ? "" : plainText(String(row[f]))
      );
      rowsFile.write(
        [
          id,
          csv(row.sis_taxon_id as number),
          csv(row.scientific_name as string),
          ...fields.map(csv),
        ].join(",") + "\n"
      );
      rows += 1;
      for (const [term, at] of indexPostings(fields)) {
        // Positions as one space-separated string per posting: a CSV column
        // DuckDB casts to INTEGER[] on the way into the parquet, without
        // needing 67 million rows of (term, assessment, position) in between.
        indexFile.write(`${csv(term)},${id},"${at.join(" ")}"\n`);
        postings += 1;
      }
    }
    if (rows % 20000 < 500) console.log(`  ${rows.toLocaleString()} assessments…`);
  }
  await new Promise((r) => rowsFile.end(r));
  await new Promise((r) => indexFile.end(r));
  await cursor.close();
  await pg.end();
  console.log(
    `Read ${rows.toLocaleString()} assessments, ${postings.toLocaleString()} (term, assessment) pairs`
  );

  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();

  /**
   * Small row groups, on purpose.
   *
   * A result reads one assessment's prose. At DuckDB's default of 122,880 rows
   * per group that is the whole corpus in two groups, so reading one row means
   * reading everything. At 2,048 a lookup costs a few megabytes.
   */
  await conn.run(`
    COPY (
      SELECT * FROM read_csv('${rowsCsv}', header=true, auto_detect=true)
      ORDER BY assessment_id
    ) TO '${narrativesOut}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 2048)
  `);

  /**
   * Sorted by term, which is the entire point.
   *
   * Parquet keeps min/max per row group; sorted, a `WHERE term = 'quarry'`
   * touches the one group whose range covers it and skips the rest of the file.
   * Unsorted, every group's range is [a…z] and the reader has to open all of
   * them — which over R2 means downloading the index to answer one word.
   *
   * `positions` is a separate column, so a search that only asks which
   * assessments hold a word never reads it: parquet is columnar, and DuckDB
   * projects before it fetches. The phrase search is what pays for it.
   */
  await conn.run(`
    COPY (
      SELECT term, assessment_id, CAST(str_split(positions, ' ') AS INTEGER[]) AS positions
      FROM read_csv('${indexCsv}', header=true, quote='"',
                    columns={'term': 'VARCHAR', 'assessment_id': 'BIGINT', 'positions': 'VARCHAR'})
      ORDER BY term, assessment_id
    ) TO '${indexOut}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)
  `);

  const size = (p: string) => `${(fs.statSync(p).size / 1e6).toFixed(1)} MB`;
  console.log(`\nnarratives.parquet     ${size(narrativesOut)}`);
  console.log(`narrative-index.parquet ${size(indexOut)}`);

  const [distinct] = (
    await conn.runAndReadAll(
      `SELECT count(DISTINCT term) AS terms FROM read_parquet('${indexOut}')`
    )
  ).getRowObjects();
  console.log(`${Number(distinct.terms).toLocaleString()} distinct terms`);

  fs.rmSync(scratch, { recursive: true, force: true });
}

const isDirectRun =
  process.argv[1]?.endsWith("build-narratives.ts") ||
  process.argv[1]?.endsWith("build-narratives.js");
if (isDirectRun) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
