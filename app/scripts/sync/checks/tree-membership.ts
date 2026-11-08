/**
 * Does tree_membership agree with the app's live filter? The summaries count a
 * tree node's species from tree_membership (dbt/models/lists/tree_membership.sql);
 * the app's live views (the country-scoped tree, drill-downs) still filter with
 * taxonomy-sql.ts. Until they read tree_membership too, the two must hold the
 * same species, node by node, or a summary and its live view disagree.
 *
 * The app's filter for a node: its own filter less what claiming siblings hold
 * (childFilterSql), or a CoL name its override holds (filterToSql with the node id).
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { NODE_INDEX, PARENT_INDEX } from "../../../src/lib/taxonomy-utils";
import { filterToSql, childFilterSql } from "../../../src/lib/taxonomy-sql";
import { COL_SPECIES_NAME_OVERRIDES } from "../../../src/config/col-described-overrides";
import { parquet, type Tables } from "../paths";
import { rows } from "../sql";

/** One line per node and kind of species where the two disagree. */
export async function treeMembershipMismatches(conn: DuckDBConnection, T: Pick<Tables, "assessed" | "species" | "treeMembership">): Promise<string[]> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE tm AS SELECT * FROM ${parquet(T.treeMembership)}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE tm_assessed AS SELECT * FROM ${parquet(T.assessed)}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE tm_species AS SELECT * FROM ${parquet(T.species)}`);
  const out: string[] = [];
  for (const [id, node] of NODE_INDEX) {
    const parentId = PARENT_INDEX.get(id);
    if (!parentId) continue;
    const siblings = NODE_INDEX.get(parentId)!.children!;
    const app = `(${childFilterSql(siblings, siblings.indexOf(node))})${COL_SPECIES_NAME_OVERRIDES[id] ? ` OR (${filterToSql(node.filter, id)})` : ""}`;
    for (const [label, table, key, col] of [["assessed", "tm_assessed", "id", "sis_taxon_id"], ["CoL", "tm_species", "col_id", "col_id"]]) {
      const [r] = await rows<{ app_only: number; table_only: number }>(conn, `
        WITH app AS (SELECT ${key} AS k FROM ${table} WHERE ${app}),
             tm AS (SELECT ${col} AS k FROM tm WHERE node_id = '${id}' AND ${col} IS NOT NULL)
        SELECT (SELECT count(*) FROM (SELECT k FROM app EXCEPT SELECT k FROM tm))::INT AS app_only,
               (SELECT count(*) FROM (SELECT k FROM tm EXCEPT SELECT k FROM app))::INT AS table_only`);
      if (r.app_only || r.table_only) out.push(`${id} (${label}): ${r.app_only} only in the app's filter, ${r.table_only} only in tree_membership`);
    }
  }
  return out;
}
