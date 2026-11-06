/**
 * Build-time generator for the taxonomy tree's live-drilldown children
 * (scripts/build/build-tree-children.ts writes its output as static files; the browser
 * reads them via lib/tree-children/loader.ts).
 *
 * Produces, for one dynamic drilldown root (mammals, pl-flowering_plants, …), the
 * exact NodeSummary[] that getLiveRankChildren(parentId, nextDynamicRank(parentId))
 * returns for EVERY expandable node under that root — keyed by parentId — so one
 * download answers every unscoped expand under the root. On a fresh deployment the
 * live route took 2-22s per expand (minutes for molluscs) until the edge cached it.
 *
 * Calling getLiveRankChildren once per node would take minutes per build (thousands
 * of orders/families at ~10-50ms each), so this computes the same numbers from two
 * grouped scans per root and recurses in memory. What makes that exact rather than
 * approximate:
 *   - A child's rows are its parent's rows narrowed by the predicate filterToSql adds
 *     for that one segment (segmentMatches below — the same alias expansion, the same
 *     order→class fallback, the same lowercasing), not by the child's bucket value.
 *     The two differ where canonicalization reassigns a species (e.g. an order
 *     override): the live route counts it in one bucket at the parent level but its
 *     filter doesn't find it inside that bucket, and this reproduces that faithfully.
 *   - Bucket values are computed in SQL with the very RANK_COLUMN_SQL expressions the
 *     live route groups by.
 *   - Rows are grouped by every column either side reads, so no distinction is lost.
 * scripts/build/check-tree-children.ts proves it against getLiveRankChildren node by node.
 */
// taxonomy-utils first: it and dynamic-taxon import each other, and entering the cycle
// through dynamic-taxon hits its constants before they're initialised.
import { NODE_INDEX } from "@/lib/taxonomy-utils";
import { getConn, parquetUri, ensureNeHelpers } from "./species-duckdb";
import { outdatedSql } from "./scoped-taxa-summary-duckdb";
import { ensureVernacularNamesLoaded } from "./vernacular-names";
import { EXCLUDED_COL_IDS_SQL, RANK_COLUMN_SQL, isEmptyLiveBucket } from "./live-taxa-children";
import type { NodeSummary } from "./species-store";
import { filterToSql, expandClasses, expandOrders, GENUS_SQL } from "@/lib/taxonomy-sql";
import { outdatedCutoffDate } from "@/lib/outdated";
import { getDataSyncDate } from "@/lib/data-sync-date";
import { buildDynamicNodeId, dynamicNodeDisplayName, parseDynamicNodeId, rankOrderFor, type DynamicRank } from "@/lib/dynamic-taxon";

/** One grouped row: the filter-side columns, the bucket per rank, and its counts. */
interface Row {
  cls: string; ord: string; fam: string; gen: string;
  bucket: Record<DynamicRank, string>;
  // assessed side (src "a")
  src: "a" | "c";
  category?: string | null;
  n?: number; nOutdated?: number;
  // CoL side (src "c")
  colDescribed?: number; colNe?: number;
}

// Filter-side columns exactly as filterToSql writes them.
const FILTER_COLS = `
  coalesce(lower(class_name), '') AS cls,
  coalesce(lower(order_name), '') AS ord,
  coalesce(lower(family), '') AS fam,
  coalesce(${GENUS_SQL}, '') AS gen,
  ${RANK_COLUMN_SQL.class} AS b_class,
  ${RANK_COLUMN_SQL.order} AS b_order,
  ${RANK_COLUMN_SQL.family} AS b_family,
  ${RANK_COLUMN_SQL.genus} AS b_genus`;
const GROUP_COLS = "cls, ord, fam, gen, b_class, b_order, b_family, b_genus";

/** Does a row satisfy the predicate filterToSql emits for one segment (rank = value)? */
export function segmentMatches(row: Pick<Row, "cls" | "ord" | "fam" | "gen">, rank: DynamicRank, value: string): boolean {
  const v = value.toLowerCase();
  switch (rank) {
    case "class": return expandClasses([value]).some((c) => c.toLowerCase() === row.cls);
    case "order": return expandOrders([value]).some((o) => o.toLowerCase() === row.ord) || (row.ord === "" && row.cls === v);
    case "family": return row.fam === v;
    case "genus": return row.gen === v;
  }
}

