/**
 * One `taxa=` URL token as a SQL predicate over a species table.
 *
 * The dashboard's own taxon filter never needed this: resolveWhere()
 * (species-duckdb.ts) narrows to a node's taxonGroups and leaves the rest of the
 * drill-down — rodents, Dioscoreaceae — to the client, which already holds every
 * row it is filtering. A narrative search holds nothing: it asks DuckDB for a
 * ranked page of ten out of ~170,000 assessments, so a filter that isn't in the
 * query would be a filter applied to ten rows that were chosen before it was
 * considered. Hence a full predicate, the same one filterToSql() builds for a
 * node's counts.
 *
 * Column names come from filterToSql: scientific_name / class_name / order_name
 * / family / taxon_group, which assessed.parquet carries — so a caller only has
 * to put this in front of something shaped like that parquet.
 */
// taxonomy-utils MUST be imported before dynamic-taxon — the two import each
// other, and entering the cycle from the dynamic-taxon side leaves its own
// consts uninitialized (see candidate-scope.ts, which hit exactly that).
import { NODE_INDEX, expandTaxaToken } from "@/lib/taxonomy-utils";
import { isDynamicNodeId, dynamicNodeFilter } from "@/lib/dynamic-taxon";
import { filterToSql, sqlStrList, GENUS_SQL } from "@/lib/taxonomy-sql";

/**
 * The predicate for a token, or null when the token scopes nothing (absent,
 * blank, or "all" — the root of the tree, which is every group there is).
 *
 * A token naming nothing we know falls through to an arbitrary-rank match, the
 * same fallback resolveWhere() uses: `panthera` is a genus nobody put in the
 * tree, and a token that is genuinely meaningless then matches no rows rather
 * than — far worse for a filter — all of them. Values are escaped through
 * sqlStrList/filterToSql, so a token is never a way to write SQL.
 */
export function taxaScopeSql(token: string | null | undefined): string | null {
  const raw = (token ?? "").trim();
  if (!raw || raw.toLowerCase() === "all") return null;

  // A sub-group token carries its root with it (corals → invertebrates +
  // inv-corals), and it is the narrower of the two that was asked for.
  const { taxa, subgroup } = expandTaxaToken(raw);
  const id = subgroup ?? taxa;

  const node = NODE_INDEX.get(id);
  if (node) return filterToSql(node.filter);

  // A live-drilldown node (flowering_plants~dioscoreales~dioscoreaceae) is not a
  // tree entry but is a real rank chain — see dynamic-taxon.ts.
  if (isDynamicNodeId(id)) {
    const filter = dynamicNodeFilter(id);
    if (filter) return filterToSql(filter);
  }

  const v = sqlStrList([id]);
  return `(coalesce(lower(class_name), '') = ${v} OR coalesce(lower(order_name), '') = ${v}` +
    ` OR coalesce(lower(family), '') = ${v} OR coalesce(${GENUS_SQL}, '') = ${v})`;
}
