/**
 * Facts: the numbers a sync publishes, as plain keyed tables.
 *
 * The comparison harness diffs two syncs field by field. The old and new
 * pipelines lay their files out differently, so each layout has a loader that
 * reduces a data directory to the same set of fact tables. A fact table has a
 * varchar `key` column plus one column per published field. Two syncs agree
 * exactly when every fact table has the same keys and the same values.
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
import { COL_DOMESTIC_EXCLUDE_NAMES } from "../../../../src/config/col-described-overrides";
import { syncPath } from "../../../../src/lib/data/sync-layout";

export const FACT_KINDS = ["assessed", "ne", "groups", "nodes", "countries", "realms", "col_revisions"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export type Layout = "v1" | "v2";

/** Red List categories as they appear in summary maps; missing ones read as 0. */
const CATEGORIES = ["EX", "EW", "CR", "EN", "VU", "NT", "LC", "DD", "LR/cd", "LR/nt", "LR/lc"];

/**
 * A sync file in a data directory of either shape: grouped into folders
 * (src/lib/data/sync-layout.ts), or flat, as every sync before 2026-11-05 was.
 * Names that only old layouts had resolve flat.
 */
export function inSync(dir: string, name: string): string {
  let nested: string | null = null;
  try { nested = path.join(dir, syncPath(name)); } catch { /* not in the current layout */ }
  if (nested && fs.existsSync(nested)) return nested;
  return path.join(dir, name);
}

