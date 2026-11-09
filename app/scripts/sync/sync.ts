/**
 * sync: build a full data release from its inputs, then check it.
 *
 * Run monthly, locally, once a new GBIF snapshot is mirrored (docs/sync.md,
 * "Running it each month"). Nothing is uploaded: the build lands in
 * ~/.cache/redlist-dashboard/build/ (core/: working tables, data/: what the app
 * reads), and `npm run sync:publish` copies data/ into app/data/sync and
 * uploads it.
 *
 * The sync answers four questions. What species exist (the Catalogue of Life),
 * what IUCN has assessed (the Red List), which CoL species each assessed species
 * is (link), and how many GBIF records each species has (count). Only link and
 * count make judgements; every other stage reshapes data. Read top to bottom,
 * this file is the whole sync: each builder is given the tables it reads, and
 * writes one table, documented at the top of its file. Count and lists are SQL
 * models run by dbt (dbt.ts): there, each model's ref()s are what it reads.
 *
 *   inputs       fetch and cache each input (inputs/), and write the Specialist
 *                Groups' remits from the app's config (sources/specialist-groups.ts)
 *   1 sources    each input as one clean table (sources/)
 *   2 link       which CoL species each assessed species is (link/)
 *   3 count      whose records each GBIF usage's are (dbt/models/count/)
 *   4 lists      what the app reads, joins only (dbt/models/lists/)
 *   5 precomputed  the app's own queries, run ahead of time: the CoL-differences
 *                tables and search indexes in SQL (dbt/models/precomputed/), the
 *                summaries and revisions with the app's code (precomputed/)
 *   6 checks     fixtures and data tests (either stops the sync), then the
 *                comparison with production's sync (checks/)
 *
 * sync.json records every input version and check result, and sync.log
 * everything the run printed; both are published with the data.
 *
 * Usage:  npm run sync [-- --from <stage>] [-- --skip-compare] [-- --baseline <data dir>]
 *   --from lists   reuse the build's earlier tables and run from that stage on
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { loadEnvFiles } from "../lib/utils";
import { ensureColInputs, writeColReleasePin } from "./inputs/col";
import { ensureInatNames } from "./inputs/inat-names";
import { resolveSnapshot, ensureSnapshotCounts } from "./inputs/gbif-snapshot";
import { ensureMatcher } from "./inputs/matcher";
import { buildTaxa } from "./sources/taxa";
import { readSourcesReleases, sourcesMismatch, writeSourcesReleases } from "./sources-releases";
import { buildAssessments, REDLIST_DB } from "./sources/assessments";
import { buildOccurrences } from "./sources/occurrences";
import { buildCommonNames } from "./sources/common-names";
import { buildSpecialistGroups } from "./sources/specialist-groups";
import { askMatcher } from "./link/matches";
import { buildLink, summariseQueue } from "./link/assessment-link";
import { runDbt, exportDbtTables } from "./dbt";
import { buildColRevisions } from "./precomputed/col-revisions";
import { buildSummaries } from "./precomputed/summaries";
import { buildColTaxonIds } from "./precomputed/col-taxon-ids";
import { observe, mismatches } from "./checks/check-fixtures";
import { specialistGroupMismatches } from "./checks/specialist-groups";
import { MATCHING_CASES } from "./checks/fixtures/matching";
import { compare } from "./checks/compare";
import { ensureBaseline, prodSync } from "./checks/baseline";
import { BUILD_DIR, OUT_DIR, tables, parquet } from "./paths";
import { openDuckDB, rows } from "./sql";

const APP = path.join(__dirname, "..", "..");
const STAGES = ["sources", "link", "count", "lists", "precomputed", "checks"] as const;
type Stage = (typeof STAGES)[number];

/** Tests that read a sync's output (see the checks stage), and the files they read. */
const DATA_TESTS = ["scripts/__tests__/validate-table1a.test.ts", "src/config/__tests__/taxonomy-tree.test.ts", "src/lib/__tests__/countries.test.ts",
  "src/lib/__tests__/col-revisions-data.test.ts"];

