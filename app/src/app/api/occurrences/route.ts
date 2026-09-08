import { NextRequest, NextResponse } from "next/server";
import { CACHE_5M } from "@/lib/cache-headers";
import { getQualityFlags } from "@/lib/mapping/coordinate-cleaning";
import { GBIF_CHECKLIST_KEY, GBIF_GEOSPATIAL_ISSUES } from "@/lib/gbif";

export const dynamic = "force-dynamic";

/**
 * How many records one by-id request may name.
 *
 * GBIF ORs repeated `gbifId` parameters, so a batch is one query — but a URL
 * has a length and an assessor can have touched thousands of records over a
 * season. The client chunks; this is the cap on each chunk.
 */
const MAX_IDS_PER_REQUEST = 100;

const GBIF_PAGE_LIMIT = 300; // GBIF API max per request
const GBIF_MAX_RETRIES = 4;
const GBIF_BACKOFF_MS = 300;

type GbifRecord = {
  key: number;
  species?: string;
  scientificName?: string;
  eventDate?: string;
  recordedBy?: string;
  decimalLongitude: number;
  decimalLatitude: number;
  country?: string;
  countryCode?: string;
  basisOfRecord?: string;
  datasetKey?: string;
  datasetName?: string;
  publishingOrgKey?: string;
  coordinateUncertaintyInMeters?: number;
  year?: number;
  month?: number;
  institutionCode?: string;
  /** GrSciColl's id for the holding institution, which often names a holder
   *  the record itself gives no code for. */
  institutionKey?: string;
  // Extra Darwin Core fields — only surfaced in the list (table) view, which
  // shows one row per record rather than one dot per record.
  locality?: string;
  verbatimLocality?: string;
  stateProvince?: string;
  elevation?: number;
  depth?: number;
  identifiedBy?: string;
  collectionCode?: string;
  catalogNumber?: string;
  establishmentMeans?: string;
  // Herbarium sheets very often record elevation only as transcribed text
  // ("1900 m", "ca. 2200 msnm"), which GBIF leaves in verbatimElevation.
  verbatimElevation?: string;
  /** The publisher's own record id — outlives a GBIF re-key. */
  occurrenceID?: string;
  issues?: string[];
  // The rest of the Darwin Core an occurrence carries. None of it is on by
  // default in the list — it's there for the column picker, so an assessor
  // can pull up the field their question actually turns on (type status for a
  // name, sampling protocol for an eDNA record, georeferenceRemarks for
  // someone else's reading of the same locality) without leaving for GBIF.
  acceptedScientificName?: string;
  scientificNameAuthorship?: string;
  verbatimScientificName?: string;
  taxonRank?: string;
  taxonomicStatus?: string;
  iucnRedListCategory?: string;
  kingdom?: string;
  phylum?: string;
  class?: string;
  order?: string;
  family?: string;
  genus?: string;
  occurrenceStatus?: string;
  individualCount?: number;
  organismQuantity?: number;
  organismQuantityType?: string;
  sex?: string;
  lifeStage?: string;
  behavior?: string;
  degreeOfEstablishment?: string;
  pathway?: string;
  occurrenceRemarks?: string;
  preparations?: string[];
  typeStatus?: string;
  recordNumber?: string;
  fieldNumber?: string;
  day?: number;
  eventTime?: string;
  verbatimEventDate?: string;
  dateIdentified?: string;
  identificationRemarks?: string;
  samplingProtocol?: string[];
  samplingEffort?: string;
  habitat?: string;
  continent?: string;
  county?: string;
  municipality?: string;
  waterBody?: string;
  island?: string;
  islandGroup?: string;
  higherGeography?: string;
  locationRemarks?: string;
  coordinatePrecision?: number;
  geodeticDatum?: string;
  elevationAccuracy?: number;
  depthAccuracy?: number;
  georeferencedBy?: string;
  georeferenceProtocol?: string;
  georeferenceSources?: string;
  georeferenceRemarks?: string;
  publishingCountry?: string;
  protocol?: string;
  license?: string;
  rightsHolder?: string;
  references?: string;
  lastInterpreted?: string;
  isSequenced?: boolean;
  isInCluster?: boolean;
  media?: { type?: string; format?: string; identifier?: string; references?: string; title?: string; creator?: string; license?: string; rightsHolder?: string }[];
};

