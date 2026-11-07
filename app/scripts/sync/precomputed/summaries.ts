/**
 * The summary table's numbers, precomputed so the landing page and the static
 * tree need no query:
 *
 *   summaries/taxa-summary.json: one row per Table 1a group: assessed, by
 *     category, outdated, GBIF totals in both record modes, CoL described / NE.
 *   summaries/country-stats.json: per country, assessed species and outdated.
 *   summaries/table1a-children-summaries.json, ssc-group-children-summaries.json:
 *     for every static tree node with children, one summary per child, with its
 *     CoL breakdown (split on the "ssc-" id prefix: Table 1a's rows and the SSC
 *     Specialist Groups are unrelated sources).
 *
 * Every other level of the tree is answered live (live-taxa-children.ts).
 *
 * Built from: lists/assessed, lists/ne, lists/species, assessment_link,
 * taxonomy/taxa and the CoL-differences tables; the taxonomy tree
 * (src/config/taxonomy-tree.ts).
 *
 * Decisions:
 *   - Assessed species count in IUCN's group, so Table 1a stays exact; Not
 *     Evaluated species in their CoL group.
 *   - A node's species are the app's own SQL filter for it (childFilterSql in
 *     taxonomy-sql.ts), so these numbers are the ones the live views compute.
 *   - Outdated: assessed more than ten years before the sync, or undated.
 *   - "all" isn't summarised: its children mix the top-level taxa with the SSC
 *     wrappers, and nothing reads them as one list.
 *
 * Checks (warnings only): an IUCN class or order with no CoL species under its
 * name, which reads as "0% assessed" until an alias is added.
 */

import * as fs from "fs";
import { type DuckDBConnection } from "@duckdb/node-api";
import { getTaxa } from "../../lib/taxa";
import { NODE_INDEX, hasChildren } from "../../../src/lib/taxonomy-utils";
import type { TaxonomyNode } from "../../../src/config/taxonomy-tree";
import type { NodeSummary } from "../../../src/lib/data/species-store";
import { COL_SPECIES_NAME_OVERRIDES } from "../../../src/config/col-described-overrides";
import { outdatedCutoffDate } from "../../../src/lib/outdated";
import { filterToSql, childFilterSql, canonicalClassColumnSql, canonicalOrderColumnSql, type NodeFilter } from "../../../src/lib/taxonomy-sql";
import { DYNAMIC_DRILLDOWN_ROOTS, nextDynamicRank } from "../../../src/lib/dynamic-taxon";
import { computeBreakdownEntry, type BreakdownQueryContext } from "../../../src/lib/data/col-breakdown";
import type { GbifGroupTotals, GbifRecordMode } from "../../../src/lib/gbif-records";
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";
import { loadColDifferences, type ColDifferenceFiles } from "./col-differences";

export interface TaxonSummaryRow {
  table1a_taxon_group: string;
  total_assessed: number;
  outdated: number;
  by_category: Record<string, number>;
  /** GBIF totals for the group, georeferenced records only and all records. */
  gbif: Record<GbifRecordMode, GbifGroupTotals>;
  /** The group's described CoL species, and how many of them IUCN hasn't assessed. */
  col_described?: number;
  col_ne?: number;
}

const MODES: { mode: GbifRecordMode; col: string }[] = [
  { mode: "georeferenced", col: "gbif_georeferenced_records_count" },
  { mode: "all", col: "gbif_all_records_count" },
];

type Rows = Record<string, unknown>[];
const all = async (conn: DuckDBConnection, sql: string): Promise<Rows> => (await conn.runAndReadAll(sql)).getRowObjects();

