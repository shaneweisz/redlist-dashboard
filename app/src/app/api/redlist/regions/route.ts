/**
 * The regions the dashboard can be scoped to (lib/region-scope.ts), from
 * regional-assessed.parquet: each with how many species it has assessed.
 */
import { NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import { getConn, parquetUri } from "@/lib/data/species-duckdb";

export async function GET() {
  try {
    const conn = await getConn();
    const rows = (await conn.runAndReadAll(
      `SELECT region, count(*)::INT AS species FROM read_parquet('${parquetUri("regional-assessed.parquet")}') GROUP BY 1 ORDER BY 2 DESC`
    )).getRowObjects();
    return NextResponse.json({ regions: rows.map((r) => ({ region: String(r.region), species: Number(r.species) })) }, { headers: CACHE_1H });
  } catch (error) {
    // A sync without the regional file: no regions, so no scope picker.
    console.error("regions error:", error);
    return NextResponse.json({ regions: [] }, { headers: CACHE_1H });
  }
}
