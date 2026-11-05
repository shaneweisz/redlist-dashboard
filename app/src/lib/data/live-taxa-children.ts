/**
 * Live, arbitrary-depth taxonomic drilldown — the dynamic replacement for the
 * hand-curated ordinary-subgroup tree (Mammals -> Rodents/Bats/... etc.), which
 * this retires (see plan: node-children-summaries.json's ordinary-subgroup
 * entries become dead once this ships, deleted from taxonomy-tree.ts in a later
 * phase once both this and the country-scoped path are ported).
 *
 * Enumerates real taxonomic children (order -> family -> genus) via ONE grouped
 * DuckDB scan per level, not one query per candidate child — unlike
 * scoped-taxa-summary-duckdb.ts's getCountryChildrenSummaries, which can afford
 * a per-child loop only because it iterates a KNOWN list of <=12 static
 * children; a live "family under order" or "genus under family" enumeration can
 * have 50-300+ distinct values, so looping per-value would be 50-300 round trips.
 *
 * Deliberately omits the no-match diagnostic breakdown (colBreakdown /
 * noMatchDetails / splitDetails) that scripts/sync/outputs/build-taxa-summary.ts's
 * attachColCounts computes for the static tree — that machinery depends on
 * backbone.parquet-joined temp tables built once per whole build run, not cheap
 * per (rank,value) on demand. A later phase adds it back as a separate, lazy,
 * per-bucket-click endpoint. estimatedDescribed/gbifNeSpeciesCount are 0 here,
 * mirroring the existing country-scoped live path's precedent of zeroing fields
 * with no valid live value yet, rather than omitting them (NodeSummary requires
 * numbers).
 */
import { getConn, parquetUri, ensureNeHelpers } from "./species-duckdb";
import { outdatedSql } from "./scoped-taxa-summary-duckdb";
import { ensureVernacularNamesLoaded } from "./vernacular-names";
import { NODE_INDEX } from "@/lib/taxonomy-utils";
import { filterToSql, canonicalOrderColumnSql, canonicalClassColumnSql } from "@/lib/taxonomy-sql";
import { outdatedCutoffDate } from "@/lib/outdated";
import { getDataSyncDate } from "@/lib/data-sync-date";
import type { NodeSummary } from "./species-store";
import {
  isDynamicNodeId,
  parseDynamicNodeId,
  buildDynamicNodeId,
  dynamicNodeFilter,
  dynamicNodeDisplayName,
  type DynamicRank,
} from "@/lib/dynamic-taxon";

// Keep in sync with the same constant in scripts/sync/outputs/build-taxa-summary.ts and
// species-duckdb.ts — Homo sapiens, which IUCN omits from its Red List export.
export const EXCLUDED_COL_IDS_SQL = `('6MB3T')`;

// Mirrors filterToSql's own column derivation exactly (taxonomy-sql.ts) — genus
// is always derived from scientific_name, never a raw `genus` column, so a
// species' bucket here is guaranteed consistent with how matchesFilter/
// filterToSql would independently classify that same species into a filter.
// order_name and class_name are additionally canonicalized (canonicalOrderColumnSql/
// canonicalClassColumnSql) so known CoL-only splits (e.g. Cetacea, which IUCN
// already files under Artiodactyla; or Teleostei/Elasmobranchii/etc., which CoL
// uses in place of IUCN's coarser Actinopterygii/Chondrichthyes) fold into the
// one real-world order/class both datasets otherwise agree on, instead of
// surfacing as their own misleading "0% assessed" buckets.
export const RANK_COLUMN_SQL: Record<DynamicRank, string> = {
  class: canonicalClassColumnSql("class_name"),
  order: canonicalOrderColumnSql("order_name", "scientific_name"),
  family: "coalesce(lower(family), '')",
  genus: "coalesce(lower(split_part(scientific_name, ' ', 1)), '')",
};

// A value can appear in colByValue's GROUP BY (at least one raw CoL row has
// it) yet still carry colDescribed=0 once the in_base/universe/exclusion
// FILTERs zero it out (e.g. Reptiles' blank order_name: 202 raw rows, but
// 201 are non-accepted synonyms/extinct-unconfirmed and the 1 real one gets
// reclassified away by canonicalOrderColumnSql's species override — see
// taxonomy-sql.ts). col_ne can never exceed col_described (its FILTER is a
// strict superset), so colDescribed===0 alone is a safe "nothing real here"
// check. Skip these entirely rather than showing an empty "Unclassified X:
// 0 described, 0 assessed" row with nothing to click into. Extracted to its
// own function (rather than left inline) so this bucket-hiding rule — easy to
// get backwards (hiding a real bucket, or showing an empty one) and previously
// untested — has a direct unit test.
export function isEmptyLiveBucket(totalAssessed: number, colDescribed: number | undefined): boolean {
  return totalAssessed === 0 && (colDescribed ?? 0) === 0;
}