export async function buildSummaries(
  inputs: ColDifferenceFiles & { assessed: string; ne: string; species: string; link: string; appTaxa: string },
  out: { taxaSummary: string; countryStats: string; table1aChildren: string; sscChildren: string },
): Promise<void> {
  const conn = await openDuckDB();
  const cutoff = outdatedCutoffDate().toISOString().slice(0, 10);
  const outdated = `(assessment_date IS NULL OR CAST(assessment_date AS DATE) <= ${lit(cutoff)}::DATE)`;
  await conn.run(`CREATE TEMP TABLE assessed AS SELECT * FROM ${parquet(inputs.assessed)}`);
  await conn.run(`CREATE TEMP TABLE ne AS SELECT * FROM ${parquet(inputs.ne)}`);
  // Species GBIF has records for, per group and key: assessed ones in their IUCN
  // group, Not Evaluated ones in their CoL group.
  await conn.run(`CREATE TEMP TABLE gbif_species AS
    SELECT taxon_group, gbif_species_key AS key, gbif_georeferenced_records_count, gbif_all_records_count, false AS ne FROM assessed
    WHERE gbif_species_key IS NOT NULL AND gbif_all_records_count > 0
    UNION ALL
    SELECT taxon_group, gbif_species_key, gbif_georeferenced_records_count, gbif_all_records_count, true FROM ne`);

  const taxaSummary = await groupSummaries(conn, inputs, outdated);
  fs.writeFileSync(output(out.taxaSummary), JSON.stringify(taxaSummary, null, 2) + "\n");
  console.log(`   ${taxaSummary.length} groups → ${out.taxaSummary}`);

  const countries: Record<string, { species: number; outdated: number }> = {};
  for (const r of await all(conn, `
    SELECT cc, count(*) AS species, count(*) FILTER (${outdated}) AS outdated
    FROM (SELECT unnest(string_split(countries, ';')) AS cc, assessment_date FROM assessed WHERE countries IS NOT NULL)
    WHERE cc <> '' GROUP BY cc ORDER BY species DESC, cc`)) {
    countries[String(r.cc)] = { species: Number(r.species), outdated: Number(r.outdated) };
  }
  fs.writeFileSync(output(out.countryStats), JSON.stringify(countries, null, 2) + "\n");
  console.log(`   ${Object.keys(countries).length} countries → ${out.countryStats}`);

  const children: Record<string, NodeSummary[]> = {};
  for (const [nodeId, node] of NODE_INDEX) {
    if (!hasChildren(nodeId) || nodeId === "all") continue;
    children[nodeId] = [];
    for (let i = 0; i < node.children!.length; i++) children[nodeId].push(await childSummary(conn, node.children!, i, outdated));
  }
  await attachColCounts(conn, children, inputs);

  const table1a: Record<string, NodeSummary[]> = {};
  const ssc: Record<string, NodeSummary[]> = {};
  for (const [nodeId, summaries] of Object.entries(children)) (nodeId.startsWith("ssc-") ? ssc : table1a)[nodeId] = summaries;
  fs.writeFileSync(output(out.table1aChildren), JSON.stringify(table1a, null, 2) + "\n");
  fs.writeFileSync(output(out.sscChildren), JSON.stringify(ssc, null, 2) + "\n");
  console.log(`   children of ${Object.keys(table1a).length} Table 1a and ${Object.keys(ssc).length} SSC nodes`);

  await warnOnAliasDrift(conn, inputs);
}

