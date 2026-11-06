/**
 * build-taxa-summary: the summary table's numbers, from the read models.
 *
 *   summaries/taxa-summary.json                 per Table 1a group: assessed, by
 *                                               category, outdated, GBIF totals in
 *                                               both modes, CoL described / NE
 *   summaries/country-stats.json                the same across all species,
 *                                               per country
 *   summaries/table1a-children-summaries.json   the static tree's children: the
 *   summaries/ssc-group-children-summaries.json Table 1a rows and the SSC groups,
 *                                               with each node's CoL breakdown
 *   taxonomy/col-split-candidates, col-synonym-assessed, col-to-assessed.parquet
 *                                               the CoL-differences helper tables
 *                                               the app's live breakdown loads
 *
 * Every other level of the tree is answered live (live-taxa-children.ts).
 *
 * Usage:  npx tsx scripts/sync/outputs/build-taxa-summary.ts
 */

import * as fs from "fs";
import * as path from "path";
import { type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR } from "../../lib/utils";
import { getTaxa } from "../../lib/taxa";
import { NODE_INDEX, hasChildren, matchesFilter } from "../../../src/lib/taxonomy-utils";
import type { TaxonomyNode } from "../../../src/config/taxonomy-tree";
import type { NodeSummary } from "../../../src/lib/data/species-store";
import {
  COL_SPECIES_NAME_OVERRIDES,
} from "../../../src/config/col-described-overrides";
import { isOutdated } from "../../../src/lib/outdated";
import { filterToSql, canonicalClassColumnSql, canonicalOrderColumnSql, type NodeFilter } from "../../../src/lib/taxonomy-sql";
import { DYNAMIC_DRILLDOWN_ROOTS, nextDynamicRank } from "../../../src/lib/dynamic-taxon";
import {
  computeBreakdownEntry,
  SPLIT_CANDIDATES_SQL,
  SYNONYM_ASSESSED_SQL,
  COL_TO_ASSESSED_SQL,
  type BreakdownQueryContext,
} from "../../../src/lib/data/col-breakdown";
import { syncPath } from "../../../src/lib/data/sync-layout";
import { requireFiles } from "../paths";
import type { GbifGroupTotals, GbifRecordMode } from "../../../src/lib/gbif-records";
import { openDuckDB } from "../sql";

