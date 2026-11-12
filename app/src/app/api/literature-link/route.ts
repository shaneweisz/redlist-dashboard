/**
 * GET /api/literature-link?sis=<sis_taxon_id>|col=<col_id>&name=<binomial>[&since=YYYY-MM-DD]
 *
 * A species' OpenAlex count, opened on OpenAlex as the works it counted: OpenAlex
 * filtered to their ids (the sync's paper_works), newest first, up to the 100 a
 * filter takes. A name search can't reproduce the count (it misses synonyms and
 * abbreviated genera, and finds what the sync's rules leave out), so the link
 * lists the works instead. `since` narrows to the works counted as New.
 *
 * If the works can't be read (a sync without them), it falls back to OpenAlex's
 * search for the name, so a link never dead-ends.
 */
import { NextRequest, NextResponse } from "next/server";
import { getLiteratureWorks } from "@/lib/data/literature-works";
import { literatureSearchUrl, openAlexWorksUrl, OPENALEX_LINK_MAX_WORKS } from "@/lib/literature";

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const sis = p.get("sis"), col = p.get("col"), name = p.get("name") ?? "", since = p.get("since");
  const sisTaxonId = sis != null ? Number(sis) : undefined;
  if ((sisTaxonId == null || !Number.isInteger(sisTaxonId) || sisTaxonId <= 0) && !(col && /^[A-Za-z0-9]+$/.test(col))) {
    return NextResponse.json({ error: "sis or col is required" }, { status: 400 });
  }
  if (since != null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return NextResponse.json({ error: "since must be YYYY-MM-DD" }, { status: 400 });
  const fallback = literatureSearchUrl("openalex", name, since);
  try {
    const { works } = await getLiteratureWorks({
      sisTaxonId: sisTaxonId && sisTaxonId > 0 ? sisTaxonId : undefined, colId: col ?? undefined,
      since: since ?? undefined, limit: OPENALEX_LINK_MAX_WORKS,
    });
    if (works.length > 0) return NextResponse.redirect(openAlexWorksUrl(works), 302);
  } catch (error) {
    console.error("literature-link: falling back to a name search:", error);
  }
  if (fallback) return NextResponse.redirect(fallback, 302);
  return NextResponse.json({ error: "no works found" }, { status: 404 });
}