export function detectLayout(dir: string): Layout {
  if (fs.existsSync(inSync(dir, "assessment_link.parquet"))) return "v2";
  if (fs.existsSync(path.join(dir, "unassessed.parquet")) && fs.existsSync(path.join(dir, "species_link.parquet"))) {
    return "v1";
  }
  throw new Error(`Unrecognised data layout in ${dir}`);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * GBIF fields renamed on 2026-11-06, so a sync from before compares with one
 * from after: the old name maps to the new. The since-assessment window also
 * moved from the year after the assessment to the day after it, which the
 * reasons explain.
 */
const LEGACY_FIELDS: Record<string, string> = {
  gbif_occurrence_count: "gbif_georeferenced_records_count",
  gbif_observations_after_assessment_year: "gbif_georeferenced_records_since_assessment",
};

async function renameLegacyColumns(conn: DuckDBConnection, table: string): Promise<void> {
  const [schema, name] = table.split(".");
  const cols = new Set((await conn.runAndReadAll(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${q(schema)} AND table_name = ${q(name)}`)).getRowObjects().map((r) => String(r.column_name)));
  for (const [old, now] of Object.entries(LEGACY_FIELDS)) {
    if (cols.has(old) && !cols.has(now)) await conn.run(`ALTER TABLE ${table} RENAME COLUMN ${old} TO ${now}`);
  }
}

/** A group's GBIF totals as flat fields, from either the per-mode object or the old flat names. */
function gbifGroupFields(g: Record<string, unknown>): Record<string, unknown> {
  const { gbif, gbif_species_count, gbif_ne_species_count, total_gbif_observations, median_gbif_obs, mean_gbif_obs: _mean, ...rest } = g;
  const out: Record<string, unknown> = { ...rest };
  if (gbif && typeof gbif === "object") {
    for (const [mode, t] of Object.entries(gbif as Record<string, Record<string, unknown>>)) {
      for (const [k, v] of Object.entries(t)) out[`gbif_${mode}_${k}`] = v;
    }
  } else if (gbif_species_count !== undefined) {
    Object.assign(out, {
      gbif_georeferenced_species_count: gbif_species_count, gbif_georeferenced_ne_species_count: gbif_ne_species_count,
      gbif_georeferenced_records: total_gbif_observations, gbif_georeferenced_median: median_gbif_obs,
    });
  }
  return out;
}

/** A node's NE-with-records counts as flat fields, from either shape. */
function gbifNodeFields(n: Record<string, unknown>): Record<string, unknown> {
  const { gbifNeSpecies, gbifNeSpeciesCount, ...rest } = n;
  if (gbifNeSpecies && typeof gbifNeSpecies === "object") {
    const t = gbifNeSpecies as Record<string, number>;
    return { ...rest, gbif_ne_species_georeferenced: t.georeferenced, gbif_ne_species_all: t.all };
  }
  return gbifNeSpeciesCount === undefined ? rest : { ...rest, gbif_ne_species_georeferenced: gbifNeSpeciesCount };
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

/** The JSON summaries are the same files in both layouts. */
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

/**
 * Old layout. The NE rows mirror querySpecies' NE branch in
 * src/lib/data/species-duckdb.ts exactly (universe filter plus GBIF overlay),
 * so the facts are what the app shows, not what the files happen to contain.
 */
async function loadV1(conn: DuckDBConnection, schema: string, dir: string): Promise<void> {
  const f = (name: string) => q(inSync(dir, name));
  const link = f("species_link.parquet");

  await conn.run(`CREATE TABLE ${schema}.assessed AS
    SELECT CAST(a.id AS VARCHAR) AS key, a.* EXCLUDE (id), l.col_id AS link_col_id, l.match_method AS link_method
    FROM read_parquet(${f("assessed.parquet")}) a
    LEFT JOIN (SELECT id, col_id, match_method FROM read_parquet(${link})
               WHERE src = 'redlist' AND match_method <> 'iucn_synonym_covered') l ON l.id = a.id`);

  const domestic = COL_DOMESTIC_EXCLUDE_NAMES.map(q).join(", ");
  await conn.run(`CREATE TABLE ${schema}.ne AS
    WITH assessed_cols AS (
      SELECT DISTINCT col_id FROM read_parquet(${link}) WHERE src = 'redlist' AND col_id IS NOT NULL),
    ex_ew AS (
      SELECT DISTINCT l.col_id FROM read_parquet(${link}) l
      JOIN read_parquet(${f("assessed.parquet")}) a ON a.id = l.id
      WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND a.iucn_category IN ('EX', 'EW')),
    gbif AS (
      SELECT sl.col_id, any_value(un.gbif_species_key) AS gbif_species_key,
             max(un.gbif_occurrence_count) AS gbif_occurrence_count,
             any_value(un.countries) AS countries, any_value(un.common_name) AS common_name
      FROM read_parquet(${link}) sl JOIN read_parquet(${f("unassessed.parquet")}) un ON un.id = sl.id
      WHERE sl.src = 'gbif' AND sl.col_id IS NOT NULL GROUP BY sl.col_id)
    SELECT u.col_id AS key, u.scientific_name, u.taxon_group, u.class_name, u.order_name, u.family,
           u.described_year, g.gbif_species_key, g.gbif_occurrence_count, g.countries, g.common_name
    FROM read_parquet(${q(path.join(inSync(dir, "species"), "**", "*.parquet"))}, hive_partitioning=true) u
    LEFT JOIN gbif g ON g.col_id = u.col_id
    WHERE u.in_base
      AND (u.extinct IS NOT TRUE OR u.col_id IN (SELECT col_id FROM ex_ew))
      AND u.col_id NOT IN (SELECT col_id FROM assessed_cols)
      AND u.col_id <> '6MB3T'
      AND coalesce(lower(u.scientific_name), '') NOT IN (${domestic})`);
  await renameLegacyColumns(conn, `${schema}.assessed`);
  await renameLegacyColumns(conn, `${schema}.ne`);

  await loadSummaryFacts(conn, schema, dir);
}

/**
 * The rewrite's layout. Kinds whose files it doesn't write yet are left out,
 * so the report lists them as baseline-only rather than as every row removed.
 */
async function loadV2(conn: DuckDBConnection, schema: string, dir: string): Promise<void> {
  const f = (name: string) => q(inSync(dir, name));
  await conn.run(`CREATE TABLE ${schema}.assessed AS
    SELECT CAST(a.id AS VARCHAR) AS key, a.* EXCLUDE (id), l.col_id AS link_col_id, l.method AS link_method
    FROM read_parquet(${f("assessed.parquet")}) a
    LEFT JOIN (SELECT sis_taxon_id, col_id, method FROM read_parquet(${f("assessment_link.parquet")}) WHERE role = 'primary') l
      ON l.sis_taxon_id = a.id`);
  await renameLegacyColumns(conn, `${schema}.assessed`);
  // The NE list as the app builds it: the CoL universe minus assessed col_ids,
  // fossils (unless IUCN says EX/EW) and excluded names, with ne.parquet's overlay.
  const neCols = new Set((await conn.runAndReadAll(`SELECT name FROM parquet_schema(${f("ne.parquet")})`))
    .getRowObjects().map((r) => String(r.name)));
  const neGbif = [
    neCols.has("gbif_georeferenced_records_count") ? "g.gbif_georeferenced_records_count" : "g.gbif_occurrence_count AS gbif_georeferenced_records_count",
    ...["gbif_all_records_count", "gbif_all_records_countries"].filter((c) => neCols.has(c)).map((c) => `g.${c}`),
  ].join(", ");
  await conn.run(`CREATE TABLE ${schema}.ne AS
    WITH assessed_cols AS (
      SELECT DISTINCT col_id FROM read_parquet(${f("species_link.parquet")}) WHERE src = 'redlist' AND col_id IS NOT NULL),
    ex_ew AS (
      SELECT DISTINCT l.col_id FROM read_parquet(${f("species_link.parquet")}) l
      JOIN read_parquet(${f("assessed.parquet")}) a ON a.id = l.id
      WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND a.iucn_category IN ('EX', 'EW'))
    SELECT u.col_id AS key, u.scientific_name, u.taxon_group, u.class_name, u.order_name, u.family,
           u.described_year, g.gbif_species_key, ${neGbif}, g.countries, g.common_name
    FROM read_parquet(${q(path.join(inSync(dir, "species"), "**", "*.parquet"))}, hive_partitioning=true) u
    JOIN read_parquet(${f("taxa.parquet")}) t ON t.col_id = u.col_id
    LEFT JOIN read_parquet(${f("ne.parquet")}) g ON g.col_id = u.col_id
    WHERE u.in_base
      AND (u.extinct IS NOT TRUE OR u.col_id IN (SELECT col_id FROM ex_ew))
      AND u.col_id NOT IN (SELECT col_id FROM assessed_cols)
      AND t.ne_excluded IS NULL`);
  await loadSummaryFacts(conn, schema, dir);
  for (const kind of ["groups", "nodes", "countries", "realms", "col_revisions"]) {
    const [r] = (await conn.runAndReadAll(`SELECT count(*) AS n FROM ${schema}.${kind}`)).getRowObjects();
    if (Number(r.n) === 0) await conn.run(`DROP TABLE ${schema}.${kind}`);
  }
}

/** Load every fact table for `dir` into `schema` (created here). */
export async function loadFacts(conn: DuckDBConnection, schema: string, dir: string): Promise<Layout> {
  const layout = detectLayout(dir);
  await conn.run(`CREATE SCHEMA ${schema}`);
  if (layout === "v1") await loadV1(conn, schema, dir);
  else await loadV2(conn, schema, dir);
  return layout;
}