export interface TaxonSummaryRow {
  table1a_taxon_group: string;
  total_assessed: number;
  outdated: number;
  by_category: Record<string, number>;
  /** GBIF totals for the group, georeferenced records only and all records. */
  gbif: Record<GbifRecordMode, GbifGroupTotals>;
  // The group's extant accepted CoL species (col_described) and how many of them
  // IUCN hasn't assessed (col_ne = described minus assessed, by col_id).
  col_described?: number;
  col_ne?: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Per-taxon_group CoL counts: col_described = the described species (species/'s
// `described`, defined once in build-read-models); col_ne = those IUCN hasn't
// assessed. species/ is partitioned by taxon_group, so this is one grouped scan.
async function colCountsByGroup(conn: DuckDBConnection, dataDir: string): Promise<Map<string, { col_described: number; col_ne: number }>> {
  const out = new Map<string, { col_described: number; col_ne: number }>();
  const link = path.join(dataDir, syncPath("assessment_link.parquet"));
  const speciesGlob = path.join(dataDir, syncPath("species"), "**", "*.parquet");
  const rows = await (await conn.run(`
    SELECT taxon_group,
           count(*) FILTER (described) AS col_described,
           count(*) FILTER (described AND col_id NOT IN (
             SELECT col_id FROM read_parquet('${link}') WHERE col_id IS NOT NULL
           )) AS col_ne
    FROM read_parquet('${speciesGlob}', hive_partitioning=true)
    GROUP BY taxon_group`)).getRowObjects();
  for (const r of rows) out.set(String(r.taxon_group), { col_described: Number(r.col_described), col_ne: Number(r.col_ne) });
  return out;
}

type PrimaryDim = { field: keyof NodeFilter; rank: string; names: string[] };

// Whichever include field enumerates this node's species is its "primary dimension"
// — the tree never sets more than one of these on a node (verified by
// taxonomy-tree.test.ts), so picking the first non-empty one is unambiguous.
function primaryDimension(filter: NodeFilter): PrimaryDim | null {
  if (filter.classNames?.length) return { field: "classNames", rank: "class", names: filter.classNames };
  if (filter.orderNames?.length) return { field: "orderNames", rank: "order", names: filter.orderNames };
  if (filter.families?.length) return { field: "families", rank: "family", names: filter.families };
  if (filter.genera?.length) return { field: "genera", rank: "genus", names: filter.genera };
  if (filter.speciesNames?.length) return { field: "speciesNames", rank: "species", names: filter.speciesNames };
  return null;
}

// Attach CoL counts (colDescribed / colNe) to every node-children summary — same
// universe + assessed-by-col_id logic as the per-group counts, filtered per node so
// sub-groups (e.g. mammals → rodents) get real numbers instead of "—". Also attaches
// a per-name breakdown of colDescribed for nodes whose primary dimension enumerates
// more than one name (e.g. Pinniped SG: Otariidae/Phocidae/Odobenidae) — each count
// re-runs filterToSql narrowed to that one name (keeping every other clause, so a
// domestic-form exclusion or an overlapping node's excludeGenera still applies),
// which is why the entries sum to exactly colDescribed.
async function attachColCounts(conn: DuckDBConnection, summaries: Record<string, NodeSummary[]>, dataDir: string): Promise<void> {
  const link = path.join(dataDir, syncPath("assessment_link.parquet"));
  const assessedPath = path.join(dataDir, syncPath("assessed.parquet"));
  const speciesGlob = path.join(dataDir, syncPath("species"), "**", "*.parquet");
  const taxaPath = path.join(dataDir, syncPath("taxa.parquet"));
  await conn.run(
    `CREATE OR REPLACE TEMP TABLE assessed_cids AS SELECT DISTINCT col_id FROM read_parquet('${link}') WHERE col_id IS NOT NULL`
  );
  await conn.run(SPLIT_CANDIDATES_SQL(taxaPath, assessedPath, "assessed_cids"));
  await conn.run(SYNONYM_ASSESSED_SQL(taxaPath, assessedPath, "assessed_cids"));
  await conn.run(COL_TO_ASSESSED_SQL(link, assessedPath));
  // Published as small parquets: they depend only on the sync, but building them
  // is a full scan and self-join of taxa.parquet (8M rows), which the app's live
  // breakdown (live-breakdown.ts) would otherwise redo after every cold start.
  const splitCandidatesOut = path.join(dataDir, syncPath("col-split-candidates.parquet"));
  const synonymAssessedOut = path.join(dataDir, syncPath("col-synonym-assessed.parquet"));
  const colToAssessedOut = path.join(dataDir, syncPath("col-to-assessed.parquet"));
  await conn.run(`COPY split_candidates TO '${splitCandidatesOut}' (FORMAT PARQUET)`);
  await conn.run(`COPY synonym_assessed TO '${synonymAssessedOut}' (FORMAT PARQUET)`);
  await conn.run(`COPY col_to_assessed TO '${colToAssessedOut}' (FORMAT PARQUET)`);
  console.log(`  CoL match helpers: ${splitCandidatesOut}, ${synonymAssessedOut}, ${colToAssessedOut}`);
  const breakdownCtx: BreakdownQueryContext = {
    conn, speciesGlob, assessedPath, linkPath: link,
    assessedCidsTable: "assessed_cids", hasTaxa: true, taxaPath,
  };
  let n = 0;
  let breakdownQueries = 0;
  for (const children of Object.values(summaries)) {
    for (const child of children) {
      const node = NODE_INDEX.get(child.id);
      if (!node) continue;
      const rows = await (await conn.run(`
        SELECT count(*) FILTER (described) AS col_described,
               count(*) FILTER (described AND col_id NOT IN (SELECT col_id FROM assessed_cids)) AS col_ne
        FROM read_parquet('${speciesGlob}', hive_partitioning=true)
        WHERE ${filterToSql(node.filter, node.id)}`)).getRowObjects();
      child.colDescribed = Number(rows[0].col_described);
      child.colNe = Number(rows[0].col_ne);
      n++;

      const dim = COL_SPECIES_NAME_OVERRIDES[node.id] ? null : primaryDimension(node.filter);
      // A catch-all/remainder node (e.g. "Other Mammals", any "No/Other SSC Group")
      // has no positive dimension to enumerate — its filter is defined entirely by
      // excludeOrders/excludeClasses/excludeGenera/excludeFamilies/excludeSpeciesNames
      // instead. Without a fallback, primaryDimension returns null and the whole
      // per-name breakdown block below is skipped, leaving these nodes with no
      // colBreakdown at all — the frontend then has no click-through species list or
      // "No 1:1 CoL Match" bucket for them, unlike every named node (bug report,
      // 2026-07-20: "Other Mammals" — a real one-species remainder like Perissodactyla
      // gets a bucket, this doesn't). Fixed by computing exactly one bucket for the
      // node's own full (unnarrowed) filter, labeled with its own name, whenever
      // there's no positive dimension but at least one exclude* clause is present.
      const isExcludeOnlyCatchAll =
        !dim &&
        Boolean(
          node.filter.excludeOrders?.length ||
            node.filter.excludeClasses?.length ||
            node.filter.excludeFamilies?.length ||
            node.filter.excludeGenera?.length ||
            node.filter.excludeSpeciesNames?.length,
        );
      if (dim || isExcludeOnlyCatchAll) {
        const bucketNames = dim ? dim.names : [node.name];
        const breakdown = [];
        for (const name of bucketNames) {
          const narrowed: NodeFilter = dim ? { ...node.filter, [dim.field]: [name] } : node.filter;
          breakdown.push(await computeBreakdownEntry(breakdownCtx, name, narrowed, node.id, node.filter));
          breakdownQueries++;
        }
        child.colBreakdown = breakdown;
      }
    }
  }
  console.log(`  CoL node counts: attached to ${n} node summaries (${breakdownQueries} per-name breakdown queries).`);
}


/** An assessed species as the summaries need it. */
interface AssessedRow {
  sis_taxon_id: number; scientific_name: string; class_name: string | null; order_name: string | null; family: string | null;
  category: string; assessment_date: string | null; countries: string[];
}
/** A species GBIF has records for, as the summaries need it. */
interface GbifRow { scientific_name: string; class_name: string | null; order_name: string | null; family: string | null; counts: Record<GbifRecordMode, number> }

/**
 * Per Table 1a group: its assessed species (by IUCN's group), and the species
 * GBIF has records for (assessed ones in their IUCN group, NE ones in their CoL
 * group, from ne.parquet). "Linked" keys are the assessed species' GBIF keys.
 */
async function loadGroups(conn: DuckDBConnection, dataDir: string): Promise<{ redlist: Map<string, AssessedRow[]>; gbif: Map<string, Map<string, GbifRow>>; linked: Set<string> }> {
  const assessed = (await conn.runAndReadAll(`
    SELECT id, taxon_group, scientific_name, class_name, order_name, family, iucn_category, assessment_date,
           countries, gbif_species_key, gbif_georeferenced_records_count, gbif_all_records_count
    FROM read_parquet('${path.join(dataDir, syncPath("assessed.parquet"))}')`)).getRowObjects();
  const ne = (await conn.runAndReadAll(`
    SELECT taxon_group, scientific_name, class_name, order_name, family, gbif_species_key, gbif_georeferenced_records_count, gbif_all_records_count
    FROM read_parquet('${path.join(dataDir, syncPath("ne.parquet"))}') WHERE gbif_all_records_count > 0`)).getRowObjects();
  const redlist = new Map<string, AssessedRow[]>();
  const gbif = new Map<string, Map<string, GbifRow>>();
  const linked = new Set<string>();
  const str = (v: unknown) => (v == null ? null : String(v));
  const split = (v: unknown) => (v ? String(v).split(";").filter(Boolean) : []);
  const addGbif = (g: string, key: string, r: Record<string, unknown>) => {
    const m = gbif.get(g) ?? new Map<string, GbifRow>();
    gbif.set(g, m);
    m.set(key, { scientific_name: String(r.scientific_name), class_name: str(r.class_name), order_name: str(r.order_name),
      family: str(r.family),
      counts: { georeferenced: Number(r.gbif_georeferenced_records_count ?? 0), all: Number(r.gbif_all_records_count ?? 0) } });
  };
  for (const r of assessed) {
    const g = String(r.taxon_group);
    const list = redlist.get(g) ?? [];
    redlist.set(g, list);
    list.push({ sis_taxon_id: Number(r.id), scientific_name: String(r.scientific_name), class_name: str(r.class_name), order_name: str(r.order_name),
      family: str(r.family), category: String(r.iucn_category ?? ""), assessment_date: str(r.assessment_date),
      countries: split(r.countries) });
    if (r.gbif_species_key != null) {
      linked.add(String(r.gbif_species_key));
      if (Number(r.gbif_all_records_count) > 0) addGbif(g, String(r.gbif_species_key), r);
    }
  }
  for (const r of ne) addGbif(String(r.taxon_group), String(r.gbif_species_key), r);
  return { redlist, gbif, linked };
}

export async function run(opts: { dataDir?: string } = {}): Promise<void> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  requireFiles("build-taxa-summary", ...["species", "assessment_link.parquet", "assessed.parquet", "ne.parquet", "taxa.parquet"]
    .map((f) => path.join(dataDir, syncPath(f))));
  const conn = await openDuckDB();
  const groups = await loadGroups(conn, dataDir);
  const summaries: TaxonSummaryRow[] = [];

  // Per-country totals across ALL species (unfiltered by taxon) — feeds the
  // country-view landing page's world map. Deliberately a single precomputed
  // aggregate, not one file per country: unlike the per-taxon node summaries
  // below (which must compose with an arbitrary taxon/subgroup selection, hence
  // live DuckDB queries — see country-taxa-summary-duckdb.ts), the landing map
  // is always "all species" scope, so this never needs to vary per request.
  const countryStats = new Map<string, { total_assessed: number; outdated: number }>();

  const linkedGbifKeys = groups.linked;

  for (const taxon of getTaxa()) {
    if (!groups.redlist.has(taxon.id)) {
      console.log(`  Skipping ${taxon.id} — no assessed species`);
      continue;
    }

    const redlistSpecies = groups.redlist.get(taxon.id)!;

    const totalAssessed = redlistSpecies.length;
    let outdated = 0;
    const byCategory: Record<string, number> = {};

    for (const s of redlistSpecies) {
      const speciesOutdated = isOutdated(s.assessment_date);

      // Count outdated
      if (speciesOutdated) {
        outdated++;
      }

      // Count by category
      const cat = s.category || "DD";
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      // Per-country tally (see countryStats declaration above)
      for (const cc of s.countries) {
        const entry = countryStats.get(cc) ?? { total_assessed: 0, outdated: 0 };
        entry.total_assessed++;
        if (speciesOutdated) entry.outdated++;
        countryStats.set(cc, entry);
      }
    }

    // GBIF stats, once per record mode. A species counts in a mode only if it
    // has a record in it, so the georeferenced species count is the smaller.
    const gbifMap = groups.gbif.get(taxon.id) ?? new Map<string, GbifRow>();
    const gbifTotals = (mode: GbifRecordMode): GbifGroupTotals => {
      const t: GbifGroupTotals = { species_count: 0, ne_species_count: 0, records: 0, median: null };
      const counts: number[] = [];
      for (const [key, g] of gbifMap) {
        const n = g.counts[mode];
        if (n <= 0) continue;
        t.species_count++;
        t.records += n;
        counts.push(n);
        // NE = GBIF species not linked to any redlist entry
        if (!linkedGbifKeys.has(key)) t.ne_species_count++;
      }
      t.median = median(counts);
      return t;
    };
    const gbif = { georeferenced: gbifTotals("georeferenced"), all: gbifTotals("all") };

    summaries.push({
      table1a_taxon_group: taxon.id,
      total_assessed: totalAssessed,
      outdated,
      by_category: byCategory,
      gbif,
    });

    console.log(`  ${taxon.id}: ${totalAssessed} assessed, ${gbif.georeferenced.ne_species_count} unassessed, ${outdated} outdated, ` +
      `${gbif.georeferenced.species_count} GBIF species (${gbif.all.species_count} with any record)`);
  }

  // Catalogue of Life per-group counts: extant universe (col_described) and the
  // not-evaluated slice (col_ne = universe minus assessed col_ids). species/ is
  // partitioned by taxon_group, so this is one grouped scan. 0s if CoL not built yet.
  const colCounts = await colCountsByGroup(conn, dataDir);
  for (const s of summaries) {
    const c = colCounts.get(s.table1a_taxon_group);
    s.col_described = c?.col_described ?? 0;
    s.col_ne = c?.col_ne ?? 0;
  }

  const outputPath = path.join(dataDir, syncPath("taxa-summary.json"));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(summaries, null, 2) + "\n");
  console.log(`\nWrote ${summaries.length} taxa → ${outputPath}`);