export async function sync(opts: { from?: Stage; skipCompare?: boolean; baseline?: string } = {}): Promise<void> {
  const T = tables();
  const from = STAGES.indexOf(opts.from ?? "sources");
  if (from < 0) throw new Error(`sync: --from takes one of ${STAGES.join(", ")}`);
  const runs = (stage: Stage) => STAGES.indexOf(stage) >= from;

  // data/ is exactly what gets uploaded, so a full run starts it empty: a file
  // only an older version wrote would otherwise be published with every sync after it.
  if (from === 0) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(T.syncLog), { recursive: true });
  teeOutput(T.syncLog);
  const manifest: Record<string, unknown> = { built_at: new Date().toISOString(), commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--", "scripts", "src").length > 0, ...(from > 0 ? { from: opts.from } : {}) };
  console.log(`sync ${manifest.built_at} at ${String(manifest.commit).slice(0, 8)}${manifest.dirty ? " (uncommitted changes)" : ""}`);

  let done = step("inputs");
  const col = await ensureColInputs();
  const inat = await ensureInatNames();
  const snapshot = await ensureSnapshotCounts(resolveSnapshot());
  const matcher = await ensureMatcher(col.xr, col.nameUsage);
  manifest.col = { xr: col.xr, checklist: col.checklist };
  manifest.gbif = { snapshot: snapshot.snapshot, citation: snapshot.citation, sourceRows: snapshot.sourceRows };
  manifest.inat = path.basename(path.dirname(inat));
  const releases = { xr: col.xr.key, checklist: col.checklist.key, snapshot: snapshot.snapshot };
  if (from > 0) {
    const why = sourcesMismatch(readSourcesReleases(T.sourcesReleases), releases);
    if (why) throw new Error(`sync: --from ${opts.from} would reuse tables built from other releases (${why}). ` +
      `Run from sources, or pin the build's releases (COL_XR_DATASET, COL_CHECKLIST_DATASET).`);
  }
  // The Specialist Groups' remits come from the app's config, not the data, so
  // they are written every run: an edited remit takes effect whatever --from says.
  await buildSpecialistGroups({ remits: T.specialistGroupRemits, rankAliases: T.rankAliases });
  done();

  if (runs("sources")) {
    done = step("1 sources");
    await buildTaxa(col, T.taxa);
    await buildAssessments(T.assessments);
    await buildOccurrences({ snapshotCounts: snapshot.dir, sourceRows: snapshot.sourceRows, taxa: T.taxa },
      { occurrences: T.occurrences, occurrenceCountries: T.occurrenceCountries });
    await buildCommonNames({ colVernacularNames: col.vernacularNames, taxa: T.taxa, inatNames: inat }, T.commonNames);
    writeSourcesReleases(T.sourcesReleases, releases);
    done();
  }

  if (runs("link")) {
    done = step("2 link");
    const asked = await askMatcher({ assessments: T.assessments, matcher }, T.matches);
    console.log(`   ${asked.asked.toLocaleString()} names asked, ${asked.cached.toLocaleString()} from cache (matching-ws ${matcher.version}, XR ${matcher.datasetKey})`);
    await buildLink({ taxa: T.taxa, assessments: T.assessments, matches: T.matches }, { link: T.link, matchQueue: T.matchQueue });
    done();
  }

  if (runs("precomputed")) {
    // Count, lists and the precomputed stage's SQL tables are dbt models: `dbt
    // build` runs them in dependency order and tests them, then their tables are
    // written out as files. All of it runs from any of those stages: it takes
    // seconds, and each model reads the ones before it.
    done = step("3 count, 4 lists, 5 precomputed SQL (dbt)");
    runDbt({ buildDir: BUILD_DIR, today: new Date().toISOString().slice(0, 10),
      versions: { redlist: REDLIST_DB, colXr: col.xr.alias, colChecklist: col.checklist.alias } });
    await exportDbtTables(T, BUILD_DIR);
    done();
  }

  if (runs("precomputed")) {
    // What dbt can't do: the app's own breakdown and revision logic, run ahead of
    // time with the app's code so a precomputed number matches its live one.
    done = step("5 precomputed (app code)");
    const colDifferences = { splitCandidates: T.splitCandidates, synonymAssessed: T.synonymAssessed, colToAssessed: T.colToAssessed };
    await buildColRevisions({ ...colDifferences, species: T.species, link: T.appLink, assessed: T.assessed, appTaxa: T.appTaxa }, T.colRevisions);
    await buildSummaries({ ...colDifferences, assessed: T.assessed, ne: T.ne, species: T.species, link: T.appLink, appTaxa: T.appTaxa,
      specialistGroupSpecies: T.specialistGroupSpecies },
      { taxaSummary: T.taxaSummary, countryStats: T.countryStats, table1aChildren: T.table1aChildren, sscChildren: T.sscChildren });
    // Into the repo, not the sync: the app's client code imports these at build time.
    await buildColTaxonIds({ appTaxa: T.appTaxa });
    writeColReleasePin(col.xr, col.checklist);
    done();
  }

  done = step("6 checks");
  Object.assign(manifest, await describeBuild(T, matcher));
  const conn = await openDuckDB();
  const obs = await observe(conn, OUT_DIR, MATCHING_CASES);
  const failed = MATCHING_CASES.filter((c) => mismatches(c, obs.get(c.name)!).length > 0);
  manifest.fixtures = { cases: MATCHING_CASES.length, failed: failed.map((c) => c.name) };
  if (failed.length > 0) {
    writeManifest(T.syncJson, manifest);
    throw new Error(`sync: ${failed.length} matching fixtures fail: ${failed.map((c) => `${c.name} (${mismatches(c, obs.get(c.name)!).join("; ")})`).join(", ")}`);
  }
  const groupMismatches = await specialistGroupMismatches(conn, T);
  manifest.specialist_groups = { mismatches: groupMismatches };
  if (groupMismatches.length > 0) {
    writeManifest(T.syncJson, manifest);
    throw new Error(`sync: specialist_group_species disagrees with taxonomy-sql.ts's remits:\n  ${groupMismatches.join("\n  ")}`);
  }
  console.log("   specialist_group_species agrees with taxonomy-sql.ts's remits for every Specialist Group");
  // The tests that check a sync's output against the code (Table 1a totals, the
  // taxonomy tree's summaries, country names). CI has no data and skips them, so
  // this is where they run. The files they read are checked first: a missing one
  // would skip its test, not fail it.
  for (const f of [T.taxaSummary, T.table1aChildren, T.sscChildren, T.countryStats, T.colRevisions]) {
    if (!fs.existsSync(f)) throw new Error(`sync: ${f} was not built`);
  }
  // Piped rather than inherited, so the tests' output reaches sync.log too.
  const tests = spawnSync("npx", ["vitest", "run", ...DATA_TESTS], {
    cwd: APP, encoding: "utf-8", env: { ...process.env, PIPELINE_DATA_DIR: OUT_DIR, FORCE_COLOR: "0" } });
  process.stdout.write(tests.stdout ?? "");
  process.stderr.write(tests.stderr ?? "");
  manifest.data_tests = { files: DATA_TESTS, passed: tests.status === 0 };
  if (tests.status !== 0) {
    writeManifest(T.syncJson, manifest);
    throw new Error("sync: the data tests fail against this build (output above)");
  }
  if (!opts.skipCompare) {
    const baseline = opts.baseline ? path.resolve(opts.baseline) : await ensureBaseline(prodSync());
    const summary = await compare({ baseline, candidate: OUT_DIR, out: T.compare, candidateSnapshot: snapshot.snapshot });
    manifest.compare = { baseline: path.basename(baseline), report: path.join(T.compare, "report.md"), ...summary };
    console.log(`   ${summary.total.toLocaleString()} differences against ${path.basename(baseline)}, ` +
      `${summary.unexplained.toLocaleString()} unexplained — ${path.join(T.compare, "report.md")}`);
  }
  done();

  writeManifest(T.syncJson, manifest);
  console.log(`\nBuilt ${OUT_DIR}. Review the report, then: npm run sync:publish`);
}

