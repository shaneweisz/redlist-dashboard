/**
 * The OpenAlex works snapshot, kept locally as the text of the works that could
 * be about a species, and read from there for the species names they mention.
 *
 * OpenAlex publishes every scholarly work it indexes as parquet, free and
 * public (s3://openalex/data/parquet/works/, about 700 GiB, refreshed
 * quarterly: https://help.openalex.org/tutorials/download-the-snapshot/). It is
 * too big to keep whole, and most of it is about other things, so each file is
 * downloaded, reduced to the works worth keeping, and deleted. The reduced
 * files land in ~/.cache/redlist-dashboard/openalex/<release>/works/, each with
 * a done marker, so an interrupted run resumes and a re-run reads nothing.
 *
 * A work is kept if its title or abstract has a possible binomial in it (a
 * CoL species name's genus and epithet, as consecutive words), or OpenAlex files it under biology or environmental
 * science. That is looser than any one way of finding names, so the way names
 * are found (trinomials, genus-only mentions, a new CoL release's synonyms) can
 * change by re-reading the local copy, not the snapshot. Kept per work:
 *
 *   work_id, doi, publication_date, publication_year, type, language,
 *   is_retracted, cited_by_count, source (the journal), field, subfield, topic,
 *   keywords, title, abstract (as plain text; OpenAlex ships it as an
 *   inverted index of word → positions)
 *
 * openAlexMentions() then finds the binomials: consecutive words of the title
 * or the abstract, leading and trailing punctuation stripped ("(Panthera",
 * "leo,"), kept where the pair is a CoL species name's genus and epithet.
 * Which species a name counts for is decided later (count/paper-counts.ts).
 *
 * Environment:
 *   OPENALEX_CONCURRENCY   files downloaded and reduced at once (default 8)
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { CACHE_ROOT, DUCKDB_TMP, parquet } from "../paths";
import { lit } from "../sql";

const run = promisify(execFile);
const BUCKET = "https://openalex.s3.amazonaws.com";
const PREFIX = "data/parquet/works/";
/** What the reduced files hold; a change here rebuilds them rather than reusing them. */
const GRAIN = "works-v1";
/**
 * The OpenAlex work types that count as literature. The rest are kept locally
 * but not counted: most "dataset" and "other" records are specimens, samples and
 * occurrence downloads registered with DataCite (DiSSCo, GBIF, PlutoF, SESAR,
 * BacDive), one record per specimen, and would swamp the papers.
 */
const LITERATURE_TYPES = ["article", "review", "book", "book-chapter", "dissertation", "preprint", "report", "conference-paper", "letter", "data-paper"];
/** OpenAlex fields a work is kept for whatever its text says. */
const KEPT_FIELDS = ["Agricultural and Biological Sciences", "Environmental Science"];

export interface OpenAlexRelease {
  /** The newest updated_date partition: the release's date. */
  release: string;
  files: { key: string; size: number }[];
}

