/**
 * compare: what changed since the sync production serves, field by field.
 *
 * Both data directories are reduced to the same fact tables (compare/facts.ts),
 * and every difference is matched against the rules in compare/reasons.ts.
 * What no rule explains is listed in the report for a person to read before
 * publishing (and fails a standalone run). The report and every difference are
 * written out so the data PR can carry them.
 *
 * Usage:
 *   npx tsx scripts/sync/checks/compare.ts [--baseline DIR] [--candidate DIR] [--out DIR] [--report-only]
 *
 *   --baseline     default: prod's sync (origin/main latest-sync.txt), downloaded once
 *   --candidate    default: app/data
 *   --out          default: ~/.cache/redlist-dashboard/compare/<baseline name>/
 *   --report-only  write the report but exit 0 even with unexplained differences
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR } from "../../lib/utils";
import { ensureBaseline } from "./baseline";
import { CACHE_ROOT } from "../paths";
import { loadFacts, snapshotOf } from "./compare/facts";
import { diffFacts, applyReasons } from "./compare/diff";
import { REASONS, type ReasonRule } from "./compare/reasons";
import { buildReport, type CompareSummary } from "./compare/report";

export interface CompareOptions {
  baseline: string;
  candidate: string;
  out: string;
  rules?: ReasonRule[];
}

/** What the reason rules can read besides the diff: each side's GBIF snapshot. */
async function loadContext(conn: Awaited<ReturnType<DuckDBInstance["connect"]>>, baseline: string, candidate: string): Promise<void> {
  const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
  await conn.run(`CREATE TABLE snapshots AS SELECT ${lit(snapshotOf(baseline))}::VARCHAR AS b, ${lit(snapshotOf(candidate))}::VARCHAR AS a`);
}

export async function compare(opts: CompareOptions): Promise<CompareSummary> {
  const tmp = path.join(CACHE_ROOT, "compare", "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "8", temp_directory: tmp })).connect();
  await loadFacts(conn, "b", opts.baseline);
  await loadFacts(conn, "a", opts.candidate);
  const notes = await diffFacts(conn);
  await loadContext(conn, opts.baseline, opts.candidate);
  await applyReasons(conn, opts.rules ?? REASONS);
  const { markdown, summary } = await buildReport(conn, { baseline: opts.baseline, candidate: opts.candidate }, notes);

  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(path.join(opts.out, "report.md"), markdown + "\n");
  const diffsPath = path.join(opts.out, "diffs.parquet").replace(/'/g, "''");
  await conn.run(`COPY (SELECT * FROM diffs ORDER BY kind, field, key) TO '${diffsPath}' (FORMAT parquet)`);
  fs.writeFileSync(path.join(opts.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isDirectRun = process.argv[1]?.endsWith("checks/compare.ts") || process.argv[1]?.endsWith("checks/compare.js");
if (isDirectRun) {
  loadEnvFiles();
  (async () => {
    const baseline = path.resolve(arg("--baseline") ?? (await ensureBaseline()));
    const candidate = path.resolve(arg("--candidate") ?? DATA_DIR);
    const out = path.resolve(arg("--out") ?? path.join(CACHE_ROOT, "compare", path.basename(baseline)));
    console.log(`baseline:  ${baseline}\ncandidate: ${candidate}`);
    const s = await compare({ baseline, candidate, out });
    for (const [kind, k] of Object.entries(s.byKind)) {
      console.log(`  ${kind.padEnd(14)} ${String(k.baseline).padStart(9)} → ${String(k.candidate).padStart(9)} rows, ` +
        `${k.diffs} differences, ${k.unexplained} unexplained`);
    }
    console.log(`\n${s.total} differences, ${s.unexplained} unexplained. Report: ${path.join(out, "report.md")}`);
    if (s.unexplained > 0 && !process.argv.includes("--report-only")) process.exitCode = 1;
  })().catch((e) => { console.error(e); process.exit(1); });
}
