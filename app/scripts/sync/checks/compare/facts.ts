/**
 * Facts: the numbers a sync publishes, as plain keyed tables.
 *
 * The comparison diffs two syncs field by field, each reduced to the same set
 * of fact tables. A fact table has a varchar `key` column plus one column per
 * published field. Two syncs agree exactly when every fact table has the same
 * keys and the same values.
 *
 * Kinds:
 *   assessed     one row per assessed species (key: SIS taxon id)
 *   ne           one row per Not Evaluated species the app lists (key: col_id)
 *   groups        one row per Table 1a group, from taxa-summary.json
 *   nodes         one row per tree node summary (key: parentId/id)
 *   countries     one row per country, from country-stats.json
 *   realms        one row per realm, from realm-stats.json
 *   col_revisions one row per flagged species, from col-revisions.json
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { syncPath } from "../../../../src/lib/data/sync-layout";

export const FACT_KINDS = ["assessed", "ne", "groups", "nodes", "countries", "realms", "col_revisions"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** Red List categories as they appear in summary maps; missing ones read as 0. */
const CATEGORIES = ["EX", "EW", "CR", "EN", "VU", "NT", "LC", "DD", "LR/cd", "LR/nt", "LR/lc"];

/** A sync file in a data directory (src/lib/data/sync-layout.ts). */
export function inSync(dir: string, name: string): string {
  return path.join(dir, syncPath(name));
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A group's GBIF totals as flat fields, one per mode and figure. */
function gbifGroupFields(g: Record<string, unknown>): Record<string, unknown> {
  const { gbif, ...rest } = g;
  const out: Record<string, unknown> = { ...rest };
  for (const [mode, t] of Object.entries((gbif ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const [k, v] of Object.entries(t)) out[`gbif_${mode}_${k}`] = v;
  }
  return out;
}

/** A node's NE-with-records counts as flat fields. */
function gbifNodeFields(n: Record<string, unknown>): Record<string, unknown> {
  const { gbifNeSpecies, ...rest } = n;
  const t = (gbifNeSpecies ?? {}) as Record<string, number>;
  return { ...rest, gbif_ne_species_georeferenced: t.georeferenced, gbif_ne_species_all: t.all };
}

function flattenCategories(by: Record<string, number> | undefined, prefix = "cat_"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of CATEGORIES) out[prefix + c.replace("/", "_")] = 0;
  for (const [c, n] of Object.entries(by ?? {})) {
    const k = prefix + c.replace("/", "_");
    if (!(k in out)) throw new Error(`Unknown Red List category in summary: ${c}`);
    out[k] = n;
  }
  return out;
}

/** Load rows into schema.table through a temporary NDJSON file. */
async function loadRows(conn: DuckDBConnection, table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) {
    await conn.run(`CREATE TABLE ${table} (key VARCHAR)`);
    return;
  }
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "facts-")), "rows.ndjson");
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await conn.run(
    `CREATE TABLE ${table} AS SELECT * FROM read_json(${q(tmp)}, format='newline_delimited', sample_size=-1)`
  );
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}

function readJson<T>(dir: string, name: string): T | null {
  const p = inSync(dir, name);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf-8")) as T) : null;
}

async function loadSummaryFacts(conn: DuckDBConnection, schema: string, dir: string): Promise<void> {
  type GroupRow = Record<string, unknown> & { table1a_taxon_group: string; by_category?: Record<string, number> };
  const groups = readJson<GroupRow[]>(dir, "taxa-summary.json") ?? [];
  await loadRows(conn, `${schema}.groups`, groups.map((g) => {
    const { table1a_taxon_group, by_category, ...rest } = g;
    return { key: table1a_taxon_group, ...gbifGroupFields(rest), ...flattenCategories(by_category) };
  }));

  type Node = { id: string; byCategory?: Record<string, number>; colBreakdown?: unknown[] } & Record<string, unknown>;
  const nodes: Record<string, unknown>[] = [];
  for (const file of ["table1a-children-summaries.json", "ssc-group-children-summaries.json"]) {
    const m = readJson<Record<string, Node[]>>(dir, file) ?? {};
    for (const [parent, children] of Object.entries(m)) {
      for (const n of children) {
        const { id, name, byCategory, colBreakdown, ...rest } = n;
        nodes.push({
          key: `${parent}/${id}`,
          name,
          ...gbifNodeFields(rest),
          ...flattenCategories(byCategory),
          // The breakdown is a nested list; compare it as one canonical string.
          col_breakdown: colBreakdown === undefined ? null : JSON.stringify(colBreakdown),
        });
      }
    }
  }
  await loadRows(conn, `${schema}.nodes`, nodes);

  const countries = readJson<Record<string, { species: number; outdated: number }>>(dir, "country-stats.json") ?? {};
  await loadRows(conn, `${schema}.countries`, Object.entries(countries).map(([cc, v]) => ({ key: cc, ...v })));

  const realms = readJson<{ realms: { realm: string; species: number; outdated: number }[]; totalAssessed: number }>(
    dir, "realm-stats.json");
  await loadRows(conn, `${schema}.realms`, realms
    ? [...realms.realms.map(({ realm, ...v }) => ({ key: realm, ...v })),
       { key: "(all)", species: realms.totalAssessed, outdated: null }]
    : []);

  const revisions = readJson<{ species: Record<string, unknown> }>(dir, "col-revisions.json");
  await loadRows(conn, `${schema}.col_revisions`, Object.entries(revisions?.species ?? {})
    .map(([id, v]) => ({ key: id, revision: JSON.stringify(v) })));
}

