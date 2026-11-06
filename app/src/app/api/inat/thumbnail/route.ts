import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";

// Default-photo lookup for the species table's thumbnail column, keyed by
// scientific name. Proxied (rather than called directly from the browser)
// so repeat visits share Vercel's edge cache instead of every client hitting
// iNaturalist directly for the same handful of species on every page load.

interface InatDefaultImage {
  squareUrl: string | null;
  mediumUrl: string | null;
  // iNaturalist's own credit line for the photo, licence included, e.g.
  // "(c) Greg Lasley, some rights reserved (CC BY-NC)". CC licences require
  // showing it wherever the photo appears.
  attribution: string | null;
}

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");
  // rank=any looks up a higher taxon (an order, a class) for the taxon header;
  // the default stays species-only, as the species table needs.
  const anyRank = request.nextUrl.searchParams.get("rank") === "any";
  if (!name) {
    return NextResponse.json({ error: "name parameter is required" }, { status: 400 });
  }

  try {
    // iNat's q= search is fuzzy/relevance-ranked (by observation count), not
    // an exact lookup — per_page=10 + the match filter below guards against
    // a rare species losing the top spot to a much more commonly observed,
    // unrelated taxon that happens to share its epithet (e.g. "Monachus
    // monachus", the Mediterranean Monk Seal, ranks 10th behind several
    // unrelated birds sharing "monachus").
    //
    // Match on t.name OR matched_term, not just t.name: our scientific names
    // (from the Red List) sometimes use an older/synonym spelling that
    // differs from iNat's current accepted name — e.g. our "Caracal aurata"
    // vs. iNat's current "Caracal auratus" (gender-agreement change). iNat's
    // own synonym-aware search still resolves these and reports the matched
    // synonym via matched_term, so checking it too recovers legitimate
    // synonym matches without reopening the Monachus-style false-positive
    // bug (matched_term for the unrelated "monachus" taxa is their own name,
    // not the full queried binomial).
    const taxaResp = await fetch(
      `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(name)}${anyRank ? "" : "&rank=species"}&per_page=10`
    );
    if (!taxaResp.ok) {
      return NextResponse.json({ inatDefaultImage: null }, { headers: CACHE_1H });
    }
    const taxaData = await taxaResp.json();
    const match = (taxaData.results || []).find(
      (t: { name?: string; matched_term?: string }) => t.name === name || t.matched_term === name
    );
    const defaultPhoto = match?.default_photo;

    const inatDefaultImage: InatDefaultImage | null = defaultPhoto
      ? {
          squareUrl: defaultPhoto.square_url || defaultPhoto.url || null,
          mediumUrl: defaultPhoto.medium_url || defaultPhoto.url || null,
          attribution: defaultPhoto.attribution || null,
        }
      : null;

    return NextResponse.json({ inatDefaultImage }, { headers: CACHE_1H });
  } catch (error) {
    console.error("Error fetching iNat thumbnail:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