/** Every works file in the public snapshot, from the bucket's listing. */
export async function listOpenAlexWorks(): Promise<OpenAlexRelease> {
  const files: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const url = `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(PREFIX)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`openalex: listing failed: ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)) {
      if (m[1].endsWith(".parquet")) files.push({ key: m[1], size: Number(m[2]) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
  } while (token);
  const dates = files.map((f) => f.key.match(/updated_date=(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean) as string[];
  if (files.length === 0) throw new Error("openalex: the snapshot lists no works files");
  return { release: dates.sort().at(-1)!, files: files.sort((a, b) => a.key.localeCompare(b.key)) };
}

/** Words as names are compared: punctuation stripped from both ends. */
const WORD = (col: string) => `regexp_replace(${col}, '^[^A-Za-z]+|[^A-Za-z-]+$', '', 'g')`;

/**
 * The binomials a pair of words is checked against: every CoL species-rank name, accepted or synonym, that is
 * exactly a genus and an epithet. Virus species are named in words ("Severe acute respiratory syndrome-related
 * coronavirus", "Foot and mouth disease virus A"), and their first two words aren't a binomial.
 */
async function createBinomials(conn: DuckDBConnection, taxa: string): Promise<void> {
  await conn.run(`CREATE OR REPLACE TABLE binomials AS
    SELECT DISTINCT scientific_name AS name
    FROM ${parquet(taxa)} WHERE rank = 'species' AND regexp_full_match(scientific_name, '[A-Z][a-z]+ [\\p{Ll}-]+')`);
}

/** Consecutive word pairs of a words table (work, part, w, pos) that are CoL binomials. */
const BINOMIAL_PAIRS = (words: string, id: string) => `
  SELECT DISTINCT a.${id}, a.w || ' ' || b.w AS name, a.part
  FROM ${words} a JOIN ${words} b ON b.${id} = a.${id} AND b.part = a.part AND b.pos = a.pos + 1
  WHERE regexp_full_match(a.w, '[A-Z][a-z]+') AND a.w || ' ' || b.w IN (SELECT name FROM binomials)`;

/** One snapshot file reduced to the works worth keeping (see the header). Needs the binomials table. */
export async function reduceFile(conn: DuckDBConnection, file: string, out: string): Promise<void> {
  await conn.run(`COPY (
    WITH works AS (
      -- A few abstracts are cut off mid-JSON in the snapshot (at about 32 KB); those works keep their title only.
      SELECT id, title, CASE WHEN json_valid(abstract_inverted_index)
                             THEN json_transform(abstract_inverted_index, '"MAP(VARCHAR, INTEGER[])"') END AS abstract,
             primary_topic.field.display_name AS field
      FROM read_parquet(${lit(file)})),
    words AS MATERIALIZED (
      SELECT id, 'abstract' AS part, kv.key AS raw, unnest(kv.value) AS pos
      FROM (SELECT id, unnest(map_entries(abstract)) AS kv FROM works WHERE abstract IS NOT NULL)
      UNION ALL
      SELECT id, 'title', t.w, t.pos::INTEGER
      FROM works, unnest(string_split(title, ' ')) WITH ORDINALITY AS t(w, pos) WHERE title IS NOT NULL),
    clean AS (SELECT id, part, ${WORD("raw")} AS w, pos FROM words),
    kept AS (
      SELECT id FROM (${BINOMIAL_PAIRS("clean", "id")})
      UNION SELECT id FROM works WHERE field IN (${KEPT_FIELDS.map(lit).join(", ")})),
    abstracts AS (
      SELECT id, string_agg(raw, ' ' ORDER BY pos) AS abstract
      FROM words WHERE part = 'abstract' AND id IN (SELECT id FROM kept) GROUP BY id)
    SELECT w.id AS work_id, w.doi, w.publication_date, w.publication_year, w.type, w.language,
           w.is_retracted, w.cited_by_count, w.primary_location.source.display_name AS source,
           w.primary_topic.field.display_name AS field, w.primary_topic.subfield.display_name AS subfield,
           w.primary_topic.display_name AS topic, list_transform(w.keywords, lambda k: k.display_name) AS keywords,
           w.title, a.abstract
    FROM read_parquet(${lit(file)}) w JOIN kept k ON k.id = w.id LEFT JOIN abstracts a ON a.id = w.id
    ORDER BY w.id
  ) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);
}

/**
 * The binomials each kept work of a literature type (not retracted) mentions, one row per work and name:
 * work_id, publication_date, publication_year, name, in_title, in_abstract.
 *
 * Written as one parquet file per works file into `mentionsDir` (read it as
 * mentionsDir/*.parquet). All 56M works in one query means a self-join of ~7.5
 * billion word rows, which spilled 370 GB and never finished; one file at a
 * time is ~4.5M words. Word pairs come from the split list (word i beside
 * word i+1), not from joining words on position.
 */
export async function openAlexMentions(inputs: { works: string[]; taxa: string }, mentionsDir: string): Promise<void> {
  fs.rmSync(mentionsDir, { recursive: true, force: true });
  fs.mkdirSync(mentionsDir, { recursive: true });
  const instance = await DuckDBInstance.create(":memory:", { threads: "16", memory_limit: "32GB", temp_directory: DUCKDB_TMP });
  const setup = await instance.connect();
  await createBinomials(setup, inputs.taxa);
  const pairs = (col: string) => `list_transform(range(1, len(${col})), i -> ${WORD(`${col}[i]`)} || ' ' || ${WORD(`${col}[i + 1]`)})`;
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    const conn = await instance.connect();
    while (next < inputs.works.length) {
      const file = inputs.works[next++];
      await conn.run(`COPY (
        WITH w AS (
          SELECT work_id, publication_date, publication_year,
                 string_split(coalesce(title, ''), ' ') AS t, string_split(coalesce(abstract, ''), ' ') AS a
          FROM read_parquet(${lit(file)})
          WHERE type IN (${LITERATURE_TYPES.map(lit).join(", ")}) AND NOT coalesce(is_retracted, false)),
        p AS (
          SELECT work_id, publication_date, publication_year, 'title' AS part, unnest(${pairs("t")}) AS name FROM w
          UNION ALL
          SELECT work_id, publication_date, publication_year, 'abstract', unnest(${pairs("a")}) FROM w)
        SELECT work_id, publication_date, publication_year, name,
               bool_or(part = 'title') AS in_title, bool_or(part = 'abstract') AS in_abstract
        FROM p SEMI JOIN binomials USING (name)
        GROUP BY ALL
      ) TO ${lit(path.join(mentionsDir, path.basename(file)))} (FORMAT parquet, COMPRESSION zstd)`);
    }
  }));
}

/** The reduced files finished so far in a works directory (all of them once a run completes). */
export function finishedWorks(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".done")).sort()
    .map((f) => path.join(dir, f.replace(/\.done$/, ".parquet")));
}

/**
 * The snapshot reduced to the works worth keeping, one parquet file per
 * snapshot file. `taxa` supplies the CoL binomials.
 */
export async function ensureOpenAlexWorks(inputs: { taxa: string }): Promise<{ release: string; dir: string; files: number }> {
  const snap = await listOpenAlexWorks();
  const workDir = path.join(CACHE_ROOT, "openalex", snap.release);
  const works = path.join(workDir, "works");
  const downloads = path.join(workDir, "downloads");
  const marker = path.join(workDir, "complete.json");
  const done = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf-8")) : null;
  if (done?.grain === GRAIN) return { release: snap.release, dir: works, files: done.files };
  fs.mkdirSync(works, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });

  const instance = await DuckDBInstance.create(":memory:", { threads: "16", memory_limit: "48GB", temp_directory: DUCKDB_TMP });
  const setup = await instance.connect();
  await createBinomials(setup, inputs.taxa);

  const todo = snap.files.map((f, i) => ({ ...f, tag: String(i).padStart(5, "0") }))
    .filter((f) => !fs.existsSync(path.join(works, `${f.tag}.done`)))
    // A fixed shuffle, so a run stopped part-way has read a fair sample of the
    // snapshot (the files are sorted by update date, oldest first).
    .map((f) => ({ f, k: Number.parseInt(createHash("sha1").update(f.key).digest("hex").slice(0, 8), 16) }))
    .sort((a, b) => a.k - b.k).map(({ f }) => f);
  const total = snap.files.reduce((s, f) => s + f.size, 0);
  console.log(`   OpenAlex ${snap.release}: ${snap.files.length} files, ${(total / 2 ** 30).toFixed(0)} GiB; ${todo.length} to read`);
  const start = Date.now();
  let next = 0, bytes = 0, finished = snap.files.length - todo.length;
  const concurrency = Number(process.env.OPENALEX_CONCURRENCY ?? 8);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    const conn = await instance.connect();
    while (next < todo.length) {
      const f = todo[next++];
      const local = path.join(downloads, `${f.tag}.parquet`);
      for (let attempt = 0; ; attempt++) {
        try {
          await run("curl", ["-sSf", "--retry", "5", "--retry-delay", "5", "-o", local, `${BUCKET}/${f.key}`]);
          if (fs.statSync(local).size !== f.size) throw new Error(`size ${fs.statSync(local).size} ≠ ${f.size}`);
          await reduceFile(conn, local, path.join(works, `${f.tag}.parquet`));
          break;
        } catch (e) {
          if (attempt >= 3) throw new Error(`openalex: ${f.key}: ${(e as Error).message}`);
        } finally {
          fs.rmSync(local, { force: true });
        }
      }
      fs.writeFileSync(path.join(works, `${f.tag}.done`), "");
      bytes += f.size;
      finished++;
      if (finished % 20 === 0 || finished === snap.files.length) {
        const mins = (Date.now() - start) / 60000;
        console.log(`   ${finished}/${snap.files.length} files (${(bytes / 2 ** 30 / Math.max(mins, 0.01) * 60).toFixed(0)} GiB/h, ${mins.toFixed(0)} min)`);
      }
    }
  }));
  fs.writeFileSync(marker, JSON.stringify({ release: snap.release, files: snap.files.length, grain: GRAIN }, null, 2) + "\n");
  return { release: snap.release, dir: works, files: snap.files.length };
}

const isDirectRun = process.argv[1]?.endsWith("inputs/openalex-snapshot.ts");
if (isDirectRun) {
  const taxa = process.argv[2];
  if (!taxa) throw new Error("usage: npx tsx scripts/sync/inputs/openalex-snapshot.ts <taxa.parquet>");
  ensureOpenAlexWorks({ taxa })
    .then((r) => console.log(`Done: ${r.files} files → ${r.dir}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
