/**
 * The diff engine: every field-level difference between two loaded fact sets,
 * each one assigned a reason or left unexplained.
 *
 * Expects schemas `b` (baseline) and `a` (candidate) holding the same fact
 * kinds (see facts.ts). Writes one table, `diffs`:
 *
 *   kind, key     which fact row
 *   field         which column ('*' for a row only one side has)
 *   change        changed | added | removed
 *   before, after the two values as text
 *   delta         after - before, when both are numbers
 *   reason        the first rule in reasons.ts that explains it, or NULL
 *
 * Numbers compare as numbers, so 12 and 12.0 are equal. Everything else
 * compares as text.
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import type { ReasonRule } from "./reasons";

export interface SchemaNote {
  kind: string;
  field: string;
  side: "baseline only" | "candidate only";
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL.*)$/;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function columns(conn: DuckDBConnection, schema: string, table: string): Promise<Map<string, string>> {
  const rows = (await conn.runAndReadAll(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)} ORDER BY ordinal_position`
  )).getRowObjects();
  return new Map(rows.map((r) => [String(r.column_name), String(r.data_type)]));
}

async function tables(conn: DuckDBConnection, schema: string): Promise<string[]> {
  const rows = (await conn.runAndReadAll(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ${lit(schema)} ORDER BY 1`
  )).getRowObjects();
  return rows.map((r) => String(r.table_name));
}

export async function diffFacts(conn: DuckDBConnection): Promise<SchemaNote[]> {
  await conn.run(`CREATE OR REPLACE TABLE diffs (
    kind VARCHAR, key VARCHAR, field VARCHAR, change VARCHAR,
    before VARCHAR, after VARCHAR, delta DOUBLE, reason VARCHAR)`);
  const notes: SchemaNote[] = [];

  const kinds = new Set([...(await tables(conn, "b")), ...(await tables(conn, "a"))]);
  for (const kind of kinds) {
    const bCols = await columns(conn, "b", kind);
    const aCols = await columns(conn, "a", kind);
    if (bCols.size === 0 || aCols.size === 0) {
      notes.push({ kind, field: "*", side: bCols.size === 0 ? "candidate only" : "baseline only" });
      continue;
    }
    const B = `b.${ident(kind)}`;
    const A = `a.${ident(kind)}`;

    await conn.run(`INSERT INTO diffs
      SELECT ${lit(kind)}, key, '*', 'removed', NULL, NULL, NULL, NULL FROM ${B} WHERE key NOT IN (SELECT key FROM ${A})`);
    await conn.run(`INSERT INTO diffs
      SELECT ${lit(kind)}, key, '*', 'added', NULL, NULL, NULL, NULL FROM ${A} WHERE key NOT IN (SELECT key FROM ${B})`);

    for (const [field, bType] of bCols) {
      if (field === "key") continue;
      const aType = aCols.get(field);
      if (!aType) { notes.push({ kind, field, side: "baseline only" }); continue; }
      const numeric = NUMERIC.test(bType) && NUMERIC.test(aType);
      const bv = numeric ? `CAST(x.${ident(field)} AS DOUBLE)` : `CAST(x.${ident(field)} AS VARCHAR)`;
      const av = numeric ? `CAST(y.${ident(field)} AS DOUBLE)` : `CAST(y.${ident(field)} AS VARCHAR)`;
      await conn.run(`INSERT INTO diffs
        SELECT ${lit(kind)}, x.key, ${lit(field)}, 'changed',
               CAST(x.${ident(field)} AS VARCHAR), CAST(y.${ident(field)} AS VARCHAR),
               ${numeric ? `${av} - ${bv}` : "NULL"}, NULL
        FROM ${B} x JOIN ${A} y ON x.key = y.key
        WHERE ${bv} IS DISTINCT FROM ${av}`);
    }
    for (const field of aCols.keys()) {
      if (field !== "key" && !bCols.has(field)) notes.push({ kind, field, side: "candidate only" });
    }
  }
  return notes;
}

/** Give each difference the first rule that explains it. Rules run in order. */
export async function applyReasons(conn: DuckDBConnection, rules: ReasonRule[]): Promise<void> {
  for (const r of rules) {
    const scope = [
      r.kinds ? `kind IN (${r.kinds.map(lit).join(", ")})` : "TRUE",
      r.fields ? `field IN (${r.fields.map(lit).join(", ")})` : "TRUE",
      r.changes ? `change IN (${r.changes.map(lit).join(", ")})` : "TRUE",
    ].join(" AND ");
    await conn.run(`UPDATE diffs AS d SET reason = ${lit(r.code)}
      WHERE d.reason IS NULL AND ${scope} AND (${r.where})`);
  }
}
