/**
 * The dbt step: the SQL stages (count, lists) run as dbt models (dbt/), between
 * the TypeScript stages before and after them.
 *
 * dbt reads the tables the sources and link stages wrote (dbt/models/sources.yml)
 * and builds its models as tables in one DuckDB file, core/sync.duckdb. The
 * export below then writes the files everything after it reads: the app's
 * lists, and the count tables for the precomputed stage and the docs. Where a
 * file is sorted or partitioned is decided here, not in the models, so a model
 * says only what its rows are.
 *
 * dbt runs through uv, which installs the pinned dbt (dbt/pyproject.toml,
 * dbt/uv.lock) on first use.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { DUCKDB_TMP, output, type Tables } from "./paths";
import { lit, openDuckDB } from "./sql";

export const DBT_DIR = path.join(__dirname, "dbt");

/**
 * Run `dbt build` (models, then their tests) on the build in `buildDir`, then
 * the unit tests of what it built. `select` narrows it (dbt's selection syntax:
 * "path:models/lists"); `today` is the date "since the assessment" counts up to.
 * Throws if a model or test fails.
 *
 * Unit tests run after the models, not first as `dbt build` would run them: dbt
 * reads a unit test's column types from the tables upstream of its model, which a
 * fresh build doesn't have yet.
 */
export function runDbt(opts: { buildDir: string; today: string; select?: string; quiet?: boolean }): void {
  fs.mkdirSync(path.join(opts.buildDir, "core"), { recursive: true });
  fs.mkdirSync(DUCKDB_TMP, { recursive: true });
  const units = opts.select ? opts.select.split(/\s+/).map((s) => `test_type:unit,${s}`) : ["test_type:unit"];
  dbt(opts, ["build", "--exclude", "test_type:unit", ...(opts.select ? ["--select", ...opts.select.split(/\s+/)] : [])]);
  dbt(opts, ["test", "--select", ...units]);
}

/**
 * One model's SQL as dbt compiles it for the build in `buildDir`: its sources and
 * refs become that build's files and tables. Lets a test run the real model over
 * rows of its own (src/config/__tests__/helpers/specialist-groups.ts).
 */
export function compileDbtModel(model: string, buildDir: string): string {
  dbt({ buildDir, today: new Date().toISOString().slice(0, 10), quiet: true }, ["compile", "--select", model]);
  const find = (dir: string): string | null => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const f = find(p); if (f) return f; } else if (e.name === `${model}.sql`) return p;
    }
    return null;
  };
  const file = find(path.join(buildDir, "dbt-target", "compiled"));
  if (!file) throw new Error(`dbt: compiling ${model} wrote no SQL`);
  return fs.readFileSync(file, "utf-8");
}

function dbt(opts: { buildDir: string; today: string; quiet?: boolean }, command: string[]): void {
  const args = ["run", "--project", DBT_DIR, "--quiet", "dbt", ...command, "--project-dir", DBT_DIR, "--profiles-dir", DBT_DIR,
    "--target-path", path.join(opts.buildDir, "dbt-target")];
  // Piped rather than inherited, so dbt's output reaches sync.log too.
  const r = spawnSync("uv", args, {
    cwd: DBT_DIR, encoding: "utf-8",
    env: { ...process.env, SYNC_BUILD_DIR: opts.buildDir, SYNC_DATE: opts.today, SYNC_DUCKDB_TMP: DUCKDB_TMP, DBT_LOG_PATH: path.join(opts.buildDir, "dbt-logs") },
  });
  if (r.error) throw new Error(`dbt: could not run uv (${r.error.message}); install it: brew install uv`);
  if (!opts.quiet || r.status !== 0) {
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
  }
  if (r.status !== 0) throw new Error(`dbt ${command[0]} failed (output above):\n${(r.stdout ?? "").split("\n").filter((l) => /fail|error/i.test(l)).join("\n")}`);
}

/** Each dbt model the rest of the sync or the app reads, and how its file is laid out. */
function exports(T: Tables) {
  return [
    { model: "usage_owner", file: T.usageOwner, orderBy: "usage_key" },
    { model: "record_counts", file: T.recordCounts, orderBy: "sis_taxon_id, col_id" },
    { model: "assessment_history", file: T.assessmentHistory, orderBy: "sis_taxon_id, seq" },
    { model: "assessed", file: T.assessed, orderBy: "class_name, order_name, family, scientific_name" },
    // Partitioned by group, in row groups small enough that a lookup reads little.
    { model: "species", file: T.species, orderBy: "taxon_group, class_name, order_name, family, scientific_name",
      options: "PARTITION_BY (taxon_group), ROW_GROUP_SIZE 20000" },
    { model: "ne", file: T.ne, orderBy: "taxon_group, class_name, order_name, family, scientific_name" },
    // By col_id, so a lookup by id skips row groups.
    { model: "app_taxa", file: T.appTaxa, orderBy: "col_id" },
    { model: "specialist_group_species", file: T.specialistGroupSpecies, orderBy: "group_id, sis_taxon_id, col_id" },
  ];
}

/**
 * Write the files the stages after dbt and the app read, from dbt's tables.
 * `only` names the models to write (the tests build a few); otherwise all.
 */
export async function exportDbtTables(T: Tables, buildDir: string, only?: string[]): Promise<void> {
  const conn = await openDuckDB();
  await conn.run(`ATTACH ${lit(path.join(buildDir, "core", "sync.duckdb"))} AS dbt (READ_ONLY)`);
  for (const e of exports(T).filter((x) => !only || only.includes(x.model))) {
    if (e.options) fs.rmSync(e.file, { recursive: true, force: true });
    await conn.run(`COPY (SELECT * FROM dbt.main.${e.model} ORDER BY ${e.orderBy})
      TO ${lit(e.options ? e.file : output(e.file))} (FORMAT parquet, COMPRESSION zstd${e.options ? `, ${e.options}` : ""})`);
  }
  if (only) return;
  // The links as built, under the name the app reads them by.
  fs.copyFileSync(T.link, output(T.appLink));
  // The tree's labels, as one object keyed by lowercased scientific name.
  const names = (await conn.runAndReadAll(`SELECT key, name FROM dbt.main.vernacular_names ORDER BY key`)).getRowObjects();
  fs.writeFileSync(output(T.treeNames), JSON.stringify(Object.fromEntries(names.map((r) => [String(r.key), String(r.name)])), null, 0));
  const [s] = (await conn.runAndReadAll(`SELECT
      (SELECT count(*) FILTER (sis_taxon_id IS NOT NULL) FROM dbt.main.usage_owner) AS assessed_usages,
      (SELECT count(*) FILTER (col_id IS NOT NULL) FROM dbt.main.usage_owner) AS unassessed_usages,
      (SELECT count(*) FROM dbt.main.assessed) AS assessed, (SELECT count(*) FROM dbt.main.ne) AS ne`)).getRowObjects();
  console.log(`   ${Number(s.assessed_usages).toLocaleString()} usages count for an assessed species, ${Number(s.unassessed_usages).toLocaleString()} for an unassessed one`);
  console.log(`   ${Number(s.assessed).toLocaleString()} assessed and ${Number(s.ne).toLocaleString()} Not Evaluated species listed; ${names.length.toLocaleString()} tree labels`);
}
