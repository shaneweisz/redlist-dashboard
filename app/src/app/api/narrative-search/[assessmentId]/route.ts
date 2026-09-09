/**
 * GET /api/narrative-search/<assessment id>
 *
 * Every narrative field of one assessment, in full — what a search result
 * expands into when a reader wants the rest of the section rather than the
 * sentence around their words.
 *
 * Its own request rather than part of the search: a page of ten results is ten
 * assessments' complete prose, most of which nobody opens.
 */
import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import { getNarrative } from "@/lib/data/narratives-duckdb";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ assessmentId: string }> }
) {
  const { assessmentId } = await params;
  const id = Number(assessmentId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "assessment id must be a positive integer" }, { status: 400 });
  }

  try {
    const narrative = await getNarrative(id);
    if (!narrative) {
      return NextResponse.json({ error: "No narratives for that assessment" }, { status: 404 });
    }
    return NextResponse.json(narrative, { headers: CACHE_1H });
  } catch (error) {
    console.error("narrative fetch failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
