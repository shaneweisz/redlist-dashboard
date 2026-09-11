"use client";

/**
 * The client half of /near-me.
 *
 * Its only job is to keep MapLibre off the server: the view underneath reaches
 * for `window` and a WebGL context on mount, so it is imported with
 * `ssr: false` — the same arrangement `mapping/[key]` uses for the occurrence
 * map.
 */
import dynamic from "next/dynamic";
import type { NearbyRadiusKm } from "@/lib/mapping/nearby-species";

const NearbyMapView = dynamic(() => import("@/components/mapping/NearbyMapView"), { ssr: false });

export default function NearbyView({
  initial,
}: {
  initial: { lat: number; lng: number; radiusKm: NearbyRadiusKm } | null;
}) {
  return <NearbyMapView initial={initial} />;
}
