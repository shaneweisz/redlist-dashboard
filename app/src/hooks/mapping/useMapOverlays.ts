"use client";

/**
 * The context overlays a map can draw, and what each one says about a point.
 *
 * Protected areas, tree cover loss and its drivers, IUCN habitat classes,
 * ecoregions and GBIF sampling effort are about the ground, not about any
 * species, so they behave the same on every map that draws them: the species
 * map, and /map, which asks of a place what the species map asks of a record.
 * They lived inside the species map until /map wanted them too, and a second
 * copy would have drifted from the first the first time either was fixed.
 *
 * This holds which layers are on and the answers a left click got from them.
 * The pieces that draw it — the layers, the menu, the legend, the callout —
 * are in components/mapping/overlays and take what this returns.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import {
  highlightColour,
  identifyProtectedAreas,
  type ProtectedArea,
} from "@/lib/mapping/protected-areas";
import { FOREST_LOSS_FIRST_YEAR, FOREST_LOSS_LAST_YEAR } from "@/lib/mapping/forest-loss";
import { queryForestPoint, type ForestPoint } from "@/lib/mapping/forest-point-query";
import { identifyHabitat, type HabitatClass } from "@/lib/mapping/habitat-map";
import {
  ECOREGIONS_ASSET,
  overlayUrl,
  type EcoregionProperties,
} from "@/lib/mapping/map-overlays";
import type { EffortGroup } from "@/lib/mapping/sampling-effort";
import { useSamplingEffort, effortCell, useGbifCellCount } from "@/hooks/mapping/useSamplingEffort";

export type EcoregionCollection = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  EcoregionProperties
>;

/** Shared by every map and every species — the layer is global. */
let ecoregionCache: EcoregionCollection | null = null;

/** Where a click landed, and on which map. */
type ClickedAt = { panelId: string; lng: number; lat: number };

/**
 * Every protected area under a click.
 *
 * A click routinely sits inside several designations at once — a national
 * park that is also a World Heritage site and a biosphere reserve — and
 * they're all true, so the callout lists them and outlines whichever one you're
 * pointing at rather than picking one on your behalf.
 */
export type ClickedAreas = ClickedAt & {
  areas: ProtectedArea[];
  /** Which of the listed areas is outlined heaviest on the map. */
  highlight: number;
};

export type ClickedHabitat = ClickedAt & { habitat: HabitatClass | null; loading: boolean };
export type ClickedForest = ClickedAt & { point: ForestPoint | null; loading: boolean };
export type SelectedEcoregion = ClickedAt & {
  properties: EcoregionProperties;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
};

