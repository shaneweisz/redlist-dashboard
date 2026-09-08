/**
 * GET /api/narrative-search?q=&limit=&offset=&phrase=
 *
 * The assessments whose narratives mention every word of `q`, with the field
 * and the words around the first mention. `phrase=true` keeps only those where
 * the words appear together, as typed.
 *
 * See lib/data/narratives-duckdb.ts for why this reads a term index rather than
 * the prose, and scripts/build-narratives.ts for how both are built.
 */
import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import { searchNarratives } from "@/lib/data/narratives-duckdb";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ error: "q is required, and must be at least two characters" }, { status: 400 });
  }

  try {
    const started = Date.now();
    const result = await searchNarratives({
      query: q,
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      offset: sp.get("offset") ? Number(sp.get("offset")) : undefined,
      phrase: sp.get("phrase") === "true",
    });
    return NextResponse.json({ ...result, ms: Date.now() - started }, { headers: CACHE_1H });
  } catch (error) {
    console.error("narrative search failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 }
    );
  }
}
