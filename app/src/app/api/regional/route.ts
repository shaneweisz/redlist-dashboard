/**
 * The Regional view's data, from regional-assessments.parquet
 * (scripts/sync/sources/regional-assessments.ts).
 *
 *   GET /api/regional                      every region, with its totals
 *   GET /api/regional?region=Europe        one region: per-country totals for
 *                                          the map, and every species' row
 *   ...&country=FR                         rows narrowed to species native to FR
 */
import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import { getConn, parquetUri } from "@/lib/data/species-duckdb";
import type { RegionDetail, RegionSummary, RegionalRow } from "@/lib/regional/regional";

const FILE = () => `read_parquet('${parquetUri("regional-assessments.parquet")}')`;
const THREATENED = `category IN ('CR', 'EN', 'VU')`;

export async function GET(request: NextRequest) {
  const conn = await getConn();
  const region = request.nextUrl.searchParams.get("region");
  const country = request.nextUrl.searchParams.get("country")?.toUpperCase() ?? null;

  if (!region) {
    const rows = (await conn.runAndReadAll(`
      SELECT region, count(*)::INT AS species, count(*) FILTER (${THREATENED})::INT AS threatened,
             count(*) FILTER (global_category IS NULL)::INT AS "noGlobal"
      FROM ${FILE()} GROUP BY 1 ORDER BY 2 DESC`)).getRowObjectsJson() as unknown as RegionSummary[];
    return NextResponse.json({ regions: rows }, { headers: CACHE_1H });
  }
  if (country !== null && !/^[A-Z]{2}$/.test(country)) {
    return NextResponse.json({ error: "country must be a two-letter code" }, { status: 400 });
  }

  const countryRows = (await conn.runAndReadAll(`
    SELECT code, count(*)::INT AS species, count(*) FILTER (${THREATENED})::INT AS threatened
    -- NA (Not Applicable) species aren't assessed in the region: vagrants and
    -- introductions, often wide-ranging, which would tint the whole world.
    FROM (SELECT unnest(countries) AS code, category FROM ${FILE()} WHERE region = $region AND category <> 'NA')
    GROUP BY 1`, { region })).getRowObjectsJson() as { code: string; species: number; threatened: number }[];

  const rows = (await conn.runAndReadAll(`
    SELECT sis_taxon_id::INT AS sis, assessment_id::INT AS "assessmentId", scientific_name AS name, common_name AS common,
           taxon_group AS "group", category, criteria, year_published AS year,
           global_category AS "globalCategory", global_year AS "globalYear"
    FROM ${FILE()} WHERE region = $region ${country ? "AND list_contains(countries, $country)" : ""}
    ORDER BY scientific_name`, country ? { region, country } : { region })).getRowObjectsJson() as unknown as RegionalRow[];

  const body: RegionDetail = {
    region,
    countries: Object.fromEntries(countryRows.map((c) => [c.code, { species: c.species, threatened: c.threatened }])),
    rows,
  };
  return NextResponse.json(body, { headers: CACHE_1H });
}
