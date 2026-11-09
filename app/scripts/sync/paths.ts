/**
 * Where the sync keeps things, and the name of every table it builds.
 *
 *   CACHE_ROOT  downloaded inputs and baselines, reused across runs (cachedDir)
 *   BUILD_DIR   what a run produces; copied into app/data only to publish, so
 *               app/data keeps matching the sync production serves meanwhile
 *     core/     working tables: what the stages pass to each other, not published
 *     data/     what the app reads, laid out as src/lib/data/sync-layout.ts says
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { syncPath } from "../../src/lib/data/sync-layout";

export const CACHE_ROOT = path.join(os.homedir(), ".cache", "redlist-dashboard");
export const BUILD_DIR = process.env.PIPELINE_BUILD_DIR ?? path.join(CACHE_ROOT, "build");
/** Where the sync's DuckDB instances spill to disk (left to itself, DuckDB uses ./.tmp in the repo). */
export const DUCKDB_TMP = path.join(CACHE_ROOT, "duckdb-tmp");
export const CORE_DIR = path.join(BUILD_DIR, "core");
export const OUT_DIR = path.join(BUILD_DIR, "data");

/** Every file a sync builds, by stage, under `buildDir`. sync.ts passes these between the builders. */
export function tables(buildDir = BUILD_DIR) {
  const core = (f: string) => path.join(buildDir, "core", f);
  const data = (f: string) => path.join(buildDir, "data", syncPath(f));
  return {
    // 1. Sources
    sourcesReleases: core("sources-releases.json"),
    taxa: core("taxa.parquet"),
    assessments: core("assessments.parquet"),
    occurrences: core("occurrences.parquet"),
    occurrenceCountries: core("occurrence_countries.parquet"),
    commonNames: core("common_names.parquet"),
    specialistGroupRemits: core("specialist_group_remits.parquet"),
    rankAliases: core("rank_aliases.parquet"),
    // 2. Link
    matches: core("matches.parquet"),
    link: core("assessment_link.parquet"),
    matchQueue: path.join(buildDir, "match-queue.tsv"),
    // 3. Count
    usageOwner: core("usage_owner.parquet"),
    recordCounts: core("record_counts.parquet"),
    specialistGroupSpecies: core("specialist_group_species.parquet"),
    linkAudit: core("link_audit.parquet"),
    // 4. Lists
    assessed: data("assessed.parquet"),
    assessmentHistory: data("assessments.parquet"),
    species: data("species"),
    ne: data("ne.parquet"),
    appTaxa: data("taxa.parquet"),
    appLink: data("assessment_link.parquet"),
    // 5. Precomputed
    splitCandidates: data("col-split-candidates.parquet"),
    synonymAssessed: data("col-synonym-assessed.parquet"),
    colToAssessed: data("col-to-assessed.parquet"),
    colRevisions: data("col-revisions.json"),
    taxaSummary: data("taxa-summary.json"),
    table1aChildren: data("table1a-children-summaries.json"),
    sscChildren: data("ssc-group-children-summaries.json"),
    countryStats: data("country-stats.json"),
    treeNames: data("vernacular-names.json"),
    nameIndex: data("name-index.parquet"),
    rankIndex: data("rank-index.parquet"),
    synonymIndex: data("synonym-index.parquet"),
    // 6. Checks
    syncJson: data("sync.json"),
    syncLog: data("sync.log"),
    compare: path.join(buildDir, "compare"),
  };
}
export type Tables = ReturnType<typeof tables>;

/** A parquet table, or a partitioned folder of them, as a DuckDB relation. */
export function parquet(file: string): string {
  const quoted = (p: string) => `'${p.replace(/'/g, "''")}'`;
  return fs.existsSync(file) && fs.statSync(file).isDirectory()
    ? `read_parquet(${quoted(path.join(file, "**", "*.parquet"))}, hive_partitioning=true)`
    : `read_parquet(${quoted(file)})`;
}

/** Make sure `file`'s folder exists, and return `file`. */
export function output(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/**
 * A cached download or build: `fill` runs into an empty `dir` unless an earlier
 * run finished it. Finished means its .complete marker exists, so an interrupted
 * run is redone, never half-used.
 */
export async function cachedDir(dir: string, fill: (dir: string) => unknown): Promise<string> {
  const marker = path.join(dir, ".complete");
  if (fs.existsSync(marker)) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await fill(dir);
  fs.writeFileSync(marker, new Date().toISOString() + "\n");
  return dir;
}

/** Stop if a builder's input is missing: a sync always builds them, so a gap is a bug, not a reason to write zeros. */
export function requireFiles(step: string, ...files: string[]): void {
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`${step}: ${f} is missing`);
}
