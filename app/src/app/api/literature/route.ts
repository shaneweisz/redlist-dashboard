import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import {
  DEFAULT_PER_SOURCE_LIMIT,
  getLiteraturePool,
} from "@/lib/literature/aggregate";
import {
  assessmentSortStamp,
  countAroundAssessment,
  findMarkerPosition,
  paginate,
} from "@/lib/literature/timeline";

/**
 * Literature timeline API
 *
 * One chronological list of everything published about a species, newest
 * first, paginated, with the position of the species' last assessment marked
 * in it — replacing the old pre-/post-assessment split, which forced a reader
 * to switch modes to answer "what has appeared since we last looked?".
 *
 * Sources are merged and deduplicated (see `lib/literature/`): OpenAlex and
 * Zenodo need no credentials; BHL and Google Books activate when their API keys
 * are configured; and the assessment's own reference list comes from the Red
 * List API, so a row can show that the last assessment cited it. Every source's
 * outcome is reported in `sources` so an absent one is visible rather than
 * silently narrowing the results.
 *
 * Query parameters:
 *   scientificName  (required) accepted binomial; Latin gender variants are added
 *   assessmentDate  ISO date of the last assessment — where the marker goes
 *   assessmentYear  fallback when only the year is known (placed mid-year)
 *   assessmentId    the latest assessment, whose reference list is one of the sources
 *   page            1-based, clamped into range (default 1)
 *   perPage         1-50 (default 10)
 */

const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE = 50;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const scientificName = searchParams.get("scientificName");
  const assessmentDate = searchParams.get("assessmentDate");
  const assessmentYear = searchParams.get("assessmentYear");
  const assessmentId = searchParams.get("assessmentId");

  if (!scientificName) {
    return NextResponse.json(
      { error: "Query parameter 'scientificName' is required" },
      { status: 400 },
    );
  }

  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, parseInt(searchParams.get("perPage") || String(DEFAULT_PER_PAGE), 10) || DEFAULT_PER_PAGE),
  );

  // A full date puts the marker on the right day; a bare year is placed
  // mid-year, the same convention imprecise publication dates use.
  const markerStamp = assessmentSortStamp(assessmentDate) ?? assessmentSortStamp(assessmentYear);

  try {
    const { pool, cached } = await getLiteraturePool(
      scientificName,
      assessmentId,
      DEFAULT_PER_SOURCE_LIMIT,
    );

    const markerPosition = findMarkerPosition(pool.works, markerStamp);
    const timeline = paginate(pool.works, page, perPage, markerPosition);
    const counts = countAroundAssessment(pool.works, markerStamp);

    // The biggest single-source total is the closest honest answer to "how much
    // is out there?" — the sources overlap heavily, so summing would inflate it.
    const upstreamTotal = pool.sources.reduce<number | null>(
      (max, s) => (s.upstreamTotal === null ? max : Math.max(max ?? 0, s.upstreamTotal)),
      null,
    );

    return NextResponse.json(
      {
        scientificName: pool.scientificName,
        assessmentId: pool.assessmentId,
        nameVariants: pool.nameVariants,
        assessmentDate: assessmentDate || (assessmentYear ? String(assessmentYear) : null),
        assessmentStamp: markerStamp,
        ...timeline,
        counts,
        upstreamTotal,
        /** True when at least one source holds more than we pulled into the pool. */
        poolTruncated: pool.sources.some(
          (s) => s.upstreamTotal !== null && s.fetched > 0 && s.upstreamTotal > s.fetched,
        ),
        sources: pool.sources,
        cached,
      },
      { headers: CACHE_1H },
    );
  } catch (error) {
    console.error("Literature timeline error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 },
    );
  }
}