  const countryStatsObj: Record<string, { species: number; outdated: number }> = {};
  for (const [cc, stats] of countryStats) {
    countryStatsObj[cc] = { species: stats.total_assessed, outdated: stats.outdated };
  }
  const countryStatsOutputPath = path.join(dataDir, syncPath("country-stats.json"));
  fs.writeFileSync(countryStatsOutputPath, JSON.stringify(countryStatsObj, null, 2) + "\n");
  console.log(`Wrote ${countryStats.size} countries → ${countryStatsOutputPath}`);

  // ─── Second pass: precompute node children summaries ──────────────
  console.log("\nComputing node children summaries...");

  const redlistByGroup = groups.redlist;
  const gbifByGroup = groups.gbif;

  /** An NE species counts in each mode it has a record in. */
  const countNe = (t: Record<GbifRecordMode, number>, g: GbifRow) => {
    if (g.counts.georeferenced > 0) t.georeferenced++;
    if (g.counts.all > 0) t.all++;
  };

  function computeNodeSummary(node: TaxonomyNode): NodeSummary {
    const filter = node.filter;
    let totalAssessed = 0;
    let outdatedCount = 0;
    const gbifNeSpecies = { georeferenced: 0, all: 0 };
    const byCategory: Record<string, number> = {};

    for (const group of filter.taxonGroups) {
      const rows = redlistByGroup.get(group) ?? [];
      for (const row of rows) {
        if (!matchesFilter(row, filter)) continue;
        totalAssessed++;
        if (isOutdated(row.assessment_date)) outdatedCount++;
        const cat = row.category;
        if (cat) byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      }

      const gbifMap = gbifByGroup.get(group);
      if (gbifMap) {
        for (const [key, gbifRow] of gbifMap) {
          if (linkedGbifKeys.has(key)) continue;
          if (!matchesFilter(gbifRow, filter)) continue;
          countNe(gbifNeSpecies, gbifRow);
        }
      }
    }

    return {
      id: node.id,
      name: node.name,
      estimatedDescribed: node.estimatedDescribed ?? 0,
      totalAssessed,
      outdated: outdatedCount,
      gbifNeSpecies,
      byCategory,
    };
  }

