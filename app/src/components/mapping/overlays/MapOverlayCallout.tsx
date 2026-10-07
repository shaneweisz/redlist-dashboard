"use client";

/**
 * What the overlays say about the point last clicked, in one panel beside it.
 *
 * One section per overlay that answered — the protected areas covering the
 * spot, its habitat class, the forest rasters, its ecoregion, its sampling
 * effort — each closeable on its own. Placed by MapShapeCallout, so it sits
 * beside the boundaries it names rather than over them.
 *
 * A map can put something of its own above the sections (`header`), and an
 * action under each protected area (`areaAction`): /map uses both to offer the
 * nearby-species search, of the point and of the area.
 *
 * Rendered inside the map, and imported with `ssr: false`.
 */

import type { ReactNode } from "react";
import MapShapeCallout from "@/components/mapping/MapShapeCallout";
import type { MapOverlays } from "@/hooks/mapping/useMapOverlays";
import { effortAt } from "@/hooks/mapping/useSamplingEffort";
import { highlightColour, protectedPlanetUrl, type ProtectedArea } from "@/lib/mapping/protected-areas";
import { HABITAT_SCHEME_URL } from "@/lib/mapping/habitat-map";
import { hasForestAnswer } from "@/lib/mapping/forest-point-query";
import { FOREST_LOSS_CANOPY_THRESHOLD } from "@/lib/mapping/forest-loss";
import { oneEarthEcoregionUrl } from "@/lib/mapping/map-overlays";
import { EFFORT_GROUP_LABELS, formatEffort, gbifSearchUrl } from "@/lib/mapping/sampling-effort";
// The table's own labels, so a basis of record is worded the same wherever it
// appears.
import { BASIS_LABELS } from "@/components/mapping/OccurrenceListTable";

/** Every position in a geometry, flattened — enough to take a bounding box. */
function positionsOf(geometry: GeoJSON.Geometry): GeoJSON.Position[] {
  const out: GeoJSON.Position[] = [];
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number") out.push(node as GeoJSON.Position);
    else for (const child of node) walk(child);
  };
  if ("coordinates" in geometry) walk(geometry.coordinates);
  return out;
}

const CloseButton = ({ onClick }: { onClick: () => void }) => (
  <button
    onClick={onClick}
    title="Close"
    className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
  >
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  </button>
);

const SectionTitle = ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
  <div className="flex items-baseline gap-1 pb-0.5">
    <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{children}</span>
    <CloseButton onClick={onClose} />
  </div>
);

