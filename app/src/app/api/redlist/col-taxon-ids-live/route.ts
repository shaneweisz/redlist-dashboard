import { NextRequest, NextResponse } from "next/server";
import { getLiveColTaxonIds } from "@/lib/data/live-breakdown";
import { CACHE_1H } from "@/lib/cache-headers";

// Fast, standalone CoL-taxon-id lookup for a dynamic node's ancestor chain —
// see live-breakdown.ts's getLiveColTaxonIds doc comment for why this is a
// separate endpoint from taxa-breakdown-live rather than bundled into that
// response: it resolves far faster (no ensureColMatchHelpers setup, no
// no-match diagnostic joins), so TaxaSummary.tsx fires this in parallel and
// can light up the rank/name header's links well before the slower breakdown
// table finishes loading.
export async function GET(request: NextRequest) {
  const nodeId = request.nextUrl.searchParams.get("nodeId");
  if (!nodeId) {
    return NextResponse.json({ error: "Missing nodeId parameter" }, { status: 400 });
  }

  try {
    const colIds = await getLiveColTaxonIds(nodeId);
    return NextResponse.json({ colIds }, { headers: CACHE_1H });
  } catch (error) {
    console.error(`Live CoL taxon id lookup failed for ${nodeId}:`, error);
    // Degrade gracefully — an unlinked header is a much smaller loss than
    // blocking the popover entirely over a lookup that's a pure enhancement.
    return NextResponse.json({ colIds: {} });
  }
}
