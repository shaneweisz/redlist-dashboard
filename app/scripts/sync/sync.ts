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
 *   data       the read models, then the summary, CoL-revision, synonym and
 *              search builders run against them (PIPELINE_DATA_DIR)
 *   checks     matching fixtures (any failure stops the sync), and the
 *              comparison against the sync production serves, written to
 *              build/compare/ for the PR
 *   sync.json  every input version and check result, published with the data
 *
 * Usage:  npm run sync [-- --skip-compare]
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles } from "../lib/utils";
import { currentReleaseOnDisk, writeReleaseMetadata } from "./inputs/fetch-col-xr";
import { ensureColInputs } from "./inputs/col";
import { ensureInatNames } from "./inputs/inat";
import { run as buildTaxa } from "./core/build-taxa";
import { run as buildAssessments } from "./core/build-assessments";
import { run as buildOccurrences } from "./core/build-occurrences";
import { buildLink, summariseQueue } from "./core/build-link";
import { buildMatches } from "./core/build-matches";
import { ensureMatcher } from "./inputs/matcher";
import { buildReadModels } from "./outputs/build-read-models";
import { observe, mismatches } from "./checks/check-fixtures";
import { MATCHING_CASES } from "./checks/fixtures/matching";
import { compare } from "./checks/compare";
import { ensureBaseline, prodSync } from "./checks/baseline";
import { BUILD_DIR, CORE_DIR, OUT_DIR } from "./paths";

const APP = path.join(__dirname, "..", "..");

function step(name: string): () => void {
  const start = Date.now();
  console.log(`\n── ${name}`);
  return () => console.log(`   ${name}: ${((Date.now() - start) / 1000).toFixed(0)} s`);
}

/** A builder that reads DATA_DIR, run against the pipeline's output. */
function runBuilder(script: string): void {
  execFileSync("npx", ["tsx", path.join("scripts", "sync", "outputs", script)], {
    cwd: APP, stdio: "inherit", env: { ...process.env, PIPELINE_DATA_DIR: OUT_DIR },
  });
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: APP, encoding: "utf-8" }).trim();
}

export async function sync(opts: { skipCompare?: boolean } = {}): Promise<void> {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const manifest: Record<string, unknown> = { built_at: new Date().toISOString(), commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--", "scripts", "src").length > 0 };

  let done = step("inputs");
  const col = await ensureColInputs();
  const inat = await ensureInatNames();
  const releaseMoved = currentReleaseOnDisk() !== col.xr.key;
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
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "16", memory_limit: "64GB" })).connect();
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
  for (const s of ["build-taxa-summary.ts", "build-col-revisions.ts", "build-synonym-index.ts", "build-search-index.ts", "build-col-taxon-ids.ts"]) runBuilder(s);
  // The group root keys the live country-stats route queries GBIF with, re-derived
  // only when the CoL release moves (they are CoL ids, and GBIF resolves them).
  if (releaseMoved) runBuilder("derive-gbif-taxon-keys.ts");
  writeReleaseMetadata(col.xr, col.checklist);
  done();

  done = step("checks");
  const fx = await (await DuckDBInstance.create(":memory:")).connect();
  const obs = await observe(fx, OUT_DIR, MATCHING_CASES);
  const failed = MATCHING_CASES.filter((c) => !c.knownBug && mismatches(c, obs.get(c.name)!).length > 0);
  manifest.fixtures = { cases: MATCHING_CASES.length, failed: failed.map((c) => c.name) };
  if (failed.length > 0) {
    fs.writeFileSync(path.join(OUT_DIR, "sync.json"), JSON.stringify(manifest, null, 2) + "\n");
    throw new Error(`sync: ${failed.length} matching fixtures fail: ${failed.map((c) => `${c.name} (${mismatches(c, obs.get(c.name)!).join("; ")})`).join(", ")}`);
  }
  if (!opts.skipCompare) {
    const baseline = await ensureBaseline(prodSync());
    const out = path.join(BUILD_DIR, "compare");
    const summary = await compare({ baseline, candidate: OUT_DIR, out, core: CORE_DIR });
    manifest.compare = { baseline: path.basename(baseline), report: path.join(out, "report.md"), ...summary };
    console.log(`   ${summary.total.toLocaleString()} differences against ${path.basename(baseline)}, ` +
      `${summary.unexplained.toLocaleString()} unexplained — ${path.join(out, "report.md")}`);
  }
  done();

  fs.writeFileSync(path.join(OUT_DIR, "sync.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nBuilt ${OUT_DIR}. Review the report, then: npm run sync:publish`);
}

const isDirectRun = process.argv[1]?.endsWith("sync/sync.ts") || process.argv[1]?.endsWith("sync/sync.js");
if (isDirectRun) {
  loadEnvFiles();
  sync({ skipCompare: process.argv.includes("--skip-compare") }).catch((e) => { console.error(e); process.exit(1); });
}