export function useMapOverlays({
  defaultEffortGroup,
  resetKey,
  areaBoundaryOffset,
}: {
  /**
   * The effort surface to show first, or null to withhold the layer entirely.
   *
   * Null rather than falling back to all-taxa: the dataset has no fish group,
   * and nothing covering crustaceans, corals, mosses or the algae, so for those
   * an all-groups surface would answer a question nobody asked — "is this sea
   * well surveyed?" when what was surveyed was seabirds.
   */
  defaultEffortGroup: EffortGroup | null;
  /** Changes when the map is about something else — a different species. */
  resetKey?: string;
  /**
   * How finely WDPA is asked to draw a clicked boundary, in degrees. Left to
   * the service it follows the screen's pixel size, which is right for an
   * outline that is only drawn; a boundary that will be *searched* wants the
   * same shape whoever asks — see /map.
   */
  areaBoundaryOffset?: number;
}) {
  const [showProtectedAreas, setShowProtectedAreas] = useState(false);
  /**
   * Whether UNEP-WCMC's service is answering.
   *
   * It goes down, and when it does the layer fails silently in the worst
   * possible way: the tiles 500, nothing is drawn, and a click returns no
   * areas — which is indistinguishable from "nothing here is protected". On an
   * assessment that is a wrong answer, not a missing one, so the row says the
   * source is unreachable instead of letting the blank map speak for it.
   *
   * Observed 2026-09-02: the whole ArcGIS host answered every request, its own
   * service directory included, with "The ArcGIS Web Adaptor has been
   * configured with SSL/HTTPS. Please enable SSL/HTTPS for your ArcGIS Server
   * site." — their misconfiguration, nothing to do with the caller.
   */
  const [protectedAreasDown, setProtectedAreasDown] = useState(false);
  const [showForestLoss, setShowForestLoss] = useState(false);
  /**
   * The years of loss to draw, which the tiles are cut to server-side.
   *
   * This replaced a colour ramp. The rendered tiles are one pink whatever year
   * the loss happened in, so the year can't be read off the map any more — but
   * it can be asked for, and the question an assessor actually has is a range:
   * what has gone since the assessment, or since the last one. Narrowing to
   * that is a better answer than estimating where a colour sat on a gradient.
   */
  const [lossYears, setLossYears] = useState<[number, number]>([
    FOREST_LOSS_FIRST_YEAR,
    FOREST_LOSS_LAST_YEAR,
  ]);
  /** What the loss was for — the 1 km dominant-driver classification. */
  const [showLossDrivers, setShowLossDrivers] = useState(false);
  const [showHabitat, setShowHabitat] = useState(false);
  const [showEcoregions, setShowEcoregions] = useState(false);
  const [showSamplingEffort, setShowSamplingEffort] = useState(false);

  const [effortGroup, setEffortGroup] = useState<EffortGroup | null>(defaultEffortGroup);
  const { layer: effortLayer, loading: effortLoading } = useSamplingEffort(
    showSamplingEffort && defaultEffortGroup ? effortGroup : null
  );

  /**
   * Ecoregion polygons, fetched the first time the overlay is switched on.
   *
   * ~2 MB gzipped for the whole world, which is too much to spend on every
   * reader of the page and cheap enough to spend once on the reader who asks
   * for it. Held for the life of the module rather than the component so
   * switching species doesn't re-fetch it — the layer is global and has nothing
   * to do with which species is open.
   */
  const [ecoregions, setEcoregions] = useState<EcoregionCollection | null>(ecoregionCache);
  const [ecoregionsLoading, setEcoregionsLoading] = useState(false);
  const [ecoregionsFailed, setEcoregionsFailed] = useState(false);

  const loadEcoregions = useCallback(() => {
    if (ecoregionCache) return;
    setEcoregionsLoading(true);
    setEcoregionsFailed(false);
    fetch(overlayUrl(ECOREGIONS_ASSET))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((collection: EcoregionCollection) => {
        ecoregionCache = collection;
        setEcoregions(collection);
      })
      .catch(() => setEcoregionsFailed(true))
      .finally(() => setEcoregionsLoading(false));
  }, []);

  const toggleEcoregions = useCallback(() => {
    // Switched on with nothing loaded — or after a failed attempt, which is the
    // reader asking again.
    if (!showEcoregions && !ecoregions && !ecoregionsLoading) loadEcoregions();
    setShowEcoregions(!showEcoregions);
  }, [showEcoregions, ecoregions, ecoregionsLoading, loadEcoregions]);

  const [clickedAreas, setClickedAreas] = useState<ClickedAreas | null>(null);
  /**
   * The habitat class under the last left click, while that overlay is on.
   *
   * Habitat is a layer you click to interrogate, like the protected areas and
   * the ecoregions, and it answers into the same callout they do.
   */
  const [clickedHabitat, setClickedHabitat] = useState<ClickedHabitat | null>(null);
  /**
   * What the forest rasters say under the last left click.
   *
   * The drivers layer is the reason this exists: it is a raster, so there is
   * no feature to hit-test and no way to click a cell and be told what it is.
   * Reading the colour under the cursor would be the easy version and a
   * dishonest one — the renderer blends at cell edges, so a click near a
   * boundary would name a class that isn't stored there. The platform serves
   * the rasters themselves at a point, so the answer comes from the data.
   */
  const [clickedForest, setClickedForest] = useState<ClickedForest | null>(null);
  /** The ecoregion clicked on the map, outlined and named until dismissed. */
  const [selectedEcoregion, setSelectedEcoregion] = useState<SelectedEcoregion | null>(null);
  /**
   * The sampling-effort cell under the last left click, while that layer is on.
   *
   * A left click, like the other layers you click to interrogate, and answered
   * in the same callout — not folded into the right-click panel, which is
   * about the spot itself rather than what an overlay says of it.
   */
  const [clickedEffort, setClickedEffort] = useState<ClickedAt | null>(null);

  /** Discard a lookup that a later click has already superseded. */
  const areasQueryId = useRef(0);
  const habitatQueryId = useRef(0);
  const forestQueryId = useRef(0);

  // A different species is a different map: the effort surface goes back to
  // the one that suits it, and an ecoregion picked out on the last one has
  // nothing to say about this one.
  const [answersFor, setAnswersFor] = useState(resetKey);
  if (answersFor !== resetKey) {
    setAnswersFor(resetKey);
    setEffortGroup(defaultEffortGroup);
    setSelectedEcoregion(null);
  }

  const effortCellAtPoint = useMemo(
    () =>
      clickedEffort && effortLayer && showSamplingEffort
        ? effortCell(effortLayer, clickedEffort.lng, clickedEffort.lat)
        : null,
    [clickedEffort, effortLayer, showSamplingEffort]
  );
  const {
    count: gbifCellCount,
    byBasis: gbifCellByBasis,
    loading: gbifCellCountLoading,
  } = useGbifCellCount(effortCellAtPoint?.bounds ?? null, effortLayer?.group ?? null);

  /**
   * Ask every overlay that is on what it says about a point.
   *
   * Each answers on its own schedule — ecoregions and effort from data already
   * in the browser, the rest from their services — so the callout fills in as
   * they arrive rather than waiting on the slowest.
   */
  const queryAt = useCallback(
    (map: MapLibreMap, lng: number, lat: number, panelId: string) => {
      // A new click is a new question; the last one's protected areas are not
      // an answer to it.
      ++areasQueryId.current;
      setClickedAreas(null);
      // Answered from the polygons already loaded, so there's nothing to wait
      // for. Clicking off every ecoregion clears the selection rather than
      // leaving it stranded.
      if (showEcoregions && ecoregions) {
        const point: GeoJSON.Feature<GeoJSON.Point> = {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [lng, lat] },
        };
        const hit = ecoregions.features.find((f) => booleanPointInPolygon(point, f));
        setSelectedEcoregion(
          hit ? { properties: hit.properties, geometry: hit.geometry, lng, lat, panelId } : null
        );
      }
      // The effort counts came down with the layer, so this is a lookup rather
      // than a request: the callout opens on the click with the snapshot
      // figure, and only GBIF's live count is left to arrive.
      if (showSamplingEffort && effortLayer) setClickedEffort({ panelId, lng, lat });
      // The habitat map is a raster, so there's no feature to hit-test: the
      // service that drew the tiles answers an identify at a point, which means
      // the answer can't disagree with what's on screen.
      if (showHabitat) {
        const query = ++habitatQueryId.current;
        setClickedHabitat({ habitat: null, loading: true, panelId, lng, lat });
        identifyHabitat(lng, lat)
          .then((habitat) => {
            if (query !== habitatQueryId.current) return;
            setClickedHabitat({ habitat, loading: false, panelId, lng, lat });
          })
          .catch(() => {
            if (query !== habitatQueryId.current) return;
            setClickedHabitat({ habitat: null, loading: false, panelId, lng, lat });
          });
      }
      // Same bargain again for the forest layers, and the one that most needed
      // it: a 1 km driver cell is a colour with no name on it until you click.
      // Asked of the rasters rather than the picture of them, and answered as
      // three parts — what the loss was for, when, and how wooded the ground
      // was before it — because the last is what keeps the first two honest.
      if (showLossDrivers || showForestLoss) {
        const query = ++forestQueryId.current;
        setClickedForest({ point: null, loading: true, panelId, lng, lat });
        queryForestPoint(lng, lat)
          .then((point) => {
            if (query !== forestQueryId.current) return;
            setClickedForest({ point, loading: false, panelId, lng, lat });
          })
          .catch(() => {
            if (query !== forestQueryId.current) return;
            setClickedForest({ point: null, loading: false, panelId, lng, lat });
          });
      }
      // With the overlay on, a plain click asks what protects this spot — the
      // shapes are right there, so clicking one should answer for it. The
      // overlay is a raster, so nothing about it can be hit-tested in the
      // browser: the same service that drew the tiles answers an identify,
      // which makes what you click guaranteed to be what you saw.
      if (!showProtectedAreas) return;
      const bounds = map.getBounds();
      const canvas = map.getCanvas();
      const query = areasQueryId.current;
      identifyProtectedAreas({
        lng,
        lat,
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        maxAllowableOffset: areaBoundaryOffset,
      })
        .then((areas) => {
          // Nothing opens for a spot that isn't protected: the overlay already
          // shows that, and a section saying so on every click is noise.
          if (query !== areasQueryId.current || areas.length === 0) return;
          setClickedAreas({ panelId, lng, lat, areas, highlight: 0 });
        })
        .catch(() => {
          // Only the current query speaks for the service: an aborted one says
          // nothing about whether it is up.
          if (query === areasQueryId.current) setProtectedAreasDown(true);
        });
    },
    [
      showEcoregions,
      ecoregions,
      showSamplingEffort,
      effortLayer,
      showHabitat,
      showLossDrivers,
      showForestLoss,
      showProtectedAreas,
      areaBoundaryOffset,
    ]
  );

  /** Puts away every overlay's answer, as a new question about the map does. */
  const clearAnswers = useCallback(() => {
    ++areasQueryId.current;
    ++habitatQueryId.current;
    ++forestQueryId.current;
    setClickedAreas(null);
    setClickedHabitat(null);
    setClickedForest(null);
    setSelectedEcoregion(null);
    setClickedEffort(null);
  }, []);

  const toggleProtectedAreas = useCallback(() => {
    setShowProtectedAreas((v) => !v);
    ++areasQueryId.current;
    setClickedAreas(null);
    // A fresh attempt: the service may have come back since.
    setProtectedAreasDown(false);
  }, []);

  const toggleHabitat = useCallback(() => {
    setShowHabitat((v) => !v);
    setClickedHabitat(null);
  }, []);

  /**
   * Every protected area under the click, each carrying its own colour.
   *
   * All of them at once rather than one at a time: the whole question a click
   * on overlapping designations asks is how many there are and where each one
   * ends, and that can't be answered by a shape that changes under the
   * pointer. The one being pointed at is drawn heavier, so hover still says
   * which row is which — it just isn't the only thing that does.
   */
  const highlightedAreaGeoJson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!clickedAreas) return null;
    // Indexed before filtering, so a point-only site (which has no geometry to
    // draw) doesn't shift the colours of the ones after it away from their
    // swatches in the list.
    const features = clickedAreas.areas
      .map((area, index) => ({ area, index }))
      .filter(({ area }) => area.geometry)
      .map(({ area, index }) => ({
        type: "Feature" as const,
        properties: {
          sitePid: area.sitePid,
          colour: highlightColour(index),
          active: index === clickedAreas.highlight,
        },
        geometry: area.geometry as GeoJSON.MultiPolygon,
      }));
    if (features.length === 0) return null;
    return { type: "FeatureCollection", features };
  }, [clickedAreas]);

  const selectedEcoregionGeoJson = useMemo<GeoJSON.Feature | null>(
    () =>
      selectedEcoregion
        ? { type: "Feature", properties: {}, geometry: selectedEcoregion.geometry }
        : null,
    [selectedEcoregion]
  );

  /** One value per row in the menu, for its "N of M" count. */
  const toggleValues = [
    showProtectedAreas,
    showForestLoss,
    showLossDrivers,
    showHabitat,
    showEcoregions,
    ...(defaultEffortGroup ? [showSamplingEffort] : []),
  ];

  return {
    showProtectedAreas,
    toggleProtectedAreas,
    protectedAreasDown,
    setProtectedAreasDown,
    showForestLoss,
    setShowForestLoss,
    lossYears,
    setLossYears,
    showLossDrivers,
    setShowLossDrivers,
    showHabitat,
    toggleHabitat,
    showEcoregions,
    toggleEcoregions,
    ecoregions,
    ecoregionsLoading,
    ecoregionsFailed,
    showSamplingEffort,
    setShowSamplingEffort,
    defaultEffortGroup,
    effortGroup,
    setEffortGroup,
    effortLayer,
    effortLoading,
    clickedAreas,
    setClickedAreas,
    clickedHabitat,
    setClickedHabitat,
    clickedForest,
    setClickedForest,
    selectedEcoregion,
    setSelectedEcoregion,
    clickedEffort,
    setClickedEffort,
    effortCellAtPoint,
    gbifCellCount,
    gbifCellByBasis,
    gbifCellCountLoading,
    queryAt,
    clearAnswers,
    highlightedAreaGeoJson,
    selectedEcoregionGeoJson,
    toggleValues,
  };
}

export type MapOverlays = ReturnType<typeof useMapOverlays>;
