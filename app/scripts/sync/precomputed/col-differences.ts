/**
 * The CoL-differences card's tables, loaded for the builders that query them
 * with the app's own code (summaries.ts, col-revisions.ts). The tables are dbt
 * models (dbt/models/precomputed/col_split_candidates.sql, col_synonym_assessed.sql,
 * col_to_assessed.sql); the app loads the files exactly as this does.
 */
import { type DuckDBConnection } from "@duckdb/node-api";
import { parquet } from "../paths";

export interface ColDifferenceFiles { splitCandidates: string; synonymAssessed: string; colToAssessed: string }

/** The tables as temp tables of the names col-breakdown.ts queries, plus assessed_cids. */
export async function loadColDifferences(conn: DuckDBConnection, files: ColDifferenceFiles & { link: string }): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE assessed_cids AS SELECT DISTINCT col_id FROM ${parquet(files.link)} WHERE col_id IS NOT NULL`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE split_candidates AS SELECT * FROM ${parquet(files.splitCandidates)}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE synonym_assessed AS SELECT * FROM ${parquet(files.synonymAssessed)}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE col_to_assessed AS SELECT * FROM ${parquet(files.colToAssessed)}`);
}
