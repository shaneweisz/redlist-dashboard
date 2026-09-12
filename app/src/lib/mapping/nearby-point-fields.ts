/**
 * A neighbour's record, as the tooltip reads it out.
 *
 * A picked neighbour's dot answers the same question the map's own records do
 * — what is it, who collected it, where does it say it is — and it answers in
 * the same panel. Which fields, in which order, and how each is written is
 * therefore not a decision either map should be making on its own: the
 * occurrence map and the standalone "near here" view both call this, so a
 * record looks the same whichever of them you clicked it on.
 *
 * Deliberately not `recordFields` from the occurrence map: that one describes a
 * record the assessor is deciding about, and carries the things that go with
 * deciding — our cleaning flags, the georeference being edited, the exclusion.
 * A neighbour has none of those. It is somebody else's record, shown as
 * published.
 */
import { formatDistance } from "@/lib/mapping/geo-distance";
import type { NearbyPoint } from "@/lib/mapping/nearby-species";

export function nearbyPointFields(
  point: NearbyPoint,
  /** The species name from the pick, for the records GBIF sends without one. */
  fallbackSpecies?: string | null
): { label: string; value: string }[] {
  return [
    { label: "Species", value: point.species ?? fallbackSpecies ?? "" },
    ...(point.basis
      ? [{ label: "Basis", value: point.basis.replace(/_/g, " ").toLowerCase() }]
      : []),
    ...(point.eventDate || point.year
      ? [{ label: "Date", value: point.eventDate ?? String(point.year) }]
      : []),
    ...(point.locality ? [{ label: "Locality", value: point.locality }] : []),
    ...(point.countryCode ? [{ label: "Country", value: point.countryCode }] : []),
    { label: "Coordinates", value: `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` },
    ...(point.uncertaintyMetres != null
      ? [{ label: "GPS uncertainty", value: formatDistance(point.uncertaintyMetres) }]
      : []),
    ...(point.catalogNumber ? [{ label: "Catalogue no.", value: point.catalogNumber }] : []),
    ...(point.recordedBy ? [{ label: "Recorded by", value: point.recordedBy }] : []),
    ...(point.identifiedBy ? [{ label: "Identified by", value: point.identifiedBy }] : []),
    ...(point.datasetName ? [{ label: "Dataset", value: point.datasetName }] : []),
  ];
}
