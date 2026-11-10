/**
 * GET /api/gbif-link?key=<our CoL id>&page=species|occurrences&<gbif.org params>
 *
 * A link to gbif.org for a species, sent there with the ids GBIF's live index
 * files its records under (gbif-live-keys.ts): between GBIF re-indexing against
 * a newer CoL release and our next sync, our id can find nothing on gbif.org.
 * Every other parameter is passed through to the occurrence search unchanged.
 */
import { NextRequest, NextResponse } from "next/server";
import { liveGbifKeys, setKeys } from "@/lib/gbif-live-keys";

export async function GET(request: NextRequest) {
  const params = new URLSearchParams(request.nextUrl.searchParams);
  const key = params.get("key");
  if (!key || !/^[A-Za-z0-9]+$/.test(key)) return NextResponse.json({ error: "key is required" }, { status: 400 });
  const page = params.get("page");
  params.delete("key");
  params.delete("page");
  const keys = await liveGbifKeys(key);
  // A species page shows one taxon: the live release's id where there is one (listed last).
  const url = page === "species"
    ? `https://www.gbif.org/species/${keys.at(-1) ?? key}`
    : `https://www.gbif.org/occurrence/search?${setKeys(params, "taxonKey", keys)}`;
  return NextResponse.redirect(url, 302);
}
