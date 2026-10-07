"use client";

/**
 * The context overlays, drawn — for any map that holds a useMapOverlays.
 *
 * Rendered inside the map, and imported with `ssr: false` like everything else
 * that touches MapLibre. Each layer joins its band of MAP_LAYER_SLOTS, so the
 * map using this must mount those anchors first.
 */

import { Source, Layer } from "react-map-gl/maplibre";
import type { MapOverlays } from "@/hooks/mapping/useMapOverlays";
import { MERCATOR_LIMIT, slotId } from "./layer-slots";
import {
  FOREST_LOSS_ATTRIBUTION,
  FOREST_LOSS_MAX_ZOOM,
  forestLossTileUrl,
} from "@/lib/mapping/forest-loss";
import {
  FOREST_LOSS_DRIVERS_ATTRIBUTION,
  FOREST_LOSS_DRIVERS_MAX_ZOOM,
  FOREST_LOSS_DRIVERS_TILE_URL,
} from "@/lib/mapping/forest-loss-drivers";
import { HABITAT_ATTRIBUTION, HABITAT_TILE_URL } from "@/lib/mapping/habitat-map";
import { ECOREGIONS_ATTRIBUTION } from "@/lib/mapping/map-overlays";
import {
  PROTECTED_AREAS_ATTRIBUTION,
  PROTECTED_AREAS_HUE_ROTATION,
  PROTECTED_AREAS_MAX_ZOOM,
  PROTECTED_AREAS_TILE_URL,
} from "@/lib/mapping/protected-areas";

