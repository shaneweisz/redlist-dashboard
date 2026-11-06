/**
 * sync: build a full data release from its inputs, then check it.
 *
 * Run monthly, locally, once a new GBIF snapshot is mirrored (docs/sync.md,
 * "Running it each month"). Nothing is uploaded: the build lands in
 * ~/.cache/redlist-dashboard/build/ (core/ working tables, data/ what the app
 * reads), and `npm run sync:publish` copies data/ into app/data/sync and
 * uploads it. The steps, as the log and docs/sync.md number them:
 *
 *   1 inputs        CoL XR, curated checklist and Base sources, iNaturalist names (cached)
 *   2 taxa          core/taxa.parquet, every CoL usage
 *   3 assessments   core/assessments.parquet, from the Red List database (read-only)
 *   4 occurrences   core/occurrence_* from the GBIF snapshot mirror
 *   5 match names   GBIF's matcher (matching-ws, in Docker) on every Red List name
 *   6 link          which CoL species each assessed species is; build/match-queue.tsv
 *                   lists the ones waiting for a person
 *   7 common names, read models   the lists the app reads
 *   8 summaries and indexes       summaries, CoL revisions, search and synonym
 *                   indexes, src/config/col-taxon-ids.json and col-release.json
 *   9 checks        fixtures and data tests (either stops the sync), then the
 *                   comparison with production's sync, in build/compare/
 *
 * sync.json records every input version and check result, and sync.log
 * everything the run printed; both are published with the data.
 *
 * Usage:  npm run sync [-- --skip-compare] [-- --baseline <data dir>]
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { loadEnvFiles } from "../lib/utils";
import { ensureColInputs, writeColReleasePin } from "./inputs/col";
import { ensureInatNames } from "./inputs/inat-names";
import { run as buildTaxa } from "./core/build-taxa";
import { run as buildAssessments, REDLIST_DB } from "./core/build-assessments";
import { run as buildOccurrences } from "./core/build-occurrences";
import { buildLink, summariseQueue, writeQueue } from "./core/build-link";
import { buildMatches } from "./core/build-matches";
import { ensureMatcher } from "./inputs/matcher";
import { buildCommonNames } from "./outputs/build-common-names";
import { buildReadModels } from "./outputs/build-read-models";
import { run as buildTaxaSummary } from "./outputs/build-taxa-summary";
import { run as buildColRevisions } from "./outputs/build-col-revisions";
import { run as buildSynonymIndex } from "./outputs/build-synonym-index";
import { run as buildSearchIndex } from "./outputs/build-search-index";
import { run as buildColTaxonIds } from "./outputs/build-col-taxon-ids";
import { observe, mismatches } from "./checks/check-fixtures";
import { MATCHING_CASES } from "./checks/fixtures/matching";
import { compare } from "./checks/compare";
import { ensureBaseline, prodSync } from "./checks/baseline";
import { BUILD_DIR, CORE_DIR, OUT_DIR } from "./paths";
import { syncPath } from "../../src/lib/data/sync-layout";
import { openDuckDB } from "./sql";

const APP = path.join(__dirname, "..", "..");

function step(name: string): () => void {
  const start = Date.now();
  console.log(`\n── ${name}`);
  return () => console.log(`   ${name}: ${((Date.now() - start) / 1000).toFixed(0)} s`);
}

/**
 * Copy everything the sync prints into `file` as well as the terminal. It is
 * opened in data/, so the log is published with the sync (sync.log beside
 * sync.json): each release carries the record of how it was built.
 */
function teeOutput(file: string): void {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      // The file gets plain text; the terminal keeps its colours.
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      fs.appendFileSync(file, text.replace(/\x1b\[[0-9;]*m/g, ""));
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: APP, encoding: "utf-8" }).trim();
}

