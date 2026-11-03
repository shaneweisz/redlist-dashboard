"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import dynamic from "next/dynamic";
import { loadMapGL } from "@/lib/mapping/load-map";
import type { MapRef, MapLayerMouseEvent } from "react-map-gl/maplibre";
import type * as maplibregl from "maplibre-gl";
import { InatObservation, getThumbUrl } from "./InatPhotoCard";

const MapGL = dynamic(loadMapGL, { ssr: false });
const Source = dynamic(() => import("react-map-gl/maplibre").then((m) => m.Source), { ssr: false });
const Layer = dynamic(() => import("react-map-gl/maplibre").then((m) => m.Layer), { ssr: false });
const ScaleControl = dynamic(() => import("react-map-gl/maplibre").then((m) => m.ScaleControl), { ssr: false });
const MapOccurrenceTooltip = dynamic(() => import("@/components/mapping/MapOccurrenceTooltip"), { ssr: false });

// Plain OSM raster basemap (matches the streets basemap used by OccurrenceMapRow).
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [{ id: "basemap-layer", type: "raster", source: "basemap" }],
};

const POINT_LAYER_ID = "inat-points";

const circleLayer = {
  id: POINT_LAYER_ID,
  type: "circle" as const,
  paint: {
    "circle-radius": 5,
    "circle-color": "#22c55e",
    "circle-opacity": 0.7,
    "circle-stroke-color": "#15803d",
    "circle-stroke-width": 1,
  },
};

interface InatObservationMapProps {
  observations: InatObservation[];
  scientificName: string;
  mounted: boolean;
}

/**
 * Lightweight map of iNaturalist observation points for a species with no GBIF
 * backbone match. Plots the georeferenced observations as circles and shows a
 * photo/date/observer tooltip on hover. Unlike OccurrenceMapRow this has no
 * split-view / uncertainty / color-by-date controls — those are GBIF-specific.
 */
export default function InatObservationMap({ observations, scientificName, mounted }: InatObservationMapProps) {
  const mapRef = useRef<MapRef>(null);
  const [loaded, setLoaded] = useState(false);
  const [hovered, setHovered] = useState<InatObservation | null>(null);

  const points = useMemo(
    () => observations.filter((o) => o.decimalLatitude != null && o.decimalLongitude != null),
    [observations]
  );

  const geojson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: points.map((o, idx) => ({
        type: "Feature" as const,
        properties: { idx },
        geometry: { type: "Point" as const, coordinates: [o.decimalLongitude!, o.decimalLatitude!] },
      })),
    }),
    [points]
  );

  const fitToPoints = useCallback(() => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const o of points) {
      minLon = Math.min(minLon, o.decimalLongitude!);
      maxLon = Math.max(maxLon, o.decimalLongitude!);
      minLat = Math.min(minLat, o.decimalLatitude!);
      maxLat = Math.max(maxLat, o.decimalLatitude!);
    }
    if (minLon === maxLon && minLat === maxLat) {
      map.flyTo({ center: [minLon, minLat], zoom: 6, duration: 0 });
    } else {
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 40, maxZoom: 10, duration: 0 });
    }
  }, [points]);

  // Re-fit whenever the points arrive after the map has loaded.
  useEffect(() => {
    if (loaded) fitToPoints();
  }, [loaded, fitToPoints]);

  const handleMouseMove = useCallback(
    (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      const idx = feature?.properties?.idx;
      setHovered(typeof idx === "number" ? points[idx] ?? null : null);
    },
    [points]
  );

  if (!mounted || points.length === 0) return null;

  return (
    <div className="flex-1 flex flex-col rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700 relative isolate z-0">
      <div className="h-[300px] sm:h-auto sm:min-h-[450px] sm:flex-1 relative">
        <MapGL
          ref={mapRef}
          initialViewState={{ longitude: 0, latitude: 20, zoom: 1.5 }}
          style={{ width: "100%", height: "100%" }}
          mapStyle={OSM_STYLE}
          interactiveLayerIds={[POINT_LAYER_ID]}
          onLoad={() => {
            setLoaded(true);
            fitToPoints();
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHovered(null)}
          cursor={hovered ? "pointer" : "grab"}
        >
          <ScaleControl position="bottom-right" />
          <Source id="inat-observations" type="geojson" data={geojson}>
            <Layer {...circleLayer} />
          </Source>
          {hovered && hovered.decimalLatitude != null && hovered.decimalLongitude != null && (
            <MapOccurrenceTooltip
              lat={hovered.decimalLatitude}
              lng={hovered.decimalLongitude}
              fields={[
                { label: "Species", value: scientificName },
                ...(hovered.date ? [{ label: "Date", value: hovered.date }] : []),
                ...(hovered.observer ? [{ label: "Observer", value: hovered.observer }] : []),
                {
                  label: "Coordinates",
                  value: `${hovered.decimalLatitude.toFixed(4)}, ${hovered.decimalLongitude.toFixed(4)}`,
                },
              ]}
              images={hovered.imageUrl ? [{ url: getThumbUrl(hovered.imageUrl) }] : undefined}
            />
          )}
        </MapGL>
        {/* Legend */}
        <div className="absolute bottom-2 left-2 z-[1000] bg-white dark:bg-zinc-800 px-2 py-1.5 rounded text-xs text-zinc-600 dark:text-zinc-300 shadow flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500 border-2 border-green-700" />
          <span>iNaturalist observations</span>
          <span className="text-zinc-400 tabular-nums">({points.length})</span>
        </div>
      </div>
    </div>
  );
}