/**
 * Images attached to a record — for a herbarium sheet this is a photograph of
 * the sheet itself, label and all, which is the thing you actually want in
 * front of you when reading a locality or checking a determination. Capped at a
 * few per record: some datasets attach dozens, and the list only ever shows the
 * first.
 */
const MAX_IMAGES_PER_RECORD = 4;

function imagesOf(r: GbifRecord) {
  return (r.media ?? [])
    .filter((m) => m.type === "StillImage" && (m.identifier || m.references))
    .slice(0, MAX_IMAGES_PER_RECORD)
    .map((m) => ({
      url: m.identifier || m.references!,
      title: m.title,
      creator: m.creator,
      license: m.license,
      rightsHolder: m.rightsHolder,
    }));
}

/**
 * Darwin Core fields passed through untouched for the list's column picker.
 * Listed rather than spread wholesale so the response stays a known shape —
 * a GBIF record carries a lot that means nothing here (crawl ids, internal
 * keys, the verbatim block).
 */
const PASS_THROUGH_FIELDS = [
  "acceptedScientificName", "scientificNameAuthorship", "verbatimScientificName", "taxonRank",
  "taxonomicStatus", "iucnRedListCategory", "kingdom", "phylum", "class", "order", "family", "genus",
  "occurrenceStatus", "individualCount", "organismQuantity", "organismQuantityType", "sex", "lifeStage",
  "behavior", "degreeOfEstablishment", "pathway", "occurrenceRemarks", "preparations", "typeStatus",
  "recordNumber", "fieldNumber", "day", "eventTime", "verbatimEventDate", "dateIdentified",
  "identificationRemarks", "samplingProtocol", "samplingEffort", "habitat", "continent", "county",
  "municipality", "waterBody", "island", "islandGroup", "higherGeography", "locationRemarks",
  "coordinatePrecision", "geodeticDatum", "elevationAccuracy", "depthAccuracy", "georeferencedBy",
  "georeferenceProtocol", "georeferenceSources", "georeferenceRemarks", "publishingCountry",
  "protocol", "license", "rightsHolder", "references", "lastInterpreted", "isSequenced", "isInCluster",
] as const satisfies readonly (keyof GbifRecord)[];

function passThrough(r: GbifRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PASS_THROUGH_FIELDS) {
    const value = r[field];
    if (value !== undefined && value !== null && value !== "") out[field] = value;
  }
  return out;
}

/**
 * Which of the three record sets an occurrence belongs to.
 *
 * The viewer has always asked GBIF for `hasCoordinate=true&hasGeospatialIssue=false`,
 * i.e. only records it can put a dot on and trusts the position of. For a
 * well-collected species that is most of the record set; for an unassessed one
 * it can be a minority — Dioscorea biplicata has 58 GBIF records, of which 27
 * are mapped, 30 have no coordinates at all (herbarium sheets whose locality
 * was never georeferenced) and 1 is flagged. The other two sets are what an
 * assessor georeferences by hand, so they are fetchable on request.
 */
export type CoordinateStatus =
  /** Has coordinates GBIF is happy with — the only set the map used to show. */
  | "mapped"
  /** Has coordinates, but GBIF flags a geospatial issue with them. */
  | "issue"
  /** No coordinates at all: a locality string waiting to be georeferenced. */
  | "missing";

/** GBIF search params selecting one record set. */
function bucketParams(base: URLSearchParams, bucket: CoordinateStatus): URLSearchParams {
  const params = new URLSearchParams(base);
  if (bucket === "mapped") {
    params.set("hasCoordinate", "true");
    params.set("hasGeospatialIssue", "false");
  } else if (bucket === "issue") {
    params.set("hasGeospatialIssue", "true");
  } else {
    params.set("hasCoordinate", "false");
  }
  return params;
}