/** taxa-summary.json's rows, in Table 1a order; a group with nothing assessed is left out. */
async function groupSummaries(conn: DuckDBConnection, inputs: { species: string; link: string }, outdated: string): Promise<TaxonSummaryRow[]> {
  const byGroup = new Map<string, TaxonSummaryRow>();
  for (const r of await all(conn, `
    SELECT taxon_group, coalesce(nullif(iucn_category, ''), 'DD') AS category, count(*) AS n, count(*) FILTER (${outdated}) AS outdated
    FROM assessed GROUP BY ALL ORDER BY taxon_group, n DESC, category`)) {
    const g = String(r.taxon_group);
    const row = byGroup.get(g) ?? { table1a_taxon_group: g, total_assessed: 0, outdated: 0, by_category: {}, gbif: {} as TaxonSummaryRow["gbif"] };
    row.total_assessed += Number(r.n);
    row.outdated += Number(r.outdated);
    row.by_category[String(r.category)] = Number(r.n);
    byGroup.set(g, row);
  }
  // A species counts in a record mode only if it has a record in it.
  for (const { mode, col } of MODES) {
    for (const r of await all(conn, `
      SELECT taxon_group, count(*) AS species_count, count(*) FILTER (ne) AS ne_species_count,
             sum(${col})::BIGINT AS records, median(${col}) AS median
      FROM gbif_species WHERE ${col} > 0 GROUP BY taxon_group`)) {
      const row = byGroup.get(String(r.taxon_group));
      if (row) row.gbif[mode] = { species_count: Number(r.species_count), ne_species_count: Number(r.ne_species_count),
        records: Number(r.records), median: r.median == null ? null : Number(r.median) };
    }
  }
  // The group's described CoL species, and the ones no assessed species is linked to.
  const col = new Map((await all(conn, `
    SELECT taxon_group, count(*) FILTER (described) AS described,
           count(*) FILTER (described AND col_id NOT IN (SELECT col_id FROM ${parquet(inputs.link)} WHERE col_id IS NOT NULL)) AS ne
    FROM ${parquet(inputs.species)} GROUP BY taxon_group`)).map((r) => [String(r.taxon_group), r]));
  const rows: TaxonSummaryRow[] = [];
  for (const taxon of getTaxa()) {
    const row = byGroup.get(taxon.id);
    if (!row) continue;
    for (const { mode } of MODES) row.gbif[mode] ??= { species_count: 0, ne_species_count: 0, records: 0, median: null };
    row.col_described = Number(col.get(taxon.id)?.described ?? 0);
    row.col_ne = Number(col.get(taxon.id)?.ne ?? 0);
    rows.push(row);
  }
  return rows;
}

/** One child's summary among its siblings. */
async function childSummary(conn: DuckDBConnection, siblings: TaxonomyNode[], i: number, outdated: string): Promise<NodeSummary> {
  const node = siblings[i];
  const where = childFilterSql(siblings, i);
  const byCategory: Record<string, number> = {};
  let totalAssessed = 0, outdatedCount = 0;
  for (const r of await all(conn, `
    SELECT iucn_category AS category, count(*) AS n, count(*) FILTER (${outdated}) AS outdated
    FROM assessed WHERE ${where} GROUP BY ALL ORDER BY n DESC, category`)) {
    totalAssessed += Number(r.n);
    outdatedCount += Number(r.outdated);
    if (r.category) byCategory[String(r.category)] = Number(r.n);
  }
  const [ne] = await all(conn, `
    SELECT count(*) FILTER (gbif_georeferenced_records_count > 0) AS georeferenced, count(*) FILTER (gbif_all_records_count > 0) AS "all"
    FROM ne WHERE ${where}`);
  return {
    id: node.id, name: node.name, estimatedDescribed: node.estimatedDescribed ?? 0,
    totalAssessed, outdated: outdatedCount,
    gbifNeSpecies: { georeferenced: Number(ne.georeferenced), all: Number(ne.all) },
    byCategory,
  };
}

/** The include field that enumerates a node's species: the tree sets at most one (taxonomy-tree.test.ts). */
function primaryDimension(filter: NodeFilter): { field: keyof NodeFilter; names: string[] } | null {
  if (filter.classNames?.length) return { field: "classNames", names: filter.classNames };
  if (filter.orderNames?.length) return { field: "orderNames", names: filter.orderNames };
  if (filter.families?.length) return { field: "families", names: filter.families };
  if (filter.genera?.length) return { field: "genera", names: filter.genera };
  if (filter.speciesNames?.length) return { field: "speciesNames", names: filter.speciesNames };
  return null;
}

/**
 * Each child's CoL counts (described, and not linked to any assessment), and a
 * breakdown of them per name of its primary dimension (Pinniped SG: Otariidae,
 * Phocidae, Odobenidae), each the node's own filter narrowed to that one name,
 * so the entries sum to the node's count. A catch-all node defined only by
 * exclusions ("Other Mammals") gets one entry for its whole filter, so it too
 * has a species list and a "No 1:1 CoL Match" bucket.
 */
