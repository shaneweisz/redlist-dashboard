/**
 * The CoL-differences card's tables, precomputed because each is a full scan
 * and self-join of taxa (8M rows) that the app's live breakdown would otherwise
 * redo after every cold start. The queries are the app's own
 * (src/lib/data/col-breakdown.ts), and the app loads the files exactly as
 * loadColDifferences does here.
 *
 * Built from: taxonomy/taxa, lists/assessed, assessment_link.
 *
 *   taxonomy/col-split-candidates: one row per Not Evaluated species CoL likely
 *     split from an assessed one (an infraspecific name, now a synonym, that
 *     resolves to it). ne_col_id, parent_id, parent_name, parent_category, rn
 *     (1 for the likeliest parent).
 *   taxonomy/col-synonym-assessed: one row per Not Evaluated species that an
 *     assessed species names as its synonym. ne_col_id, assessed_id,
 *     assessed_name, assessed_category.
 *   taxonomy/col-to-assessed: one row per CoL species and assessed species linked
 *     to it. col_id, assessed_id, assessed_name.
 *
 * Decisions: a split is a heuristic (CoL keeps the old infraspecific name as a
 * synonym when it promotes one), so the card words it as likely, never as fact.
 */
import { type DuckDBConnection } from "@duckdb/node-api";
import { SPLIT_CANDIDATES_SQL, SYNONYM_ASSESSED_SQL, COL_TO_ASSESSED_SQL } from "../../../src/lib/data/col-breakdown";
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

export interface ColDifferenceFiles { splitCandidates: string; synonymAssessed: string; colToAssessed: string }

/** Every col_id an assessed species is linked to, by any row, as the temp table assessed_cids. */
async function loadAssessedColIds(conn: DuckDBConnection, link: string): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE assessed_cids AS SELECT DISTINCT col_id FROM ${parquet(link)} WHERE col_id IS NOT NULL`);
}

export async function buildColDifferences(inputs: { appTaxa: string; assessed: string; link: string }, out: ColDifferenceFiles): Promise<void> {
  const conn = await openDuckDB();
  await loadAssessedColIds(conn, inputs.link);
  await conn.run(SPLIT_CANDIDATES_SQL(inputs.appTaxa, inputs.assessed, "assessed_cids"));
  await conn.run(SYNONYM_ASSESSED_SQL(inputs.appTaxa, inputs.assessed, "assessed_cids"));
  await conn.run(COL_TO_ASSESSED_SQL(inputs.link, inputs.assessed));
  await conn.run(`COPY split_candidates TO ${lit(output(out.splitCandidates))} (FORMAT PARQUET)`);
  await conn.run(`COPY synonym_assessed TO ${lit(output(out.synonymAssessed))} (FORMAT PARQUET)`);
  await conn.run(`COPY col_to_assessed TO ${lit(output(out.colToAssessed))} (FORMAT PARQUET)`);
}

/** The tables as temp tables of the names col-breakdown.ts queries, plus assessed_cids. */
export async function loadColDifferences(conn: DuckDBConnection, files: ColDifferenceFiles & { link: string }): Promise<void> {
  await loadAssessedColIds(conn, files.link);
  await conn.run(`CREATE OR REPLACE TEMP TABLE split_candidates AS SELECT * FROM ${parquet(files.splitCandidates)}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE synonym_assessed AS SELECT * FROM ${parquet(files.synonymAssessed)}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE col_to_assessed AS SELECT * FROM ${parquet(files.colToAssessed)}`);
}
