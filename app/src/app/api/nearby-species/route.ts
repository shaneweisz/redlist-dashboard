/**
 * GET /api/nearby-species?lat=&lng=&radiusKm=&exclude=
 * GET /api/nearby-species?geometry=<WKT>&exclude=
 *
 * The assessed species GBIF has records for within `radiusKm` of a point — or
 * inside a boundary given as WKT, which is how "what is threatened inside this
 * protected area" is asked — with the threats their assessments cite. See lib/mapping/nearby-species.ts for why
 * the search is narrowed on GBIF's Red List categories but never labelled with
 * them.
 *
 * `exclude` is the GBIF key of the species whose map this is: it is trivially
 * its own neighbour, and its own threats would dominate the summary it is meant
 * to be compared against.
 */
import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import { gbifJson } from "@/lib/gbif-fetch";
import { normalizeCategory } from "@/config/taxa";
import { threatTags } from "@/lib/mapping/nearby-threats";
import { getAssessedByGbifKeys, getUnassessedByGbifKeys } from "@/lib/data/species-duckdb";
import { isPolygonWkt, GBIF_URL_BUDGET } from "@/lib/mapping/gbif-geometry";
import {
  NEARBY_CATEGORIES,
  NEARBY_SCOPE_CATEGORIES,
  parseScope,
  whereParams,
  type NearbyWhere,
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

/** The parts of GBIF's occurrence-search response these two queries read. */
interface GbifSearchResponse {
  count?: number;
  facets?: { counts?: GbifFacetCount[] }[];
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const exclude = sp.get("exclude");
  const geometry = sp.get("geometry");
  const scope = parseScope(sp.get("scope"));

  let where: NearbyWhere;
  let lat = Number(sp.get("lat"));
  let lng = Number(sp.get("lng"));
  // Anything outside the offered set would be a radius the panel can't label
  // and the cache would never be asked for twice.
  let radiusKm: number | undefined = snapRadiusKm(sp.get("radiusKm"));

  if (geometry) {
    if (!isPolygonWkt(geometry)) {
      return NextResponse.json({ error: "geometry must be a POLYGON or MULTIPOLYGON in WKT" }, { status: 400 });
    }
    // Refused here rather than passed on, because GBIF's own refusal is a
    // Tomcat error page rather than an explanation — see gbif-geometry, which
    // is what callers should be preparing a boundary with.
    if (encodeURIComponent(geometry).length > GBIF_URL_BUDGET) {
      return NextResponse.json({ error: "geometry is too long for GBIF to accept" }, { status: 400 });
    }
    where = { wkt: geometry };
    radiusKm = undefined;
    // A boundary has no centre of its own, and the panel wants somewhere to
    // point at; the caller sends the point it was picked at when it has one.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) [lat, lng] = [0, 0];
  } else {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return NextResponse.json({ error: "lat and lng are required, and must be a real position" }, { status: 400 });
    }
    where = { lat, lng, radiusKm: radiusKm as number };
  }

  try {
    // Two counts, one purpose: the threatened facet is the panel, and the
    // unfiltered total is the denominator that says how hard anyone has looked
    // here at all. A radius with 40 threatened records out of 40 total is a
    // different claim from 40 out of 400,000.
    const [faceted, all] = (await Promise.all([
      gbifJson(nearbyFacetUrl({ ...where, categories: NEARBY_SCOPE_CATEGORIES[scope] })),
      gbifJson(
        `https://api.gbif.org/v1/occurrence/search?${new URLSearchParams({
          ...whereParams(where),
          hasCoordinate: "true",
          hasGeospatialIssue: "false",
          limit: "0",
        })}`
      ),
    ])) as [GbifSearchResponse, GbifSearchResponse];

    const counts: GbifFacetCount[] = faceted?.facets?.[0]?.counts ?? [];
    const byKey = new Map(counts.map((c) => [String(c.name), c.count]));
    if (exclude) byKey.delete(exclude);

    const assessed = await getAssessedByGbifKeys([...byKey.keys()]);
    const matched: NearbySpecies[] = assessed
      // Our own category decides, not GBIF's. Theirs is a lagging snapshot and
      // is only good enough to narrow the search; a species it still calls
      // threatened may have been down-listed since, and the panel would then
      // list an LC or NT species under a heading that says otherwise.
      .filter(
        (a) =>
          scope !== "threatened" ||
          (NEARBY_CATEGORIES as readonly string[]).includes(normalizeCategory(a.category))
      )
      .map((a) => ({
        ...a,
        records: byKey.get(a.gbif_species_key) ?? 0,
        threat_tags: threatTags(a.threat_codes),
      }));

    // The species nobody has assessed, which is most of what an unfiltered
    // facet returns. Only fetched for the scope that asks for them — the other
    // two are defined by having an assessment, so a second parquet scan would
    // be a scan whose every row is then discarded.
    const unassessed: NearbySpecies[] =
      scope === "all"
        ? (
            await getUnassessedByGbifKeys(
              [...byKey.keys()].filter((k) => !matched.some((m) => m.gbif_species_key === k))
            )
          ).map((u) => ({
            ...u,
            category: "NE",
            criteria: null,
            threat_codes: [],
            threat_tags: [],
            assessment_year: null,
            assessment_id: null,
            sis_taxon_id: null,
            dashboard_row_key: null,
            records: byKey.get(u.gbif_species_key) ?? 0,
          }))
        : [];

    const species: NearbySpecies[] = [...matched, ...unassessed]
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
      geometry: geometry ?? undefined,
      totalRecords: all?.count ?? 0,
      categoryRecords: faceted?.count ?? 0,
      scope,
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
