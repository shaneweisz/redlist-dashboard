/**
 * build-taxa-summary: Compute per-taxon summary stats → taxa-summary.json
 *                     + table1a-children-summaries.json / ssc-group-children-
 *                     summaries.json for instant drill-down
 *
 * Reads per-taxon redlist and GBIF CSVs, computes summary statistics, and
 * writes to data/taxa-summary.json plus the two remaining static-tree
 * children-summary files — the only parent nodes left in the tree after the
 * ordinary-subgroup drilldown moved to live DuckDB queries (live-taxa-
 * children.ts) are the Table 1a official rows and the SSC Specialist Groups
 * subtree, so the single old node-children-summaries.json is split in two
 * along that same line (id.startsWith("ssc-")) rather than kept as one file
 * mixing two conceptually distinct, separately-versioned data sources.
 *
 * Usage:
 *   npx tsx scripts/build-taxa-summary.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR, REDLIST_DIR, GBIF_DIR } from "./utils";
import { allTaxaUnchecked } from "./taxa";
import { readRedlistCsv } from "./fetch-redlist-species";
import { readGbifCsv } from "./fetch-gbif-species";
import { readMappingCsv } from "./match-redlist-species-to-gbif";
import { EXCLUDED_DOMESTICATED_GBIF_KEYS } from "../src/lib/data/taxonomy-constants";
import { NODE_INDEX, hasChildren, matchesFilter } from "../src/lib/taxonomy-utils";
import type { TaxonomyNode } from "../src/config/taxonomy-tree";
import type { NodeSummary } from "../src/lib/data/species-store";
import {
  COL_SPECIES_NAME_OVERRIDES,
  COL_DOMESTIC_EXCLUDE_NAMES,
} from "../src/config/col-described-overrides";
import { isOutdated } from "../src/lib/outdated";
import { filterToSql, sqlStrList, canonicalClassColumnSql, canonicalOrderColumnSql, type NodeFilter } from "../src/lib/taxonomy-sql";
import { DYNAMIC_DRILLDOWN_ROOTS, nextDynamicRank } from "../src/lib/dynamic-taxon";
import {
  computeBreakdownEntry,
  SPLIT_CANDIDATES_SQL,
  SYNONYM_ASSESSED_SQL,
  COL_TO_ASSESSED_SQL,
  backboneHasChecklistColumns,
  type BreakdownQueryContext,
} from "../src/lib/data/col-breakdown";

// CoL species kept out of the universe (like the domesticated-GBIF exclusion). Homo sapiens
// — IUCN omits humans from its Red List export. Keep in sync with species-duckdb.ts.
const EXCLUDED_COL_IDS_SQL = `('6MB3T')`; // Homo sapiens

export interface TaxonSummaryRow {
  table1a_taxon_group: string;
  total_assessed: number;
  outdated: number;
  by_category: Record<string, number>;
  gbif_species_count: number;
  gbif_ne_species_count: number;
  total_gbif_observations: number;
  mean_gbif_obs: number;
  median_gbif_obs: number | null;
  // Catalogue of Life backbone (#271): the extant accepted-species universe in this
  // group (col_described) and how many of those IUCN hasn't evaluated (col_ne =
  // universe minus assessed, by col_id). Filled after the per-taxon loop; 0 if the
  // CoL artifacts aren't present.
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

// A species CoL flags extinct still counts toward "described" if IUCN's OWN linked
// assessment agrees it's extinct (category EX/EW) — matching IUCN's Red List
// Guidelines (taxa extinct before 1500 CE are out of scope entirely; CoL gives us no
// extinction date, so "IUCN has confirmed EX/EW" is the closest available signal).
// Deliberately NOT "any IUCN assessment exists for this col_id": species_link matches
// by name/synonym, not taxonomic concept, so a CoL-extinct species can link to a
// STALE assessment of an unrelated or since-split taxon with a non-EX category (e.g.
// several CoL-extinct-flagged names matched to Least-Concern Columba species during
// verification) — requiring the category itself be EX/EW is what makes this safe.
// Species newly included this way are, by construction, always already-assessed
// (that's the join condition), so they can never also appear in col_ne — expanding
// this set only ever grows col_described, it never mislabels something "Not
// Evaluated" that's actually a long-extinct, never-assessed fossil.
async function createExEwAssessedTable(conn: DuckDBConnection, link: string, assessed: string, tableName: string): Promise<void> {
  await conn.run(`
    CREATE TEMP TABLE ${tableName} AS
      SELECT DISTINCT l.col_id
      FROM read_parquet('${link}') l
      JOIN read_parquet('${assessed}') a ON a.id = l.id
      WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND a.iucn_category IN ('EX', 'EW')`);
}

// "Extant, or CoL-extinct but IUCN-confirmed EX/EW" — see createExEwAssessedTable.
function extantUniverseSql(exEwTable: string): string {
  return `(extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ${exEwTable}))`;
}

// Per-taxon_group CoL counts from the backbone artifacts: col_described = extant
// accepted universe; col_ne = that minus the col_ids IUCN has assessed. species/ is
// partitioned by taxon_group, so this is a single grouped scan. Returns empty (→ 0s)
// when the CoL artifacts aren't present (e.g. a sync that hasn't built them yet).
async function colCountsByGroup(): Promise<Map<string, { col_described: number; col_ne: number }>> {
  const out = new Map<string, { col_described: number; col_ne: number }>();
  const link = path.join(DATA_DIR, "species_link.parquet");
  const assessedPath = path.join(DATA_DIR, "assessed.parquet");
  const speciesGlob = path.join(DATA_DIR, "species", "**", "*.parquet");
  if (!fs.existsSync(path.join(DATA_DIR, "species")) || !fs.existsSync(link)) {
    console.log("  CoL counts: species/ or species_link.parquet missing — skipping (col_described/col_ne = 0)");
    return out;
  }
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await createExEwAssessedTable(conn, link, assessedPath, "ex_ew_assessed");
  const universe = extantUniverseSql("ex_ew_assessed");
  // Same domestic-form exclusion every SSC group's own CoL count already applies (see
  // filterToSql/COL_DOMESTIC_EXCLUDE_NAMES below) — without it, this per-taxon_group
  // total (used for the top-level "Mammals" row etc.) counts a domestic form alongside
  // its wild sibling species, diverging from the sum of that taxon's SSC group rows.
  // Deliberately COL_DOMESTIC_EXCLUDE_NAMES here, not the wider COL_EXCLUDE_ALL_NODES —
  // the extra bison-name overrides in that list exist only to stop sibling SSC nodes
  // (Bison SG vs. Asian Wild Cattle SG) double-counting each other, which doesn't apply
  // to this flat, single-group scan; excluding them here would just undercount bison.
  const notDomestic = `coalesce(lower(scientific_name), '') NOT IN (${sqlStrList(COL_DOMESTIC_EXCLUDE_NAMES)})`;
  const rows = await (await conn.run(`
    SELECT taxon_group,
           count(*) FILTER (in_base AND ${universe} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL} AND ${notDomestic}) AS col_described,
           count(*) FILTER (in_base AND ${universe} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL} AND ${notDomestic} AND col_id NOT IN (
             SELECT col_id FROM read_parquet('${link}') WHERE src = 'redlist' AND col_id IS NOT NULL
           )) AS col_ne
    FROM read_parquet('${speciesGlob}', hive_partitioning=true)
    GROUP BY taxon_group`)).getRowObjects();
  for (const r of rows) out.set(String(r.taxon_group), { col_described: Number(r.col_described), col_ne: Number(r.col_ne) });
  return out;
}

// filterToSql/sqlStrList now live in src/lib/taxonomy-sql.ts (imported above) — shared
// with the live per-country query path (src/lib/data/country-taxa-summary-duckdb.ts).

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

// NoMatchDetail/SplitDetail/classifyNoMatch/SPLIT_CANDIDATES_SQL/
// COL_TO_ASSESSED_SQL/computeBreakdownEntry now live in
// ../src/lib/data/col-breakdown.ts (imported above), shared with
// live-taxa-children.ts's request-time equivalent for dynamic taxonomic-drilldown
// nodes — see that file's doc comment for why.

// Attach CoL counts (colDescribed / colNe) to every node-children summary — same
// universe + assessed-by-col_id logic as the per-group counts, filtered per node so
// sub-groups (e.g. mammals → rodents) get real numbers instead of "—". Also attaches
// a per-name breakdown of colDescribed for nodes whose primary dimension enumerates
// more than one name (e.g. Pinniped SG: Otariidae/Phocidae/Odobenidae) — each count
// re-runs filterToSql narrowed to that one name (keeping every other clause, so a
// domestic-form exclusion or an overlapping node's excludeGenera still applies),
// which is why the entries sum to exactly colDescribed.
async function attachColCounts(summaries: Record<string, NodeSummary[]>): Promise<void> {
  const link = path.join(DATA_DIR, "species_link.parquet");
  const assessedPath = path.join(DATA_DIR, "assessed.parquet");
  const speciesGlob = path.join(DATA_DIR, "species", "**", "*.parquet");
  const backbonePath = path.join(DATA_DIR, "backbone.parquet");
  if (!fs.existsSync(path.join(DATA_DIR, "species")) || !fs.existsSync(link)) {
    console.log("  CoL node counts: species/ or species_link.parquet missing — skipping.");
    return;
  }
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(
    `CREATE TEMP TABLE assessed_cids AS SELECT DISTINCT col_id FROM read_parquet('${link}') WHERE src = 'redlist' AND col_id IS NOT NULL`
  );
  await createExEwAssessedTable(conn, link, assessedPath, "ex_ew_assessed");
  const universe = extantUniverseSql("ex_ew_assessed");
  const hasBackbone = fs.existsSync(backbonePath);
  if (hasBackbone) {
    await conn.run(SPLIT_CANDIDATES_SQL(backbonePath, assessedPath, "assessed_cids"));
    await conn.run(SYNONYM_ASSESSED_SQL(backbonePath, assessedPath, "assessed_cids"));
    await conn.run(COL_TO_ASSESSED_SQL(link, assessedPath));
    // Dump both to small precomputed parquet files — they're fully determined by
    // this data sync (never by which taxon/bucket a user is viewing), but building
    // them requires a full scan + self-join over backbone.parquet (8M rows,
    // ~125MB). live-breakdown.ts's ensureBackboneHelpers used to redo that same
    // scan+join from scratch on the first breakdown request after every cold
    // server start; loading these tiny files instead (~6K / ~173K rows) is
    // effectively instant. See that file's fallback if these are ever missing.
    const splitCandidatesOut = path.join(DATA_DIR, "col-split-candidates.parquet");
    const synonymAssessedOut = path.join(DATA_DIR, "col-synonym-assessed.parquet");
    const colToAssessedOut = path.join(DATA_DIR, "col-to-assessed.parquet");
    await conn.run(`COPY split_candidates TO '${splitCandidatesOut}' (FORMAT PARQUET)`);
    await conn.run(`COPY synonym_assessed TO '${synonymAssessedOut}' (FORMAT PARQUET)`);
    await conn.run(`COPY col_to_assessed TO '${colToAssessedOut}' (FORMAT PARQUET)`);
    console.log(`  CoL match helpers: ${splitCandidatesOut}, ${synonymAssessedOut}, ${colToAssessedOut}`);
  }
  const breakdownCtx: BreakdownQueryContext = {
    conn, speciesGlob, assessedPath, linkPath: link,
    universeSql: universe, assessedCidsTable: "assessed_cids",
    excludedColIdsSql: EXCLUDED_COL_IDS_SQL, hasBackbone, backbonePath,
    // See BreakdownQueryContext.hasChecklistColumns: the sync rebuilds a backbone
    // that lacks these, so this is true for every real build — probed anyway so a
    // hand-run against an older data dir degrades instead of throwing.
    hasChecklistColumns: hasBackbone && (await backboneHasChecklistColumns(conn, backbonePath)),
  };
  let n = 0;
  let breakdownQueries = 0;
  for (const children of Object.values(summaries)) {
    for (const child of children) {
      const node = NODE_INDEX.get(child.id);
      if (!node) continue;
      const rows = await (await conn.run(`
        SELECT count(*) FILTER (in_base AND ${universe} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL}) AS col_described,
               count(*) FILTER (in_base AND ${universe} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL} AND col_id NOT IN (SELECT col_id FROM assessed_cids)) AS col_ne
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
          breakdown.push(await computeBreakdownEntry(breakdownCtx, name, narrowed, node.id));
          breakdownQueries++;
        }
        child.colBreakdown = breakdown;
      }
    }
  }
  console.log(`  CoL node counts: attached to ${n} node summaries (${breakdownQueries} per-name breakdown queries).`);
}

export async function run(): Promise<void> {
  const summaries: TaxonSummaryRow[] = [];

  // Per-country totals across ALL species (unfiltered by taxon) — feeds the
  // country-view landing page's world map. Deliberately a single precomputed
  // aggregate, not one file per country: unlike the per-taxon node summaries
  // below (which must compose with an arbitrary taxon/subgroup selection, hence
  // live DuckDB queries — see country-taxa-summary-duckdb.ts), the landing map
  // is always "all species" scope, so this never needs to vary per request.
  const countryStats = new Map<string, { total_assessed: number; outdated: number }>();

  // Load mapping to determine which GBIF species are linked to redlist entries
  const mapping = readMappingCsv();
  const linkedGbifKeys = new Set<string>();
  for (const links of mapping.values()) {
    for (const link of links) {
      if (link.gbif_species_key != null) linkedGbifKeys.add(link.gbif_species_key);
    }
  }

  for (const taxon of allTaxaUnchecked()) {
    const redlistPath = path.join(REDLIST_DIR, `${taxon.id}.csv`);
    const gbifPath = path.join(GBIF_DIR, `${taxon.id}.csv`);

    if (!fs.existsSync(redlistPath)) {
      console.log(`  Skipping ${taxon.id} — no redlist CSV`);
      continue;
    }

    const redlistSpecies = readRedlistCsv(taxon.id);

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

    // GBIF stats
    let gbifSpeciesCount = 0;
    let gbifNeSpeciesCount = 0;
    let totalGbifObservations = 0;
    const obsCounts: number[] = [];

    if (fs.existsSync(gbifPath)) {
      const gbifMap = readGbifCsv(taxon.id);
      gbifSpeciesCount = gbifMap.size;
      for (const [key, g] of gbifMap) {
        totalGbifObservations += g.total_count;
        obsCounts.push(g.total_count);
        // NE = GBIF species not linked to any redlist entry
        if (!linkedGbifKeys.has(key)) gbifNeSpeciesCount++;
      }
    }

    const meanGbifObs = gbifSpeciesCount > 0
      ? totalGbifObservations / gbifSpeciesCount
      : 0;

    summaries.push({
      table1a_taxon_group: taxon.id,
      total_assessed: totalAssessed,
      outdated,
      by_category: byCategory,
      gbif_species_count: gbifSpeciesCount,
      gbif_ne_species_count: gbifNeSpeciesCount,
      total_gbif_observations: totalGbifObservations,
      mean_gbif_obs: meanGbifObs,
      median_gbif_obs: median(obsCounts),
    });

    console.log(`  ${taxon.id}: ${totalAssessed} assessed, ${gbifNeSpeciesCount} unassessed, ${outdated} outdated, ${gbifSpeciesCount} GBIF species`);
  }

  // Catalogue of Life per-group counts: extant universe (col_described) and the
  // not-evaluated slice (col_ne = universe minus assessed col_ids). species/ is
  // partitioned by taxon_group, so this is one grouped scan. 0s if CoL not built yet.
  const colCounts = await colCountsByGroup();
  for (const s of summaries) {
    const c = colCounts.get(s.table1a_taxon_group);
    s.col_described = c?.col_described ?? 0;
    s.col_ne = c?.col_ne ?? 0;
  }

  const outputPath = path.join(DATA_DIR, "taxa-summary.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(summaries, null, 2) + "\n");
  console.log(`\nWrote ${summaries.length} taxa → ${outputPath}`);

  const countryStatsObj: Record<string, { species: number; outdated: number }> = {};
  for (const [cc, stats] of countryStats) {
    countryStatsObj[cc] = { species: stats.total_assessed, outdated: stats.outdated };
  }
  const countryStatsOutputPath = path.join(DATA_DIR, "country-stats.json");
  fs.writeFileSync(countryStatsOutputPath, JSON.stringify(countryStatsObj, null, 2) + "\n");
  console.log(`Wrote ${countryStats.size} countries → ${countryStatsOutputPath}`);

  // ─── Second pass: precompute node children summaries ──────────────
  console.log("\nComputing node children summaries...");

  // Build caches for CSV data (reusing what readRedlistCsv/readGbifCsv load)
  const redlistByGroup = new Map<string, ReturnType<typeof readRedlistCsv>>();
  const gbifByGroup = new Map<string, ReturnType<typeof readGbifCsv>>();
  for (const taxon of allTaxaUnchecked()) {
    if (fs.existsSync(path.join(REDLIST_DIR, `${taxon.id}.csv`))) {
      redlistByGroup.set(taxon.id, readRedlistCsv(taxon.id));
    }
    if (fs.existsSync(path.join(GBIF_DIR, `${taxon.id}.csv`))) {
      gbifByGroup.set(taxon.id, readGbifCsv(taxon.id));
    }
  }

  // Must match EXCLUDED_DOMESTICATED_GBIF_KEYS in species-store.ts
  // Was a hand-copied duplicate of the same list, carrying a comment asking that
  // the two be kept in step; imported now so they cannot drift.
  const excludedDomesticatedGbifKeys = EXCLUDED_DOMESTICATED_GBIF_KEYS;

  function computeNodeSummary(node: TaxonomyNode): NodeSummary {
    const filter = node.filter;
    let totalAssessed = 0;
    let outdatedCount = 0;
    let gbifNeSpeciesCount = 0;
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
          if (excludedDomesticatedGbifKeys.has(key)) continue;
          if (!matchesFilter(gbifRow, filter)) continue;
          gbifNeSpeciesCount++;
        }
      }
    }

    return {
      id: node.id,
      name: node.name,
      estimatedDescribed: node.estimatedDescribed ?? 0,
      totalAssessed,
      outdated: outdatedCount,
      gbifNeSpeciesCount,
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
              if (!linkedGbifKeys.has(key) && !excludedDomesticatedGbifKeys.has(key) && matchesFilter(gbifRow, child.filter)) {
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
      let gbifNeSpeciesCount = 0;
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
            if (excludedDomesticatedGbifKeys.has(key)) continue;
            if (!matchesFilter(gbifRow, child.filter)) continue;
            if (claimedGbifKeys.has(key)) continue;
            gbifNeSpeciesCount++;
          }
        }
      }

      results.push({
        id: child.id,
        name: child.name,
        estimatedDescribed: child.estimatedDescribed ?? 0,
        totalAssessed,
        outdated: outdatedCount,
        gbifNeSpeciesCount,
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

  await attachColCounts(nodeChildrenSummaries);

  // Split along the same "ssc-" id prefix TaxaSummary.tsx's SSC_SECTIONS
  // already uses to distinguish SSC breadcrumbs — Table 1a's official rows
  // and the SSC Specialist Groups subtree are two unrelated data sources
  // (citation-sourced counts vs. curated organizational units) that happened
  // to share one file only because both were leftovers of the same static
  // tree the ordinary-subgroup drilldown used to live in.
  const table1aChildrenSummaries: Record<string, NodeSummary[]> = {};
  const sscGroupChildrenSummaries: Record<string, NodeSummary[]> = {};
  for (const [nodeId, summaries] of Object.entries(nodeChildrenSummaries)) {
    (nodeId.startsWith("ssc-") ? sscGroupChildrenSummaries : table1aChildrenSummaries)[nodeId] = summaries;
  }

  const table1aOutputPath = path.join(DATA_DIR, "table1a-children-summaries.json");
  fs.writeFileSync(table1aOutputPath, JSON.stringify(table1aChildrenSummaries, null, 2) + "\n");
  console.log(`\nWrote ${Object.keys(table1aChildrenSummaries).length} Table 1a parents → ${table1aOutputPath}`);

  const sscOutputPath = path.join(DATA_DIR, "ssc-group-children-summaries.json");
  fs.writeFileSync(sscOutputPath, JSON.stringify(sscGroupChildrenSummaries, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(sscGroupChildrenSummaries).length} SSC group parents (${childCount} total children across both files) → ${sscOutputPath}`);

  console.log("\nChecking for new IUCN/CoL class-order alias drift...");
  await checkTaxonomyAliasDrift();
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
async function checkTaxonomyAliasDrift(): Promise<void> {
  const speciesGlob = path.join(DATA_DIR, "species", "**", "*.parquet");
  const assessedPath = path.join(DATA_DIR, "assessed.parquet");
  if (!fs.existsSync(path.join(DATA_DIR, "species")) || !fs.existsSync(assessedPath)) {
    console.log("  Skipping — species/ or assessed.parquet missing.");
    return;
  }
  const liveTaxa = allTaxaUnchecked().filter((t) => DYNAMIC_DRILLDOWN_ROOTS.has(t.id));
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const dimensions: { label: "class" | "order"; col: string; taxa: ReturnType<typeof allTaxaUnchecked> }[] = [
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

  console.log("build-taxa-summary: per-taxon CSVs → taxa-summary.json");
  console.log("=".repeat(50));

  await run();
}

const isDirectRun = process.argv[1]?.endsWith("build-taxa-summary.ts") || process.argv[1]?.endsWith("build-taxa-summary.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