/**
 * Classify by what the record actually carries rather than by which query
 * returned it: `hasGeospatialIssue=true` and `hasCoordinate=false` overlap
 * (a record whose coordinates were invalid enough to be dropped is in both),
 * so the two queries can hand back the same record wearing different hats.
 */
function classify(r: GbifRecord, geospatialIssues: string[]): CoordinateStatus {
  if (r.decimalLatitude == null || r.decimalLongitude == null) return "missing";
  return geospatialIssues.length > 0 ? "issue" : "mapped";
}

/** Total matching records for a bucket, without transferring any of them. */
async function countBucket(base: URLSearchParams, bucket: CoordinateStatus): Promise<number> {
  const params = bucketParams(base, bucket);
  params.set("limit", "0");
  const response = await fetch(`https://api.gbif.org/v1/occurrence/search?${params}`, {
    cache: "no-store",
  });
  if (!response.ok) return 0;
  return (await response.json()).count ?? 0;
}

/**
 * Fetch paginated records from GBIF up to the given limit, starting from startOffset.
 * Returns { results, totalCount }.
 */
async function fetchPaginated(
  baseParams: URLSearchParams,
  fetchLimit: number,
  startOffset = 0
): Promise<{ results: GbifRecord[]; totalCount: number }> {
  let results: GbifRecord[] = [];
  let totalCount = 0;
  let offset = startOffset;

  while (results.length < fetchLimit) {
    const pageSize = Math.min(GBIF_PAGE_LIMIT, fetchLimit - results.length);
    const params = new URLSearchParams(baseParams);
    params.set("limit", pageSize.toString());
    params.set("offset", offset.toString());

    // Retried, because this pages in a tight loop and GBIF throttles the burst.
    // Reproduced on every run of the browser check: the map for a species with
    // 130,322 records 500s while the same requests issued sequentially by hand
    // all return 200. Naming a non-default checklistKey appears to make each
    // request more expensive for GBIF to answer, so this got easier to trigger
    // after the Catalogue of Life migration.
    //
    // The status goes in the message because response.statusText is empty over
    // HTTP/2, which is what Node's fetch negotiates — the original error read
    // "GBIF API error: " with nothing after it, and hid the 429 for two rounds
    // of debugging.
    let response: Response | undefined;
    for (let attempt = 0; attempt <= GBIF_MAX_RETRIES; attempt++) {
      response = await fetch(`https://api.gbif.org/v1/occurrence/search?${params}`, {
        cache: "no-store",
      });
      if (response.ok) break;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === GBIF_MAX_RETRIES) {
        throw new Error(`GBIF API error: HTTP ${response.status} ${response.statusText}`.trim());
      }
      await new Promise((r) => setTimeout(r, 2 ** attempt * GBIF_BACKOFF_MS));
    }
    if (!response?.ok) throw new Error("GBIF API error: exhausted retries");

    const data = await response.json();
    totalCount = data.count;
    results = results.concat(data.results);
    offset += pageSize;

    if (data.endOfRecords || offset >= totalCount) {
      break;
    }
  }

  return { results, totalCount };
}

/**
 * GBIF records as the map and the list read them.
 *
 * Shared by both ways into this route — a page of a record set, and a handful
 * of records asked for by id — so a record recovered by id carries the same
 * coordinate status, quality flags and passed-through fields as one that
 * arrived in a sample. Anything less and the two would behave differently in
 * the table that shows them side by side.
 */
