/**
 * GET /api/nearby-species?lat=&lng=&radiusKm=&exclude=
 *
 * The assessed species GBIF has records for within `radiusKm` of a point, with
 * the threats their assessments cite. See lib/mapping/nearby-species.ts for why
 * the search is narrowed on GBIF's Red List categories but never labelled with
 * them.
 *
 * `exclude` is the GBIF key of the species whose map this is: it is trivially
 * its own neighbour, and its own threats would dominate the summary it is meant
 * to be compared against.
 */
import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import { normalizeCategory } from "@/config/taxa";
import { threatTags } from "@/lib/mapping/nearby-threats";
import { getAssessedByGbifKeys } from "@/lib/data/species-duckdb";
import {
  NEARBY_CATEGORIES,
  NEARBY_FACET_LIMIT,
  snapRadiusKm,
  nearbyFacetUrl,
  type NearbyResult,
  type NearbySpecies,
} from "@/lib/mapping/nearby-species";

/** GBIF facet counts come back as { name: <speciesKey>, count: n }. */
interface GbifFacetCount {
  name: string;
  count: number;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const lat = Number(sp.get("lat"));
  const lng = Number(sp.get("lng"));
  const exclude = sp.get("exclude");

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: "lat and lng are required, and must be a real position" }, { status: 400 });
  }
  // Anything outside the offered set would be a radius the panel can't label
  // and the cache would never be asked for twice.
  const radiusKm = snapRadiusKm(sp.get("radiusKm"));

  try {
    // Two counts, one purpose: the threatened facet is the panel, and the
    // unfiltered total is the denominator that says how hard anyone has looked
    // here at all. A radius with 40 threatened records out of 40 total is a
    // different claim from 40 out of 400,000.
    const [faceted, all] = await Promise.all([
      fetchJson(nearbyFacetUrl({ lat, lng, radiusKm })),
      fetchJson(
        `https://api.gbif.org/v1/occurrence/search?${new URLSearchParams({
          geoDistance: `${lat},${lng},${radiusKm}km`,
          hasCoordinate: "true",
          hasGeospatialIssue: "false",
          limit: "0",
        })}`
      ),
    ]);

    const counts: GbifFacetCount[] = faceted?.facets?.[0]?.counts ?? [];
    const byKey = new Map(counts.map((c) => [String(c.name), c.count]));
    if (exclude) byKey.delete(exclude);

    const assessed = await getAssessedByGbifKeys([...byKey.keys()]);
    const species: NearbySpecies[] = assessed
      // Our own category decides, not GBIF's. Theirs is a lagging snapshot and
      // is only good enough to narrow the search; a species it still calls
      // threatened may have been down-listed since, and the panel would then
      // list an LC or NT species under a heading that says otherwise.
      .filter((a) => (NEARBY_CATEGORIES as readonly string[]).includes(normalizeCategory(a.category)))
      .map((a) => ({
        ...a,
        records: byKey.get(a.gbif_species_key) ?? 0,
        threat_tags: threatTags(a.threat_codes),
      }))
      .sort(
        (a, b) =>
          // How much of it was actually found here, first. Sorting by category
          // put a species with one record above one with three hundred, which
          // reads as a ranking of how threatened the neighbourhood is; sorting
          // by records says how strongly each one is attested at this spot,
          // which is what decides whether a precedent is worth opening. The
          // category is still on every row, and still breaks ties.
          b.records - a.records ||
          categoryRank(a.category) - categoryRank(b.category) ||
          a.scientific_name.localeCompare(b.scientific_name)
      );

    const result: NearbyResult = {
      lat,
      lng,
      radiusKm,
      totalRecords: all?.count ?? 0,
      categoryRecords: faceted?.count ?? 0,
      species,
      unmatched: byKey.size - species.length,
      truncated: counts.length >= NEARBY_FACET_LIMIT,
    };
    return NextResponse.json(result, { headers: CACHE_1H });
  } catch (error) {
    console.error("Nearby species lookup failed", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Nearby species lookup failed: ${message}` }, { status: 502 });
  }
}

/** CR first: the order the panel reads in, not the alphabet's. */
const CATEGORY_ORDER = ["CR", "EN", "VU", "NT", "LC", "DD", "EW", "EX"];

/**
 * Sort position for a category, normalised and with unknowns last.
 *
 * Older assessments carry the pre-2001 Lower Risk codes — 442 species are still
 * "LR/nt" — and GBIF's category filter maps them onto the modern ones, so they
 * arrive here however the assessment was written. A bare indexOf answers -1 for
 * those, which sorted an LR/nt palm *above* every Critically Endangered species
 * in the panel. normalizeCategory is the same mapping the rest of the dashboard
 * reads them through.
 */
function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(normalizeCategory(category));
  return i === -1 ? CATEGORY_ORDER.length : i;
}

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GBIF returned ${res.status}`);
  return res.json();
}