export default function MapOverlayCallout({
  overlays,
  panelId,
  header,
  areaAction,
  width,
}: {
  overlays: MapOverlays;
  panelId: string;
  /** Above the overlays' sections, anchored at its own point. */
  header?: { lng: number; lat: number; content: ReactNode } | null;
  /** Under each protected area listed — what the map can do with it. */
  areaAction?: (area: ProtectedArea, index: number) => ReactNode;
  /** The panel's width in pixels, when its contents want more than the default. */
  width?: number;
}) {
  const o = overlays;
  const areasHere = o.clickedAreas?.panelId === panelId ? o.clickedAreas : null;
  const eco = o.showEcoregions && o.selectedEcoregion?.panelId === panelId ? o.selectedEcoregion : null;
  const hab = o.showHabitat && o.clickedHabitat?.panelId === panelId ? o.clickedHabitat : null;
  const forest =
    (o.showLossDrivers || o.showForestLoss) && o.clickedForest?.panelId === panelId ? o.clickedForest : null;
  const effort =
    o.showSamplingEffort && o.effortLayer && o.effortCellAtPoint && o.clickedEffort?.panelId === panelId
      ? { ...o.clickedEffort, layer: o.effortLayer, cell: o.effortCellAtPoint }
      : null;
  if (!header && !areasHere && !eco && !hab && !forest && !effort) return null;

  // The extent of everything being highlighted, so the callout can sit outside
  // it. Habitat and sampling effort have no shape here — each is read at a
  // point — so on their own they anchor to their click.
  const shapes: GeoJSON.Geometry[] = [];
  for (const area of areasHere?.areas ?? []) if (area.geometry) shapes.push(area.geometry);
  if (eco) shapes.push(eco.geometry);
  let bounds: [number, number, number, number] | null = null;
  for (const shape of shapes) {
    for (const position of positionsOf(shape)) {
      bounds = bounds
        ? [
            Math.min(bounds[0], position[0]),
            Math.min(bounds[1], position[1]),
            Math.max(bounds[2], position[0]),
            Math.max(bounds[3], position[1]),
          ]
        : [position[0], position[1], position[0], position[1]];
    }
  }
  const at = header ?? areasHere ?? eco ?? forest ?? hab ?? effort!;

  // A rule above every section but the first, whichever that turns out to be.
  let sections = 0;
  const divider = () => (sections++ > 0 ? "pt-1.5 border-t border-zinc-100 dark:border-zinc-700" : "");

  return (
    <MapShapeCallout bounds={bounds} lng={at.lng} lat={at.lat} width={width}>
      <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-md border border-zinc-200 dark:border-zinc-700 px-2 py-1.5 text-[11px] text-zinc-700 dark:text-zinc-200 space-y-1.5">
        {header && <div className={divider()}>{header.content}</div>}
        {areasHere && (
          <div className={divider()}>
            <SectionTitle onClose={() => o.setClickedAreas(null)}>Protected areas</SectionTitle>
            <div className="space-y-1">
              {/* Says up front that there is more than one, before you have to
                  infer it from the length of the list. */}
              {areasHere.areas.length > 1 && (
                <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
                  {areasHere.areas.length} overlapping designations here
                </div>
              )}
              {areasHere.areas.map((area, index) => (
                <div
                  key={area.sitePid}
                  onMouseEnter={() => o.setClickedAreas((prev) => (prev ? { ...prev, highlight: index } : prev))}
                  className={`-mx-1 px-1 py-0.5 rounded flex gap-1.5 ${
                    index === areasHere.highlight ? "bg-zinc-100 dark:bg-zinc-800" : ""
                  }`}
                >
                  {/* The swatch is what ties this row to its outline on the map.
                      Only drawn when there's more than one site — a single
                      colour keyed to nothing is just decoration. */}
                  {areasHere.areas.length > 1 && (
                    <span
                      className="mt-1 w-2 h-2 rounded-sm shrink-0"
                      style={{ background: highlightColour(index) }}
                      title="This site's outline on the map"
                    />
                  )}
                  <div className="min-w-0">
                    <a
                      href={protectedPlanetUrl(area)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open this site on Protected Planet"
                      className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {area.name}
                    </a>
                    <div className="text-zinc-500 dark:text-zinc-400">
                      {[
                        area.designation,
                        area.iucnCategory ? `IUCN ${area.iucnCategory}` : null,
                        area.statusYear ? String(area.statusYear) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    {areaAction?.(area, index)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {hab && (
          <div className={divider()}>
            <SectionTitle onClose={() => o.setClickedHabitat(null)}>Habitat</SectionTitle>
            {hab.loading ? (
              <span className="text-zinc-400">Reading habitat…</span>
            ) : hab.habitat == null ? (
              <span className="text-zinc-400">No habitat class mapped here.</span>
            ) : (
              <div className="flex items-start gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0 translate-y-1"
                  style={{ background: hab.habitat.color }}
                />
                <div className="min-w-0">
                  {hab.habitat.name}{" "}
                  <a
                    href={HABITAT_SCHEME_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="IUCN Habitats Classification Scheme"
                    className="tabular-nums text-zinc-400 hover:underline"
                  >
                    {hab.habitat.code}
                  </a>
                </div>
              </div>
            )}
          </div>
        )}
        {forest && (
          <div className={divider()}>
            <SectionTitle onClose={() => o.setClickedForest(null)}>Forest</SectionTitle>
            {forest.loading ? (
              <span className="text-zinc-400">Reading the rasters…</span>
            ) : forest.point == null || !hasForestAnswer(forest.point) ? (
              <span className="text-zinc-400">No tree cover loss recorded here.</span>
            ) : (
              <div className="space-y-0.5">
                {/* The class, and nothing else about it. What each driver
                    covers is a sentence long and lives in the legend, a hover
                    away on the same swatch — repeating it here made a two-line
                    answer into a paragraph. */}
                {forest.point.driver && (
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: forest.point.driver.color }}
                    />
                    <span className="font-medium text-zinc-600 dark:text-zinc-300">
                      {forest.point.driver.label}
                    </span>
                  </div>
                )}
                <div className="text-zinc-500 dark:text-zinc-400 tabular-nums">
                  {[
                    forest.point.lossYear ? `Loss ${forest.point.lossYear}` : null,
                    forest.point.canopyPercent != null ? `${forest.point.canopyPercent}% canopy 2000` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {/* The three qualifiers as one line. All of them still need
                    saying — a driver is the dominant one for a 1 km cell, the
                    point query answers for ground the layers leave blank, and
                    the loss it was measured from is 30 m so a spot can sit in a
                    cell without having lost anything. As three sentences they
                    were most of the card, and a caveat that long stops being
                    read. */}
                {forest.point.driver && (
                  <div className="text-zinc-400">
                    {[
                      "Dominant driver, 1 km cell",
                      forest.point.lossYear ? null : "no loss at this 30 m pixel",
                      forest.point.belowThreshold
                        ? `below the ${FOREST_LOSS_CANOPY_THRESHOLD}% canopy cut, so not shaded`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {eco && (
          <div className={divider()}>
            <SectionTitle onClose={() => o.setSelectedEcoregion(null)}>Ecoregion</SectionTitle>
            <div className="flex items-start gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0 translate-y-1 border border-black/10"
                style={{ background: eco.properties.biomeColor }}
              />
              <div className="min-w-0">
                <div className="font-medium">{eco.properties.name}</div>
                <div className="text-zinc-400">{eco.properties.biome}</div>
                <div className="text-zinc-400">
                  {eco.properties.realm} · {eco.properties.nnh}
                </div>
                {eco.properties.oneEarth && (
                  <a
                    href={oneEarthEcoregionUrl(eco.properties.oneEarth)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Read about it on One Earth
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
        {effort && (
          <div className={divider()}>
            <SectionTitle onClose={() => o.setClickedEffort(null)}>Sampling effort</SectionTitle>
            <div className="max-w-[16rem]">
              {(() => {
                const records = effortAt(effort.layer, effort.lng, effort.lat);
                return (
                  <>
                    <span className="font-medium text-zinc-700 dark:text-zinc-200">
                      {records == null
                        ? `No ${EFFORT_GROUP_LABELS[effort.layer.group].toLowerCase()} records when this was published`
                        : formatEffort(records, effort.cell.widthKm)}
                    </span>
                    <span className="block text-zinc-400">{EFFORT_GROUP_LABELS[effort.layer.group]}, all years</span>
                    {/* The layer is a snapshot published with the paper; this
                        is what GBIF holds today. They differ by a lot and
                        neither is wrong, so both are shown and both are
                        labelled. */}
                    <span className="block text-zinc-500 dark:text-zinc-400">
                      {o.gbifCellCountLoading
                        ? "Counting on GBIF…"
                        : o.gbifCellCount == null
                          ? ""
                          : `${o.gbifCellCount.toLocaleString()} on GBIF today`}
                    </span>
                    {/* Broken down, because the total alone doesn't say what
                        kind of looking happened here. A cell of photographs and
                        a cell of herbarium sheets are different evidence about
                        whether a plant would have been collected if it were
                        present. Each kind is its own search, so the answer is
                        one click rather than a filter to set again on GBIF. */}
                    {o.gbifCellByBasis.length > 0 && (
                      <span className="block pl-2 border-l border-zinc-200 dark:border-zinc-700">
                        {o.gbifCellByBasis.slice(0, 4).map((b) => (
                          <a
                            key={b.basis}
                            href={gbifSearchUrl(effort.cell.bounds, effort.layer.group, [b.basis])}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
                          >
                            <span className="tabular-nums">{b.count.toLocaleString()}</span>{" "}
                            {BASIS_LABELS[b.basis] ?? b.basis.replace(/_/g, " ").toLowerCase()}
                          </a>
                        ))}
                      </span>
                    )}
                    <a
                      href={gbifSearchUrl(effort.cell.bounds, effort.layer.group)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open this cell on GBIF, filtered to the same taxon. The total there is today's; the figure above is the snapshot this layer was published with."
                      className="block text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Inspect these records on GBIF
                    </a>
                  </>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </MapShapeCallout>
  );
}
