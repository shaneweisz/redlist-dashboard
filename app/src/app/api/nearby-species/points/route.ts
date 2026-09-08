/**
 * GET /api/nearby-species/points?lat=&lng=&radiusKm=&speciesKey=
 *
 * Where one neighbour's records actually are, inside the radius the panel is
 * describing — so a name in the list can be turned into dots on the map.
 *
 * One species at a time, deliberately. Drawing every neighbour at once would be
 * a thousand-odd anonymous dots over the records the assessor came to look at;
 * one species is a shape you can read — a valley, a roadside, a single locality
 * that everything was collected from.
 */
import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import {
  NEARBY_POINTS_LIMIT,
  snapRadiusKm,
  nearbyPointsUrl,
  type NearbyPoint,
} from "@/lib/mapping/nearby-species";

interface GbifOccurrence {
  key?: number;
  decimalLatitude?: number;
  decimalLongitude?: number;
  species?: string;
  scientificName?: string;
  eventDate?: string;
  year?: number;
  basisOfRecord?: string;
  recordedBy?: string;
  identifiedBy?: string;
  locality?: string;
  verbatimLocality?: string;
  countryCode?: string;
  coordinateUncertaintyInMeters?: number;
  catalogNumber?: string;
  datasetName?: string;
  media?: { type?: string; format?: string; identifier?: string; references?: string; title?: string; creator?: string; license?: string; rightsHolder?: string }[];
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const lat = Number(sp.get("lat"));
  const lng = Number(sp.get("lng"));
  const speciesKey = sp.get("speciesKey");

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: "lat and lng are required, and must be a real position" }, { status: 400 });
  }
  if (!speciesKey) {
    return NextResponse.json({ error: "speciesKey is required" }, { status: 400 });
  }
  const radiusKm = snapRadiusKm(sp.get("radiusKm"));

  try {
    const res = await fetch(nearbyPointsUrl({ lat, lng, radiusKm, speciesKey }), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GBIF returned ${res.status}`);
    const data = await res.json();

    const points: NearbyPoint[] = (data.results ?? [])
      .filter((r: GbifOccurrence) => Number.isFinite(r.decimalLatitude) && Number.isFinite(r.decimalLongitude))
      .map((r: GbifOccurrence) => ({
        gbifID: r.key ?? 0,
        lat: r.decimalLatitude as number,
        lng: r.decimalLongitude as number,
        species: r.species ?? r.scientificName ?? null,
        eventDate: r.eventDate ?? null,
        year: Number.isFinite(r.year) ? (r.year as number) : null,
        basis: r.basisOfRecord ?? null,
        recordedBy: r.recordedBy ?? null,
        identifiedBy: r.identifiedBy ?? null,
        // GBIF leaves a locality it couldn't interpret in the verbatim field,
        // and for these records that is often the only description there is.
        locality: r.locality ?? r.verbatimLocality ?? null,
        countryCode: r.countryCode ?? null,
        uncertaintyMetres: Number.isFinite(r.coordinateUncertaintyInMeters)
          ? (r.coordinateUncertaintyInMeters as number)
          : null,
        catalogNumber: r.catalogNumber ?? null,
        datasetName: r.datasetName ?? null,
        // Same filter and cap the map's own records use (api/occurrences).
        images: (r.media ?? [])
          .filter((m) => m.type === "StillImage" && (m.identifier || m.references))
          .slice(0, 6)
          .map((m) => ({
            url: (m.identifier || m.references) as string,
            title: m.title,
            creator: m.creator,
            license: m.license,
            rightsHolder: m.rightsHolder,
          })),
      }));

    return NextResponse.json(
      {
        speciesKey,
        radiusKm,
        points,
        /** Every record GBIF holds for it here, which `points` may only sample. */
        total: data.count ?? points.length,
        sampled: (data.count ?? 0) > NEARBY_POINTS_LIMIT,
      },
      { headers: CACHE_1H }
    );
  } catch (error) {
    console.error("Nearby points lookup failed", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Nearby points lookup failed: ${message}` }, { status: 502 });
  }
}
