/**
 * GET /api/gbif-link?key=<the lists' key>&page=species|occurrences&<gbif.org params>
 *
 * A link to gbif.org for a species, sent there with the key GBIF's live index
 * uses (gbif-live-keys.ts): the lists follow CoL's newest release and GBIF
 * re-indexes a few times a year, so a key in the lists can name nothing on gbif.org.
 * Every other parameter is passed through to the occurrence search unchanged.
 */
import { NextRequest, NextResponse } from "next/server";
import { liveGbifKey } from "@/lib/gbif-live-keys";

export async function GET(request: NextRequest) {
  const params = new URLSearchParams(request.nextUrl.searchParams);
  const key = params.get("key");
  if (!key || !/^[A-Za-z0-9]+$/.test(key)) return NextResponse.json({ error: "key is required" }, { status: 400 });
  const page = params.get("page");
  params.delete("key");
  params.delete("page");
  const live = await liveGbifKey(key);
  const url = page === "species"
    ? `https://www.gbif.org/species/${live}`
    : `https://www.gbif.org/occurrence/search?${new URLSearchParams([["taxonKey", live], ...params])}`;
  return NextResponse.redirect(url, 302);
}
