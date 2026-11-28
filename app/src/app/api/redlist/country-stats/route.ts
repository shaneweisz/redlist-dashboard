import { NextRequest, NextResponse } from "next/server";
import { getCountryStats } from "@/lib/data/species-store";
import { getRegionCountryStats } from "@/lib/data/scoped-taxa-summary-duckdb";
import { parseRegion, REGION_PARAM } from "@/lib/region-scope";
import { CACHE_1H } from "@/lib/cache-headers";

/**
 * Per-country totals across ALL species (unfiltered by taxon) — the
 * country-view landing page's world map reads this instead of loading the
 * full species dataset client-side just to aggregate it in the browser.
 * Distinct from /api/country/stats, which queries GBIF observation counts
 * (a different data source) per taxon.
 *
 * Under a region scope (?scope=Europe) the totals are that region's
 * assessments, computed live: the precomputed file is global.
 */
export async function GET(request: NextRequest) {
  try {
    const region = parseRegion(request.nextUrl.searchParams.get(REGION_PARAM));
    const stats = region ? await getRegionCountryStats(region) : getCountryStats();
    return NextResponse.json({ stats }, { headers: CACHE_1H });
  } catch (error) {
    console.error("Country stats error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Country stats failed: ${message}` },
      { status: 500 }
    );
  }
}
