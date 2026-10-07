/**
 * The overlay stack, bottom to top — and the reason it has to be written down.
 *
 * MapLibre draws layers in the order they were *added*, and react-map-gl adds
 * a `<Layer>` when it mounts. Every overlay here mounts on a checkbox, so the
 * order on screen was the order the boxes happened to be ticked, not the order
 * the JSX is written in. That made the layers below silently wrong rather than
 * broken: ticking tree cover loss after the drivers layer put a near-opaque
 * sheet of pink over it, so "tree cover loss by dominant driver" appeared to do
 * nothing at all — the one combination an assessor is most likely to try,
 * since the drivers layer exists to answer the question the loss layer raises.
 * The same applied to the habitat and protected-area rasters, and to the
 * occurrence circles, which the rasters covered instead of the reverse.
 *
 * So the stack is declared once, here, and each layer names the band it
 * belongs in. Each band is anchored by a hidden, always-mounted layer, and a
 * layer joins its band with `beforeId`, which inserts it in the right place
 * whatever order it mounted in. Within a band the mount order still decides,
 * which is what the JSX order is for.
 *
 * Shared by the species map and /map, so a layer the two have in common sits
 * at the same height on both.
 */
export const MAP_LAYER_SLOTS = [
  /** Sampling effort: whether anyone has looked here. Under everything. */
  "effort",
  "ecoregions",
  "habitat",
  "forest-loss",
  /** Above the loss it classifies — this is the layer that says why. */
  "loss-drivers",
  "protected-areas",
  /** POWO/IUCN native range polygons. */
  "ranges",
  /** The nearby search's radius: the question's boundary, under its answers. */
  "nearby-radius",
  /**
   * The GPS uncertainty rings, under the dots whose ground they are. Its own
   * band rather than the records' because the toggle mounts them after the
   * points are already on the map, and within a band mount order decides — so
   * sharing "records" would have put the rings over the dots they belong to.
   */
  "uncertainty",
  /** The species' own GBIF records. */
  "records",
  /** A picked neighbour's records, above this species' own. */
  "nearby-points",
  /** The assessor's own georeferences, above every published record. */
  "georeferences",
  /** EOO/AOO and measuring — always readable over the data they describe. */
  "tools",
] as const;

export type MapLayerSlot = (typeof MAP_LAYER_SLOTS)[number];

/**
 * The anchor that marks the top of a band. A layer passing this as `beforeId`
 * lands immediately below it, and so above every band declared earlier.
 */
export const slotId = (slot: MapLayerSlot, panelId: string) => `slot-${slot}-${panelId}`;

/** The latitude Web Mercator stops at, and so the top edge of a world PNG. */
export const MERCATOR_LIMIT = 85.051129;
