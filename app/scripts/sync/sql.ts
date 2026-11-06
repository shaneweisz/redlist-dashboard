/**
 * The small DuckDB helpers every sync step uses.
 */

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { DUCKDB_TMP } from "./paths";

/**
 * A DuckDB connection the way every sync step opens one: in memory, spilling
 * to DUCKDB_TMP (left to itself DuckDB spills into ./.tmp, inside the repo),
 * with 16 threads and 64 GB unless the step needs more.
 */
export async function openDuckDB(options: Record<string, string> = {}): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:", { threads: "16", memory_limit: "64GB", temp_directory: DUCKDB_TMP, ...options });
  return instance.connect();
}

/** A SQL string literal. */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A query's rows as plain objects. */
export async function rows<T>(conn: DuckDBConnection, sql: string): Promise<T[]> {
  return (await conn.runAndReadAll(sql)).getRowObjects() as unknown as T[];
}

type ColumnType = "VARCHAR" | "INTEGER" | "BIGINT" | "BOOLEAN" | "JSON";

/**
 * (Re)create temp table `name` with `columns` and fill it from `data`, one
 * object per row keyed by column name; null and undefined become NULL.
 */
export async function writeTable<R extends object>(
  conn: DuckDBConnection, name: string, columns: Partial<Record<keyof R & string, ColumnType>>, data: Iterable<R>,
): Promise<void> {
  const cols = Object.entries(columns) as [keyof R & string, ColumnType][];
  await conn.run(`CREATE OR REPLACE TEMP TABLE ${name} (${cols.map(([c, t]) => `${c} ${t}`).join(", ")})`);
  const ap = await conn.createAppender(name);
  for (const row of data) {
    for (const [c, t] of cols) {
      const v = row[c] as unknown;
      if (v === null || v === undefined) ap.appendNull();
      else if (t === "INTEGER") ap.appendInteger(Number(v));
      else if (t === "BIGINT") ap.appendBigInt(BigInt(v as number));
      else if (t === "BOOLEAN") ap.appendBoolean(Boolean(v));
      else ap.appendVarchar(String(v));
    }
    ap.endRow();
  }
  ap.closeSync();
}
