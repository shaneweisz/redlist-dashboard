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
 *   npx tsx scripts/sync/checks/compare.ts [--baseline DIR] [--candidate DIR] [--out DIR] [--report-only]
 *
 *   --baseline     default: prod's sync (origin/main latest-sync.txt), downloaded once
 *   --candidate    default: app/data
 *   --out          default: ~/.cache/redlist-dashboard/compare/<baseline name>/
 *   --core         the candidate's core tables, for the reason rules; default <candidate>/../core
 *   --report-only  write the report but exit 0 even with unexplained differences
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR } from "../../lib/utils";
import { ensureBaseline } from "./baseline";
import { CACHE_ROOT } from "../paths";
import { usageCountsSql } from "../core/counts";
import { loadFacts, inSync } from "./compare/facts";
import { diffFacts, applyReasons } from "./compare/diff";
import { REASONS, type ReasonRule } from "./compare/reasons";
import { buildReport, type CompareSummary } from "./compare/report";

export interface CompareOptions {
  baseline: string;
  candidate: string;
  out: string;
  rules?: ReasonRule[];
  /** The candidate's core tables, which reason rules may consult (ctx_* views). */
  core?: string;
}

/** Context the reason rules can read: the candidate's core tables, where it has them. */
async function loadContext(conn: Awaited<ReturnType<DuckDBInstance["connect"]>>, core?: string, baseline?: string): Promise<void> {
  const views: Record<string, string> = {
    ctx_link: "assessment_link.parquet", ctx_taxa: "taxa.parquet",
    ctx_assessments: "assessments.parquet", ctx_components: "count_components.parquet",
  };
  for (const [name, file] of Object.entries(views)) {
    const p = core ? path.join(core, file) : "";
    await conn.run(core && fs.existsSync(p)
      ? `CREATE TABLE ${name} AS SELECT * FROM read_parquet('${p.replace(/'/g, "''")}')`
      : `CREATE TABLE ${name} AS SELECT NULL AS none WHERE false`);
  }
  // Counted georeferenced records per usage, so rules can bound a count by the
  // usages it is made of.
  const occ = core ? path.join(core, "occurrence_counts.parquet") : "";
  await conn.run(core && fs.existsSync(occ)
    ? `CREATE TABLE ctx_usage AS SELECT usage_key, coalesce(sum(n) FILTER (georef), 0)::BIGINT AS georef
       FROM (${usageCountsSql({ taxa: "ctx_taxa", counts: `read_parquet('${occ.replace(/'/g, "''")}')` })}) GROUP BY 1`
    : `CREATE TABLE ctx_usage (usage_key VARCHAR, georef BIGINT)`);
  // CoL species the baseline kept off the NE list with a covered link row.
  const bLink = baseline ? inSync(baseline, "species_link.parquet") : "";
  await conn.run(bLink && fs.existsSync(bLink)
    ? `CREATE TABLE ctx_b_covered AS SELECT DISTINCT col_id FROM read_parquet('${bLink.replace(/'/g, "''")}')
       WHERE match_method = 'iucn_synonym_covered' AND col_id IS NOT NULL`
    : `CREATE TABLE ctx_b_covered (col_id VARCHAR)`);
  // One row per assessed species with both sides' link, key and count, so rules
  // can be plain semi-joins instead of correlated subqueries per difference.
  await conn.run(`CREATE TABLE pair AS
    SELECT b.key, b.link_col_id AS b_col, a.link_col_id AS a_col, b.gbif_species_key AS b_key, a.gbif_species_key AS a_key,
           b.gbif_georeferenced_records_count AS b_n, a.gbif_georeferenced_records_count AS a_n
    FROM b.assessed b JOIN a.assessed a USING (key)`);
}

export async function compare(opts: CompareOptions): Promise<CompareSummary> {
  const tmp = path.join(CACHE_ROOT, "compare", "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "8", temp_directory: tmp })).connect();
  const bLayout = await loadFacts(conn, "b", opts.baseline);
  const aLayout = await loadFacts(conn, "a", opts.candidate);
  const notes = await diffFacts(conn);
  if (aLayout === "v2") await loadContext(conn, opts.core, opts.baseline);
  await applyReasons(conn, aLayout === "v2" ? (opts.rules ?? REASONS) : (opts.rules ?? []));
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

const isDirectRun = process.argv[1]?.endsWith("checks/compare.ts") || process.argv[1]?.endsWith("checks/compare.js");
if (isDirectRun) {
  loadEnvFiles();
  (async () => {
    const baseline = path.resolve(arg("--baseline") ?? (await ensureBaseline()));
    const candidate = path.resolve(arg("--candidate") ?? DATA_DIR);
    const out = path.resolve(arg("--out") ?? path.join(CACHE_ROOT, "compare", path.basename(baseline)));
    console.log(`baseline:  ${baseline}\ncandidate: ${candidate}`);
    const core = path.resolve(arg("--core") ?? path.join(candidate, "..", "core"));
    const s = await compare({ baseline, candidate, out, core: fs.existsSync(core) ? core : undefined });
    for (const [kind, k] of Object.entries(s.byKind)) {
      console.log(`  ${kind.padEnd(14)} ${String(k.baseline).padStart(9)} → ${String(k.candidate).padStart(9)} rows, ` +
        `${k.diffs} differences, ${k.unexplained} unexplained`);
    }
    console.log(`\n${s.total} differences, ${s.unexplained} unexplained. Report: ${path.join(out, "report.md")}`);
    if (s.unexplained > 0 && !process.argv.includes("--report-only")) process.exitCode = 1;
  })().catch((e) => { console.error(e); process.exit(1); });
}
