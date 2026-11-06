/**
 * Turn the diffs table into a markdown report a reviewer can read in a PR.
 *
 * For each fact kind: row counts on both sides, then each field that differs
 * with its total, how many differences each reason explains, and a few
 * examples of the unexplained ones (largest moves first).
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import type { SchemaNote } from "./diff";
import { lit } from "../../sql";

export interface CompareSummary {
  total: number;
  unexplained: number;
  byKind: Record<string, { baseline: number; candidate: number; diffs: number; unexplained: number }>;
}

const EXAMPLES = 8;

const n = (v: unknown) => Number(v ?? 0);
const fmt = (v: number) => v.toLocaleString("en-GB");
const cell = (v: unknown) => (v === null || v === undefined ? "∅" : String(v).replace(/\|/g, "\\|").slice(0, 80));

async function rows(conn: DuckDBConnection, sql: string) {
  return (await conn.runAndReadAll(sql)).getRowObjects();
}

async function tableRows(conn: DuckDBConnection, schema: string, kind: string): Promise<number> {
  const exists = await rows(conn, `SELECT 1 FROM information_schema.tables
    WHERE table_schema = ${lit(schema)} AND table_name = ${lit(kind)}`);
  if (exists.length === 0) return 0;
  return n((await rows(conn, `SELECT count(*) AS c FROM ${schema}."${kind}"`))[0].c);
}

export async function buildReport(
  conn: DuckDBConnection,
  meta: { baseline: string; candidate: string },
  notes: SchemaNote[],
): Promise<{ markdown: string; summary: CompareSummary }> {
  const kinds = (await rows(conn, `SELECT DISTINCT table_name AS k FROM information_schema.tables
    WHERE table_schema IN ('a', 'b') ORDER BY 1`)).map((r) => String(r.k));

  const summary: CompareSummary = { total: 0, unexplained: 0, byKind: {} };
  const out: string[] = [];
  out.push(`# Sync comparison`, "", `- baseline: \`${meta.baseline}\``, `- candidate: \`${meta.candidate}\``, "");

  const head: string[] = ["| kind | baseline rows | candidate rows | differences | unexplained |", "|---|---:|---:|---:|---:|"];
  const body: string[] = [];

  for (const kind of kinds) {
    const baseline = await tableRows(conn, "b", kind);
    const candidate = await tableRows(conn, "a", kind);
    const [{ diffs, unexplained }] = await rows(conn, `SELECT count(*) AS diffs,
      count(*) FILTER (WHERE reason IS NULL) AS unexplained FROM diffs WHERE kind = ${lit(kind)}`);
    summary.byKind[kind] = { baseline, candidate, diffs: n(diffs), unexplained: n(unexplained) };
    summary.total += n(diffs);
    summary.unexplained += n(unexplained);
    head.push(`| ${kind} | ${fmt(baseline)} | ${fmt(candidate)} | ${fmt(n(diffs))} | ${fmt(n(unexplained))} |`);
    if (n(diffs) === 0) continue;

    body.push(`## ${kind}`, "");
    const fields = await rows(conn, `SELECT field, change, count(*) AS c,
        count(*) FILTER (WHERE reason IS NULL) AS u
      FROM diffs WHERE kind = ${lit(kind)} GROUP BY ALL ORDER BY c DESC`);
    for (const f of fields) {
      const field = String(f.field);
      const change = String(f.change);
      body.push(`### \`${field}\` ${change === "changed" ? "" : `(${change})`} — ${fmt(n(f.c))}`, "");
      const reasons = await rows(conn, `SELECT coalesce(reason, 'UNEXPLAINED') AS r, count(*) AS c FROM diffs
        WHERE kind = ${lit(kind)} AND field = ${lit(field)} AND change = ${lit(change)} GROUP BY 1 ORDER BY 2 DESC`);
      for (const r of reasons) body.push(`- ${r.r}: ${fmt(n(r.c))}`);
      if (n(f.u) > 0) {
        const ex = await rows(conn, `SELECT key, before, after, delta FROM diffs
          WHERE kind = ${lit(kind)} AND field = ${lit(field)} AND change = ${lit(change)} AND reason IS NULL
          ORDER BY abs(delta) DESC NULLS LAST, key LIMIT ${EXAMPLES}`);
        body.push("", "| key | before | after | Δ |", "|---|---|---|---:|");
        for (const e of ex) body.push(`| ${cell(e.key)} | ${cell(e.before)} | ${cell(e.after)} | ${e.delta === null ? "" : fmt(n(e.delta))} |`);
      }
      body.push("");
    }
  }

  out.push(...head, "", `**${fmt(summary.total)} differences, ${fmt(summary.unexplained)} unexplained.**`, "");
  if (notes.length > 0) {
    out.push("## Schema differences", "", "| kind | field | present in |", "|---|---|---|");
    for (const s of notes) out.push(`| ${s.kind} | ${s.field} | ${s.side} |`);
    out.push("");
  }
  out.push(...body);
  return { markdown: out.join("\n"), summary };
}