export default function MapOverlayLayers({
  overlays,
  panelId,
}: {
  overlays: MapOverlays;
  panelId: string;
}) {
  const {
    showSamplingEffort,
    effortLayer,
    showEcoregions,
    ecoregions,
    selectedEcoregionGeoJson,
    showHabitat,
    showForestLoss,
    lossYears,
    showLossDrivers,
    showProtectedAreas,
    highlightedAreaGeoJson,
    clickedAreas,
  } = overlays;

  return (
    <>
      {/* Sampling effort — the very bottom of the stack. It answers whether a
          blank area is empty because the species isn't there or because nobody
          has looked, which is context for everything drawn above it.

          An image source rather than a raster one: the PNG is a single
          world-wide Web Mercator image, and MapLibre maps an image source
          linearly in Mercator space between its corners, which is exactly the
          projection it's already in. At 10 km per source cell it is
          deliberately coarse — the pattern is the point, not any one pixel. */}
      {showSamplingEffort && effortLayer && (
        <Source
          id={`sampling-effort-${panelId}`}
          type="image"
          url={effortLayer.url}
          coordinates={[
            [-180, MERCATOR_LIMIT],
            [180, MERCATOR_LIMIT],
            [180, -MERCATOR_LIMIT],
            [-180, -MERCATOR_LIMIT],
          ]}
        >
          <Layer
            id={`sampling-effort-layer-${panelId}`}
            beforeId={slotId("effort", panelId)}
            type="raster"
            paint={{ "raster-opacity": 0.6, "raster-fade-duration": 0 }}
          />
        </Source>
      )}
      {/* Ecoregions (Dinerstein et al. 2017), drawn in the dataset's own biome
          colours. Fill kept faint and the boundary strong: the useful thing is
          where one ecoregion ends and the next begins, and a heavy fill hides
          the ground being compared. */}
      {showEcoregions && ecoregions && (
        <Source id={`ecoregions-${panelId}`} type="geojson" data={ecoregions} attribution={ECOREGIONS_ATTRIBUTION}>
          <Layer
            id={`ecoregions-fill-${panelId}`}
            beforeId={slotId("ecoregions", panelId)}
            type="fill"
            paint={{ "fill-color": ["get", "biomeColor"], "fill-opacity": 0.22 }}
          />
          <Layer
            id={`ecoregions-line-${panelId}`}
            beforeId={slotId("ecoregions", panelId)}
            type="line"
            paint={{ "line-color": ["get", "biomeColor"], "line-width": 1, "line-opacity": 0.9 }}
          />
        </Source>
      )}
      {/* The clicked ecoregion, outlined. Same treatment as a clicked protected
          area — white casing under a strong line, so the boundary reads over
          whatever basemap is underneath. */}
      {showEcoregions && selectedEcoregionGeoJson && (
        <Source id={`ecoregion-highlight-${panelId}`} type="geojson" data={selectedEcoregionGeoJson}>
          <Layer
            id={`ecoregion-highlight-fill-${panelId}`}
            beforeId={slotId("ecoregions", panelId)}
            type="fill"
            paint={{ "fill-color": "#059669", "fill-opacity": 0.18 }}
          />
          <Layer
            id={`ecoregion-highlight-casing-${panelId}`}
            beforeId={slotId("ecoregions", panelId)}
            type="line"
            paint={{ "line-color": "#ffffff", "line-width": 4.5, "line-opacity": 0.9 }}
          />
          <Layer
            id={`ecoregion-highlight-line-${panelId}`}
            beforeId={slotId("ecoregions", panelId)}
            type="line"
            paint={{ "line-color": "#059669", "line-width": 2 }}
          />
        </Source>
      )}
      {/* Habitat types (Jung et al.) — it covers whole continents, so anything
          drawn over it stays readable and it never hides a boundary or a
          point. */}
      {showHabitat && (
        <Source
          id={`habitat-${panelId}`}
          type="raster"
          tiles={[HABITAT_TILE_URL]}
          tileSize={256}
          attribution={HABITAT_ATTRIBUTION}
        >
          <Layer
            id={`habitat-layer-${panelId}`}
            beforeId={slotId("habitat", panelId)}
            type="raster"
            paint={{ "raster-opacity": 0.55 }}
          />
        </Source>
      )}
      {/* Global Forest Watch tree cover loss, year-coded. Above the habitat
          map, below everything else: the question is what happened inside a
          range, so it sits under the range and the records rather than over
          them. */}
      {showForestLoss && (
        <Source
          // The year range is baked into the tile URL, so a change of range is
          // a different source rather than a repaint of this one — keyed so it
          // is torn down and rebuilt instead of holding the tiles it already
          // fetched.
          key={`forest-loss-${lossYears[0]}-${lossYears[1]}`}
          id={`forest-loss-${panelId}`}
          type="raster"
          tiles={[forestLossTileUrl(lossYears[0], lossYears[1])]}
          tileSize={256}
          maxzoom={FOREST_LOSS_MAX_ZOOM}
          attribution={FOREST_LOSS_ATTRIBUTION}
        >
          {/* No hue rotation any more: these tiles are already the pink the
              old ramp was rotated into. */}
          <Layer
            id={`forest-loss-layer-${panelId}`}
            beforeId={slotId("forest-loss", panelId)}
            type="raster"
            paint={{ "raster-opacity": 0.85 }}
          />
        </Source>
      )}
      {/* What the loss was for, at 1 km. Drawn as the platform draws it — their
          tiles, their colours — because the legend has to be true of the
          pixels, and above the loss layer, since where both are on this is the
          one that answers "why". */}
      {showLossDrivers && (
        <Source
          id={`loss-drivers-${panelId}`}
          type="raster"
          tiles={[FOREST_LOSS_DRIVERS_TILE_URL]}
          tileSize={256}
          maxzoom={FOREST_LOSS_DRIVERS_MAX_ZOOM}
          attribution={FOREST_LOSS_DRIVERS_ATTRIBUTION}
        >
          <Layer
            id={`loss-drivers-layer-${panelId}`}
            beforeId={slotId("loss-drivers", panelId)}
            type="raster"
            paint={{ "raster-opacity": 0.85 }}
          />
        </Source>
      )}
      {/* Protected areas (WDPA), under anything a map draws of its own. */}
      {showProtectedAreas && (
        <Source
          id={`wdpa-${panelId}`}
          type="raster"
          tiles={[PROTECTED_AREAS_TILE_URL]}
          tileSize={256}
          maxzoom={PROTECTED_AREAS_MAX_ZOOM}
          attribution={PROTECTED_AREAS_ATTRIBUTION}
        >
          {/* Recoloured here rather than by the server: the tiles are WDPA's
              own green, which disappears against the terrain basemap. See
              PROTECTED_AREAS_HUE_ROTATION. */}
          <Layer
            id={`wdpa-layer-${panelId}`}
            beforeId={slotId("protected-areas", panelId)}
            type="raster"
            paint={{
              "raster-opacity": 0.55,
              "raster-hue-rotate": PROTECTED_AREAS_HUE_ROTATION,
              "raster-saturation": 0.2,
            }}
          />
        </Source>
      )}
      {/* The clicked area, outlined. A boundary you can see the whole of
          answers "does my point sit inside this?" in a way a name in a popup
          can't — and with several designations stacked at one spot, it's the
          only way to tell which one you're reading. The white casing keeps it
          legible over satellite imagery. */}
      {highlightedAreaGeoJson && clickedAreas?.panelId === panelId && (
        <Source id={`wdpa-highlight-${panelId}`} type="geojson" data={highlightedAreaGeoJson}>
          <Layer
            id={`wdpa-highlight-fill-${panelId}`}
            beforeId={slotId("protected-areas", panelId)}
            type="fill"
            paint={{
              "fill-color": ["get", "colour"],
              // Light, because these stack: three overlapping fills at the old
              // opacity turned the shared ground opaque and hid the records the
              // question was about.
              "fill-opacity": ["case", ["get", "active"], 0.2, 0.08],
            }}
          />
          <Layer
            id={`wdpa-highlight-casing-${panelId}`}
            beforeId={slotId("protected-areas", panelId)}
            type="line"
            paint={{ "line-color": "#ffffff", "line-width": 4.5, "line-opacity": 0.9 }}
          />
          <Layer
            id={`wdpa-highlight-line-${panelId}`}
            beforeId={slotId("protected-areas", panelId)}
            type="line"
            paint={{
              "line-color": ["get", "colour"],
              "line-width": ["case", ["get", "active"], 3, 1.75],
            }}
          />
        </Source>
      )}
    </>
  );
}