function toFeatures(results: GbifRecord[]) {
  // De-duplicated by gbifID: the issue and missing queries overlap for records
  // whose coordinates were invalid enough that GBIF dropped them entirely.
  const seen = new Set<number>();
  const allResults: GbifRecord[] = [];
  for (const r of results) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    allResults.push(r);
  }

  const geospatialIssuesByKey = new Map<number, string[]>(
    allResults.map((r) => [r.key, (r.issues ?? []).filter((i) => GBIF_GEOSPATIAL_ISSUES.has(i))])
  );

  // Coordinate-cleaning checks only mean anything for records that have a
  // position; the unmapped ones are indexed alongside them as nulls so the two
  // arrays stay aligned.
  const positioned = allResults.filter(
    (r) => r.decimalLatitude != null && r.decimalLongitude != null
  );
  // Computed over this request's result set (a single species, per cc_dupl's species
  // key), not the species' full GBIF record — this route is paginated per-request and
  // never sees a species' complete point set.
  const positionedFlags = getQualityFlags(
    positioned.map((r) => ({ lon: r.decimalLongitude, lat: r.decimalLatitude, countryCode: r.countryCode }))
  );
  const qualityFlagsByKey = new Map<number, string[]>(
    positioned.map((r, i) => [r.key, positionedFlags[i]])
  );

  return allResults.map((r) => ({
    type: "Feature",
    properties: {
      gbifID: r.key,
      species: r.species || r.scientificName,
      eventDate: r.eventDate,
      recordedBy: r.recordedBy,
      country: r.country,
      countryCode: r.countryCode,
      basisOfRecord: r.basisOfRecord,
      datasetKey: r.datasetKey,
      datasetName: r.datasetName,
      publishingOrgKey: r.publishingOrgKey,
      coordinateUncertaintyInMeters: r.coordinateUncertaintyInMeters ?? null,
      year: r.year ?? null,
      month: r.month ?? null,
      institutionCode: r.institutionCode,
      institutionKey: r.institutionKey,
      qualityFlags: qualityFlagsByKey.get(r.key) ?? [],
      // List-view-only fields. `locality` is often empty on aggregator records
      // (iNaturalist, for one, only ships verbatimLocality), so both are sent
      // and the client falls back.
      locality: r.locality,
      verbatimLocality: r.verbatimLocality,
      stateProvince: r.stateProvince,
      elevation: r.elevation ?? null,
      verbatimElevation: r.verbatimElevation,
      depth: r.depth ?? null,
      identifiedBy: r.identifiedBy,
      collectionCode: r.collectionCode,
      catalogNumber: r.catalogNumber,
      establishmentMeans: r.establishmentMeans,
      occurrenceID: r.occurrenceID,
      coordinateStatus: classify(r, geospatialIssuesByKey.get(r.key) ?? []),
      gbifIssues: geospatialIssuesByKey.get(r.key) ?? [],
      ...passThrough(r),
      images: imagesOf(r),
    },
    // null for records with no coordinates — valid GeoJSON, and the signal the
    // map uses to skip them while the list still shows their locality.
    geometry:
      r.decimalLatitude != null && r.decimalLongitude != null
        ? { type: "Point", coordinates: [r.decimalLongitude, r.decimalLatitude] }
        : null,
  }));
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const speciesKey = searchParams.get("speciesKey");
  const country = searchParams.get("country");
  const limit = Math.min(parseInt(searchParams.get("limit") || "500"), 5000);
  const maxUncertainty = searchParams.get("maxUncertainty");
  // Optional: fetch more records of just one basis-of-record category (e.g. "load
  // more Preserved specimen records" from the Basis of Record dropdown), starting
  // after the given offset within that category's own GBIF result set.
  const basisOfRecord = searchParams.get("basisOfRecord");
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0"));
  // Opt-in record sets: GBIF records the viewer has always filtered out, either
  // because they carry no coordinates or because GBIF distrusts the ones they
  // carry. Both are candidates for manual georeferencing, so they're fetchable.
  // Skipped for the per-basis-of-record top-up, which is only ever topping up
  // the mapped set the map is drawing.
  const includeMissing = searchParams.get("includeMissing") === "true" && !basisOfRecord;
  const includeIssues = searchParams.get("includeIssues") === "true" && !basisOfRecord;
  // "Load more records without coordinates": pages that set alone, from its own
  // offset, so it can't disturb where the mapped set has got to.
  const onlyMissing = searchParams.get("onlyMissing") === "true";
  /**
   * Named records, whatever page of the species they would otherwise fall on.
   *
   * An assessor's edits are held against a gbifID and outlive the sample they
   * were made in: georeference a record on the fourth page, come back
   * tomorrow, and the default sample no longer contains it. This is how the
   * page gets those records back — asked for by id, and normalised like every
   * other record here.
   */
  const ids = (searchParams.get("gbifIds") ?? "")
    .split(",")
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(0, MAX_IDS_PER_REQUEST);

  if (!speciesKey) {
    return NextResponse.json(
      { error: "speciesKey parameter is required" },
      { status: 400 }
    );
  }

  try {
    // Shared across all three record sets; each bucket adds its own
    // hasCoordinate/hasGeospatialIssue pair on top.
    const baseParams = new URLSearchParams({
      speciesKey,
      checklistKey: GBIF_CHECKLIST_KEY,
    });

    if (country) {
      baseParams.set("country", country.toUpperCase());
    }

    if (maxUncertainty) {
      baseParams.set("coordinateUncertaintyInMeters", `*,${maxUncertainty}`);
    }

    if (basisOfRecord) {
      baseParams.set("basisOfRecord", basisOfRecord);
    }

    // GBIF default order: year descending, then month ascending within each year,
    // then by gbifID ascending. No custom sort is available via the API.
    //
    // By id: one query with the keys ORed together, and none of the bucket
    // machinery — which set a record belongs to is decided by what it carries,
    // exactly as it is for the rest.
    if (ids.length > 0) {
      const byId = new URLSearchParams(baseParams);
      for (const id of ids) byId.append("gbifId", String(id));
      const named = await fetchPaginated(byId, ids.length, 0);
      return NextResponse.json(
        {
          type: "FeatureCollection",
          features: toFeatures(named.results),
          metadata: { speciesKey, count: named.results.length, requested: ids.length },
        },
        { headers: CACHE_5M }
      );
    }

    // Each requested set is fetched under its own bounded limit rather than by
    // dropping the filters and taking whatever comes back, so a species with
    // thousands of mapped records can't crowd out the handful of unmapped ones
    // (or the reverse) inside a single sample.
    const [mapped, issues, missing] = await Promise.all([
      onlyMissing
        ? Promise.resolve({ results: [] as GbifRecord[], totalCount: 0 })
        : fetchPaginated(bucketParams(baseParams, "mapped"), limit, offset),
      includeIssues && !onlyMissing
        ? fetchPaginated(bucketParams(baseParams, "issue"), limit, offset)
        : Promise.resolve(null),
      includeMissing || onlyMissing
        ? fetchPaginated(bucketParams(baseParams, "missing"), limit, offset)
        : Promise.resolve(null),
    ]);

    // Counts for the sets that weren't fetched, so the UI can offer them by name
    // ("Include 30 records without coordinates") before anyone opts in.
    const [issueTotal, missingTotal] = await Promise.all([
      issues ? Promise.resolve(issues.totalCount) : countBucket(baseParams, "issue"),
      missing ? Promise.resolve(missing.totalCount) : countBucket(baseParams, "missing"),
    ]);

    const features = toFeatures([
      ...mapped.results,
      ...(issues?.results ?? []),
      ...(missing?.results ?? []),
    ]);

    // Calculate bbox from the mapped features only. Flagged records are exactly
    // the ones whose coordinates can't be trusted — this species' single flagged
    // record sits at (0, 0), which would stretch the map's auto-fit from the
    // Andes to the Gulf of Guinea.
    let minLon = Infinity,
      maxLon = -Infinity;
    let minLat = Infinity,
      maxLat = -Infinity;
    let positionedCount = 0;

    for (const feature of features) {
      if (!feature.geometry || feature.properties.coordinateStatus !== "mapped") continue;
      const [lon, lat] = feature.geometry.coordinates;
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      positionedCount++;
    }

    return NextResponse.json({
      type: "FeatureCollection",
      features,
      metadata: {
        speciesKey,
        count: features.length,
        // `total` stays the mapped set's total, which is what the "Loaded X of Y"
        // badge and every load-more control have always counted against.
        total: onlyMissing ? (missing?.totalCount ?? 0) : mapped.totalCount,
        totals: {
          mapped: mapped.totalCount,
          issue: issueTotal,
          missing: missingTotal,
        },
        bbox: positionedCount > 0 ? [minLon, minLat, maxLon, maxLat] : null,
      },
    }, { headers: CACHE_5M });
  } catch (error) {
    console.error("Error fetching occurrences:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