  function computeChildrenSummaries(parentNode: TaxonomyNode): NodeSummary[] {
    const children = parentNode.children!;

    // Check if we need claim tracking (for catch-all nodes with excludeClasses)
    const needsClaimTracking = children.some(c =>
      c.filter.excludeClasses && c.filter.excludeClasses.length > 0
    );

    if (!needsClaimTracking) {
      return children.map(child => computeNodeSummary(child));
    }

    // Complex case: track claimed rows for catch-all nodes
    const claimedRowIds = new Set<number>();
    const claimedGbifKeys = new Set<string>();
    const results: NodeSummary[] = [];

    const nonCatchAll = children.filter(c =>
      !c.filter.excludeClasses || c.filter.excludeClasses.length === 0
    );
    const catchAll = children.filter(c =>
      c.filter.excludeClasses && c.filter.excludeClasses.length > 0
    );

    for (const child of nonCatchAll) {
      const summary = computeNodeSummary(child);
      results.push(summary);

      if (child.filter.classNames || child.filter.orderNames) {
        for (const group of child.filter.taxonGroups) {
          const rows = redlistByGroup.get(group) ?? [];
          for (const row of rows) {
            if (matchesFilter(row, child.filter)) {
              claimedRowIds.add(row.sis_taxon_id);
            }
          }
          const gbifMap = gbifByGroup.get(group);
          if (gbifMap) {
            for (const [key, gbifRow] of gbifMap) {
              if (!linkedGbifKeys.has(key) && matchesFilter(gbifRow, child.filter)) {
                claimedGbifKeys.add(key);
              }
            }
          }
        }
      }
    }

    for (const child of catchAll) {
      let totalAssessed = 0;
      let outdatedCount = 0;
      const gbifNeSpecies = { georeferenced: 0, all: 0 };
      const byCategory: Record<string, number> = {};

      for (const group of child.filter.taxonGroups) {
        const rows = redlistByGroup.get(group) ?? [];
        for (const row of rows) {
          if (!matchesFilter(row, child.filter)) continue;
          if (claimedRowIds.has(row.sis_taxon_id)) continue;
          totalAssessed++;
          if (isOutdated(row.assessment_date)) outdatedCount++;
          const cat = row.category;
          if (cat) byCategory[cat] = (byCategory[cat] ?? 0) + 1;
        }

        const gbifMap = gbifByGroup.get(group);
        if (gbifMap) {
          for (const [key, gbifRow] of gbifMap) {
            if (linkedGbifKeys.has(key)) continue;
            if (!matchesFilter(gbifRow, child.filter)) continue;
            if (claimedGbifKeys.has(key)) continue;
            countNe(gbifNeSpecies, gbifRow);
          }
        }
      }

      results.push({
        id: child.id,
        name: child.name,
        estimatedDescribed: child.estimatedDescribed ?? 0,
        totalAssessed,
        outdated: outdatedCount,
        gbifNeSpecies,
        byCategory,
      });
    }

    return results;
  }