/** Tests that read a sync's output (see the checks step), and the files they read. */
const DATA_TESTS = ["scripts/__tests__/validate-table1a.test.ts", "src/config/__tests__/taxonomy-tree.test.ts", "src/lib/__tests__/countries.test.ts",
  "src/lib/__tests__/col-revisions-data.test.ts"];
const DATA_TEST_FILES = ["taxa-summary.json", "table1a-children-summaries.json", "ssc-group-children-summaries.json", "country-stats.json", "col-revisions.json"];

/**
 * @param baseline a data directory to compare against instead of the sync
 *   production serves: a previous build's data/, to see one change at a time
 *   (a new CoL release, then a new Red List release, each against the last)
 */
export async function sync(opts: { skipCompare?: boolean; baseline?: string } = {}): Promise<void> {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const manifest: Record<string, unknown> = { built_at: new Date().toISOString(), commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--", "scripts", "src").length > 0 };

  // data/ is exactly what gets uploaded, so it starts empty: a file only an
  // older version wrote would otherwise be published with every sync after it.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  teeOutput(path.join(OUT_DIR, syncPath("sync.log")));
  console.log(`sync ${manifest.built_at} at ${String(manifest.commit).slice(0, 8)}${manifest.dirty ? " (uncommitted changes)" : ""}`);

  let done = step("1 inputs");
  const col = await ensureColInputs();
  const inat = await ensureInatNames();
  manifest.col = { xr: col.xr, checklist: col.checklist };
  done();

  done = step("2 taxa");
  await buildTaxa({ inputs: col });
  done();
  done = step("3 assessments");
  await buildAssessments();
  done();
  done = step("4 occurrences");
  manifest.gbif = await buildOccurrences();
  done();

  done = step("5 match names");
  // Each step gets its own connection, so no step can read another's temp tables.
  let conn = await openDuckDB();
  const matcher = await ensureMatcher(col.xr, col.nameUsage);
  const m = await buildMatches(conn, CORE_DIR, matcher);
  console.log(`   ${m.asked.toLocaleString()} names asked, ${m.cached.toLocaleString()} from cache (matching-ws ${matcher.version}, XR ${matcher.datasetKey})`);
  done();

  done = step("6 link");
  conn = await openDuckDB();
  const { queue } = await buildLink(conn, CORE_DIR);
  writeQueue(queue, path.join(BUILD_DIR, "match-queue.tsv"));
  const [basis] = (await conn.runAndReadAll(`SELECT count(*) FILTER (basis = 'matcher') AS matcher, count(*) FILTER (basis = 'decision') AS decision,
      count(*) FILTER (basis IS NULL) AS unlinked FROM read_parquet('${path.join(CORE_DIR, "assessment_link.parquet")}') WHERE role = 'primary'`)).getRowObjects();
  manifest.matching = { matcher: matcher.version, xr: matcher.datasetKey, by_matcher: Number(basis.matcher), by_decision: Number(basis.decision),
    unlinked: Number(basis.unlinked), queue: summariseQueue(queue) };
  console.log(`   ${Number(basis.matcher).toLocaleString()} by the matcher, ${Number(basis.decision).toLocaleString()} by decisions.tsv, ` +
    `${queue.length.toLocaleString()} queued for review (${path.join(BUILD_DIR, "match-queue.tsv")})`);
  done();

  done = step("7 common names, read models");
  conn = await openDuckDB();
  await buildCommonNames(conn, { vernacularTsv: col.vernacularNames, taxa: path.join(CORE_DIR, "taxa.parquet"), coreDir: CORE_DIR, dataDir: OUT_DIR });
  await buildReadModels(conn, { coreDir: CORE_DIR, outDir: OUT_DIR, inatNames: inat });
  const [rl] = (await conn.runAndReadAll(`SELECT count(*) FILTER (is_latest) AS species, max(year_published) AS newest
    FROM read_parquet('${path.join(CORE_DIR, "assessments.parquet")}')`)).getRowObjects();
  manifest.redlist = { database: REDLIST_DB, assessed_species: Number(rl.species), newest_published: rl.newest };
  manifest.inat = path.basename(path.dirname(inat));
  done();

  done = step("8 summaries and indexes");
  await buildTaxaSummary({ dataDir: OUT_DIR });
  await buildColRevisions({ dataDir: OUT_DIR });
  await buildSynonymIndex({ dataDir: OUT_DIR });
  await buildSearchIndex({ dataDir: OUT_DIR, coreDir: CORE_DIR, inatNames: inat });
  await buildColTaxonIds({ taxaPath: path.join(OUT_DIR, syncPath("taxa.parquet")) });
  writeColReleasePin(col.xr, col.checklist);
  done();

  done = step("9 checks");
  const fx = await openDuckDB();
  const obs = await observe(fx, OUT_DIR, MATCHING_CASES);
  const failed = MATCHING_CASES.filter((c) => mismatches(c, obs.get(c.name)!).length > 0);
  manifest.fixtures = { cases: MATCHING_CASES.length, failed: failed.map((c) => c.name) };
  if (failed.length > 0) {
    fs.writeFileSync(path.join(OUT_DIR, syncPath("sync.json")), JSON.stringify(manifest, null, 2) + "\n");
    throw new Error(`sync: ${failed.length} matching fixtures fail: ${failed.map((c) => `${c.name} (${mismatches(c, obs.get(c.name)!).join("; ")})`).join(", ")}`);
  }
  // The tests that check a sync's output against the code (Table 1a totals, the
  // taxonomy tree's summaries, country names). CI has no data and skips them, so
  // this is where they run. The files they read are checked first: a missing one
  // would skip its test, not fail it.
  for (const f of DATA_TEST_FILES) {
    if (!fs.existsSync(path.join(OUT_DIR, syncPath(f)))) throw new Error(`sync: ${f} was not built`);
  }
  // Piped rather than inherited, so the tests' output reaches sync.log too.
  const tests = spawnSync("npx", ["vitest", "run", ...DATA_TESTS], {
    cwd: APP, encoding: "utf-8", env: { ...process.env, PIPELINE_DATA_DIR: OUT_DIR, FORCE_COLOR: "0" } });
  process.stdout.write(tests.stdout ?? "");
  process.stderr.write(tests.stderr ?? "");
  if (tests.status === 0) {
    manifest.data_tests = { files: DATA_TESTS, passed: true };
  } else {
    manifest.data_tests = { files: DATA_TESTS, passed: false };
    fs.writeFileSync(path.join(OUT_DIR, syncPath("sync.json")), JSON.stringify(manifest, null, 2) + "\n");
    throw new Error("sync: the data tests fail against this build (output above)");
  }
  if (!opts.skipCompare) {
    const baseline = opts.baseline ? path.resolve(opts.baseline) : await ensureBaseline(prodSync());
    const out = path.join(BUILD_DIR, "compare");
    const summary = await compare({ baseline, candidate: OUT_DIR, out });
    manifest.compare = { baseline: path.basename(baseline), report: path.join(out, "report.md"), ...summary };
    console.log(`   ${summary.total.toLocaleString()} differences against ${path.basename(baseline)}, ` +
      `${summary.unexplained.toLocaleString()} unexplained — ${path.join(out, "report.md")}`);
  }
  done();

  fs.writeFileSync(path.join(OUT_DIR, syncPath("sync.json")), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nBuilt ${OUT_DIR}. Review the report, then: npm run sync:publish`);
}

const isDirectRun = process.argv[1]?.endsWith("sync/sync.ts") || process.argv[1]?.endsWith("sync/sync.js");
if (isDirectRun) {
  loadEnvFiles();
  const i = process.argv.indexOf("--baseline");
  sync({ skipCompare: process.argv.includes("--skip-compare"), baseline: i >= 0 ? process.argv[i + 1] : undefined })
    .catch((e) => { console.error(e); process.exit(1); });
}
