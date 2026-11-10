import { NextRequest, NextResponse } from "next/server";
import { CACHE_5M } from "@/lib/cache-headers";
import { GBIF_CHECKLIST_KEY } from "@/lib/gbif";
import { gbifJson } from "@/lib/gbif-fetch";

const GBIF_SEARCH = "https://api.gbif.org/v1/occurrence/search";

interface GbifSearchResponse {
  count?: number;
  results?: unknown[];
  facets?: { field: string; counts: { name: string; count: number }[] }[];
}

type GbifRecentObservation = {
  key?: number;
  references?: string;
  eventDate?: string;
  media?: { type?: string; identifier?: string; format?: string }[];
  decimalLatitude?: number;
  decimalLongitude?: number;
  verbatimLocality?: string;
  stateProvince?: string;
  country?: string;
  recordedBy?: string;
};

function requireCount(data: GbifSearchResponse): number {
  if (typeof data?.count !== "number") {
    throw new Error("GBIF search response had no count");
  }
  return data.count;
}

interface InatObservation {
  url: string;
  date: string | null;
  imageUrl: string | null;
  location: string | null;
  observer: string | null;
  mediaType: "StillImage" | "Sound" | "MovingImage" | null;
  audioUrl: string | null;
  gbifID: number | null;
  decimalLatitude: number | null;
  decimalLongitude: number | null;
}

interface RecordTypeBreakdown {
  humanObservation: number;
  machineObservation: number;
  observation: number;
  preservedSpecimen: number;
  fossilSpecimen: number;
  livingSpecimen: number;
  materialSample: number;
  materialCitation: number;
  occurrence: number;
  iNaturalist: number;
  recentInatObservations: InatObservation[];
  inatTotalCount: number;
  total: number;
}

// Cache breakdown results for 1 hour
const cache: Record<string, { data: RecordTypeBreakdown; timestamp: number }> = {};
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// iNaturalist dataset key in GBIF
const INAT_DATASET_KEY = "50c9509d-22c7-4a22-a47d-8c48425ef4a7";