/**
 * Enumerate the live children of `parentId` at `nextRank`. `parentId` is either
 * a real static root (e.g. "mammals") or a dynamic id (e.g.
 * "mammals~order:rodentia"). `extraWhere` (used by the Country view port) is
 * ANDed into the assessed-side query only — CoL/GBIF have no country dimension,
 * so colDescribed/colNe are skipped entirely when set (matching
 * getCountryChildrenSummaries' existing precedent of omitting those fields for
 * country-scoped requests).
 */
export async function getLiveRankChildren(
  parentId: string,
  nextRank: DynamicRank,
  extraWhere?: string,
): Promise<NodeSummary[]> {
  const parentFilter = isDynamicNodeId(parentId) ? dynamicNodeFilter(parentId) : NODE_INDEX.get(parentId)?.filter;
  if (!parentFilter) return [];

  ensureVernacularNamesLoaded();
  const conn = await getConn();
  const cutoff = outdatedCutoffDate(getDataSyncDate()).toISOString().slice(0, 10);
  const assessedUri = parquetUri("assessed.parquet");
  const parentWhere = filterToSql(parentFilter);
  const rankCol = RANK_COLUMN_SQL[nextRank];
  const extra = extraWhere ? ` AND (${extraWhere})` : "";

  interface Acc { totalAssessed: number; outdated: number; byCategory: Record<string, number>; }
  const byValue = new Map<string, Acc>();
  const assessedRows = (await conn.runAndReadAll(
    `SELECT ${rankCol} AS v, iucn_category AS category, count(*) AS n,
            sum(CASE WHEN ${outdatedSql(cutoff)} THEN 1 ELSE 0 END) AS n_outdated
     FROM read_parquet('${assessedUri}')
     WHERE (${parentWhere})${extra}
     GROUP BY v, category`
  )).getRowObjects();
  for (const r of assessedRows) {
    const v = String(r.v);
    const acc = byValue.get(v) ?? { totalAssessed: 0, outdated: 0, byCategory: {} };
    const n = Number(r.n);
    acc.totalAssessed += n;
    acc.outdated += Number(r.n_outdated);
    const cat = (r.category as string) || "DD";
    acc.byCategory[cat] = (acc.byCategory[cat] ?? 0) + n;
    byValue.set(v, acc);
  }

  const colByValue = new Map<string, { colDescribed: number; colNe: number }>();
  if (!extraWhere) {
    await ensureNeHelpers(conn);
    const speciesGlob = parquetUri("species/**/*.parquet");
    const universe = `(extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ne_ex_ew_col_ids))`;
    const colRows = (await conn.runAndReadAll(
      `SELECT ${rankCol} AS v,
              count(*) FILTER (in_base AND ${universe} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL}) AS col_described,
              count(*) FILTER (in_base AND ${universe} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL} AND col_id NOT IN (SELECT col_id FROM ne_assessed_col_ids)) AS col_ne
       FROM read_parquet('${speciesGlob}', hive_partitioning=true)
       WHERE (${parentWhere})
       GROUP BY v`
    )).getRowObjects();
    for (const r of colRows) {
      colByValue.set(String(r.v), { colDescribed: Number(r.col_described), colNe: Number(r.col_ne) });
    }
  }

  const parsed = isDynamicNodeId(parentId) ? parseDynamicNodeId(parentId) : null;
  const rootId = parsed ? parsed.rootId : parentId;
  const parentSegments = parsed ? parsed.segments : [];

  const out: NodeSummary[] = [];
  for (const value of new Set([...byValue.keys(), ...colByValue.keys()])) {
    const acc = byValue.get(value) ?? { totalAssessed: 0, outdated: 0, byCategory: {} };
    const col = colByValue.get(value);
    if (isEmptyLiveBucket(acc.totalAssessed, col?.colDescribed)) continue;
    const childId = buildDynamicNodeId(rootId, [...parentSegments, { rank: nextRank, value }]);
    out.push({
      id: childId,
      name: dynamicNodeDisplayName(childId),
      estimatedDescribed: 0,
      totalAssessed: acc.totalAssessed,
      outdated: acc.outdated,
      gbifNeSpeciesCount: 0,
      byCategory: acc.byCategory,
      colDescribed: col?.colDescribed,
      colNe: col?.colNe,
    });
  }
  out.sort((a, b) => b.totalAssessed - a.totalAssessed || a.name.localeCompare(b.name));
  return out;
}
