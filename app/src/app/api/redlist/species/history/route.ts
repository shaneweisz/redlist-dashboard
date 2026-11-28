/**
 * Lazy assessment history (#260 Phase 2). The species list no longer carries the
 * full per-species history array (it's ~half the payload); the detail panel
 * fetches it here on open. ?id=<sisTaxonId> → { previous_assessments }.
 *
 * &scope=<region> gives that region's history instead (lib/region-scope.ts), and
 * &scopes=1 adds `scopes`: global and every region the species is assessed in,
 * for the Red List tab's switch.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAssessmentHistory, getAssessmentScopes } from "@/lib/data/species-duckdb";
import { parseRegion, REGION_PARAM } from "@/lib/region-scope";
import { CACHE_5M } from "@/lib/cache-headers";

export async function GET(request: NextRequest) {
  const id = Number(request.nextUrl.searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "missing or invalid id" }, { status: 400 });
  }
  try {
    const sp = request.nextUrl.searchParams;
    const region = parseRegion(sp.get(REGION_PARAM));
    const [previous_assessments, scopes] = await Promise.all([
      getAssessmentHistory(id, region),
      // A sync without the regional files has no scopes to offer: the tab shows no switch.
      sp.get("scopes") ? getAssessmentScopes(id).catch(() => []) : Promise.resolve(undefined),
    ]);
    return NextResponse.json(scopes ? { previous_assessments, scopes } : { previous_assessments }, { headers: CACHE_5M });
  } catch (error) {
    console.error("history query error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `history query failed: ${message}` }, { status: 500 });
  }
}
