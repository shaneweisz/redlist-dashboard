import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import {
  gbifOccurrenceParams,
  gbifTaxonKeysForGroup,
  taxonGroupCountsPreservedSpecimens,
} from "@/lib/gbif";
import { gbifJson } from "@/lib/gbif-fetch";

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

  const cacheKey = taxonIds.join(",");

  // Return cached data if still valid
  if (cachedStats[cacheKey] && Date.now() - (cacheTime[cacheKey] || 0) < CACHE_DURATION) {
    return NextResponse.json({ stats: cachedStats[cacheKey], cached: true }, { headers: CACHE_1H });
  }

  try {
    // GBIF ORs repeated taxonKey parameters, so every key of every requested group
    // goes into one query per basisOfRecord set — at most two (plants and fungi
    // count herbarium/fungarium material, matching the totals the sync writes;
    // animals don't). This used to be one query per key: 49 for invertebrates
    // alone, the slowest taking 24s, and Sentry flagging the fan-out as an N+1.
    // The groups' keys are disjoint, so one faceted query returns exactly what
    // summing the per-key queries did (checked against the live API: fishes' five
    // keys gave 5,353,556 GB records either way).
    //
    // The keys come from the generated config, derived from the Red List group
    // definitions — a hand-kept list of backbone integers once went stale when the
    // pipeline moved to Catalogue of Life, and GBIF quietly returned nothing.
    const keysByBasis = new Map<boolean, Set<string>>();
    for (const taxonId of taxonIds) {
      const preserved = taxonGroupCountsPreservedSpecimens(taxonId);
      const keys = keysByBasis.get(preserved) ?? new Set<string>();
      for (const key of gbifTaxonKeysForGroup(taxonId)) keys.add(key);
      keysByBasis.set(preserved, keys);
    }

    // gbifJson identifies us to GBIF and retries 429/5xx; anything it still can't
    // get throws, so a failed query is a 502 rather than a group silently missing
    // from the map (and cached that way for an hour).
    const results = await Promise.all(
      [...keysByBasis].filter(([, keys]) => keys.size > 0).map(([includePreservedSpecimens, keys]) => {
        const params = gbifOccurrenceParams(
          { facet: "country", facetLimit: "300", limit: "0" },
          { includePreservedSpecimens },
        );
        for (const key of keys) params.append("taxonKey", key);
        return gbifJson(`https://api.gbif.org/v1/occurrence/search?${params}`) as Promise<GbifFacetResponse>;
      }),
    );

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
