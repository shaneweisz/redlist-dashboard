import { NextRequest, NextResponse } from "next/server";
import { getPrecomputedChildrenSummaries, type NodeSummary } from "@/lib/data/species-store";
import { getScopedChildrenSummaries, scopeWhere } from "@/lib/data/scoped-taxa-summary-duckdb";
import { getLiveRankChildren } from "@/lib/data/live-taxa-children";
import { findNode, hasChildren } from "@/lib/taxonomy-utils";
import { isLiveDrilldownNode, nextDynamicRank } from "@/lib/dynamic-taxon";
import { CACHE_1H } from "@/lib/cache-headers";

/** Upper bound on `nodeIds=` — the SSC groups table asks for 6. */
const MAX_NODE_IDS = 20;

async function childrenOf(nodeId: string, where: ReturnType<typeof scopeWhere>): Promise<NodeSummary[]> {
  // Live, arbitrary-depth taxonomic drilldown (see dynamic-taxon.ts) — takes
  // over from the static tree + precomputed JSON for DYNAMIC_DRILLDOWN_ROOTS,
  // scoped or not (Phase 7: country-scoping ports onto the same
  // getLiveRankChildren mechanism via an extra scope predicate ANDed
  // into the assessed-side query only, mirroring getScopedChildrenSummaries'
  // existing precedent of omitting CoL/GBIF fields — no country or realm
  // dimension exists for either — when extraWhere is set; realm rides that
  // exact same path, it's just a different column in the same predicate).
  if (isLiveDrilldownNode(nodeId)) {
    const nextRank = nextDynamicRank(nodeId);
    // No further rank below genus — the leaf is the existing species-list view.
    if (!nextRank) return [];
    return getLiveRankChildren(nodeId, nextRank, where ?? undefined);
  }

  if (!findNode(nodeId) || !hasChildren(nodeId)) return [];

  // Scoped summaries carry zeroed estimatedDescribed/gbifNeSpeciesCount
  // (neither country nor realm exists in that data) — `scoped` tells the client
  // to hide those columns rather than render a misleading 0.
  return where ? getScopedChildrenSummaries(where, nodeId) : getPrecomputedChildrenSummaries(nodeId);
}

/**
 * The child summaries of one node (`?nodeId=x` → `{ subgroups, scoped }`), or of
 * several at once (`?nodeIds=x,y,z` → `{ subgroupsByNode: { x: [...], … }, scoped }`).
 * The batch form exists so a table built from several nodes — the SSC groups view,
 * one node per taxon — is one request rather than one per node.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const nodeId = params.get("nodeId");
  const nodeIds = params.get("nodeIds")?.split(",").map((n) => n.trim()).filter(Boolean) ?? [];
  // One or more comma-separated values each, composing by AND — see
  // taxa-summary/route.ts's own comment.
  const countries = params.get("country")?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];
  const realms = params.get("realm")?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
  const where = scopeWhere(countries, realms);
  const scoped = where !== null;

  if (!nodeId && nodeIds.length === 0) {
    return NextResponse.json({ error: "Missing nodeId parameter" }, { status: 400 });
  }
  if (nodeIds.length > MAX_NODE_IDS) {
    return NextResponse.json({ error: `At most ${MAX_NODE_IDS} nodeIds` }, { status: 400 });
  }

  try {
    if (nodeId) {
      const subgroups = await childrenOf(nodeId, where);
      return NextResponse.json({ subgroups, scoped }, { headers: CACHE_1H });
    }
    const unique = [...new Set(nodeIds)];
    const lists = await Promise.all(unique.map((id) => childrenOf(id, where)));
    const subgroupsByNode = Object.fromEntries(unique.map((id, i) => [id, lists[i]]));
    return NextResponse.json({ subgroupsByNode, scoped }, { headers: CACHE_1H });
  } catch (error) {
    console.error(`Node children summary error for ${nodeId ?? nodeIds.join(",")}:`, error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Node summary failed: ${message}` },
      { status: 500 }
    );
  }
}