async function attachColCounts(
  conn: DuckDBConnection, summaries: Record<string, NodeSummary[]>,
  inputs: ColDifferenceFiles & { assessed: string; species: string; link: string; appTaxa: string },
): Promise<void> {
  await loadColDifferences(conn, inputs);
  const speciesGlob = `${inputs.species}/**/*.parquet`;
  const ctx: BreakdownQueryContext = {
    conn, speciesGlob, assessedPath: inputs.assessed, linkPath: inputs.link,
    assessedCidsTable: "assessed_cids", hasTaxa: true, taxaPath: inputs.appTaxa,
  };
  for (const children of Object.values(summaries)) {
    for (const child of children) {
      const node = NODE_INDEX.get(child.id);
      if (!node) continue;
      const [r] = await all(conn, `
        SELECT count(*) FILTER (described) AS col_described,
               count(*) FILTER (described AND col_id NOT IN (SELECT col_id FROM assessed_cids)) AS col_ne
        FROM ${parquet(inputs.species)} WHERE ${filterToSql(node.filter, node.id)}`);
      child.colDescribed = Number(r.col_described);
      child.colNe = Number(r.col_ne);

      const dim = COL_SPECIES_NAME_OVERRIDES[node.id] ? null : primaryDimension(node.filter);
      const f = node.filter;
      const exclusionsOnly = !dim && Boolean(f.excludeOrders?.length || f.excludeClasses?.length || f.excludeFamilies?.length
        || f.excludeGenera?.length || f.excludeSpeciesNames?.length);
      if (!dim && !exclusionsOnly) continue;
      const breakdown = [];
      for (const name of dim ? dim.names : [node.name]) {
        const narrowed: NodeFilter = dim ? { ...f, [dim.field]: [name] } : f;
        breakdown.push(await computeBreakdownEntry(ctx, name, narrowed, node.id, f));
      }
      child.colBreakdown = breakdown;
    }
  }
}

/**
 * Warn about an IUCN class or order with no CoL species under its name once
 * aliased: each alias in taxonomy-sql.ts (Cetacea/Artiodactyla,
 * Maxillopoda/Copepoda, …) was found by someone noticing a "0% assessed" row.
 * Only where a live bucket would show it: order for every live-drillable group,
 * class for those that group by class first.
 */
async function warnOnAliasDrift(conn: DuckDBConnection, inputs: { species: string }): Promise<void> {
  const liveTaxa = getTaxa().filter((t) => DYNAMIC_DRILLDOWN_ROOTS.has(t.id));
  const dimensions = [
    { label: "class", col: canonicalClassColumnSql("class_name"), taxa: liveTaxa.filter((t) => nextDynamicRank(t.id) === "class") },
    { label: "order", col: canonicalOrderColumnSql("order_name", "scientific_name"), taxa: liveTaxa },
  ];
  let found = false;
  for (const { label, col, taxa } of dimensions) {
    for (const taxon of taxa) {
      for (const row of await all(conn, `
        WITH iucn AS (SELECT ${col} AS v, count(*) AS n FROM assessed WHERE taxon_group = ${lit(taxon.id)} GROUP BY v),
             col_side AS (SELECT DISTINCT ${col} AS v FROM ${parquet(inputs.species)} WHERE taxon_group = ${lit(taxon.id)} AND in_base)
        SELECT v AS value, n FROM iucn WHERE v != '' AND v NOT IN (SELECT v FROM col_side) ORDER BY n DESC`)) {
        found = true;
        console.warn(`   ⚠ ${taxon.id}: IUCN ${label} "${row.value}" (${row.n} assessed) has no CoL species — check COL_${label.toUpperCase()}_ALIASES in taxonomy-sql.ts`);
      }
    }
  }
  if (!found) console.log("   no IUCN class or order without CoL species");
}
