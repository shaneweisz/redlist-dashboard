/**
 * compare: diff a sync against a baseline, field by field, and require every
 * difference to be explained.
 *
 * This is the acceptance test for the sync rewrite. Both data directories are
 * reduced to the same fact tables (compare/facts.ts), every difference is
 * matched against the rules in compare/reasons.ts, and anything no rule
 * explains fails the run. The report and every difference are written out so
 * the PR can carry them.
 *
 * Usage:
 *   npx tsx scripts/pipeline/compare.ts [--baseline DIR] [--candidate DIR] [--out DIR] [--report-only]
 *
 *   --baseline     default: prod's sync (origin/main latest-sync.txt), downloaded once
 *   --candidate    default: app/data
 *   --out          default: ~/.cache/redlist-dashboard/compare/<baseline name>/
 *   --report-only  write the report but exit 0 even with unexplained differences
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR } from "../utils";
import { CACHE_ROOT, ensureBaseline } from "./baseline";
import { loadFacts } from "./compare/facts";
import { diffFacts, applyReasons } from "./compare/diff";
import { REASONS, type ReasonRule } from "./compare/reasons";
import { buildReport, type CompareSummary } from "./compare/report";

export interface CompareOptions {
  baseline: string;
  candidate: string;
  out: string;
  rules?: ReasonRule[];
}

export async function compare(opts: CompareOptions): Promise<CompareSummary> {
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "8" })).connect();
  const bLayout = await loadFacts(conn, "b", opts.baseline);
  const aLayout = await loadFacts(conn, "a", opts.candidate);
  const notes = await diffFacts(conn);
  await applyReasons(conn, opts.rules ?? REASONS);
  const { markdown, summary } = await buildReport(conn, {
    baseline: `${opts.baseline} (${bLayout})`,
    candidate: `${opts.candidate} (${aLayout})`,
  }, notes);

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

const isDirectRun = process.argv[1]?.endsWith("pipeline/compare.ts") || process.argv[1]?.endsWith("pipeline/compare.js");
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
