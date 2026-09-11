/**
 * "What threatened species are near me" on its own page: /near-me.
 *
 * The nearby-species search, reachable without first knowing a species. On the
 * occurrence map it hangs off a record, which is the right doorway for an
 * assessor working a taxon and the wrong one for everybody else — the question
 * names a place, and until now the only way to ask it was to pick some species
 * you didn't care about and right-click one of its dots.
 *
 * A route of its own rather than a card on the dashboard, for the same reason
 * /compare and /narrative-search are: it wants the whole window (a map with a
 * table under it), and it has nothing to say about the taxon selection the
 * dashboard is built around.
 *
 * Nothing is resolved server-side — every answer comes from GBIF and from the
 * two /api/nearby-species routes, in the browser — so this is a static shell
 * around a client view.
 */
import type { Metadata } from "next";
import MapPageHeader from "@/components/mapping/MapPageHeader";
import NearbyView from "./NearbyView";
import { snapRadiusKm } from "@/lib/mapping/nearby-species";

export const metadata: Metadata = {
  title: "Threatened species near you",
  description:
    "Critically Endangered, Endangered and Vulnerable species with GBIF records near a point, and the threats their Red List assessments cite.",
};

export default async function NearMePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const lat = Number(one("lat"));
  const lng = Number(one("lng"));
  // A link that carries a point opens on it instead of asking the browser where
  // the reader is — see NearbyMapView. Anything unreadable is simply not a
  // point, and falls back to asking.
  const initial =
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng, radiusKm: snapRadiusKm(one("r")) }
      : null;

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-zinc-900">
      <MapPageHeader title="Threatened species near you" />
      <div className="min-h-0 flex-1">
        <NearbyView initial={initial} />
      </div>
    </div>
  );
}