/** Load every fact table for `dir` into `schema` (created here). */
export async function loadFacts(conn: DuckDBConnection, schema: string, dir: string): Promise<void> {
  const f = (name: string) => q(inSync(dir, name));
  await conn.run(`CREATE SCHEMA ${schema}`);
  await conn.run(`CREATE TABLE ${schema}.assessed AS
    SELECT CAST(a.id AS VARCHAR) AS key, a.* EXCLUDE (id), l.col_id AS link_col_id, l.method AS link_method
    FROM read_parquet(${f("assessed.parquet")}) a
    LEFT JOIN (SELECT sis_taxon_id, col_id, method FROM read_parquet(${f("assessment_link.parquet")}) WHERE role = 'primary') l
      ON l.sis_taxon_id = a.id`);
  // The NE list as the app builds it: the described species no assessed species
  // is linked to, with ne.parquet's counts. A sync from before species/ carried
  // `described` (November 2026) reads as the app then built it, so the comparison
  // shows what the column changed; drop this once production's sync has it.
  const hasDescribed = (await conn.runAndReadAll(`SELECT 1 FROM parquet_schema(${q(path.join(inSync(dir, "species"), "**", "*.parquet"))})
    WHERE name = 'described' LIMIT 1`)).getRowObjects().length > 0;
  const described = hasDescribed ? "u.described" : `u.in_base AND u.col_id <> '6MB3T' AND (u.extinct IS NOT TRUE OR u.col_id IN (
      SELECT DISTINCT l.col_id FROM read_parquet(${f("species_link.parquet")}) l JOIN read_parquet(${f("assessed.parquet")}) a ON a.id = l.id
      WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND a.iucn_category IN ('EX', 'EW')))
    AND lower(u.scientific_name) NOT IN ('bos taurus', 'bos frontalis', 'bubalus bubalis', 'canis familiaris', 'equus caballus',
      'equus asinus', 'felis catus', 'lama glama', 'sus domesticus', 'vicugna pacos')`;
  await conn.run(`CREATE TABLE ${schema}.ne AS
    WITH assessed_cols AS (
      SELECT DISTINCT col_id FROM read_parquet(${f("species_link.parquet")}) WHERE src = 'redlist' AND col_id IS NOT NULL)
    SELECT u.col_id AS key, u.scientific_name, u.taxon_group, u.class_name, u.order_name, u.family,
           u.described_year, g.gbif_species_key, g.gbif_georeferenced_records_count, g.gbif_all_records_count,
           g.gbif_all_records_countries, g.countries, g.common_name
    FROM read_parquet(${q(path.join(inSync(dir, "species"), "**", "*.parquet"))}, hive_partitioning=true) u
    LEFT JOIN read_parquet(${f("ne.parquet")}) g ON g.col_id = u.col_id
    WHERE ${described} AND u.col_id NOT IN (SELECT col_id FROM assessed_cols)`);
  await loadSummaryFacts(conn, schema, dir);
}

/** The GBIF snapshot a sync counted, from its sync.json. */
export function snapshotOf(dir: string): string | null {
  const manifest = readJson<{ gbif?: { snapshot?: string } }>(dir, "sync.json");
  return manifest?.gbif?.snapshot ?? null;
}