/** getLiveRankChildren's per-value aggregation + ordering, over in-memory rows. */
export function summarizeChildren(rootId: string, parentSegments: { rank: DynamicRank; value: string }[], rank: DynamicRank, rows: Row[]): NodeSummary[] {
  interface Acc { totalAssessed: number; outdated: number; byCategory: Record<string, number> }
  const byValue = new Map<string, Acc>();
  const colByValue = new Map<string, { colDescribed: number; colNe: number }>();
  for (const r of rows) {
    const v = r.bucket[rank];
    if (r.src === "a") {
      const acc = byValue.get(v) ?? { totalAssessed: 0, outdated: 0, byCategory: {} };
      acc.totalAssessed += r.n!;
      acc.outdated += r.nOutdated!;
      const cat = r.category || "DD";
      acc.byCategory[cat] = (acc.byCategory[cat] ?? 0) + r.n!;
      byValue.set(v, acc);
    } else {
      const col = colByValue.get(v) ?? { colDescribed: 0, colNe: 0 };
      col.colDescribed += r.colDescribed!;
      col.colNe += r.colNe!;
      colByValue.set(v, col);
    }
  }
  const out: NodeSummary[] = [];
  for (const value of new Set([...byValue.keys(), ...colByValue.keys()])) {
    const acc = byValue.get(value) ?? { totalAssessed: 0, outdated: 0, byCategory: {} };
    const col = colByValue.get(value);
    if (isEmptyLiveBucket(acc.totalAssessed, col?.colDescribed)) continue;
    const childId = buildDynamicNodeId(rootId, [...parentSegments, { rank, value }]);
    out.push({
      id: childId,
      name: dynamicNodeDisplayName(childId),
      estimatedDescribed: 0,
      totalAssessed: acc.totalAssessed,
      outdated: acc.outdated,
      gbifNeSpecies: { georeferenced: 0, all: 0 },
      byCategory: acc.byCategory,
      colDescribed: col?.colDescribed,
      colNe: col?.colNe,
    });
  }
  out.sort((a, b) => b.totalAssessed - a.totalAssessed || a.name.localeCompare(b.name));
  return out;
}

/** Every expandable node under `rootId` → its children, exactly as the live route returns them. */
export async function buildRootChildren(rootId: string): Promise<Record<string, NodeSummary[]>> {
  const root = NODE_INDEX.get(rootId);
  if (!root) throw new Error(`Unknown drilldown root ${rootId}`);
  // dynamicNodeFilter keeps only the root's taxonGroups for every node below it, so a
  // child's rows are a subset of the root's rows only when the root filter is
  // groups-only. True for every drilldown root today; refuse loudly if that changes.
  const extraKeys = Object.entries(root.filter).filter(([k, v]) => k !== "taxonGroups" && (Array.isArray(v) ? v.length : v));
  if (extraKeys.length) throw new Error(`Root ${rootId} filters on ${extraKeys.map(([k]) => k)} — tree-children-build assumes taxonGroups only`);

  ensureVernacularNamesLoaded();
  const conn = await getConn();
  await ensureNeHelpers(conn);
  const where = filterToSql(root.filter);
  const cutoff = outdatedCutoffDate(getDataSyncDate()).toISOString().slice(0, 10);
  const universe = `(extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ne_ex_ew_col_ids))`;
  const counted = `in_base AND ${universe} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL}`;

  const toRow = (r: Record<string, unknown>, src: "a" | "c"): Row => ({
    cls: String(r.cls), ord: String(r.ord), fam: String(r.fam), gen: String(r.gen),
    bucket: { class: String(r.b_class), order: String(r.b_order), family: String(r.b_family), genus: String(r.b_genus) },
    src,
    ...(src === "a"
      ? { category: (r.category as string | null) ?? null, n: Number(r.n), nOutdated: Number(r.n_outdated) }
      : { colDescribed: Number(r.col_described), colNe: Number(r.col_ne) }),
  });

  const assessed = (await conn.runAndReadAll(
    `SELECT ${FILTER_COLS}, iucn_category AS category, count(*) AS n,
            sum(CASE WHEN ${outdatedSql(cutoff)} THEN 1 ELSE 0 END) AS n_outdated
     FROM read_parquet('${parquetUri("assessed.parquet")}')
     WHERE (${where})
     GROUP BY ${GROUP_COLS}, category`)).getRowObjects().map((r) => toRow(r, "a"));
  const col = (await conn.runAndReadAll(
    `SELECT ${FILTER_COLS},
            count(*) FILTER (${counted}) AS col_described,
            count(*) FILTER (${counted} AND col_id NOT IN (SELECT col_id FROM ne_assessed_col_ids)) AS col_ne
     FROM read_parquet('${parquetUri("species/**/*.parquet")}', hive_partitioning=true)
     WHERE (${where})
     GROUP BY ${GROUP_COLS}`)).getRowObjects().map((r) => toRow(r, "c"));

  const ranks = rankOrderFor(rootId);
  const out: Record<string, NodeSummary[]> = {};
  const visit = (nodeId: string, segments: { rank: DynamicRank; value: string }[], rows: Row[]) => {
    const rank = ranks[segments.length];
    if (!rank) return; // genus: a leaf
    const children = summarizeChildren(rootId, segments, rank, rows);
    out[nodeId] = children;
    if (!ranks[segments.length + 1]) return; // children are leaves — nothing to expand
    // Bucket values are distinct per child, so walk the ones that survived.
    for (const child of children) {
      const childSegments = parseDynamicNodeId(child.id)!.segments;
      const value = childSegments[childSegments.length - 1].value;
      visit(child.id, childSegments, rows.filter((r) => segmentMatches(r, rank, value)));
    }
  };
  visit(rootId, [], [...assessed, ...col]);
  return out;
}