/** What sync.json records about the Red List and the link, read from the built tables. */
async function describeBuild(T: ReturnType<typeof tables>, matcher: { version: string; datasetKey: string }): Promise<Record<string, unknown>> {
  const conn = await openDuckDB();
  const [rl] = await rows<{ species: number; newest: string }>(conn, `SELECT count(*) FILTER (is_latest)::INT AS species, max(year_published) AS newest
    FROM ${parquet(T.assessments)}`);
  const [link] = await rows<{ matcher: number; decision: number; unlinked: number }>(conn, `
    SELECT count(*) FILTER (basis = 'matcher')::INT AS matcher, count(*) FILTER (basis = 'decision')::INT AS decision,
           count(*) FILTER (basis IS NULL)::INT AS unlinked FROM ${parquet(T.link)} WHERE role = 'primary'`);
  const queue = fs.readFileSync(T.matchQueue, "utf-8").trim().split("\n").slice(1).map((line) => {
    const [, , , status, reason] = line.split("\t");
    return { status, reason } as { status: "undecided"; reason: string };
  });
  // How each link was made, and how many carry a difference worth checking
  // (dbt/models/audit/link_audit.sql).
  const audit = await rows<{ stratum: string; links: number; with_signal: number; with_two: number; iucn_lists_col_name: number }>(conn, `
    SELECT stratum, count(*)::INT AS links, count(*) FILTER (signals > 0)::INT AS with_signal,
           count(*) FILTER (signals > 1)::INT AS with_two, count(*) FILTER (iucn_lists_col_name)::INT AS iucn_lists_col_name
    FROM ${parquet(T.linkAudit)} GROUP BY stratum ORDER BY links DESC`);
  return {
    redlist: { database: REDLIST_DB, assessed_species: rl.species, newest_published: rl.newest },
    link_audit: Object.fromEntries(audit.map(({ stratum, ...r }) => [stratum, r])),
    matching: { matcher: matcher.version, xr: matcher.datasetKey, by_matcher: link.matcher, by_decision: link.decision,
      unlinked: link.unlinked, queue: summariseQueue(queue as Parameters<typeof summariseQueue>[0]) },
  };
}

function writeManifest(file: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}

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

const isDirectRun = process.argv[1]?.endsWith("sync/sync.ts") || process.argv[1]?.endsWith("sync/sync.js");
if (isDirectRun) {
  loadEnvFiles();
  const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  sync({ from: arg("--from") as Stage | undefined, skipCompare: process.argv.includes("--skip-compare"), baseline: arg("--baseline") })
    .catch((e) => { console.error(e); process.exit(1); });
}