// Data source keys
const DATA_SOURCES: Record<string, { type: "dataset" | "publishingOrg"; key: string }> = {
  iNaturalist: { type: "dataset", key: "50c9509d-22c7-4a22-a47d-8c48425ef4a7" },
  iRecord: { type: "publishingOrg", key: "32f1b389-5871-4da3-832f-9a89132520c5" },
  BSBI: { type: "publishingOrg", key: "aa569acf-991d-4467-b327-8442f30ddbd2" },
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  const speciesKey = key;
  const searchParams = request.nextUrl.searchParams;
  const country = searchParams.get("country");

  // Get current filters to match the species list query
  const maxUncertainty = searchParams.get("maxUncertainty");
  const dataSource = searchParams.get("dataSource");

  // Build cache key including filters
  const cacheKey = `${speciesKey}-${country || "global"}-${maxUncertainty || ""}-${dataSource || ""}`;

  // Return cached data if valid
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) {
    return NextResponse.json(cache[cacheKey].data, { headers: CACHE_5M });
  }

  try {
    // Build base params using occurrence/search with limit=0 to get counts
    // This supports hasCoordinate and hasGeospatialIssue unlike /count endpoint
    const buildParams = (extraParams: Record<string, string> = {}) => {
      const params = new URLSearchParams({
        taxonKey: speciesKey,
        checklistKey: GBIF_CHECKLIST_KEY,
        hasCoordinate: "true",
        hasGeospatialIssue: "false",
        limit: "0",
        ...extraParams,
      });

      if (country) {
        params.set("country", country.toUpperCase());
      }

      // Add uncertainty filter if specified
      if (maxUncertainty) {
        params.set("coordinateUncertaintyInMeters", `*,${maxUncertainty}`);
      }

      // Add data source filter if specified
      if (dataSource && DATA_SOURCES[dataSource]) {
        const source = DATA_SOURCES[dataSource];
        if (source.type === "dataset") {
          params.set("datasetKey", source.key);
        } else {
          params.set("publishingOrg", source.key);
        }
      }

      return params;
    };

    // Three requests, not twelve. This route used to ask GBIF one question per
    // basis of record (nine), plus iNat count, recent iNat and total — twelve
    // parallel calls per species opened, from Vercel's shared egress. Some of
    // them failed on prod, each failure was read as `.count || 0`, and the
    // half-zero result was cached for an hour: Protea odorata (4N2W3) showed
    // iNaturalist 0 / total 0 against GBIF's 22 / 57, which hid the iNat panel
    // (it is gated on `iNaturalist > 0`). One faceted search gives the total
    // and every basis-of-record count at once, and gbifJson identifies us and
    // backs off on 429 — and throws, rather than handing back a zero, when a
    // request still fails.
    const [faceted, inatData, inatRecentData] = (await Promise.all([
      gbifJson(`${GBIF_SEARCH}?${buildParams({ facet: "basisOfRecord", facetLimit: "20" })}`),
      // iNaturalist count (with current filters)
      gbifJson(`${GBIF_SEARCH}?${buildParams({ datasetKey: INAT_DATASET_KEY })}`),
      // Recent iNaturalist observations (up to 10 for preview).
      //
      // Built by hand rather than through buildParams, and so was the one request
      // in this route that never named a checklist. Against the default (frozen
      // Backbone) a CoL key resolves to nothing — verified: taxonKey=43MJ7 with a
      // dataset filter returns 0, and 2,771 with checklistKey. For the 3,416
      // species whose CoL id happens to be all digits it is worse than empty, as
      // the id is a valid Backbone key for an unrelated taxon.
      gbifJson(`${GBIF_SEARCH}?${new URLSearchParams({
        taxonKey: speciesKey,
        checklistKey: GBIF_CHECKLIST_KEY,
        datasetKey: INAT_DATASET_KEY,
        hasCoordinate: "true",
        limit: "10",
        ...(country ? { country: country.toUpperCase() } : {}),
      })}`),
    ])) as [GbifSearchResponse, GbifSearchResponse, GbifSearchResponse];

    // A 200 without a count is a failure too — never let it become a zero.
    const totalCount = requireCount(faceted);
    const inatCount = requireCount(inatData);
    const byBasis = new Map(
      (faceted.facets?.find((f) => f.field === "BASIS_OF_RECORD")?.counts ?? [])
        .map((c) => [c.name, c.count]),
    );
    const basis = (name: string) => byBasis.get(name) ?? 0;
    const humanCount = basis("HUMAN_OBSERVATION");
    const machineCount = basis("MACHINE_OBSERVATION");
    const observationCount = basis("OBSERVATION");
    const preservedCount = basis("PRESERVED_SPECIMEN");
    const fossilCount = basis("FOSSIL_SPECIMEN");
    const livingCount = basis("LIVING_SPECIMEN");
    const materialSampleCount = basis("MATERIAL_SAMPLE");
    const materialCitationCount = basis("MATERIAL_CITATION");
    const occurrenceCount = basis("OCCURRENCE");

    // Recent iNaturalist observations that have a reference URL and any media
    const recentInatObservations: InatObservation[] =
      ((inatRecentData.results ?? []) as GbifRecentObservation[])
        .filter((obs): obs is GbifRecentObservation & { references: string } =>
          !!obs.references && !!obs.media?.[0]?.identifier)
        .map((obs) => {
          const media = obs.media || [];
          const imageMedia = media.find((m) => m.type === "StillImage");
          const audioMedia = media.find((m) => m.type === "Sound");
          const primaryType = (media[0]?.type as InatObservation["mediaType"]) || null;
          const imageUrl = imageMedia?.identifier || null;
          const audioUrl = audioMedia?.identifier || null;
          const locationParts = [obs.verbatimLocality, obs.stateProvince, obs.country].filter(Boolean);
          const location = locationParts.length > 0 ? locationParts.join(", ") : null;
          return {
            url: obs.references,
            date: obs.eventDate ? obs.eventDate.split("T")[0] : null,
            imageUrl,
            audioUrl,
            mediaType: primaryType,
            location,
            observer: obs.recordedBy || null,
            gbifID: obs.key ?? null,
            decimalLatitude: obs.decimalLatitude ?? null,
            decimalLongitude: obs.decimalLongitude ?? null,
          };
        });

    const breakdown: RecordTypeBreakdown = {
      humanObservation: humanCount,
      machineObservation: machineCount,
      observation: observationCount,
      preservedSpecimen: preservedCount,
      fossilSpecimen: fossilCount,
      livingSpecimen: livingCount,
      materialSample: materialSampleCount,
      materialCitation: materialCitationCount,
      occurrence: occurrenceCount,
      iNaturalist: inatCount,
      recentInatObservations,
      inatTotalCount: inatCount,
      total: totalCount,
    };

    // Cache the result
    cache[cacheKey] = { data: breakdown, timestamp: Date.now() };

    return NextResponse.json(breakdown, { headers: CACHE_5M });
  } catch (error) {
    // Not cached: a failure here is GBIF's, and transient. The next request
    // should ask again rather than be served this one for an hour.
    console.error(`Error fetching record breakdown for ${speciesKey}:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
