/**
 * Which SSC Specialist Groups a species is in, for tests of the remits in
 * taxonomy-tree.ts, decided by the sync's own model (specialist_group_species,
 * scripts/sync/dbt/models/lists/) rather than a copy of its rules: the remits are
 * written out as the sync writes them, dbt compiles the model once, and each call
 * runs that SQL over the rows given, as assessed species.
 *
 * Needs uv (dbt runs through it), as the count/lists tests do.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildSpecialistGroups } from "../../../../scripts/sync/sources/specialist-groups";
import { compileDbtModel } from "../../../../scripts/sync/dbt";
import { tables } from "../../../../scripts/sync/paths";
import { isSpecialistGroup, speciesMatchesNode } from "@/lib/taxonomy-utils";

export interface SpeciesRow {
  taxon_group: string;
  class_name: string | null;
  order_name: string | null;
  family?: string | null;
  scientific_name?: string | null;
}

let setup: Promise<{ conn: DuckDBConnection; sql: string; assessments: string }> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ready() {
  setup ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specialist-groups-"));
    const T = tables(dir);
    await buildSpecialistGroups({ remits: T.specialistGroupRemits, rankAliases: T.rankAliases });
    const sql = compileDbtModel("specialist_group_species", dir);
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    // The model reads CoL species from taxa too; the rows here are all assessed.
    await conn.run(`COPY (SELECT NULL::VARCHAR AS col_id, NULL::VARCHAR AS taxon_group, NULL::VARCHAR AS class_name,
        NULL::VARCHAR AS order_name, NULL::VARCHAR AS family, NULL::VARCHAR AS scientific_name,
        NULL::VARCHAR AS rank, NULL::VARCHAR AS status, NULL::BOOLEAN AS demoted WHERE false) TO '${T.taxa}' (FORMAT parquet)`);
    return { conn, sql, assessments: T.assessments };
  })();
  return setup;
}

const lit = (v: string | null | undefined) => (v == null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

/** The Specialist Groups each row is in (at most one each, when the remits are right). */
export function groupsOf(rows: SpeciesRow[]): Promise<string[][]> {
  // One at a time: each call rewrites the file the compiled SQL reads.
  const run = queue.then(async () => {
    const { conn, sql, assessments } = await ready();
    if (rows.length === 0) return [];
    const values = rows.map((r, i) => `(${i + 1}, ${lit(r.taxon_group)}, ${lit(r.class_name)}, ${lit(r.order_name)}, ${lit(r.family)}, ${lit(r.scientific_name)})`);
    await conn.run(`COPY (SELECT *, true AS is_latest FROM (VALUES ${values.join(", ")})
        t(sis_taxon_id, taxon_group, class_name, order_name, family, scientific_name)) TO '${assessments}' (FORMAT parquet)`);
    const out: string[][] = rows.map(() => []);
    for (const r of (await conn.runAndReadAll(sql)).getRowObjects()) out[Number(r.sis_taxon_id) - 1].push(String(r.group_id));
    for (const g of out) g.sort();
    return out;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Is the row in this node: a Specialist Group by the model, any other node as the app decides. */
export async function holds(row: SpeciesRow, nodeId: string): Promise<boolean> {
  if (!isSpecialistGroup(nodeId)) return speciesMatchesNode(row, nodeId);
  return (await groupsOf([row]))[0].includes(nodeId);
}
