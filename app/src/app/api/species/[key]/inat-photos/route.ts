import { NextRequest, NextResponse } from "next/server";
import { CACHE_5M } from "@/lib/cache-headers";
import { GBIF_CHECKLIST_KEY } from "@/lib/gbif";
import { gbifJson } from "@/lib/gbif-fetch";

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
  license: string | null;
  rightsHolder: string | null;
}

const INAT_DATASET_KEY = "50c9509d-22c7-4a22-a47d-8c48425ef4a7";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  const speciesKey = key;
  const searchParams = request.nextUrl.searchParams;
  const country = searchParams.get("country");
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const limit = parseInt(searchParams.get("limit") || "10", 10);

  try {
    const queryParams = new URLSearchParams({
      taxonKey: speciesKey,
      checklistKey: GBIF_CHECKLIST_KEY,
      datasetKey: INAT_DATASET_KEY,
      hasCoordinate: "true",
      limit: limit.toString(),
      offset: offset.toString(),
      ...(country ? { country: country.toUpperCase() } : {}),
    });

    // Through gbifJson (User-Agent, 429/5xx/network backoff), and a failure is
    // an error, not an empty page: this used to answer any non-OK GBIF response
    // with { observations: [] } at 200, which the panel rendered as an empty
    // iNaturalist column for a species with 22 photographed records.
    const data = (await gbifJson(
      `https://api.gbif.org/v1/occurrence/search?${queryParams}`
    )) as {
      count?: number;
      // Narrowed by the filter/map annotations below, as before.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      results?: any[];
    };
    if (typeof data?.count !== "number") {
      throw new Error("GBIF search response had no count");
    }
    const totalCount = data.count;

    const observations: InatObservation[] = (data.results || [])
      .filter(
        (obs: { references?: string; media?: { type?: string; identifier?: string }[] }) =>
          obs.references && obs.media && obs.media.length > 0 && obs.media[0]?.identifier
      )
      .map(
        (obs: {
          key?: number;
          references: string;
          eventDate?: string;
          media?: { type?: string; identifier?: string; format?: string }[];
          decimalLatitude?: number;
          decimalLongitude?: number;
          verbatimLocality?: string;
          stateProvince?: string;
          country?: string;
          recordedBy?: string;
          license?: string;
          rightsHolder?: string;
        }) => {
          const media = obs.media || [];
          const imageMedia = media.find((m) => m.type === "StillImage");
          const audioMedia = media.find((m) => m.type === "Sound");
          const primaryType = (media[0]?.type as InatObservation["mediaType"]) || null;

          const imageUrl = imageMedia?.identifier || null;
          const audioUrl = audioMedia?.identifier || null;

          const locationParts = [
            obs.verbatimLocality,
            obs.stateProvince,
            obs.country,
          ].filter(Boolean);
          const location =
            locationParts.length > 0 ? locationParts.join(", ") : null;
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
            license: obs.license ?? null,
            rightsHolder: obs.rightsHolder ?? null,
          };
        }
      );

    return NextResponse.json({ observations, totalCount }, { headers: CACHE_5M });
  } catch (error) {
    console.error(`Error fetching iNat photos for ${speciesKey}:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
