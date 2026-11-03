"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import type { MapRef } from "react-map-gl/maplibre";


interface AohMetadata {
  id_no: string;
  scientific_name: string;
  aoh_total: number;
  range_total: number;
  prevalence: number;
  category: string;
  bounds: [number, number, number, number] | null; // [south, west, north, east]
  /**
   * Set when the source raster's bounding box extended slightly outside
   * the valid Mollweide projection ellipse (globe-spanning species like
   * wide-ranging seabirds). The upload script trimmed `x` % off the
   * left/right edges and `y` % off the top/bottom before reprojecting.
   * The trimmed edge pixels are guaranteed to be empty so no habitat
   * is lost — but we surface this so the user knows the displayed AOH
   * footprint is slightly smaller than the source raster's full bbox.
   */
  inset_clip?: { x: number; y: number };
}

interface AohMapLayerProps {
  sisTaxonId: number;
  taxonGroup: string;
  visible: boolean;
  panelId?: string;
  mapRef: React.RefObject<MapRef | null>;
  onLoadingChange?: (loading: boolean) => void;
}

function AohMapLayerInner({ sisTaxonId, taxonGroup, visible, panelId = "main", mapRef, onLoadingChange }: AohMapLayerProps) {
  const [metadata, setMetadata] = useState<AohMetadata | null>(null);
  const [pngUrl, setPngUrl] = useState<string | null>(null);
  const [imageCoords, setImageCoords] = useState<[[number, number], [number, number], [number, number], [number, number]] | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef<number | null>(null);

  // Track whether the image source has been added to the map for cleanup
  const addedSourceRef = useRef(false);

  useEffect(() => {
    if (!visible || !sisTaxonId || fetchedRef.current === sisTaxonId) return;

    Promise.resolve().then(() => {
      setLoading(true);
      onLoadingChange?.(true);
    });

    fetch(`/api/species/${sisTaxonId}/aoh/metadata`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((data: AohMetadata) => {
        setMetadata(data);
        fetchedRef.current = sisTaxonId;

        if (data.bounds) {
          const [south, west, north, east] = data.bounds;
          // MapLibre image source coordinates: [top-left, top-right, bottom-right, bottom-left]
          setImageCoords([
            [west, north],   // top-left
            [east, north],   // top-right
            [east, south],   // bottom-right
            [west, south],   // bottom-left
          ]);
          setPngUrl(`/api/species/${sisTaxonId}/aoh`);
        }
      })
      .catch(() => {
        // Silent fail
      })
      .finally(() => {
        setLoading(false);
        onLoadingChange?.(false);
      });
  }, [visible, sisTaxonId, taxonGroup, onLoadingChange]);

  // Clean up the image source when unmounting or hiding, since MapLibre
  // image sources can't be reactively updated as easily as geojson sources
  const cleanupSource = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map || !addedSourceRef.current) return;
    const sourceId = `aoh-image-${panelId}`;
    const layerId = `aoh-raster-${panelId}`;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    addedSourceRef.current = false;
  }, [mapRef, panelId]);

  // Add the image source imperatively since react-map-gl's Source doesn't
  // support the `image` type with coordinates well
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !visible || !pngUrl || !imageCoords) return;

    const sourceId = `aoh-image-${panelId}`;
    const layerId = `aoh-raster-${panelId}`;

    const addImageLayer = () => {
      if (map.getSource(sourceId)) {
        // Update existing source
        (map.getSource(sourceId) as maplibregl.ImageSource).updateImage({
          url: pngUrl,
          coordinates: imageCoords,
        });
      } else {
        map.addSource(sourceId, {
          type: "image",
          url: pngUrl,
          coordinates: imageCoords,
        });
        addedSourceRef.current = true;
      }
      if (!map.getLayer(layerId)) {
        // Insert before occurrence circles so AOH renders underneath
        const occLayerId = `occ-circles-${panelId}`;
        const beforeLayer = map.getLayer(occLayerId) ? occLayerId : undefined;
        map.addLayer(
          {
            id: layerId,
            type: "raster",
            source: sourceId,
            paint: { "raster-opacity": 0.7 },
          },
          beforeLayer
        );
      }
    };

    if (map.isStyleLoaded()) {
      addImageLayer();
    } else {
      map.once("styledata", addImageLayer);
    }

    return cleanupSource;
  }, [visible, pngUrl, imageCoords, mapRef, panelId, cleanupSource]);

  // Toggle visibility
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layerId = `aoh-raster-${panelId}`;
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
  }, [visible, mapRef, panelId]);

  if (!visible || loading) return null;

  if (metadata && metadata.bounds) {
    return (
      <div className="absolute bottom-8 right-2 z-[1000] bg-white dark:bg-zinc-800 px-2.5 py-2 rounded shadow text-xs text-zinc-600 dark:text-zinc-300 space-y-1">
        <div className="font-medium text-zinc-800 dark:text-zinc-100">Area of Habitat</div>
        <div>AOH: {metadata.aoh_total.toLocaleString(undefined, { maximumFractionDigits: 0 })} km&sup2;</div>
        <div>Range: {metadata.range_total.toLocaleString(undefined, { maximumFractionDigits: 0 })} km&sup2;</div>
        <div>Prevalence: {(metadata.prevalence * 100).toFixed(1)}%</div>
        {metadata.inset_clip && (
          <div
            className="text-amber-600 dark:text-amber-400 flex items-center gap-1 cursor-help pt-0.5"
            title={`This species' range spans most of the globe, and the source raster's bounding-box corners fell just outside the valid Mollweide projection domain. The upload pipeline trimmed ${metadata.inset_clip.x}% off the left/right edges${metadata.inset_clip.y > 0 ? ` and ${metadata.inset_clip.y}% off the top/bottom` : ""} so the reprojection to Web Mercator could complete. The trimmed edge pixels are empty (no habitat), so the displayed AOH is unchanged.`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
            Edges trimmed {metadata.inset_clip.x}%
            {metadata.inset_clip.y > 0 ? `×${metadata.inset_clip.y}%` : ""}
          </div>
        )}
      </div>
    );
  }

  return null;
}

// Need to import maplibregl type for ImageSource
import type * as maplibregl from "maplibre-gl";

const AohMapLayer = dynamic(
  () => Promise.resolve(AohMapLayerInner),
  { ssr: false }
);

export default AohMapLayer;
export type { AohMetadata };
