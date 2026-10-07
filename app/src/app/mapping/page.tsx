/**
 * The map on its own, about a place rather than a species: /mapping.
 *
 * The same map as /mapping/<species key> with no species in the address — so
 * the same overlays, toolbar and callouts, and none of the records.
 *
 * The species map's overlays and its nearby-species search, reachable without
 * first knowing a species. On the occurrence map the search hangs off a record,
 * which is the right doorway for an assessor working a taxon and the wrong one
 * for everybody else — the question names a place, and until /near-me the only
 * way to ask it was to pick some species you didn't care about and click one
 * of its dots. It was /near-me until it carried the same overlays as the
 * species map; links to the old address are redirected here (next.config.ts).
 *
 * A route of its own rather than a card on the dashboard, for the same reason
 * /compare and /narrative-search are: it wants the whole window (a map with a
 * table under it), and it has nothing to say about the taxon selection the
 * dashboard is built around.
 *
 * Nothing is resolved server-side — every answer comes from GBIF, the overlays'
 * own services and the two /api/nearby-species routes, in the browser — so this
 * is a static shell around a client view.
 */
import type { Metadata } from "next";
import MapPageHeader from "@/components/mapping/MapPageHeader";
import NearbyView from "./NearbyView";
import { snapRadiusKm, parseScope } from "@/lib/mapping/nearby-species";

export const metadata: Metadata = {
  title: "Map",
  description:
    "Protected areas, habitat, forest loss, ecoregions and GBIF sampling effort at any point — and the threatened species with GBIF records nearby, with the threats their Red List assessments cite.",
};

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const lat = Number(one("lat"));
  const lng = Number(one("lng"));
  // A link that carries a point opens on its search. Anything unreadable is
  // simply not a point, and the map opens on the world.
  const initial =
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      // Snapped to the same grid the view searches on, so a shared link is a
      // cache hit rather than a near-miss of one.
      ? {
          lat: Number(lat.toFixed(3)),
          lng: Number(lng.toFixed(3)),
          radiusKm: snapRadiusKm(one("r")),
          scope: parseScope(one("scope")),
        }
      : null;

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-zinc-900">
      <MapPageHeader title="Map" />
      <div className="min-h-0 flex-1">
        <NearbyView initial={initial} />
      </div>
    </div>
  );
}