  const nodeChildrenSummaries: Record<string, NodeSummary[]> = {};
  let childCount = 0;

  for (const [nodeId, node] of NODE_INDEX) {
    if (!hasChildren(nodeId)) continue;
    // "all" is a special case: its tree children mix the 8 real top-level taxa
    // with the SSC wrapper ids (ssc-groups, ssc-fish-groups, ...), which stay
    // nested under "all" purely so NODE_INDEX/getAncestors can resolve them
    // (see VIEW_ROOT_OVERRIDES in taxonomy-utils.ts) — not because "all" has
    // a real UI that shows its own children list. The landing page and Table
    // 1a mode both get their row lists from TAXONOMY_VIEWS instead (explicit
    // id lists with no "all" or "ssc-*" entries), and "all" is never
    // expandable in the UI, so nothing ever reads getPrecomputedChildrenSummaries("all").
    // Skipping it here avoids baking those SSC rollup duplicates into the
    // output for no consumer.
    if (nodeId === "all") continue;
    const childSummaries = computeChildrenSummaries(node);
    nodeChildrenSummaries[nodeId] = childSummaries;
    childCount += childSummaries.length;
    console.log(`  ${nodeId}: ${childSummaries.length} children`);
  }

  await attachColCounts(conn, nodeChildrenSummaries, dataDir);

