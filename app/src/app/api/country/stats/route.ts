import { NextRequest, NextResponse } from "next/server";
import { liveGbifKey } from "@/lib/gbif-live-keys";
import { CACHE_1H } from "@/lib/cache-headers";
import { gbifOccurrenceParams, gbifTaxonKeysForGroup } from "@/lib/gbif";
import { gbifJson } from "@/lib/gbif-fetch";
import { GBIF_RECORDS_PARAM, parseGbifRecordMode } from "@/lib/gbif-records";

interface CountryStats {
  [countryCode: string]: {
    occurrences: number;
    species: number;
  };
}

interface GbifFacetResponse {
  facets?: { field: string; counts?: { name: string; count: number }[] }[];
}

// Cache the results for 1 hour, keyed by the (sorted) taxon list
const cachedStats: Record<string, CountryStats> = {};
const cacheTime: Record<string, number> = {};
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * GBIF occurrence counts per country for one or more dashboard groups
 * (`?taxon=birds` or `?taxon=birds,mammals,…`), summed into one map.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const taxonIds = [...new Set(
    (searchParams.get("taxon") || "plantae").split(",").map((t) => t.trim()).filter(Boolean),
  )].sort();

  // Georeferenced records (the default) or all records, as the counts beside the map.
  const mode = parseGbifRecordMode(searchParams.get(GBIF_RECORDS_PARAM));
  const cacheKey = `${taxonIds.join(",")}|${mode}`;

  // Return cached data if still valid
  if (cachedStats[cacheKey] && Date.now() - (cacheTime[cacheKey] || 0) < CACHE_DURATION) {
    return NextResponse.json({ stats: cachedStats[cacheKey], cached: true }, { headers: CACHE_1H });
  }

  try {
    // GBIF ORs repeated taxonKey parameters, so every key of every requested
    // group goes into one query. This used to be one query per key: 49 for
    // invertebrates alone, the slowest taking 24s, and Sentry flagging the fan-out
    // as an N+1. The groups' keys are disjoint, so one faceted query returns
    // exactly what summing the per-key queries did. Every kingdom counts the
    // same record types now (gbif-records.ts), so it is one query, not one per
    // record-type set.
    //
    // The keys come from the generated config, derived from the Red List group
    // definitions — a hand-kept list of backbone integers once went stale when the
    // pipeline moved to Catalogue of Life, and GBIF quietly returned nothing.
    // Each as GBIF's live index keys it, which can be a newer CoL release than
    // the config was derived from (gbif-live-keys.ts).
    const keys = new Set(await Promise.all(taxonIds.flatMap((t) => gbifTaxonKeysForGroup(t)).map(liveGbifKey)));
    const params = gbifOccurrenceParams({ facet: "country", facetLimit: "300", limit: "0" }, { mode });
    for (const key of keys) params.append("taxonKey", key);

    // gbifJson identifies us to GBIF and retries 429/5xx; anything it still can't
    // get throws, so a failed query is a 502 rather than a group silently missing
    // from the map (and cached that way for an hour).
    const results = keys.size > 0
      ? [await gbifJson(`https://api.gbif.org/v1/occurrence/search?${params}`) as GbifFacetResponse]
      : [];

    const stats: CountryStats = {};
    for (const result of results) {
      const countryFacets = result.facets?.find((f) => f.field === "COUNTRY");
      for (const facet of countryFacets?.counts ?? []) {
        if (!stats[facet.name]) stats[facet.name] = { occurrences: 0, species: 0 };
        stats[facet.name].occurrences += facet.count;
      }
    }

    cachedStats[cacheKey] = stats;
    cacheTime[cacheKey] = Date.now();

    return NextResponse.json({ stats, cached: false }, { headers: CACHE_1H });
  } catch (error) {
    console.error("Error fetching country stats:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
