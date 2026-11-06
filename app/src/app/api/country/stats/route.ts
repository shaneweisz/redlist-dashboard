import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import {
  gbifOccurrenceParams,
  gbifTaxonKeysForGroup,
  taxonGroupCountsPreservedSpecimens,
} from "@/lib/gbif";
import { GBIF_RECORDS_PARAM, parseGbifRecordMode } from "@/lib/gbif-records";

interface CountryStats {
  [countryCode: string]: {
    occurrences: number;
    species: number;
  };
}

// Cache the results for 1 hour, keyed by taxon
const cachedStats: Record<string, CountryStats> = {};
const cacheTime: Record<string, number> = {};
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const taxonId = searchParams.get("taxon") || "plantae";

  // Georeferenced records (the default) or all records, as the counts beside the map.
  const mode = parseGbifRecordMode(searchParams.get(GBIF_RECORDS_PARAM));
  const cacheKey = `${taxonId}|${mode}`;

  // Return cached data if still valid
  if (cachedStats[cacheKey] && Date.now() - (cacheTime[cacheKey] || 0) < CACHE_DURATION) {
    return NextResponse.json({ stats: cachedStats[cacheKey], cached: true }, { headers: CACHE_1H });
  }

  try {
    // One query per GBIF taxon key making up this group, combined by country.
    //
    // The keys come from the generated config, which is derived from the Red List
    // group definitions. They used to be a hand-kept list of backbone integers in
    // src/config/taxa.ts; that list did not move when the pipeline moved to
    // Catalogue of Life, so every request here named the CoL checklist while
    // sending a backbone key and GBIF returned an empty result set for all of
    // them — a blank occurrence layer on the world map, with nothing raised.
    //
    // This also removed a second bug: the old branching fell through to querying
    // an entire kingdom for any group defined by order keys, which is what Fishes
    // was doing.
    const taxonKeys = gbifTaxonKeysForGroup(taxonId);
    const stats: CountryStats = {};
    // Plants and fungi count herbarium/fungarium material, matching the totals
    // the sync writes — otherwise the map's per-country occurrence layer
    // disagrees with every plant count shown next to it.
    const includePreservedSpecimens = taxonGroupCountsPreservedSpecimens(taxonId);

    const results = await Promise.all(
      taxonKeys.map(async (taxonKey) => {
        const params = gbifOccurrenceParams({
          taxonKey,
          facet: "country",
          facetLimit: "300",
          limit: "0",
        }, { includePreservedSpecimens, mode });
        const response = await fetch(`https://api.gbif.org/v1/occurrence/search?${params}`);
        if (!response.ok) return null;
        return response.json();
      })
    );

    for (const result of results) {
      if (!result) continue;
      const countryFacets = result.facets?.find(
        (f: { field: string }) => f.field === "COUNTRY"
      );
      if (!countryFacets?.counts) continue;
      for (const facet of countryFacets.counts) {
        if (!stats[facet.name]) stats[facet.name] = { occurrences: 0, species: 0 };
        stats[facet.name].occurrences += facet.count;
      }
    }

    // Cache the results by taxon
    cachedStats[cacheKey] = stats;
    cacheTime[cacheKey] = Date.now();

    return NextResponse.json({ stats, cached: false }, { headers: CACHE_1H });
  } catch (error) {
    console.error("Error fetching country stats:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