  // Two files, split on the "ssc-" id prefix (as TaxaSummary.tsx's SSC_SECTIONS
  // does): Table 1a's rows and the SSC Specialist Groups are unrelated sources.
  const table1aChildrenSummaries: Record<string, NodeSummary[]> = {};
  const sscGroupChildrenSummaries: Record<string, NodeSummary[]> = {};
  for (const [nodeId, summaries] of Object.entries(nodeChildrenSummaries)) {
    (nodeId.startsWith("ssc-") ? sscGroupChildrenSummaries : table1aChildrenSummaries)[nodeId] = summaries;
  }

  const table1aOutputPath = path.join(dataDir, syncPath("table1a-children-summaries.json"));
  fs.writeFileSync(table1aOutputPath, JSON.stringify(table1aChildrenSummaries, null, 2) + "\n");
  console.log(`\nWrote ${Object.keys(table1aChildrenSummaries).length} Table 1a parents → ${table1aOutputPath}`);

  const sscOutputPath = path.join(dataDir, syncPath("ssc-group-children-summaries.json"));
  fs.writeFileSync(sscOutputPath, JSON.stringify(sscGroupChildrenSummaries, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(sscGroupChildrenSummaries).length} SSC group parents (${childCount} total children across both files) → ${sscOutputPath}`);

  console.log("\nChecking for new IUCN/CoL class-order alias drift...");
  await checkTaxonomyAliasDrift(conn, dataDir);
}

// Warns (does not fail the sync) about any IUCN class/order value with zero
// matching CoL rows after canonical aliasing — the exact failure mode behind
// every alias fixed in this PR (Cetacea/Artiodactyla, Struthioniformes,
// Pinales, Maxillopoda/Hexanauplia→Copepoda, Theocostraca→Thecostraca,
// Nemertea→Hoplonemertea): each was found by a human noticing an implausible
// percentage and then manually querying assessed.parquet vs. species/ by
// hand. This automates that same query across every taxon group on every
// sync, so the next CoL taxonomy shift gets caught here rather than waiting
// for someone to spot a "0% assessed" row again. Deliberately just a console
// warning — a real mismatch here doesn't corrupt any data (a live bucket just
// reads oddly until someone adds the alias to COL_CLASS_ALIASES/
// COL_ORDER_ALIASES in taxonomy-sql.ts), so it shouldn't block a sync the way
// a thrown error would.
//
// Scoped to only what could actually show up as a misleading live bucket —
// order for every DYNAMIC_DRILLDOWN_ROOTS group (order is somewhere in all
// of their rank chains, first or second), class only for the ones that group
// by class at all (nextDynamicRank(id) === "class" on a bare root, i.e. the
// class-first roots — see dynamic-taxon.ts's ROOT_RANK_ORDER). Checking every
// taxon/rank combination regardless of relevance (e.g. Gymnosperms' class,
// which nothing ever groups by) was tried first and buried the few real,
// actionable mismatches under ~50 lines of noise nobody would keep reading.
async function checkTaxonomyAliasDrift(conn: DuckDBConnection, dataDir: string): Promise<void> {
  const speciesGlob = path.join(dataDir, syncPath("species"), "**", "*.parquet");
  const assessedPath = path.join(dataDir, syncPath("assessed.parquet"));
  const liveTaxa = getTaxa().filter((t) => DYNAMIC_DRILLDOWN_ROOTS.has(t.id));
  const dimensions: { label: "class" | "order"; col: string; taxa: ReturnType<typeof getTaxa> }[] = [
    { label: "class", col: canonicalClassColumnSql("class_name"), taxa: liveTaxa.filter((t) => nextDynamicRank(t.id) === "class") },
    { label: "order", col: canonicalOrderColumnSql("order_name", "scientific_name"), taxa: liveTaxa },
  ];
  let driftFound = false;
  for (const { label, col, taxa } of dimensions) {
    for (const taxon of taxa) {
      const rows = await (await conn.run(`
        WITH iucn AS (
          SELECT ${col} AS v, count(*) AS n FROM read_parquet('${assessedPath}')
          WHERE taxon_group = '${taxon.id}' GROUP BY v
        ),
        col_side AS (
          SELECT DISTINCT ${col} AS v FROM read_parquet('${speciesGlob}', hive_partitioning=true)
          WHERE taxon_group = '${taxon.id}' AND in_base
        )
        SELECT iucn.v AS value, iucn.n AS assessed_count FROM iucn
        WHERE iucn.v != '' AND iucn.v NOT IN (SELECT v FROM col_side)
        ORDER BY iucn.n DESC`)).getRowObjects();
      for (const row of rows) {
        driftFound = true;
        console.warn(`  ⚠ ${taxon.id}: IUCN ${label} "${row.value}" (${row.assessed_count} assessed) has zero matching CoL rows — check COL_${label.toUpperCase()}_ALIASES in taxonomy-sql.ts`);
      }
    }
  }
  if (!driftFound) console.log("  None found.");
}

async function main() {
  loadEnvFiles();

  await run();
}

const isDirectRun = process.argv[1]?.endsWith("outputs/build-taxa-summary.ts") || process.argv[1]?.endsWith("outputs/build-taxa-summary.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
