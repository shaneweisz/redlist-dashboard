/**
 * sync: build a full data release from the three inputs, then check it.
 *
 * Run monthly, locally, once a new GBIF snapshot is mirrored (see
 * build-occurrences.ts for the `aws s3 sync` line). Nothing is uploaded: the
 * output lands in ~/.cache/redlist-dashboard/build/ and `npm run sync:publish`
 * copies it into app/data and uploads it.
 *
 *   inputs     CoL XR + curated checklist (cached by dataset key), the Red List
 *              database (read-only), the GBIF snapshot mirror, iNaturalist names
 *   core       taxa → assessments → occurrence_counts → matches → assessment_link
 *   matching   GBIF's matcher (matching-ws, run locally in Docker, pinned to the
 *              XR) answers every Red List name; build-link takes the certain
 *              answers and decisions.tsv for the rest, and writes the species
 *              still waiting for a person to build/match-queue.tsv
 *   outputs    the read models, then the summaries, CoL revisions, synonym
 *              and search indexes and CoL taxon ids built from them
 *   checks     matching fixtures (any failure stops the sync), and the
 *              comparison against the sync production serves, written to
 *              build/compare/ for the PR
 *   sync.json  every input version and check result, published with the data
 *
 * Usage:  npm run sync [-- --skip-compare] [-- --baseline <data dir>]
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles } from "../lib/utils";
import { writeReleaseMetadata } from "./inputs/fetch-col-xr";
import { ensureColInputs } from "./inputs/col";
import { ensureInatNames } from "./inputs/inat";
import { run as buildTaxa } from "./core/build-taxa";
import { run as buildAssessments } from "./core/build-assessments";
import { run as buildOccurrences } from "./core/build-occurrences";
import { buildLink, summariseQueue } from "./core/build-link";
import { buildMatches } from "./core/build-matches";
import { ensureMatcher } from "./inputs/matcher";
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
import { BUILD_DIR, CORE_DIR, DUCKDB_TMP, OUT_DIR } from "./paths";
import { syncPath } from "../../src/lib/data/sync-layout";

const APP = path.join(__dirname, "..", "..");

function step(name: string): () => void {
  const start = Date.now();
  console.log(`\n── ${name}`);
  return () => console.log(`   ${name}: ${((Date.now() - start) / 1000).toFixed(0)} s`);
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

  let done = step("inputs");
  const col = await ensureColInputs();
  const inat = await ensureInatNames();
  manifest.col = { xr: col.xr, checklist: col.checklist };
  done();

  done = step("taxa");
  await buildTaxa({ inputs: col });
  done();
  done = step("assessments");
  await buildAssessments();
  done();
  done = step("occurrences");
  await buildOccurrences();
  manifest.gbif = JSON.parse(fs.readFileSync(path.join(CORE_DIR, "occurrences.json"), "utf-8"));
  done();

  done = step("match names");
  // Spills go to the cache, not DuckDB's default ./.tmp inside the repo.
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "16", memory_limit: "64GB", temp_directory: DUCKDB_TMP })).connect();
  const matcher = await ensureMatcher(col.xr, col.nameUsage);
  const m = await buildMatches(conn, CORE_DIR, matcher);
  console.log(`   ${m.asked.toLocaleString()} names asked, ${m.cached.toLocaleString()} from cache (matching-ws ${matcher.version}, XR ${matcher.datasetKey})`);
  done();

  done = step("link + read models");
  const { queue } = await buildLink(conn, CORE_DIR);
  await conn.run(`COPY (SELECT * FROM read_parquet('${path.join(CORE_DIR, "match_queue.parquet")}'))
    TO '${path.join(BUILD_DIR, "match-queue.tsv")}' (DELIMITER '\t', HEADER)`);
  const [basis] = (await conn.runAndReadAll(`SELECT count(*) FILTER (basis = 'matcher') AS matcher, count(*) FILTER (basis = 'decision') AS decision,
      count(*) FILTER (basis IS NULL) AS unlinked FROM read_parquet('${path.join(CORE_DIR, "assessment_link.parquet")}') WHERE role = 'primary'`)).getRowObjects();
  manifest.matching = { matcher: matcher.version, xr: matcher.datasetKey, by_matcher: Number(basis.matcher), by_decision: Number(basis.decision),
    unlinked: Number(basis.unlinked), queue: summariseQueue(queue) };
  console.log(`   ${Number(basis.matcher).toLocaleString()} by the matcher, ${Number(basis.decision).toLocaleString()} by decisions.tsv, ` +
    `${queue.length.toLocaleString()} queued for review (${path.join(BUILD_DIR, "match-queue.tsv")})`);
  await buildReadModels(conn, { coreDir: CORE_DIR, outDir: OUT_DIR, inatNames: inat });
  const [rl] = (await conn.runAndReadAll(`SELECT count(*) FILTER (is_latest) AS species, max(year_published) AS newest
    FROM read_parquet('${path.join(CORE_DIR, "assessments.parquet")}')`)).getRowObjects();
  manifest.redlist = { database: process.env.DB_NAME ?? "redlist_2026_1", assessed_species: Number(rl.species), newest_published: rl.newest };
  manifest.inat = path.basename(path.dirname(inat));
  done();

  done = step("summaries, CoL revisions, synonym and search indexes");
  await buildTaxaSummary({ dataDir: OUT_DIR });
  await buildColRevisions({ dataDir: OUT_DIR });
  await buildSynonymIndex({ dataDir: OUT_DIR });
  await buildSearchIndex({ dataDir: OUT_DIR, coreDir: CORE_DIR, inatNames: inat });
  await buildColTaxonIds({ taxaPath: path.join(OUT_DIR, syncPath("taxa.parquet")) });
  writeReleaseMetadata(col.xr, col.checklist);
  done();

  done = step("checks");
  const fx = await (await DuckDBInstance.create(":memory:")).connect();
  const obs = await observe(fx, OUT_DIR, MATCHING_CASES);
  const failed = MATCHING_CASES.filter((c) => !c.knownBug && mismatches(c, obs.get(c.name)!).length > 0);
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
  try {
    execFileSync("npx", ["vitest", "run", ...DATA_TESTS], { cwd: APP, stdio: "inherit", env: { ...process.env, PIPELINE_DATA_DIR: OUT_DIR } });
    manifest.data_tests = { files: DATA_TESTS, passed: true };
  } catch {
    manifest.data_tests = { files: DATA_TESTS, passed: false };
    fs.writeFileSync(path.join(OUT_DIR, syncPath("sync.json")), JSON.stringify(manifest, null, 2) + "\n");
    throw new Error("sync: the data tests fail against this build (output above)");
  }
  if (!opts.skipCompare) {
    const baseline = opts.baseline ? path.resolve(opts.baseline) : await ensureBaseline(prodSync());
    const out = path.join(BUILD_DIR, "compare");
    const summary = await compare({ baseline, candidate: OUT_DIR, out, core: CORE_DIR });
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
