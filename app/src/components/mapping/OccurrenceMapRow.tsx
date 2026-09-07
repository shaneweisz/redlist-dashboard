"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { MapRef, ViewStateChangeEvent, MapLayerMouseEvent, MapTouchEvent } from "react-map-gl/maplibre";
import type maplibregl from "maplibre-gl";
import { InatObservation, getThumbUrl, InatPhotoWithPreview } from "@/components/InatPhotoCard";
import { QualityFlag, QUALITY_FLAG_LABELS, QUALITY_FLAG_DESCRIPTIONS, QUALITY_FLAG_SOURCES } from "@/lib/mapping/coordinate-cleaning";
import { fetchInstitutionName, knownInstitutionName } from "@/lib/mapping/grscicoll";
import { duplicateOf } from "@/lib/mapping/georeferences";
import {
  backupFileName,
  buildEditsBackup,
  readEditsBackup,
  summariseBackup,
  type EditsBackup,
} from "@/lib/mapping/edits-backup";
import { duplicatesByPrimary as groupDuplicates, keepRecord as keepRecordIn } from "@/lib/mapping/duplicates";
import { CATEGORY_COLORS, normalizeCategory } from "@/config/taxa";
import { FaInfoCircle } from "react-icons/fa";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import YearRangeSlider from "@/components/mapping/YearRangeSlider";
import ListZoomControl, { LIST_ZOOM_DEFAULT } from "@/components/mapping/ListZoomControl";
import CompilerDialog from "@/components/mapping/CompilerDialog";
import NearbySpeciesPanel from "@/components/mapping/NearbySpeciesPanel";
import {
  NEARBY_RADIUS_DEFAULT,
  NEARBY_SEARCH_COLOR,
  NEARBY_PICKED_COLORS,
  NEARBY_MAX_PICKED,
  groupNearbyFeatures,
  type NearbyPoint,
  type NearbyRadiusKm,
} from "@/lib/mapping/nearby-species";
import MapGeoreferenceEditor from "./MapGeoreferenceEditor";
import type { OccurrenceFeature as OccurrenceFeatureType } from "./OccurrenceListTable";
// The table's own labels, so a basis of record is worded the same wherever it
// appears. A value import from a module the map otherwise loads lazily, which
// is fine: it's a plain object with no component behind it.
import { BASIS_LABELS, isGeoreferenceable } from "./OccurrenceListTable";
import {
  PROTECTED_AREAS_TILE_URL,
  PROTECTED_AREAS_ATTRIBUTION,
  highlightColour,
  PROTECTED_AREAS_HUE_ROTATION,
  PROTECTED_AREAS_MAX_ZOOM,
  identifyProtectedAreas,
  protectedPlanetUrl,
  type ProtectedArea,
} from "@/lib/mapping/protected-areas";
import { ELEVATION_ATTRIBUTION, elevationAt, formatElevation } from "@/lib/mapping/elevation";
import {
  EFFORT_GROUP_LABELS,
  EFFORT_GROUPS,
  EFFORT_LEGEND,
  EFFORT_PAPER_URL,
  effortGroupFor,
  formatEffort,
  gbifSearchUrl,
  type EffortGroup,
} from "@/lib/mapping/sampling-effort";
import { useSamplingEffort, effortAt, effortCell, useGbifCellCount } from "@/hooks/mapping/useSamplingEffort";
import {
  BIOMES,
  ECOREGIONS_ASSET,
  ECOREGIONS_ATTRIBUTION,
  ECOREGIONS_PAPER_URL,
  oneEarthEcoregionUrl,
  overlayUrl,
  type EcoregionProperties,
} from "@/lib/mapping/map-overlays";
import { formatDistance, pathLengthMetres } from "@/lib/mapping/geo-distance";
import {
  clearPointFile,
  comparePointFile,
  type PointComparison,
  loadPointFile,
  normaliseCatalogNumber,
  POINT_FILE_COLOR,
  pointSummary,
  savePointFile,
  type IucnPoint,
  type MatchedRecord,
  type MatchVia,
  buildIucnPointFileCsv,
  type PointFileComparison,
  type PointFileImport,
} from "@/lib/mapping/iucn-point-file";
import { useAssessorEdits } from "@/hooks/mapping/useAssessorEdits";
import {
  b1Threshold,
  b2Threshold,
  computeAoo,
  computeEoo,
  formatAreaKm2,
} from "@/lib/mapping/range-metrics";
import { type Place, type PinnedPlace } from "@/lib/mapping/geocode";
import {
  FOREST_LOSS_ATTRIBUTION,
  FOREST_LOSS_CANOPY_THRESHOLD,
  FOREST_LOSS_CAVEAT,
  FOREST_LOSS_COLOR,
  FOREST_LOSS_DATASET_URL,
  FOREST_LOSS_FIRST_YEAR,
  FOREST_LOSS_LAST_YEAR,
  FOREST_LOSS_MAX_ZOOM,
  FOREST_LOSS_SOURCE_NOTE,
  FOREST_LOSS_THRESHOLD_NOTE,
  forestLossTileUrl,
} from "@/lib/mapping/forest-loss";
import {
  DRIVERS_CANOPY_THRESHOLD,
  FOREST_LOSS_DRIVERS,
  FOREST_LOSS_DRIVERS_ATTRIBUTION,
  FOREST_LOSS_DRIVERS_CAVEAT,
  FOREST_LOSS_DRIVERS_FIRST_YEAR,
  FOREST_LOSS_DRIVERS_LAST_YEAR,
  FOREST_LOSS_DRIVERS_MAX_ZOOM,
  FOREST_LOSS_DRIVERS_PAPER_URL,
  FOREST_LOSS_DRIVERS_TILE_URL,
  type LossDriverClass,
} from "@/lib/mapping/forest-loss-drivers";
import { hasForestAnswer, queryForestPoint, type ForestPoint } from "@/lib/mapping/forest-point-query";

import {
  HABITAT_ATTRIBUTION,
  HABITAT_LEGEND,
  HABITAT_SCHEME_URL,
  HABITAT_TILE_URL,
  identifyHabitat,
  type HabitatClass,
} from "@/lib/mapping/habitat-map";
import {
  uncertaintyCircle,
  DEFAULT_GEOREFERENCE_RADIUS_M,
  type Georeference,
} from "@/lib/mapping/georeferences";

// Fixed page size for iNat photo grid (2 columns x 5 rows)
const INAT_PAGE_SIZE = 10;

// Dynamically import MapLibre GL components
const MapGL = dynamic(
  () => import("react-map-gl/maplibre").then((mod) => mod.Map),
  { ssr: false }
);
const Source = dynamic(
  () => import("react-map-gl/maplibre").then((mod) => mod.Source),
  { ssr: false }
);
const Layer = dynamic(
  () => import("react-map-gl/maplibre").then((mod) => mod.Layer),
  { ssr: false }
);
const MapLibreMarker = dynamic(
  () => import("react-map-gl/maplibre").then((mod) => mod.Marker),
  { ssr: false }
);
const ScaleControl = dynamic(
  () => import("react-map-gl/maplibre").then((mod) => mod.ScaleControl),
  { ssr: false }
);
const MapPopup = dynamic(
  () => import("react-map-gl/maplibre").then((mod) => mod.Popup),
  { ssr: false }
);
const MapImageTooltip = dynamic(
  () => import("./MapImageTooltip"),
  { ssr: false }
);
const MapOccurrenceTooltip = dynamic(
  () => import("./MapOccurrenceTooltip"),
  { ssr: false }
);
const RangeMapLayer = dynamic(
  () => import("@/components/RangeMapLayer"),
  { ssr: false }
);
const AohMapLayer = dynamic(
  () => import("@/components/AohMapLayer"),
  { ssr: false }
);
// The list (table) view of the same occurrences — only pulled in when the user
// actually switches to it.
const PointFileTable = dynamic(() => import("./PointFileTable"), { ssr: false });
const OccurrenceListTable = dynamic(
  () => import("./OccurrenceListTable"),
  { ssr: false }
);
const ExclusionDialog = dynamic(
  () => import("./ExclusionDialog"),
  { ssr: false }
);
const MapToolsMenu = dynamic(
  () => import("./MapToolsMenu"),
  { ssr: false }
);
const MapShapeCallout = dynamic(
  () => import("./MapShapeCallout"),
  { ssr: false }
);
const MapPlaceSearch = dynamic(
  () => import("./MapPlaceSearch"),
  { ssr: false }
);
const PointFileDialog = dynamic(
  () => import("./PointFileDialog"),
  { ssr: false }
);

// Shape of coordinate-cleaning-refdata/countries.json (Natural Earth admin-0
// country polygons, keyed by ISO 3166-1 alpha-2), dynamically imported for the
// POWO/IUCN native-range overlays.
interface CountryPolygon {
  iso_a2: string;
  polygon: GeoJSON.Polygon;
}

// The occurrence record shape is shared with the list view (which renders the
// same records as table rows, including the Darwin Core fields a map dot has
// nowhere to show), so it lives there.
type OccurrenceFeature = OccurrenceFeatureType;

/**
 * The assessor's own point on the map.
 *
 * Its hover handlers are attached natively rather than as React props: a
 * MapLibre marker's children are portalled into the map's own DOM, and React's
 * synthetic mouseenter/mouseleave (which it synthesises from delegated
 * mouseover/mouseout) doesn't reach them there — onClick does, which is what
 * makes the omission easy to miss.
 */
function GeoreferenceMarkerDot({
  hovered,
  onClick,
  onEnter,
  onLeave,
}: {
  hovered: boolean;
  onClick: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Where the pointer went down, so the click that ends a drag can be told
  // apart from a click meant as a click — the two arrive identically, and
  // opening a GBIF tab every time you nudge a point would be unusable.
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A marker sits inside the map container, so its mousemoves bubble to
    // MapLibre, which queries the layers underneath, finds nothing, and clears
    // the hover this element just set. Keep those to ourselves.
    const swallow = (e: Event) => e.stopPropagation();
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("mousemove", swallow);
    return () => {
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("mousemove", swallow);
    };
  }, [onEnter, onLeave]);
  return (
    <div
      ref={ref}
      onMouseDown={(e) => {
        pressAt.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        const from = pressAt.current;
        pressAt.current = null;
        if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 3) return;
        onClick();
      }}
      // No title: the map's own tooltip is already up by the time you could
      // read one, and a native tooltip on top of it just covers the record.
      style={{
        width: hovered ? 18 : 14,
        height: hovered ? 18 : 14,
        borderRadius: "50%",
        background: "#7c3aed",
        border: "2px solid #ffffff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        cursor: "grab",
      }}
    />
  );
}

/** A record GBIF has coordinates for, i.e. one the map can actually draw. */
type PositionedOccurrence = OccurrenceFeature & { geometry: NonNullable<OccurrenceFeature["geometry"]> };
function hasPosition(o: OccurrenceFeature): o is PositionedOccurrence {
  return o.geometry != null;
}

// Uncertainty filter options (meters)
const UNCERTAINTY_OPTIONS = [
  { label: "Any", value: null },
  { label: "\u2264 10m", value: 10 },
  { label: "\u2264 100m", value: 100 },
  { label: "\u2264 1km", value: 1000 },
  { label: "\u2264 10km", value: 10000 },
  { label: "\u2264 50km", value: 50000 },
] as const;

// Format a meters value for display, e.g. in the custom-uncertainty badge
function formatUncertainty(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1)}km`;
  }
  return `${meters}m`;
}

// Basemap style options for MapLibre GL
function makeRasterStyle(tileUrl: string, attribution: string): maplibregl.StyleSpecification {
  return {
    version: 8 as const,
    sources: {
      basemap: {
        type: "raster" as const,
        tiles: [tileUrl],
        tileSize: 256,
        attribution,
      },
    },
    layers: [
      {
        id: "basemap-layer",
        type: "raster" as const,
        source: "basemap",
      },
    ],
  };
}
/**
 * Several raster tile sets drawn over each other, bottom first.
 *
 * For the hybrid basemap: imagery answers "what is on the ground here", labels
 * answer "where is here", and reading a locality description against a photo
 * of the ground needs both at once.
 */
function makeStackedRasterStyle(
  tiles: { url: string; attribution: string }[]
): maplibregl.StyleSpecification {
  return {
    version: 8 as const,
    sources: Object.fromEntries(
      tiles.map((t, i) => [
        `basemap-${i}`,
        { type: "raster" as const, tiles: [t.url], tileSize: 256, attribution: t.attribution },
      ])
    ),
    layers: tiles.map((_, i) => ({
      id: `basemap-layer-${i}`,
      type: "raster" as const,
      source: `basemap-${i}`,
    })),
  };
}

// Lazy import for maplibre-gl types
type MaplibreStyle = ReturnType<typeof makeRasterStyle>;
const BASEMAP_STYLES: Record<string, { label: string; style: MaplibreStyle }> = {
  streets: {
    label: "Streets",
    style: makeRasterStyle(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    ),
  },
  satellite: {
    label: "Satellite",
    style: makeRasterStyle(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      '&copy; <a href="https://www.esri.com">Esri</a> World Imagery'
    ),
  },
  /**
   * Imagery with place names over it.
   *
   * Esri publishes the labels as a transparent reference layer meant to go
   * over its own World Imagery, so this is the pairing as intended rather than
   * two unrelated tile sets stacked. Satellite on its own is the better view of
   * the ground; this is the one for finding out which valley you are looking at.
   */
  hybrid: {
    label: "Hybrid",
    style: makeStackedRasterStyle([
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attribution: '&copy; <a href="https://www.esri.com">Esri</a> World Imagery',
      },
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        attribution: '&copy; <a href="https://www.esri.com">Esri</a> World Boundaries and Places',
      },
    ]),
  },
  terrain: {
    label: "Terrain",
    style: makeRasterStyle(
      "https://tile.opentopomap.org/{z}/{x}/{y}.png",
      '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)'
    ),
  },
  /**
   * Two quiet basemaps, for reading a data layer rather than a place.
   *
   * Streets and Terrain both colour the ground — green for vegetation, white
   * for ice, blue for water — which is fine when the map is the subject and
   * actively misleading when something is drawn on top of it: a sampling-effort
   * ramp or a biome fill has to compete with colour that means something else
   * entirely. These carry the coastlines, the administrative outlines and
   * their names, and no colour of their own.
   *
   * Street-level place names are what Streets is for, and are worth having
   * while georeferencing; here they would be clutter over the surface being
   * read.
   *
   * Esri's Canvas basemaps rather than CARTO's: CARTO now watermarks every
   * unkeyed tile with "API KEY REQUIRED", which is not a basemap you can read
   * a data layer off. Esri serves the same idea keyless, and is already what
   * Satellite and Hybrid are drawn from.
   */
  plain: {
    label: "Plain",
    style: makeRasterStyle(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      '&copy; <a href="https://www.esri.com">Esri</a> Light Gray Canvas'
    ),
  },
  /** Dark, where a bright ramp reads best — the effort layer especially. */
  dark: {
    label: "Dark",
    style: makeRasterStyle(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      '&copy; <a href="https://www.esri.com">Esri</a> Dark Gray Canvas'
    ),
  },
};
type BasemapKey = keyof typeof BASEMAP_STYLES;


/**
 * Determine whether an occurrence record is "new" (recorded after the assessment date).
 * Uses full date comparison when eventDate is available, falls back to year comparison.
 */
/** The table's own labels for GBIF's basisOfRecord constants, reused here. */
const formatBasisOfRecord = (basis?: string) =>
  basis ? BASIS_LABELS[basis] ?? basis.replace(/_/g, " ").toLowerCase() : "";

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

/** The latitude Web Mercator stops at, and so the top edge of a world PNG. */
const MERCATOR_LIMIT = 85.051129;

type EcoregionCollection = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, EcoregionProperties>;

/** Shared by every panel and every species — the layer is global. */
let ecoregionCache: EcoregionCollection | null = null;

export function isAfterAssessment(
  eventDate: string | undefined | null,
  year: number | undefined | null,
  assessmentDate: string | undefined | null,
  assessmentYear: number | undefined | null,
): boolean {
  if (!assessmentDate) return true;
  if (eventDate) {
    return new Date(eventDate) > new Date(assessmentDate);
  }
  if (year != null && assessmentYear != null) {
    return year > assessmentYear;
  }
  return false;
}

// Convert an eventDate string (or year-only) to a numeric value for interpolation
function dateToNumeric(eventDate?: string | null, year?: number | null): number | null {
  if (eventDate) {
    const ts = new Date(eventDate).getTime();
    if (!isNaN(ts)) return ts;
  }
  if (year != null) return new Date(year, 0, 1).getTime();
  return null;
}

// Comparable yyyy-mm-dd key for the date-range filter — full eventDate when
// available, otherwise Jan 1 of `year` (same fallback the split-view before/after
// partition uses). Records with neither can't be placed in a date window, so they
// have no key and are excluded whenever the date-range filter is active.
function occurrenceDateKey(o: OccurrenceFeature): string | null {
  const e = o.properties.eventDate;
  if (e && e.length >= 10) return e.slice(0, 10);
  if (o.properties.year != null) return `${String(o.properties.year).padStart(4, "0")}-01-01`;
  return null;
}

// Fixed absolute color scale so the same year always maps to the same color
// across all species. Simple continuous hue gradient: orange-red(20) → green(130).
// Anchored so that the last ~20 years span the full visible range.
const COLOR_SCALE_MIN_YEAR = new Date().getFullYear() - 20;
const COLOR_SCALE_MAX_YEAR = new Date().getFullYear();
const COLOR_SCALE_MIN_TS = new Date(COLOR_SCALE_MIN_YEAR, 0, 1).getTime();
const COLOR_SCALE_MAX_TS = new Date(COLOR_SCALE_MAX_YEAR, 0, 1).getTime();

// Date-based color interpolation — continuous hue gradient
function dateToColor(dateNum: number): { stroke: string; fill: string } {
  // Clamp to range; anything older than 20 years gets the orange-red color
  const t = Math.max(0, Math.min(1, (dateNum - COLOR_SCALE_MIN_TS) / (COLOR_SCALE_MAX_TS - COLOR_SCALE_MIN_TS)));
  // Hue: 20 (orange-red) → 130 (green)
  const hue = Math.round(20 + t * 110);
  return {
    stroke: `hsl(${hue}, 75%, 30%)`,
    fill: `hsl(${hue}, 75%, 50%)`,
  };
}

// Classify an occurrence into one of the basis-of-record checkbox categories.
function classifyOccurrence(o: OccurrenceFeature): string {
  const basis = o.properties.basisOfRecord;
  if (basis === "HUMAN_OBSERVATION") return "humanObservation";
  if (basis === "MACHINE_OBSERVATION") return "machineObservation";
  if (basis === "OBSERVATION") return "observation";
  if (basis === "PRESERVED_SPECIMEN") return "preservedSpecimen";
  if (basis === "FOSSIL_SPECIMEN") return "fossilSpecimen";
  if (basis === "LIVING_SPECIMEN") return "livingSpecimen";
  if (basis === "MATERIAL_SAMPLE") return "materialSample";
  if (basis === "MATERIAL_CITATION") return "materialCitation";
  if (basis === "OCCURRENCE") return "occurrence";
  return "observation"; // fallback
}

// Inverse of classifyOccurrence — the GBIF basisOfRecord value to filter
// /api/occurrences by when loading more of just this category.
const GBIF_BASIS_OF_RECORD: Record<string, string> = {
  humanObservation: "HUMAN_OBSERVATION",
  machineObservation: "MACHINE_OBSERVATION",
  observation: "OBSERVATION",
  preservedSpecimen: "PRESERVED_SPECIMEN",
  fossilSpecimen: "FOSSIL_SPECIMEN",
  livingSpecimen: "LIVING_SPECIMEN",
  materialSample: "MATERIAL_SAMPLE",
  materialCitation: "MATERIAL_CITATION",
  occurrence: "OCCURRENCE",
};

// How many additional records to fetch per "Load more" click on a Basis of Record row.
const BASIS_OF_RECORD_LOAD_MORE_BATCH = 200;

// An even split between the map and the list, and the bounds the divider can
// be dragged between — enough map to stay a map, enough list to stay a list.
// Even rather than map-weighted: side by side, the list is a sixteen-column
// reference table, and the half it was getting cut it off mid-record.
const FULLSCREEN_DEFAULT_MAP_PCT = 50;
const FULLSCREEN_MIN_MAP_PCT = 20;
const FULLSCREEN_MAX_MAP_PCT = 85;

// How many additional records to fetch per click of the general "Load N more" button
// next to the "Loaded X of Y" badge (all basis-of-record categories together).
const OVERALL_LOAD_MORE_BATCH = 200;

interface RecordTypeBreakdown {
  humanObservation: number;
  machineObservation: number;
  observation: number;
  preservedSpecimen: number;
  fossilSpecimen: number;
  livingSpecimen: number;
  materialSample: number;
  materialCitation: number;
  occurrence: number;
  iNaturalist: number;
  recentInatObservations?: InatObservation[];
  inatTotalCount?: number;
  total?: number;
}

interface OccurrenceMapRowProps {
  speciesKey: string;
  countryCode?: string | null;
  mounted: boolean;
  assessmentYear?: number | null;
  assessmentDate?: string | null;
  assessmentId?: number | null;
  sisTaxonId?: number | null;
  /** This species' current IUCN Red List category (e.g. "VU", "EN") — shown as a
   * small colored badge on the current-assessment marker in the date-range
   * timeline, alongside the same badges for previousAssessments' categories. */
  category?: string | null;
  /** This species' current assessment's Red List criteria (e.g. "A2bd") — shown
   * in the current-assessment marker's tooltip alongside its category. */
  criteria?: string | null;
  /** CSV taxon group (e.g. "flowering_plants", "mushrooms") — used to default
   * preserved specimens ON for plants & fungi, where herbarium/fungarium
   * records are a core data source. */
  taxonGroup?: string;
  /** This species' scientific name — used to look up its POWO/WCVP native range. */
  scientificName?: string;
  /** This species' native-range countries (ISO 3166-1 alpha-2), per its IUCN Red
   * List assessment's locations (already filtered to origin="Native" upstream in
   * scripts/fetch-redlist-species.ts) — the "Red List" native-range source. */
  nativeCountriesRedList?: string[];
  /** This species' past Red List assessments (most recent one is covered by
   * assessmentDate/assessmentYear above, not repeated here unless the caller's
   * history array happens to include it too — de-duped by date either way when
   * building the date-range slider's assessment markers). Lazily populated by
   * RedListView's own history fetch, so may still be empty/stale on first render
   * of this tab — markers just don't appear yet in that case. */
  previousAssessments?: { year: string; date: string | null; category?: string; criteria?: string | null }[];
  /** The species' node in the taxonomy, as the dashboard's `taxa` URL token —
   *  needed to send someone back to a filtered dashboard rather than a bare one. */
  dashboardTaxonToken?: string | null;
  /** The dashboard's row id for this species, so leaving fullscreen lands on
   *  the row already open rather than on a list to hunt through. */
  dashboardSpeciesKey?: string | null;
  /** Render as the fullscreen page: map above, record list below, filling the
   *  height given to it. Driven by the /mapping/<key> route. */
  fullscreen?: boolean;
  /** Called once the occurrence data has loaded and there are no records to show,
   * letting the parent fall back to another tab (e.g. Catalogue of Life). */
  onEmpty?: () => void;
}

/**
 * Which record types are selected when the viewer opens.
 *
 * Every kingdom now starts with every record type but two, rather than only
 * plants and fungi: a herbarium sheet, a museum skin or a literature citation
 * is evidence of where the species was, and a default that quietly drops
 * record types hides the very evidence an assessment gets written from.
 *
 * The two exceptions are the ones that say where an individual *ended up*
 * rather than where the species lives: a living specimen is a zoo or botanic
 * garden animal or plant, and a fossil specimen is a range from a different
 * epoch. Both are off until asked for.
 */
export function defaultCheckedTypes() {
  return {
    humanObservation: true,
    machineObservation: true,
    observation: true,
    preservedSpecimen: true,
    fossilSpecimen: false,
    livingSpecimen: false,
    materialSample: true,
    materialCitation: true,
    occurrence: true,
  };
}

/**
 * Which coordinate-cleaning checks are applied when the viewer opens.
 *
 * None at all, for any kingdom — the rule that used to apply only to plants
 * and fungi. These checks are plausibility heuristics with real false-positive
 * rates, and a record trimmed by one is a record an assessor never sees. The
 * viewer opens on everything GBIF holds; the cleaning is opt-in from there.
 */
export function defaultAppliedChecks(): Record<QualityFlag, boolean> {
  return {
    ZERO_COORDINATE: false,
    EQUAL_COORDINATES: false,
    GBIF_HEADQUARTERS: false,
    DUPLICATE: false,
    NEAR_CAPITAL: false,
    NEAR_CENTROID: false,
    NEAR_INSTITUTION: false,
    OCEAN: false,
    URBAN_AREA: false,
    ARTIFICIAL_HOTSPOT: false,
    OUTSIDE_REPORTED_COUNTRY: false,
  };
}

/**
 * Vascular plants only — the taxonomic scope WCVP/POWO actually covers (not
 * mosses, algae, or fungi), used to gate the "POWO" native-range source fetch.
 */
export function isVascularPlantTaxonGroup(taxonGroup: string | undefined): boolean {
  return taxonGroup === "flowering_plants" || taxonGroup === "gymnosperms" || taxonGroup === "ferns_and_allies";
}

/**
 * True if this occurrence's reported country falls outside the species' native
 * range (its IUCN Red List assessment's country list, already Native-only).
 * Records with no reported country, or species with no native-range data at
 * all, can't be checked and are never flagged — same "nothing to contradict"
 * logic as isOutsideReportedCountry in coordinate-cleaning.ts.
 */
export function isOutsideNativeRange(
  countryCode: string | null | undefined,
  nativeCountries: readonly string[] | undefined,
): boolean {
  if (!countryCode || !nativeCountries || nativeCountries.length === 0) return false;
  const upper = countryCode.toUpperCase();
  return !nativeCountries.some((c) => c.toUpperCase() === upper);
}

/**
 * One driver's colour in the legend, with its name on hover.
 *
 * The same bubble FlagMark uses, for the same reason: these sit over the map,
 * where a native `title` never appears at all. A 10px square makes it worse —
 * the tooltip needs the pointer held still on a target smaller than the
 * pointer, so drifting along the row of seven cancels it every time. The
 * cursor promised something to read and nothing was ever shown.
 */
function DriverSwatch({ driver }: { driver: LossDriverClass }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      className="relative block h-2.5 w-2.5 rounded-sm cursor-help"
      style={{ background: driver.color }}
    >
      {/* Opens rightward: the legend sits against the map's left edge, so a
          bubble anchored the other way runs off the side of the screen. */}
      {open && (
        <span className="absolute bottom-4 left-0 z-[1000] block w-max max-w-[240px] rounded-md bg-zinc-900/95 dark:bg-zinc-700 px-1.5 py-1 text-[10px] leading-snug text-white shadow-lg">
          <span className="font-medium">{driver.label}</span>
          <span className="block text-zinc-300">{driver.description}</span>
        </span>
      )}
    </span>
  );
}

/**
 * Where an overlay's data comes from, as a citation you can click.
 *
 * These rows each carried an ⓘ linking to the source, which said that a source
 * existed and nothing about what it was. A layer drawn over a species' range
 * is evidence, and evidence in an assessment gets attributed — so the row
 * names the paper or the database instead, in the bracketed form a reader
 * already knows how to skim past or follow.
 *
 * It links where the ⓘ linked, and opens the same way: these sit inside a
 * <label>, so a plain anchor click would be forwarded to the checkbox and
 * toggle the layer on the way out.
 */
function SourceCitation({ href, cite, title }: { href: string; cite: string; title: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      }}
      className="shrink-0 italic tabular-nums text-[10px] text-zinc-400 hover:text-zinc-600 hover:underline dark:text-zinc-500 dark:hover:text-zinc-300"
    >
      [{cite}]
    </a>
  );
}

export default function OccurrenceMapRow({
  speciesKey,
  countryCode,
  mounted,
  assessmentYear,
  assessmentDate,
  assessmentId,
  sisTaxonId,
  category,
  criteria,
  taxonGroup,
  scientificName,
  nativeCountriesRedList,
  previousAssessments,
  fullscreen: fullscreenProp,
  dashboardTaxonToken,
  dashboardSpeciesKey,
  onEmpty,
}: OccurrenceMapRowProps) {
  const [occurrences, setOccurrences] = useState<OccurrenceFeature[]>([]);
  const [breakdown, setBreakdown] = useState<RecordTypeBreakdown | null>(null);
  const [loadingOccurrences, setLoadingOccurrences] = useState(true);
  const [loadingBreakdown, setLoadingBreakdown] = useState(true);

  const [checkedTypes, setCheckedTypes] = useState(() => defaultCheckedTypes());

  // Advanced filter state
  const [maxUncertainty, setMaxUncertainty] = useState<number | null>(null);
  // Custom max-uncertainty entry, shown instead of the preset <select> when active
  const [customUncertaintyMode, setCustomUncertaintyMode] = useState(false);
  const [customUncertaintyInput, setCustomUncertaintyInput] = useState("");
  // Date-range filter — client-side, narrows the *already-loaded* sample to an
  // eventDate window. null means "no restriction on that end" (mirrors
  // maxUncertainty's null-means-off pattern); both start null so the slider's
  // handles sit at the full loaded range until the user actually drags one.
  const [dateRangeFrom, setDateRangeFrom] = useState<string | null>(null);
  const [dateRangeTo, setDateRangeTo] = useState<string | null>(null);
  // Coordinate-cleaning checks (zero/equal coords, GBIF HQ, duplicates — see
  // src/lib/coordinate-cleaning.ts), individually toggleable. Default all off —
  // opt-in, since these are plausibility heuristics with real false-positive risk
  // (documented per-check), not the same as GBIF's own hasGeospatialIssue=false
  // parsing-error filter, which stays on unconditionally upstream of this. No
  // exceptions: not even null island or exact duplicates are trimmed before the
  // assessor asks, so the viewer opens on everything GBIF holds for the species.
  const [appliedChecks, setAppliedChecks] = useState<Record<QualityFlag, boolean>>(() =>
    defaultAppliedChecks()
  );
  // Native range only — hide occurrences reported in a country outside this
  // species' native range. Off by default (folded into the Coordinate cleaning
  // dropdown below as an opt-in check, same as every other check there).
  const [nativeRangeOnly, setNativeRangeOnly] = useState(false);
  // Which native-range source backs the filter above. Defaults to "wcvp" (POWO)
  // — the source issue #82 originally asked for by name — falling back to the
  // Red List assessment's own locations when this species has no WCVP match.
  // The two sources can genuinely disagree (e.g. Acorus calamus: WCVP treats it
  // as native only to Kazakhstan, everywhere else — including the Red List
  // assessment's own 26-country list — as introduced), which is why both are
  // offered rather than picking one as canonical.
  const [nativeRangeSource, setNativeRangeSource] = useState<"redlist" | "wcvp">("wcvp");
  const [nativeCountriesWcvp, setNativeCountriesWcvp] = useState<string[] | null>(null);
  // This species' accepted-taxon POWO/IPNI id (from the WCVP fetch), for linking
  // out to its real POWO page — see the "POWO native range" overlay's info icon.
  const [wcvpPowoId, setWcvpPowoId] = useState<string | null>(null);
  const [loadingWcvpRange, setLoadingWcvpRange] = useState(false);
  const [colorByDate, setColorByDate] = useState(true);
  /** The spanner beside GBIF points: how they're coloured, and split view. */
  const [gbifOptionsOpen, setGbifOptionsOpen] = useState(false);
  const gbifOptionsRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!gbifOptionsOpen) return;
    // Capture, so a click elsewhere closes it before that thing acts — but not
    // a click inside the menu, which would tear it down before its own button
    // ever fired.
    const close = (e: MouseEvent) => {
      if (gbifOptionsRef.current?.contains(e.target as Node)) return;
      setGbifOptionsOpen(false);
    };
    document.addEventListener("click", close, true);
    return () => document.removeEventListener("click", close, true);
  }, [gbifOptionsOpen]);
  const [basemap, setBasemap] = useState<BasemapKey>("streets");
  // Overlays — informational map layers, independent of the "Native range only"
  // occurrence filter above: shading which countries a source considers native,
  // regardless of whether occurrences are being filtered by it.
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

  /**
   * The effort surface this species can honestly be shown against.
   *
   * Null withholds the layer entirely rather than falling back to all-taxa:
   * the dataset has no fish group, and nothing covering crustaceans, corals,
   * mosses or the algae, so for those an all-groups surface would answer a
   * question nobody asked — "is this sea well surveyed?" when what was
   * surveyed was seabirds.
   */
  const nativeEffortGroup = effortGroupFor(taxonGroup);
  const [effortGroup, setEffortGroup] = useState<EffortGroup | null>(nativeEffortGroup);
  const [effortGroupFor_, setEffortGroupFor] = useState(speciesKey);
  if (effortGroupFor_ !== speciesKey) {
    setEffortGroupFor(speciesKey);
    setEffortGroup(nativeEffortGroup);
  }
  const { layer: effortLayer, loading: effortLoading } = useSamplingEffort(
    showSamplingEffort && nativeEffortGroup ? effortGroup : null
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

  useEffect(() => {
    if (!showEcoregions || ecoregions || ecoregionsLoading) return;
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
  }, [showEcoregions, ecoregions, ecoregionsLoading]);

  /** Whether the Overlays panel is rolled up to its header. */
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const overlaysRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the basemap list is showing, or just its icon.
   *
   * Folded to one button until asked for. Six basemap names down the side of
   * the map is a lot of furniture for a choice most people make once, if ever.
   */
  const [basemapOpen, setBasemapOpen] = useState(false);
  /** Whether the map's tools menu — EOO/AOO and measuring — is showing. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /**
   * Which list is under the map: GBIF's records, or the imported file's rows.
   *
   * Two tables rather than one. The file's rows aren't GBIF records — they
   * have their own columns, several of them are tied to no GBIF record at all,
   * and the ones that are already say so in that record's panel — so putting
   * them in the same table would have meant a row that means something
   * different in every column.
   */
  const [listTab, setListTab] = useState<"gbif" | "excluded" | "file" | "nearby">("gbif");
  /** Whether the nearby tab has already been brought forward for this search. */
  const nearbyTabSeen = useRef(false);
  /**
   * The record whose menu is open, from clicking its point.
   *
   * A click used to open gbif.org straight away, which is one of four things
   * you might want and the only one that leaves the page. The others — read
   * every field in the table, strike the record out, settle which of a stack
   * of duplicates is the real one — have no other way in from the map.
   */

  const [showRangeMetrics, setShowRangeMetrics] = useState(false);
  /**
   * The AOO grid's cell width, in kilometres.
   *
   * 2 km is the Red List standard (Guidelines §4.10) and the only width whose
   * result is comparable with a published assessment — but AOO is scale
   * dependent, so it's a parameter of the measurement rather than a constant,
   * and GeoCAT lets an assessor set it. Changing it is deliberately a step
   * away from the default rather than a field sitting open.
   */
  const [aooCellKm, setAooCellKm] = useState(2);
  const [aooCellOpen, setAooCellOpen] = useState(false);
  const [habitatLegendOpen, setHabitatLegendOpen] = useState(false);
  /** Whether the tree cover loss legend's two caveats are showing. */
  const [forestLossNotesOpen, setForestLossNotesOpen] = useState(false);
  const [lossDriverNotesOpen, setLossDriverNotesOpen] = useState(false);
  const [biomeLegendOpen, setBiomeLegendOpen] = useState(false);
  /**
   * What's at the point last clicked: its elevation, and — when the overlay is
   * on — what protects it.
   *
   * Elevation is here because it's the constraint a specimen label gives you
   * that a locality description doesn't: "1900 m" is checkable against the
   * ground before you place a point, and having to leave the map to check it is
   * how it stops being checked.
   *
   * A click routinely sits inside several designations at once — a national
   * park that is also a World Heritage site and a biosphere reserve — and
   * they're all true, so the popup lists them and outlines whichever one you're
   * pointing at rather than picking one on your behalf.
   */
  const [pointQuery, setPointQuery] = useState<{
    /** Which button opened it — the two answer different questions. */
    kind: "areas" | "point";
    panelId: string;
    lng: number;
    lat: number;
    elevation: number | null;
    elevationLoading: boolean;
    areas: ProtectedArea[];
    areasLoading: boolean;
    areasFailed?: boolean;
    /** Which of the listed areas is outlined on the map. */
    highlight: number;
  } | null>(null);
  const pointQueryId = useRef(0);
  /** Discards a habitat lookup that a later click has already superseded. */
  const habitatQueryId = useRef(0);
  const forestQueryId = useRef(0);
  /** Copied-to-clipboard acknowledgement, cleared on a timer. */
  const [copiedPoint, setCopiedPoint] = useState(false);
  /**
   * The measuring tool: the points clicked so far, along the ground.
   *
   * Started from the right-click menu, like Google Maps, because it's a mode —
   * while it's on, a left click adds a vertex rather than doing what a left
   * click normally does, and that needs to have been asked for.
   */
  const [measure, setMeasure] = useState<[number, number][] | null>(null);
  /** True while the map is being panned, so the cursor can say so. */
  const [panning, setPanning] = useState(false);
  /**
   * True while the pointer is over a record — a GBIF point, one of the
   * assessor's own, or a point-file row.
   *
   * The points are clickable (they open the record on GBIF) and nothing said
   * so: the cursor stayed an arrow over them and only turned into a hand if
   * the tooltip happened to slide under the pointer, so the hand came and went
   * for reasons that had nothing to do with what was underneath it.
   */
  const [hoveringPoint, setHoveringPoint] = useState(false);
  /**
   * Places pinned from the search, kept until each is dismissed by its own ×.
   *
   * They accumulate on purpose: a locality description names several places —
   * "Carretera Hollín-Loreto-Coca, near Volcán Sumaco" — and pinning them all
   * at once is how you see whether they agree with each other and with the
   * records, which is the judgement being made.
   */
  const [georefMessage, setGeorefMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const {
    georeferences,
    exclusions,
    dates: assessorDates,
    notes: assessorNotes,
    pins,
    commit: commitEdits,
    undo: undoEdit,
    redo: redoEdit,
    jumpBack: jumpBackEdits,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    history: editHistory,
  } = useAssessorEdits(speciesKey, {
    onStorageError: () =>
      setGeorefMessage({
        kind: "error",
        text: "Couldn't save to this browser's storage — export before you close the tab.",
      }),
  });
  const pinnedPlaces = pins;
  /**
   * Pins go through the same commit every other edit does.
   *
   * They were their own state with their own effect writing them to storage,
   * which meant the one edit undo couldn't reach was the one naming a place no
   * gazetteer knows. Deleting a pin was as unrecoverable as deleting a
   * georeference and had no way back.
   */
  const setPinnedPlaces = useCallback(
    (update: (prev: PinnedPlace[]) => PinnedPlace[], label: string) => {
      commitEdits({ pins: update(pins) }, label);
    },
    [commitEdits, pins]
  );
  /** The label being typed in the right-click panel, before the pin exists. */
  const [newPinLabel, setNewPinLabel] = useState("");
  /**
   * The spot the "recorded nearby" panel is describing, once asked for.
   *
   * Held here rather than on pointQuery so the panel outlives the popup that
   * opened it — you ask what else is here, then carry on clicking around the
   * map with the answer still up beside it.
   */
  const [nearbyAt, setNearbyAt] = useState<{ lng: number; lat: number; recordName: string } | null>(null);
  /**
   * The radius the nearby panel is asking about, held here because the map
   * draws it: "within 10 km" is a claim about the ground, and a list that says
   * it without showing it leaves you to guess whether the next valley is in or
   * out. Opening it on a different record starts from the default again.
   */
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState<NearbyRadiusKm>(NEARBY_RADIUS_DEFAULT);
  /**
   * One neighbour from the list, drawn on the map.
   *
   * One at a time on purpose: every neighbour at once is a thousand anonymous
   * dots over the records the assessor came to look at, where one species is a
   * shape that can be read — a valley, a roadside, a single locality everything
   * came from.
   */
  const [nearbyPicked, setNearbyPicked] = useState<{ key: string; name: string; commonName: string | null }[]>([]);
  /** Each picked species' records, by GBIF key, as they arrive. */
  const [nearbyPoints, setNearbyPoints] = useState<Record<string, { points: NearbyPoint[]; total: number }>>({});
  /**
   * The neighbours' records under the last click, and which of them is showing.
   *
   * A list rather than one record, because these stack: a locality collected
   * from repeatedly puts several dots on the same pixel, and with only the top
   * one clickable the ones underneath were unreachable — the same problem the
   * map's own records solve by paging, so this pages the same way.
   */
  const [nearbyShownGroup, setNearbyShownGroup] = useState<NearbyPoint[]>([]);
  const [nearbyShownIndex, setNearbyShownIndex] = useState(0);
  const nearbyShown = nearbyShownGroup[Math.min(nearbyShownIndex, nearbyShownGroup.length - 1)] ?? null;
  /**
   * Picked species currently switched off in the legend.
   *
   * Hiding is not un-picking: the list in the panel still shows what you chose
   * and its colour, and the records are already fetched, so switching one back
   * on is instant. It is the same distinction the map's own layers make between
   * a checkbox and removing a thing.
   */
  const [nearbyHidden, setNearbyHidden] = useState<Set<string>>(new Set());
  /** Whether the legend's nearby-species list is rolled up. */
  const [nearbyLegendOpen, setNearbyLegendOpen] = useState(true);
  /** Where the browser says the reader is, once they've asked. */
  const [locating, setLocating] = useState<"idle" | "asking" | "denied">("idle");
  /** Where the browser last said the reader was, marked on the map. */
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);

  /**
   * Fly to where the reader is.
   *
   * The panel's question — what is around this point — has an obvious first
   * answer the map could not reach: where you are standing. The browser will
   * not give it without a prompt, so this is a button rather than anything
   * that happens on load.
   */
  const findMe = useCallback(() => {
    if (!navigator.geolocation) {
      setLocating("denied");
      return;
    }
    setLocating("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating("idle");
        const { latitude: lat, longitude: lng } = pos.coords;
        // Takes you there and stops. Listing what is threatened around you is a
        // question you then ask of the spot, with the same right click as
        // anywhere else — doing it on arrival made one button do two things,
        // and the second was rarely the one being asked for.
        setMyLocation({ lat, lng });
        mapRef.current?.flyTo({ center: [lng, lat], zoom: 11, duration: 900 });
      },
      // Denied, or no fix. Either way the map cannot help and says so rather
      // than leaving the button spinning.
      () => setLocating("denied"),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  /**
   * A colour per picked species, by pick order.
   *
   * Held against the key rather than the list position so that dropping the
   * first of three doesn't recolour the other two under the reader — the
   * legend and the map would both change meaning without anything being asked
   * for. A freed colour is handed to the next species picked.
   */
  const nearbyColors = useMemo(() => {
    const out: Record<string, string> = {};
    const taken = new Set<string>();
    for (const p of nearbyPicked) {
      const free = NEARBY_PICKED_COLORS.find((c) => !taken.has(c)) ?? NEARBY_PICKED_COLORS[0];
      out[p.key] = free;
      taken.add(free);
    }
    return out;
  }, [nearbyPicked]);

  const toggleNearbyPicked = useCallback((species: { key: string; name: string; commonName: string | null }) => {
    setNearbyPicked((prev) => {
      if (prev.some((p) => p.key === species.key)) {
        setNearbyHidden((hidden) => {
          if (!hidden.has(species.key)) return hidden;
          const next = new Set(hidden);
          next.delete(species.key);
          return next;
        });
        return prev.filter((p) => p.key !== species.key);
      }
      // Past the palette the map stops being readable, so the oldest pick makes
      // way rather than the newest being silently refused.
      return [...prev, species].slice(-NEARBY_MAX_PICKED);
    });
  }, []);

  // One request per newly picked species; a species already fetched at this
  // radius is not asked for again, so re-picking one is instant.
  useEffect(() => {
    if (!nearbyAt || nearbyPicked.length === 0) {
      setNearbyPoints({});
      return;
    }
    const controller = new AbortController();
    for (const picked of nearbyPicked) {
      const params = new URLSearchParams({
        lat: String(nearbyAt.lat),
        lng: String(nearbyAt.lng),
        radiusKm: String(nearbyRadiusKm),
        speciesKey: picked.key,
      });
      fetch(`/api/nearby-species/points?${params}`, { signal: controller.signal })
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
          setNearbyPoints((prev) => ({
            ...prev,
            [picked.key]: { points: body.points ?? [], total: body.total ?? 0 },
          }));
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          // A neighbour that won't draw shouldn't take the list down with it:
          // its row stops saying "drawing…" and nothing appears.
          setNearbyPoints((prev) => ({ ...prev, [picked.key]: { points: [], total: 0 } }));
        });
    }
    return () => controller.abort();
  }, [nearbyAt, nearbyPicked, nearbyRadiusKm]);

  // Changing the radius invalidates every drawn set at once.
  const nearbyFetchKey = `${nearbyAt?.lat},${nearbyAt?.lng},${nearbyRadiusKm}`;
  const lastNearbyFetchKey = useRef(nearbyFetchKey);
  if (lastNearbyFetchKey.current !== nearbyFetchKey) {
    lastNearbyFetchKey.current = nearbyFetchKey;
    if (Object.keys(nearbyPoints).length) setNearbyPoints({});
    if (nearbyShownGroup.length) setNearbyShownGroup([]);
  }

  const nearbyPointsGeoJson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      // Keyed and indexed rather than carrying the record: MapLibre flattens
      // feature properties through its tile encoding, so this pair is what
      // survives to find the point again on a click. The colour rides along
      // because one layer draws every picked species.
      features: nearbyPicked.filter((p) => !nearbyHidden.has(p.key)).flatMap((p) =>
        (nearbyPoints[p.key]?.points ?? []).map((pt, i) => ({
          type: "Feature" as const,
          properties: { nearbyKey: p.key, nearbyIndex: i, color: nearbyColors[p.key] },
          geometry: { type: "Point" as const, coordinates: [pt.lng, pt.lat] },
        }))
      ),
    }),
    [nearbyPicked, nearbyPoints, nearbyColors, nearbyHidden]
  );
  /** A pin whose label is being renamed in place. */
  const [renamingPin, setRenamingPin] = useState<string | null>(null);
  /**
   * Drops a pin where you right-clicked.
   *
   * Somewhere worth remembering on a map rarely has a name a gazetteer knows —
   * "the ridge the 1987 collections came from", "where the road crosses the
   * river" — so the label is whatever you say it is, and blank falls back to
   * the coordinates rather than to nothing.
   */
  const addPin = useCallback((lng: number, lat: number, label: string) => {
    setPinnedPlaces((prev) => {
      // Numbered from what's already there rather than from a counter, so a
      // pin restored from the last session can't have its id taken by a new
      // one.
      const used = new Set(prev.map((place) => place.id));
      let n = prev.length + 1;
      while (used.has(`pin-${n}`)) n += 1;
      return [
        ...prev,
        {
          id: `pin-${n}`,
          name: label.trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
          context: "",
          lat,
          lng,
        },
      ];
    }, `Pin ${label.trim() || "a place"}`);
  }, [setPinnedPlaces]);
  /** The candidate under the pointer in the results list, marked but not flown
   *  to — you're deciding which one to commit to, and moving the camera for
   *  each one you glance at would lose the records you're comparing against. */
  const [previewPlace, setPreviewPlace] = useState<Place | null>(null);

  const goToPlace = useCallback((place: Place) => {
    setPinnedPlaces(
      (prev) => (prev.some((p) => p.id === place.id) ? prev : [...prev, place]),
      `Pin ${place.name}`
    );
    const map = mapRef.current;
    if (!map) return;
    // A named area gets its extent; a point gets a zoom close enough to read
    // the ground without losing the surroundings you're matching the label
    // against.
    if (place.bbox) {
      map.fitBounds([[place.bbox[0], place.bbox[1]], [place.bbox[2], place.bbox[3]]], {
        padding: 80,
        maxZoom: 14,
        duration: 900,
      });
    } else {
      map.flyTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 11), duration: 900 });
    }
  }, [setPinnedPlaces]);
  const [showPowoRangeOverlay, setShowPowoRangeOverlay] = useState(false);
  const [showIucnRangeOverlay, setShowIucnRangeOverlay] = useState(false);
  // Whether the current hover started on the map — the list scrolls to meet a
  // map hover, but must not yank itself around under the pointer for its own.

  // Which way the two panels sit. Dragging the divider resizes them; this flips
  // the axis. Side by side by default: a record has sixteen columns and a
  // screen is wider than it is tall, so beneath the map the table showed four
  // of them.
  const [panelLayout, setPanelLayout] = useState<"rows" | "columns">("columns");
  /**
   * How much of the table's own size it's drawn at.
   *
   * Its own size, and adjustable to any percentage from the control beside the
   * tabs. It used to open at two thirds to fit more columns beside the map,
   * which bought columns at the cost of legibility on every screen — including
   * the ones with room to spare. The even split does that job better, and
   * anyone who wants the columns back can shrink it.
   *
   * Not remembered between reloads, unlike the column and sort preferences
   * beside it — worth doing if it turns out to be set once and left.
   */
  const [listZoom, setListZoom] = useState(LIST_ZOOM_DEFAULT);

  // Fullscreen — map above, record list below, and nothing else on the page —
  // is a route of its own (/mapping/<key>), so it can be linked, shared,
  // and loaded without the dashboard's own queries. The component just renders
  // that way when told to.
  const fullscreen = !!fullscreenProp;

  // Leaving fullscreen returns to this species on the dashboard, not the
  // landing page — a shared link is usually the first thing someone sees, and
  // dropping them into an unfiltered dashboard loses the species they came for.
  // The taxon token matters as much as the search text: the Not Evaluated view
  // won't list anything until the tree is narrowed (there are 1.8M unassessed
  // species), so `search=` on its own arrives at an empty dashboard.
  const dashboardHref = useMemo(() => {
    if (!scientificName) return "/";
    const params = new URLSearchParams({ search: scientificName });
    if (category === "NE") params.set("view", "new-assessments");
    if (dashboardTaxonToken) params.set("taxa", dashboardTaxonToken);
    // Open the row itself, on the tab you were just looking at — the dashboard
    // already reads both of these from the URL.
    if (dashboardSpeciesKey) {
      params.set("species", dashboardSpeciesKey);
      params.set("tab", "gbif");
    }
    return `/?${params}`;
  }, [scientificName, category, dashboardTaxonToken, dashboardSpeciesKey]);
  // Share of the fullscreen height given to the map, as a percentage. Two
  // thirds by default, dragged from the divider between map and list.
  const [mapHeightPct, setMapHeightPct] = useState(FULLSCREEN_DEFAULT_MAP_PCT);
  const [draggingDivider, setDraggingDivider] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitView, setSplitView] = useState(false);
  const [splitDate, setSplitDate] = useState<string>(assessmentDate?.split("T")[0] || "");
  const [sharedViewState, setSharedViewState] = useState({ longitude: 0, latitude: 20, zoom: 1.5 });
  const mapRef = useRef<MapRef>(null);
  // Initial fetch size — no longer user-adjustable; loading more of a specific
  // basis-of-record category is handled by loadMoreForCategory below instead.
  const sampleSize = 300;

  // GBIF points toggle (on by default)
  const [showGbif, setShowGbif] = useState(true);

  /**
   * The three point sets are toggled independently rather than being one
   * choice, because the comparison the assessor is making is between them —
   * hiding GBIF's to look at the other two is as useful as the reverse.
   */
  const [showMyGeoreferences, setShowMyGeoreferences] = useState(true);
  const [showPointFile, setShowPointFile] = useState(true);
  /** Whether the hand-dropped pins are drawn. They are notes to yourself, and
   *  a map you are reading the records off is sometimes better without them. */
  const [showPins, setShowPins] = useState(true);
  /** Whether struck-out records stay on the map, greyed, or come off it. */
  const [showExcludedOnMap, setShowExcludedOnMap] = useState(true);

  /**
   * Outside fullscreen the map draws GBIF's records and nothing else.
   *
   * The panel that toggles these three is fullscreen-only, so on the dashboard
   * an assessor's own coordinates and an imported point file would be drawn
   * with no way to take them off — and worse, no label saying they were there.
   * The dashboard's map answers "what does GBIF hold for this species", which
   * is one layer's worth of question.
   */
  const drawMyGeoreferences = showMyGeoreferences && fullscreen;
  const drawPointFile = showPointFile && fullscreen;

  /**
   * The IUCN point file loaded for this species, if any.
   *
   * Read from its own store, and adjusted during render when the species
   * changes rather than in an effect — an effect would paint one frame of the
   * previous species' points over the new species' map.
   */
  const [pointFile, setPointFile] = useState<PointFileImport | null>(() => loadPointFile(speciesKey));
  const [pointFileOpen, setPointFileOpen] = useState(false);
  const [pointFileLoadedFor, setPointFileLoadedFor] = useState(speciesKey);
  if (pointFileLoadedFor !== speciesKey) {
    setPointFileLoadedFor(speciesKey);
    setPointFile(loadPointFile(speciesKey));
  }

  // Range maps and AOH are both restricted for now — hide their toggles
  // unless the signed-in user is an admin. The real enforcement is
  // server-side (the /range-map and /aoh API routes themselves 403); this is
  // just so unauthorized users don't see a toggle for a layer they can't
  // actually load. Triggered on either assessmentId or sisTaxonId since AOH
  // availability keys off sisTaxonId, not assessmentId.
  const [canViewRangeMap, setCanViewRangeMap] = useState(false);
  // The signed-in account, if any — used to fill georeferencedBy on a saved
  // georeference. Nothing here is gated on it.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : { canViewRangeMap: false, email: null }))
      .then((data: { canViewRangeMap?: boolean; email?: string | null }) => {
        if (cancelled) return;
        setCanViewRangeMap(!!data.canViewRangeMap);
        setAccountEmail(data.email ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Records struck out by hand, each with the reason given. Distinct from a
  // filter: the filters answer "which records match these rules", this answers
  // "I have looked at that one and it shouldn't count" — and the reason is the
  // part worth keeping, so it's stored alongside the georeferences.
  const [pendingExclusion, setPendingExclusion] = useState<number[] | null>(null);

  // Range map layer state
  const [showRange, setShowRange] = useState(false);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeNotFound, setRangeNotFound] = useState(false);
  const [rangeCategories, setRangeCategories] = useState<import("@/components/RangeMapLayer").RangeCategory[]>([]);
  const [visibleCategories, setVisibleCategories] = useState<Set<string> | undefined>(undefined);
  const [rangeCategoriesExpanded, setRangeCategoriesExpanded] = useState(false);
  const [rangeSimplification, setRangeSimplification] = useState<import("@/components/RangeMapLayer").SimplificationInfo | null>(null);
  // Currently-visible range polygons (post category-filtering), reported up from
  // RangeMapLayer — paired with filteredOccurrences below to compute the
  // in-range/out-of-range breakdown shown in the corner stats table.
  const [rangePolygons, setRangePolygons] = useState<Feature[] | null>(null);

  // AOH layer state. taxonGroup is the friendly bucket name ("birds", not
  // "aves") — matches taxon_group from the species API, not class_name.
  // Gated behind the same admin check as the range map layer — the AOH API
  // routes enforce this server-side too, this just hides the toggle from
  // users who can't load it anyway.
  const isAohAvailable = !!(sisTaxonId && taxonGroup && canViewRangeMap &&
    ["mammals", "birds", "reptiles", "amphibians"].includes(taxonGroup.toLowerCase()));
  const [showAoh, setShowAoh] = useState(false);
  const [aohLoading, setAohLoading] = useState(false);

  // Filters dropdown state
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);

  // Coordinate-cleaning checks dropdown state
  const [cleaningFilterOpen, setCleaningFilterOpen] = useState(false);
  const cleaningFilterRef = useRef<HTMLDivElement>(null);

  // Date-range filter dropdown state
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const dateRangeRef = useRef<HTMLDivElement>(null);
  // Which of the two overlapping range-input handles was most recently grabbed —
  // given the raise-on-interaction z-index below, so whichever the user is actively
  // dragging always stays on top and stays grabbable even where the handles overlap.
  const [activeDateHandle, setActiveDateHandle] = useState<"from" | "to" | null>(null);

  // Fixed page size for filmstrip
  const pageSize = INAT_PAGE_SIZE;

  // iNat photos pagination
  const [inatPage, setInatPage] = useState(0);
  const [inatPhotos, setInatPhotos] = useState<InatObservation[]>([]);
  const [inatTotalCount, setInatTotalCount] = useState(0);
  const [loadingInatPhotos, setLoadingInatPhotos] = useState(false);

  // Close filters popover on outside click
  useEffect(() => {
    if (!filtersOpen) return;
    const handler = (e: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) {
        setFiltersOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filtersOpen]);

  // Close coordinate-cleaning popover on outside click
  useEffect(() => {
    if (!cleaningFilterOpen) return;
    const handler = (e: MouseEvent) => {
      if (cleaningFilterRef.current && !cleaningFilterRef.current.contains(e.target as Node)) {
        setCleaningFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [cleaningFilterOpen]);

  // Close the overlays dropdown on outside click
  useEffect(() => {
    if (!overlaysOpen) return;
    const handler = (e: MouseEvent) => {
      if (overlaysRef.current && !overlaysRef.current.contains(e.target as Node)) {
        setOverlaysOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [overlaysOpen]);

  // Close date-range popover on outside click
  useEffect(() => {
    if (!dateRangeOpen) return;
    const handler = (e: MouseEvent) => {
      if (dateRangeRef.current && !dateRangeRef.current.contains(e.target as Node)) {
        setDateRangeOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dateRangeOpen]);

  // Hovered iNat observation (for map highlight)
  const [hoveredObs, setHoveredObs] = useState<InatObservation | null>(null);

  // Hovered occurrence on map (for hover tooltip)
  const [hoveredFeature, setHoveredFeature] = useState<OccurrenceFeature | null>(null);
  const [hoveredPanel, setHoveredPanel] = useState<string | null>(null);
  /**
   * Where the current hover came from.
   *
   * Both the map and the list set the same hoveredFeature — that's what links
   * them — but only a hover on the map itself opens the tooltip. Reading down
   * the table shouldn't have a panel following your pointer across the map;
   * seeing which point the row is is the whole of what's wanted there.
   */
  const [hoverSource, setHoverSource] = useState<"map" | "list" | null>(null);
  /** A hovered point from the loaded IUCN point file, which is not a GBIF record. */
  /**
   * Where to hang the panel for a record that has no coordinates of its own:
   * the imported point that matched it. Keyed by record so it can never be
   * left over from the last one hovered.
   */
  const [hoverAnchor, setHoverAnchor] = useState<{ gbifID: number; lng: number; lat: number } | null>(null);
  const [pointFileHover, setPointFileHover] = useState<{
    row: number;
    lat: number;
    lng: number;
    panelId: string;
  } | null>(null);
  // Which of the records sharing a point the tooltip is showing, and whether
  // the pointer has moved onto the tooltip itself — without that, reaching for
  // the pager takes the pointer off the point and dismisses the thing.
  const [groupIndex, setGroupIndex] = useState(0);
  const [tooltipHeld, setTooltipHeld] = useState(false);
  /**
   * Clearing the hover is delayed by a beat so the pointer can travel from the
   * point (or the row) onto the tooltip itself. Without the gap the tooltip
   * unmounts the instant you set off towards its pager, which makes paging
   * between co-located records impossible to actually reach.
   */
  const hoverClearTimer = useRef<number | null>(null);
  /**
   * Set once you page through the records at a point, and only then.
   *
   * Hovering stays hovering — but the moment you click through the pager the
   * tooltip has to stop being hover-driven, because it resizes as you go: step
   * onto a record with no specimen image and it shrinks out from under the
   * pointer, which reads as "hovered away" and loses your place mid-sequence.
   * Kept in a ref as well as state so the pinning is in effect before the
   * mouseleave that same click provokes.
   */
  const [tooltipPinned, setTooltipPinned] = useState(false);
  const occurrencesByGbifIdRef = useRef<Map<number, OccurrenceFeature>>(new Map());
  const tooltipPinnedRef = useRef(false);
  const pinTooltip = useCallback(() => {
    tooltipPinnedRef.current = true;
    setTooltipPinned(true);
  }, []);
  const unpinTooltip = useCallback(() => {
    tooltipPinnedRef.current = false;
    setTooltipPinned(false);
  }, []);
  const cancelHoverClear = useCallback(() => {
    if (hoverClearTimer.current != null) {
      window.clearTimeout(hoverClearTimer.current);
      hoverClearTimer.current = null;
    }
  }, []);
  const closeTooltip = useCallback(() => {
    setRowMenu(null);
    cancelHoverClear();
    unpinTooltip();
    setTooltipHeld(false);
    setHoveredFeature(null);
    setHoveredPanel(null);
    setPointFileHover(null);
  }, [cancelHoverClear, unpinTooltip]);

  const clearHoverSoon = useCallback(() => {
    // A pinned tooltip (several records at one point) ignores hover-out
    // entirely; see tooltipPinned below.
    if (tooltipPinnedRef.current) return;
    cancelHoverClear();
    hoverClearTimer.current = window.setTimeout(() => {
      hoverClearTimer.current = null;
      setHoveredFeature(null);
      setHoveredPanel(null);
    }, 220);
  }, [cancelHoverClear]);

  // Touch-only device detection (no hover tooltips on touch-only devices)
  // Check for coarse pointer (phone/tablet) rather than maxTouchPoints which is true on Mac trackpads
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  useEffect(() => {
    setIsTouchDevice(window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches);
  }, []);

  // Lookup: gbifID → InatObservation (for showing photos in map popups)
  const inatPhotosByGbifId = useMemo(() => {
    const m = new Map<number, InatObservation>();
    for (const obs of inatPhotos) {
      if (obs.gbifID) m.set(obs.gbifID, obs);
    }
    return m;
  }, [inatPhotos]);

  // Total occurrences count (from API metadata)
  const [totalOccurrences, setTotalOccurrences] = useState<number | null>(null);
  // Bounding box from API: [minLon, minLat, maxLon, maxLat]
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null);
  // How far into GBIF's own (unfiltered, all-basis-of-record) result ordering we've
  // paged — GBIF has no date-sort param (see api/occurrences/route.ts), but its default
  // order is newest-year-first, so paging further with this offset surfaces the next
  // oldest batch. Kept separate from occurrences.length, which also grows via
  // loadMoreForCategory's per-category fetches and would desync from what GBIF's
  // unfiltered ordering actually considers "next" if reused here.
  const [generalOffset, setGeneralOffset] = useState(0);

  // Opt-in record sets the viewer has always filtered out: records GBIF has no
  // coordinates for, and records whose coordinates GBIF flags. Both are only
  // useful in the list (one can't be drawn at all, the other shouldn't be
  // trusted where it's drawn), and both are what an assessor georeferences by
  // hand — so they're off until asked for, and their totals are always fetched
  // so the toggles can name what's being hidden.
  // Fetched automatically in fullscreen — the list is the only place they can
  // be read, and it's the whole point of that page. Off elsewhere, where
  // there's no list to put them in.
  const includeMissing = !!fullscreenProp;
  // Records GBIF flags are always fetched now: they have coordinates, so they
  // belong with the rest and are hidden (or not) by a coordinate-cleaning check
  // like any other suspect point, rather than by a separate opt-in.
  // Off by default — the same rule the other cleaning checks follow, since
  // this is now one of them.
  const [hideGbifFlagged, setHideGbifFlagged] = useState(false);
  const [recordSetTotals, setRecordSetTotals] = useState<{ mapped: number; issue: number; missing: number } | null>(null);

  /**
   * Everything the assessor has added for this species — their georeferences and
   * their exclusions — as one document with undo and redo over it.
   *
   * Held in the browser (see lib/georeferences.ts) and never sent to GBIF: they
   * are one person's working interpretation of a locality description, not a
   * correction anyone has vouched for. Every write goes through `commitEdits`,
   * which is also the only thing that persists, so nothing can change the data
   * without becoming undoable.
   */
  const [historyOpen, setHistoryOpen] = useState(false);

  /** A dragged georeference waiting to be confirmed or put back. */

  // Fetch occurrences (re-fetches when the requested record sets change)
  useEffect(() => {
    setLoadingOccurrences(true);
    const params = new URLSearchParams({
      speciesKey,
      limit: sampleSize.toString(),
    });
    if (countryCode) {
      params.set("country", countryCode);
    }
    if (includeMissing) params.set("includeMissing", "true");
    params.set("includeIssues", "true");
    fetch(`/api/occurrences?${params}`)
      .then((res) => res.json())
      .then((data) => {
        const features = data.features || [];
        setOccurrences(features);
        setTotalOccurrences(data.metadata?.total ?? null);
        setBbox(data.metadata?.bbox ?? null);
        setRecordSetTotals(data.metadata?.totals ?? null);
        setGeneralOffset(features.length);
      })
      .catch(console.error)
      .finally(() => setLoadingOccurrences(false));
  }, [speciesKey, countryCode, sampleSize, includeMissing]);

  // Basis-of-record category currently fetching more records, if any (drives the
  // per-row "Load more" spinner/disabled state in the dropdown).
  const [loadingMoreCategory, setLoadingMoreCategory] = useState<string | null>(null);
  // True while the general "Load N more" button (next to the "Loaded X of Y" badge)
  // is fetching the next unfiltered batch — separate from loadingMoreCategory since
  // this isn't scoped to one basis-of-record category.
  const [loadingMoreOverall, setLoadingMoreOverall] = useState(false);
  const [loadingMoreMissing, setLoadingMoreMissing] = useState(false);

  // Records with no coordinates arrive as their own bounded sample, so a
  // species with hundreds of unlocalised sheets doesn't stall the first paint.
  // This pages that set alone, from however many are already loaded.
  const loadMoreMissing = useCallback(() => {
    setLoadingMoreMissing(true);
    const loaded = occurrences.filter((o) => o.properties.coordinateStatus === "missing").length;
    const params = new URLSearchParams({
      speciesKey,
      limit: sampleSize.toString(),
      offset: loaded.toString(),
      onlyMissing: "true",
    });
    if (countryCode) params.set("country", countryCode);
    fetch(`/api/occurrences?${params}`)
      .then((res) => res.json())
      .then((data) => {
        const next: OccurrenceFeature[] = data.features || [];
        setOccurrences((prev) => {
          const seen = new Set(prev.map((o) => o.properties.gbifID));
          return [...prev, ...next.filter((f) => !seen.has(f.properties.gbifID))];
        });
      })
      .catch(console.error)
      .finally(() => setLoadingMoreMissing(false));
  }, [occurrences, speciesKey, countryCode, sampleSize]);

  // Load another batch of just one basis-of-record category (e.g. "load 200 more
  // Preserved specimen records"), independent of the overall sample-size selector —
  // that reloads everything and is dominated by whichever category is most numerous.
  // Offsets by how many of this category are already loaded, and de-dupes the merge
  // by gbifID since the untargeted main fetch and this filtered one aren't guaranteed
  // to line up by offset alone.
  const loadMoreForCategory = useCallback((key: string) => {
    const gbifBasis = GBIF_BASIS_OF_RECORD[key];
    if (!gbifBasis) return;
    setLoadingMoreCategory(key);
    const alreadyLoaded = occurrences.filter((o) => classifyOccurrence(o) === key).length;
    const params = new URLSearchParams({
      speciesKey,
      basisOfRecord: gbifBasis,
      limit: BASIS_OF_RECORD_LOAD_MORE_BATCH.toString(),
      offset: alreadyLoaded.toString(),
    });
    if (countryCode) {
      params.set("country", countryCode);
    }
    fetch(`/api/occurrences?${params}`)
      .then((res) => res.json())
      .then((data) => {
        const newFeatures: OccurrenceFeature[] = data.features || [];
        setOccurrences((prev) => {
          const seen = new Set(prev.map((o) => o.properties.gbifID));
          const toAdd = newFeatures.filter((f) => !seen.has(f.properties.gbifID));
          return [...prev, ...toAdd];
        });
      })
      .catch(console.error)
      .finally(() => setLoadingMoreCategory(null));
  }, [occurrences, speciesKey, countryCode]);

  // Load the next batch across all basis-of-record categories together — the general
  // "Load N more" button next to the "Loaded X of Y" badge. Paginates via generalOffset
  // rather than occurrences.length so per-category loads (loadMoreForCategory) don't
  // desync it from GBIF's own unfiltered offset; de-dupes the merge by gbifID for the
  // same reason (a record already pulled in by a per-category load may reappear here).
  const loadMoreOverall = useCallback(() => {
    setLoadingMoreOverall(true);
    const params = new URLSearchParams({
      speciesKey,
      limit: OVERALL_LOAD_MORE_BATCH.toString(),
      offset: generalOffset.toString(),
    });
    if (countryCode) {
      params.set("country", countryCode);
    }
    // Keep paging the same record sets the user asked for, or the extra sets
    // would silently drop out of the sample on the first "load more".
    if (includeMissing) params.set("includeMissing", "true");
    params.set("includeIssues", "true");
    fetch(`/api/occurrences?${params}`)
      .then((res) => res.json())
      .then((data) => {
        const newFeatures: OccurrenceFeature[] = data.features || [];
        setOccurrences((prev) => {
          const seen = new Set(prev.map((o) => o.properties.gbifID));
          const toAdd = newFeatures.filter((f) => !seen.has(f.properties.gbifID));
          return [...prev, ...toAdd];
        });
        setGeneralOffset((prev) => prev + newFeatures.length);
        setTotalOccurrences(data.metadata?.total ?? null);
      })
      .catch(console.error)
      .finally(() => setLoadingMoreOverall(false));
  }, [generalOffset, speciesKey, countryCode, includeMissing]);

  // Fetch breakdown data
  useEffect(() => {
    setLoadingBreakdown(true);
    const params = new URLSearchParams();
    if (countryCode) {
      params.set("country", countryCode);
    }
    fetch(`/api/species/${speciesKey}/breakdown?${params}`)
      .then((res) => res.json())
      .then((data) => {
        setBreakdown(data);
        setInatTotalCount(data.inatTotalCount || data.iNaturalist || 0);
      })
      .catch(console.error)
      .finally(() => setLoadingBreakdown(false));
  }, [speciesKey, countryCode]);

  // Fetch this species' POWO/WCVP native range (only meaningful for vascular
  // plants — WCVP doesn't cover mosses/algae/fungi/animals).
  useEffect(() => {
    if (!isVascularPlantTaxonGroup(taxonGroup) || !scientificName) {
      setNativeCountriesWcvp(null);
      setWcvpPowoId(null);
      return;
    }
    setLoadingWcvpRange(true);
    fetch(`/api/wcvp-native-range?name=${encodeURIComponent(scientificName)}`)
      .then((res) => res.json())
      .then((data) => {
        setNativeCountriesWcvp(data.countries ?? null);
        setWcvpPowoId(data.powoId ?? null);
      })
      .catch(console.error)
      .finally(() => setLoadingWcvpRange(false));
  }, [taxonGroup, scientificName]);

  // Once occurrences have loaded, tell the parent if GBIF (which includes iNat
  // records) returned nothing — so an unevaluated species with no occurrence data
  // can fall back to another tab (e.g. Catalogue of Life).
  useEffect(() => {
    if (!loadingOccurrences && totalOccurrences === 0) {
      onEmpty?.();
    }
  }, [loadingOccurrences, totalOccurrences, onEmpty]);

  // Fetch iNat photos for a given page
  const fetchInatPhotos = useCallback((page: number, limit: number) => {
    setLoadingInatPhotos(true);
    const params = new URLSearchParams({
      offset: (page * limit).toString(),
      limit: limit.toString(),
    });
    if (countryCode) {
      params.set("country", countryCode);
    }
    fetch(`/api/species/${speciesKey}/inat-photos?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.observations) {
          setInatPhotos(data.observations);
          if (data.totalCount) setInatTotalCount(data.totalCount);
        }
      })
      .catch(console.error)
      .finally(() => setLoadingInatPhotos(false));
  }, [speciesKey, countryCode]);

  // Re-fetch when screen size changes (page size changes)
  useEffect(() => {
    // Reset to page 0 and re-fetch with new page size
    setInatPage(0);
    fetchInatPhotos(0, pageSize);
  }, [pageSize, fetchInatPhotos]);

  // Which native-country list actually backs the filter right now, per the
  // selected source. Only "wcvp" when this species has a real WCVP match —
  // there's nothing to fall back to silently, since the source picker itself
  // (below) is only ever shown once nativeCountriesWcvp is known to be non-empty.
  const effectiveNativeCountries = nativeRangeSource === "wcvp" ? (nativeCountriesWcvp ?? undefined) : nativeCountriesRedList;
  /** The name of the source the native-range check is currently running on. */
  const nativeRangeSourceLabel = nativeRangeSource === "wcvp" ? "POWO" : "IUCN";
  // Only a species with a Red List assessment has an IUCN native range. An
  // unassessed species arrives here with no list at all (the dashboard withholds
  // its GBIF-derived countries), and an overlay offered but permanently disabled
  // reads as "we couldn't load it" rather than "there is no such thing".
  const hasIucnNativeRange = (nativeCountriesRedList?.length ?? 0) > 0;
  const hasNativeRangeData = hasIucnNativeRange || (nativeCountriesWcvp?.length ?? 0) > 0;
  // Same "outside native range" signal the map tooltip shows, bound to the
  // currently selected source, for the list view's Flags column.
  const isOutsideNativeRangeForList = useCallback(
    (countryCode: string | null | undefined) => isOutsideNativeRange(countryCode, effectiveNativeCountries),
    [effectiveNativeCountries]
  );
  const hasBothNativeRangeSources = (nativeCountriesRedList?.length ?? 0) > 0 && (nativeCountriesWcvp?.length ?? 0) > 0;

  // Country border polygons for the POWO/IUCN native-range overlays — loaded
  // lazily (dynamic import) only once one of those overlays is actually turned
  // on, so the ~1.7MB Natural Earth dataset never weighs down the initial
  // bundle for the (majority of) sessions that never open this dropdown.
  const [countryPolygons, setCountryPolygons] = useState<CountryPolygon[] | null>(null);
  useEffect(() => {
    if (!(showPowoRangeOverlay || showIucnRangeOverlay) || countryPolygons) return;
    import("@/lib/mapping/coordinate-cleaning-refdata/countries.json").then((mod) => {
      setCountryPolygons(mod.default as unknown as CountryPolygon[]);
    });
  }, [showPowoRangeOverlay, showIucnRangeOverlay, countryPolygons]);

  const buildRangeGeoJson = useCallback((countries: string[] | null | undefined): GeoJSON.FeatureCollection | null => {
    if (!countryPolygons || !countries || countries.length === 0) return null;
    const codes = new Set(countries.map((c) => c.toUpperCase()));
    const features = countryPolygons
      .filter((p) => codes.has(p.iso_a2))
      .map((p) => ({ type: "Feature" as const, properties: {}, geometry: p.polygon }));
    return { type: "FeatureCollection", features };
  }, [countryPolygons]);

  const powoRangeGeoJson = useMemo(() => buildRangeGeoJson(nativeCountriesWcvp), [buildRangeGeoJson, nativeCountriesWcvp]);
  const iucnRangeGeoJson = useMemo(() => buildRangeGeoJson(nativeCountriesRedList), [buildRangeGeoJson, nativeCountriesRedList]);

  // Multi-stage filtering pipeline, minus the date-range filter — kept as a separate
  // memo so the date-range slider's own track (sliderMinDate/sliderMaxDate below)
  // reflects the full span these other filters allow through, not a span already
  // narrowed by wherever the slider's own handles currently sit.
  const dateFilterableOccurrences = useMemo(() => {
    let result = occurrences;
    // 1. Basis of record checkboxes
    result = result.filter((o) => checkedTypes[classifyOccurrence(o) as keyof typeof checkedTypes]);
    // 2. GPS uncertainty filter
    if (maxUncertainty != null) {
      result = result.filter((o) => {
        const u = o.properties.coordinateUncertaintyInMeters;
        return u != null && u <= maxUncertainty;
      });
    }
    // 3. Coordinate-cleaning checks (zero/equal coords, GBIF HQ, duplicates)
    result = result.filter((o) => !o.properties.qualityFlags?.some((f) => appliedChecks[f as QualityFlag]));
    // 3b. GBIF's own geospatial issues, treated as one more cleaning check
    if (hideGbifFlagged) {
      result = result.filter((o) => !(o.properties.gbifIssues?.length));
    }
    // 4. Native range only — hide occurrences reported outside this species' native countries
    if (nativeRangeOnly) {
      result = result.filter((o) => !isOutsideNativeRange(o.properties.countryCode, effectiveNativeCountries));
    }
    return result;
  }, [occurrences, checkedTypes, maxUncertainty, appliedChecks, hideGbifFlagged, nativeRangeOnly, effectiveNativeCountries]);

  // 5. Date range — applied last, on top of every filter above.
  const filteredOccurrences = useMemo(() => {
    if (dateRangeFrom == null && dateRangeTo == null) return dateFilterableOccurrences;
    return dateFilterableOccurrences.filter((o) => {
      const d = occurrenceDateKey(o);
      if (!d) return false;
      if (dateRangeFrom != null && d < dateRangeFrom) return false;
      if (dateRangeTo != null && d > dateRangeTo) return false;
      return true;
    });
  }, [dateFilterableOccurrences, dateRangeFrom, dateRangeTo]);

  // What the map draws and the export writes: everything the filters allow,
  // less anything struck out by hand. The list still shows all of it, greyed.
  const includedOccurrences = useMemo(
    () => filteredOccurrences.filter((o) => !exclusions[o.properties.gbifID]),
    [filteredOccurrences, exclusions]
  );

  /**
   * What the map draws: the records that survived the filters, kept and struck
   * out alike. The struck-out ones are greyed rather than removed — a record
   * you have judged and set aside is a different thing from a record nobody
   * collected, and the map couldn't tell you which a gap was.
   */
  const mappedOccurrences = useMemo(
    () => (showExcludedOnMap ? filteredOccurrences : includedOccurrences),
    [showExcludedOnMap, filteredOccurrences, includedOccurrences]
  );

  /**
   * How many of the records the map draws are struck out, and how many it
   * draws at all.
   *
   * Both count only the records with a position. The legend is a key to what's
   * on the map, and a record GBIF published without coordinates isn't on it —
   * counting those made the legend claim twice as many points as the map had.
   */
  const mappedPositionedCount = useMemo(
    () => mappedOccurrences.filter(hasPosition).length,
    [mappedOccurrences]
  );
  const struckOutCount = useMemo(
    () => filteredOccurrences.filter((o) => hasPosition(o) && exclusions[o.properties.gbifID]).length,
    [filteredOccurrences, exclusions]
  );

  // Records the filters have removed, for the list's Excluded column.
  const excludedIds = useMemo(() => {
    const kept = new Set(filteredOccurrences.map((o) => o.properties.gbifID));
    return new Set(occurrences.filter((o) => !kept.has(o.properties.gbifID)).map((o) => o.properties.gbifID));
  }, [occurrences, filteredOccurrences]);

  // The subset the map actually draws — the list shows all of filteredOccurrences,
  // including any fetched with no coordinates.
  const georeferencedFilteredCount = useMemo(
    () => includedOccurrences.filter(hasPosition).length,
    [includedOccurrences]
  );

  // Georeferences for records currently passing the filters — what the map
  // draws and what an export covers. A stored georeference whose record isn't
  // in the loaded sample stays in storage untouched.
  const visibleGeoreferences = useMemo(() => {
    const shown = new Set(includedOccurrences.map((o) => o.properties.gbifID));
    return Object.values(georeferences).filter((g) => shown.has(g.gbifID));
  }, [georeferences, includedOccurrences]);

  // The uncertainty radius, drawn to scale on the ground. A georeferenced
  // locality is an area, not a pinpoint, and showing it as a bare dot would
  // overstate it exactly the way the radius exists to prevent.
  const georeferenceCirclesGeoJson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: visibleGeoreferences.map((g) => ({
        type: "Feature" as const,
        properties: { gbifID: g.gbifID },
        geometry: uncertaintyCircle(
          g.decimalLatitude,
          g.decimalLongitude,
          g.coordinateUncertaintyInMeters
        ),
      })),
    }),
    [visibleGeoreferences]
  );

  /**
   * A position typed into the Coordinates cell.
   *
   * Everything the old editor asked for and this doesn't is carried over or
   * defaulted: the radius keeps whatever it already had, or GBIF's own figure
   * for the record where there is one, or DEFAULT_GEOREFERENCE_RADIUS_M — which
   * is deliberately coarse, because a locality description resolved by eye is
   * coarse, and the Uncertainty cell is right there to sharpen it.
   */
  const saveGeoreferenceInline = useCallback(
    (
      feature: OccurrenceFeature,
      edit: { lat: number; lon: number; uncertainty?: number; note?: string }
    ) => {
      const p = feature.properties;
      const existing = georeferences[p.gbifID];
      const radius =
        edit.uncertainty ??
        existing?.coordinateUncertaintyInMeters ??
        p.coordinateUncertaintyInMeters ??
        DEFAULT_GEOREFERENCE_RADIUS_M;
      // Empty means "no note", not "leave the old one": clearing the box is
      // how you take a note back.
      const note = edit.note === undefined ? undefined : edit.note.trim();
      const georeference: Georeference = {
        ...existing,
        gbifID: p.gbifID,
        occurrenceID: p.occurrenceID ?? existing?.occurrenceID,
        scientificName: p.species ?? scientificName ?? existing?.scientificName,
        verbatimLocality: p.locality ?? p.verbatimLocality ?? existing?.verbatimLocality,
        decimalLatitude: edit.lat,
        decimalLongitude: edit.lon,
        coordinateUncertaintyInMeters: radius,
        georeferencedBy: existing?.georeferencedBy || accountEmail || undefined,
        georeferencedDate: new Date().toISOString(),
        georeferenceProtocol: existing?.georeferenceProtocol ?? "Typed from the locality description",
        georeferenceRemarks:
          note === undefined ? existing?.georeferenceRemarks : note || undefined,
      };
      // The note goes to its own store as well as onto the georeference, so
      // dropping the coordinates doesn't take the reasoning with them — why
      // you placed a record where you did is often why you moved it, and it
      // was the only copy.
      const nextNotes = { ...assessorNotes };
      if (note !== undefined) {
        if (note) {
          nextNotes[p.gbifID] = {
            gbifID: p.gbifID,
            text: note,
            addedAt: new Date().toISOString(),
            addedBy: accountEmail || undefined,
          };
        } else {
          delete nextNotes[p.gbifID];
        }
      }
      commitEdits(
        { georeferences: { ...georeferences, [p.gbifID]: georeference }, notes: nextNotes },
        existing ? "edit a georeference" : "add a georeference"
      );
    },
    [georeferences, assessorNotes, accountEmail, scientificName, commitEdits]
  );

  const clearGeoreference = useCallback(
    (feature: OccurrenceFeature) => {
      // Only the coordinates. The reasoning stays: it is as often about why
      // the record can't be placed as about where it was placed, and it lives
      // in its own store precisely so this can't take it.
      const next = { ...georeferences };
      delete next[feature.properties.gbifID];
      commitEdits({ georeferences: next }, "delete a georeference");
    },
    [georeferences, commitEdits]
  );

  /**
   * Dragging a marker moves the point and leaves everything else — radius,
   * notes, the record it belongs to — alone.
   *
   * It used to stop and ask, because a stray drag rewrote a coordinate someone
   * had worked out from a locality description and the old position was gone
   * the moment it moved. It goes through the edit history now, so the old
   * position isn't gone — it's one ⌘Z away, labelled "move a georeference" —
   * and a dialog on every drag was asking permission for something already
   * reversible.
   */
  const handleGeoreferenceDragged = useCallback(
    (gbifID: number, lat: number, lon: number) => {
      const existing = georeferences[gbifID];
      if (!existing) return;
      commitEdits({ georeferences: {
        ...georeferences,
        [gbifID]: {
          ...existing,
          decimalLatitude: Number(lat.toFixed(5)),
          decimalLongitude: Number(lon.toFixed(5)),
          georeferencedDate: new Date().toISOString(),
          georeferencedBy: existing.georeferencedBy || accountEmail || undefined,
        },
      } }, "move a georeference");
    },
    [georeferences, commitEdits, accountEmail]
  );

  const handleMarkerHover = useCallback(
    (gbifID: number) => {
      const record = occurrences.find((o) => o.properties.gbifID === gbifID);
      if (!record) return;
      // The pointer reaches the marker across bare map, and that last mousemove
      // — no feature under it — has already queued the hover to clear. Without
      // cancelling it here the tooltip appears and is taken away again a beat
      // later, which reads as the marker simply not having one.
      cancelHoverClear();
      setHoverSource("map");
      setHoveredFeature(record);
      setHoveredPanel("main");
    },
    [occurrences, cancelHoverClear]
  );

  const confirmExclusion = useCallback(
    (justification: string) => {
      if (!pendingExclusion) return;
      const next = { ...exclusions };
      for (const gbifID of pendingExclusion) {
        next[gbifID] = {
          gbifID,
          justification,
          excludedAt: new Date().toISOString(),
          excludedBy: accountEmail || undefined,
        };
      }
      commitEdits(
        { exclusions: next },
        `exclude ${pendingExclusion.length} record${pendingExclusion.length === 1 ? "" : "s"}`
      );
      setPendingExclusion(null);
    },
    [pendingExclusion, exclusions, commitEdits, accountEmail]
  );

  /**
   * Takes a list, not one id. Called once per record, each call would build its
   * replacement from the same render-time `exclusions` and the last would win —
   * so putting five records back restored one and left four struck out.
   */
  const includeAgain = useCallback(
    (gbifIDs: number[]) => {
      const next = { ...exclusions };
      for (const gbifID of gbifIDs) delete next[gbifID];
      commitEdits(
        { exclusions: next },
        `put ${gbifIDs.length} record${gbifIDs.length === 1 ? "" : "s"} back`
      );
    },
    [exclusions, commitEdits]
  );


  // Would this record survive everything except the GBIF-flagged check? Used
  // to say what that one check is deciding on its own, the same way the other
  // cleaning rows report their own impact.
  const passesFiltersIgnoringGbifFlag = useCallback(
    (o: OccurrenceFeature) => {
      if (!checkedTypes[classifyOccurrence(o) as keyof typeof checkedTypes]) return false;
      if (maxUncertainty != null) {
        const u = o.properties.coordinateUncertaintyInMeters;
        if (u == null || u > maxUncertainty) return false;
      }
      if (o.properties.qualityFlags?.some((f) => appliedChecks[f as QualityFlag])) return false;
      if (nativeRangeOnly && isOutsideNativeRange(o.properties.countryCode, effectiveNativeCountries)) return false;
      return true;
    },
    [checkedTypes, maxUncertainty, appliedChecks, nativeRangeOnly, effectiveNativeCountries]
  );

  // How many flagged records are loaded, and how many the check alone decides
  // (i.e. they pass every other active filter) — same "shown of loaded" reading
  // as the other cleaning rows.
  const gbifFlaggedCounts = useMemo(() => {
    const flagged = occurrences.filter((o) => o.properties.gbifIssues?.length);
    const others = new Set(filteredOccurrences.map((o) => o.properties.gbifID));
    return {
      loaded: flagged.length,
      shown: hideGbifFlagged
        ? flagged.filter((o) => passesFiltersIgnoringGbifFlag(o)).length
        : flagged.filter((o) => others.has(o.properties.gbifID)).length,
    };
  }, [occurrences, filteredOccurrences, hideGbifFlagged, passesFiltersIgnoringGbifFlag]);

  // Of the loaded occurrences that pass every other active filter, how many are
  // outside the species' native range — i.e. how many the "Native range only"
  // checkbox would additionally hide if switched on right now.
  const nativeRangeHiddenCount = useMemo(() => {
    if (!effectiveNativeCountries || effectiveNativeCountries.length === 0) return 0;
    let count = 0;
    for (const o of occurrences) {
      if (!checkedTypes[classifyOccurrence(o) as keyof typeof checkedTypes]) continue;
      if (maxUncertainty != null) {
        const u = o.properties.coordinateUncertaintyInMeters;
        if (u == null || u > maxUncertainty) continue;
      }
      if (o.properties.qualityFlags?.some((f) => appliedChecks[f as QualityFlag])) continue;
      if (dateRangeFrom != null || dateRangeTo != null) {
        const d = occurrenceDateKey(o);
        if (!d) continue;
        if (dateRangeFrom != null && d < dateRangeFrom) continue;
        if (dateRangeTo != null && d > dateRangeTo) continue;
      }
      if (isOutsideNativeRange(o.properties.countryCode, effectiveNativeCountries)) count++;
    }
    return count;
  }, [occurrences, checkedTypes, maxUncertainty, appliedChecks, effectiveNativeCountries, dateRangeFrom, dateRangeTo]);

  // Per-check counts among the currently loaded occurrences (independent of whether
  // that check is applied), for the coordinate-cleaning dropdown
  const flagCounts = useMemo(() => {
    const counts: Partial<Record<QualityFlag, number>> = {};
    for (const o of occurrences) {
      for (const f of o.properties.qualityFlags ?? []) {
        const key = f as QualityFlag;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [occurrences]);

  // For each check: of the loaded records it flags, how many would actually appear on
  // the map if just this one check were switched off (i.e. they still pass every other
  // active filter — basis of record, uncertainty, date range, native range, and every
  // other applied coordinate-cleaning check). Mirrors basisLoadedShownCounts's "shown
  // of loaded" semantics so both dropdowns read the same way.
  const flagShownCounts = useMemo(() => {
    const counts: Partial<Record<QualityFlag, number>> = {};
    for (const o of occurrences) {
      if (!checkedTypes[classifyOccurrence(o) as keyof typeof checkedTypes]) continue;
      if (maxUncertainty != null) {
        const u = o.properties.coordinateUncertaintyInMeters;
        if (u == null || u > maxUncertainty) continue;
      }
      if (nativeRangeOnly && isOutsideNativeRange(o.properties.countryCode, effectiveNativeCountries)) continue;
      if (dateRangeFrom != null || dateRangeTo != null) {
        const d = occurrenceDateKey(o);
        if (!d) continue;
        if (dateRangeFrom != null && d < dateRangeFrom) continue;
        if (dateRangeTo != null && d > dateRangeTo) continue;
      }
      const flags = o.properties.qualityFlags ?? [];
      for (const f of flags) {
        const key = f as QualityFlag;
        const blockedByOtherCheck = flags.some((f2) => f2 !== key && appliedChecks[f2 as QualityFlag]);
        if (!blockedByOtherCheck) counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [occurrences, checkedTypes, maxUncertainty, appliedChecks, nativeRangeOnly, effectiveNativeCountries, dateRangeFrom, dateRangeTo]);

  const flagDefs = useMemo(
    () =>
      (Object.keys(QUALITY_FLAG_LABELS) as QualityFlag[]).map((key) => ({
        key,
        label: QUALITY_FLAG_LABELS[key],
        description: QUALITY_FLAG_DESCRIPTIONS[key],
        source: QUALITY_FLAG_SOURCES[key],
        count: flagCounts[key] ?? 0,
        shown: flagShownCounts[key] ?? 0,
      })),
    [flagCounts, flagShownCounts]
  );

  const toggleCheck = (key: QualityFlag) => {
    setAppliedChecks((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Full date span of what's currently loaded and passing every filter except the
  // date-range filter itself — shared as the track bounds for both the split-view
  // before/after slider and the date-range filter slider below, so neither slider's
  // own bounds shrink as the user drags it.
  const { sliderMinDate, sliderMaxDate } = useMemo(() => {
    const dates = dateFilterableOccurrences
      .map((o) => o.properties.eventDate)
      .filter((d): d is string => d != null && d.length >= 10)
      .map((d) => d.slice(0, 10));
    if (dates.length === 0) return { sliderMinDate: splitDate, sliderMaxDate: splitDate };
    dates.sort();
    return { sliderMinDate: dates[0], sliderMaxDate: dates[dates.length - 1] };
  }, [dateFilterableOccurrences, splitDate]);

  // Assessment dates to mark on the date-range timeline — the current assessment
  // plus every past one (year-only entries fall back to Jan 1 of that year, same
  // as elsewhere in this file), de-duped by date since previousAssessments may or
  // may not already include the current assessment depending on the caller.
  const assessmentMarkers = useMemo(() => {
    const seen = new Set<string>();
    const markers: { date: string; category: string | null; criteria: string | null; isCurrent: boolean }[] = [];
    const add = (
      date: string | null | undefined,
      year: string | number | null | undefined,
      isCurrent: boolean,
      cat?: string | null,
      crit?: string | null,
    ) => {
      const d = date && date.length >= 10 ? date.slice(0, 10) : year != null ? `${year}-01-01` : null;
      if (!d || seen.has(d)) return;
      seen.add(d);
      markers.push({ date: d, category: cat ? normalizeCategory(cat) : null, criteria: crit || null, isCurrent });
    };
    add(assessmentDate, assessmentYear, true, category, criteria);
    for (const a of previousAssessments ?? []) {
      add(a.date, a.year, false, a.category, a.criteria);
    }
    return markers.sort((a, b) => a.date.localeCompare(b.date));
  }, [assessmentDate, assessmentYear, category, criteria, previousAssessments]);

  // Partition occurrences by exact assessment date — computed regardless of
  // split view so the Before/After rows of the range coverage table below stay
  // populated even when the user isn't in split view.
  const { preAssessmentOccs, postAssessmentOccs } = useMemo(() => {
    if (!splitDate) {
      return { preAssessmentOccs: [], postAssessmentOccs: [] };
    }
    const pre: OccurrenceFeature[] = [];
    const post: OccurrenceFeature[] = [];
    for (const o of filteredOccurrences) {
      const d = o.properties.eventDate ?? (o.properties.year != null ? String(o.properties.year) : null);
      if (d && d > splitDate) {
        post.push(o);
      } else {
        pre.push(o);
      }
    }
    return {
      preAssessmentOccs: pre,
      postAssessmentOccs: post,
    };
  }, [splitDate, filteredOccurrences]);

  // In-range/out-of-range breakdown of the currently-filtered GBIF occurrences
  // against the currently-visible IUCN range polygons — recomputed whenever the
  // range layer's polygons or the filtered occurrence set change, so it tracks
  // both the coordinate-cleaning/basis-of-record filters and the range category
  // toggles automatically. Before/after rows use the same assessment-date split
  // as split view, but are populated regardless of whether split view is open.
  const rangeCoverageStats = useMemo(() => {
    if (!rangePolygons || rangePolygons.length === 0) return null;
    const polygons = rangePolygons as Feature<Polygon | MultiPolygon>[];
    const computeFor = (allOccs: OccurrenceFeature[]) => {
      // In/out of the range polygons is only answerable for positioned records.
      const occs = allOccs.filter(hasPosition);
      let inRange = 0;
      for (const o of occs) {
        const point: Feature<GeoJSON.Point> = { type: "Feature", properties: {}, geometry: o.geometry };
        const isInside = polygons.some((poly) => {
          try {
            return booleanPointInPolygon(point, poly);
          } catch {
            return false;
          }
        });
        if (isInside) inRange++;
      }
      return { inRange, outRange: occs.length - inRange, total: occs.length };
    };
    return {
      total: computeFor(filteredOccurrences),
      before: splitDate ? computeFor(preAssessmentOccs) : null,
      after: splitDate ? computeFor(postAssessmentOccs) : null,
    };
  }, [rangePolygons, filteredOccurrences, splitDate, preAssessmentOccs, postAssessmentOccs]);

  // Date range for color gradient (uses full eventDate for finer granularity)
  const { minDateNum, maxDateNum, minDateLabel, maxDateLabel } = useMemo(() => {
    const nums = filteredOccurrences
      .map((o) => dateToNumeric(o.properties.eventDate, o.properties.year))
      .filter((n): n is number => n != null);
    if (nums.length === 0) return { minDateNum: 0, maxDateNum: 0, minDateLabel: "", maxDateLabel: "" };
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const fmt = (ts: number) => {
      const d = new Date(ts);
      // Show just year if the range spans multiple years, otherwise show month/year
      const rangeYears = new Date(max).getFullYear() - new Date(min).getFullYear();
      if (rangeYears > 2) return String(d.getFullYear());
      return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    };
    return { minDateNum: min, maxDateNum: max, minDateLabel: fmt(min), maxDateLabel: fmt(max) };
  }, [filteredOccurrences]);

  // Filter definitions — plain GBIF basis-of-record terminology (iNaturalist is just
  // part of "Human observation" here; it gets its own dedicated panel below anyway)
  const pillDefs = useMemo(() => {
    if (!breakdown) return [];
    return [
      { key: "humanObservation" as const, label: "Human observation (e.g. iNaturalist, eBird)", count: breakdown.humanObservation },
      { key: "machineObservation" as const, label: "Machine observation (e.g. camera traps)", count: breakdown.machineObservation },
      { key: "observation" as const, label: "Observation", count: breakdown.observation },
      { key: "preservedSpecimen" as const, label: "Preserved specimen (e.g. herbaria, museums)", count: breakdown.preservedSpecimen },
      { key: "fossilSpecimen" as const, label: "Fossil specimen", count: breakdown.fossilSpecimen },
      { key: "livingSpecimen" as const, label: "Living specimen (e.g. zoos, botanical gardens)", count: breakdown.livingSpecimen },
      { key: "materialSample" as const, label: "Material sample (e.g. eDNA)", count: breakdown.materialSample },
      { key: "materialCitation" as const, label: "Material citation (literature records)", count: breakdown.materialCitation },
      { key: "occurrence" as const, label: "Occurrence", count: breakdown.occurrence },
    ];
  }, [breakdown]);


  const toggleType = (key: keyof typeof checkedTypes) => {
    setCheckedTypes((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Per-category counts among the currently loaded occurrences: how many are in this
  // basis-of-record category at all ("loaded"), and of those, how many also survive
  // every other active filter — uncertainty, date range, coordinate cleaning, native
  // range — but not the basis-of-record checkboxes themselves ("shown"). Distinct from
  // pillDefs' counts, which are true GBIF-wide totals from a separate server aggregation.
  const basisLoadedShownCounts = useMemo(() => {
    const counts: Record<string, { loaded: number; shown: number }> = {};
    for (const o of occurrences) {
      const cat = classifyOccurrence(o);
      const entry = counts[cat] ?? (counts[cat] = { loaded: 0, shown: 0 });
      entry.loaded++;
      if (maxUncertainty != null) {
        const u = o.properties.coordinateUncertaintyInMeters;
        if (u == null || u > maxUncertainty) continue;
      }
      if (o.properties.qualityFlags?.some((f) => appliedChecks[f as QualityFlag])) continue;
      if (nativeRangeOnly && isOutsideNativeRange(o.properties.countryCode, effectiveNativeCountries)) continue;
      if (dateRangeFrom != null || dateRangeTo != null) {
        const d = occurrenceDateKey(o);
        if (!d) continue;
        if (dateRangeFrom != null && d < dateRangeFrom) continue;
        if (dateRangeTo != null && d > dateRangeTo) continue;
      }
      entry.shown++;
    }
    return counts;
  }, [occurrences, maxUncertainty, appliedChecks, nativeRangeOnly, effectiveNativeCountries, dateRangeFrom, dateRangeTo]);

  // Build GeoJSON FeatureCollection with computed styling properties for the circle layer
  const buildStyledFeatureCollection = useCallback((
    panelOccurrences: OccurrenceFeature[],
  ): GeoJSON.FeatureCollection => {
    // Records with no coordinates can't be drawn — they're carried through the
    // same filter pipeline so the list can show them, and dropped here.
    const features = panelOccurrences.filter(hasPosition).map((feature) => {
      const isFeatureHovered = hoveredFeature?.properties.gbifID === feature.properties.gbifID;
      const struckOut = !!exclusions[feature.properties.gbifID];

      let strokeColor: string;
      let fillColor: string;
      if (struckOut) {
        // Hollow and grey, whatever the colour mode would have made it: the
        // point is still there and no longer counted, and an empty ring reads
        // as an absence in a way a paler filled dot doesn't.
        strokeColor = "#6b7280";
        fillColor = "#d1d5db";
      } else if (feature.properties.coordinateStatus === "issue") {
        // Amber regardless of the colour mode: a record GBIF flags shouldn't be
        // indistinguishable from one it vouches for just because it happens to
        // be recent.
        strokeColor = "#b45309";
        fillColor = "#fbbf24";
      } else if (colorByDate) {
        const dNum = dateToNumeric(feature.properties.eventDate, feature.properties.year);
        if (dNum != null) {
          const colors = dateToColor(dNum);
          strokeColor = colors.stroke;
          fillColor = colors.fill;
        } else {
          strokeColor = "#6b7280";
          fillColor = "#9ca3af";
        }
      } else {
        // Color by before/after assessment date
        const isNew = isAfterAssessment(feature.properties.eventDate, feature.properties.year, assessmentDate, assessmentYear);
        strokeColor = isNew ? "#16a34a" : "#6b7280";
        fillColor = isNew ? "#4ade80" : "#9ca3af";
      }

      const radius = isFeatureHovered ? 6 : 5;
      const strokeWidth = isFeatureHovered ? 3 : 2;

      return {
        type: "Feature" as const,
        properties: {
          ...feature.properties,
          _fillColor: fillColor,
          _strokeColor: strokeColor,
          _radius: struckOut ? 4.5 : radius,
          _strokeWidth: struckOut ? 1.75 : strokeWidth,
          _fillOpacity: struckOut ? 0 : 1,
          _strokeOpacity: struckOut ? 0.85 : 1,
        },
        geometry: feature.geometry,
      };
    });
    return { type: "FeatureCollection", features };
  }, [hoveredFeature, colorByDate, assessmentDate, assessmentYear, exclusions]);

  // FitBounds helper using map ref
  const fitMapToBbox = useCallback((bbox: [number, number, number, number]) => {
    const map = mapRef.current;
    if (!map) return false;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    if (minLon === maxLon && minLat === maxLat) {
      map.flyTo({ center: [minLon, minLat], zoom: 10, duration: 500 });
    } else {
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 40, maxZoom: 14, duration: 500 });
    }
    return true;
  }, []);

  /**
   * Bring the nearby radius into view when it is asked for, and when it changes.
   *
   * Drawn to scale and left alone, a 10 km circle on a map fitted to a species'
   * whole range is a few pixels across — technically the answer and no use as
   * one. Fitting to the circle is what makes "within 10 km" a place rather than
   * a number. Only when the radius or the point changes, so panning away to
   * look at something is not undone on the next render.
   */
  const fittedNearbyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!nearbyAt) {
      fittedNearbyRef.current = null;
      return;
    }
    const key = `${nearbyAt.lng},${nearbyAt.lat},${nearbyRadiusKm}`;
    if (fittedNearbyRef.current === key) return;
    // The circle's own bounding box, so the ring sits inside the padding
    // rather than touching the edges.
    const ring = uncertaintyCircle(nearbyAt.lat, nearbyAt.lng, nearbyRadiusKm * 1000).coordinates[0];
    const lons = ring.map((c) => c[0]);
    const lats = ring.map((c) => c[1]);
    if (fitMapToBbox([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)])) {
      fittedNearbyRef.current = key;
    }
  }, [nearbyAt, nearbyRadiusKm, fitMapToBbox]);

  // Track whether we've fitted bounds for the current bbox
  const fittedBboxRef = useRef<string | null>(null);
  const pendingBboxRef = useRef<[number, number, number, number] | null>(null);

  // Reset fitted state when split view toggles (new map instances are mounted)
  const prevSplitViewRef = useRef(splitView);
  useEffect(() => {
    if (prevSplitViewRef.current !== splitView) {
      prevSplitViewRef.current = splitView;
      fittedBboxRef.current = null;
      if (bbox) {
        pendingBboxRef.current = bbox;
      }
    }
  }, [splitView, bbox]);

  // Entering or leaving fullscreen changes the map's size dramatically, and a
  // map keeps its centre and zoom when it resizes — so on a species whose
  // records sit off to one side, the change can slide them straight out of
  // view. Re-fit to the data once the new layout has settled.
  const prevFullscreenRef = useRef(fullscreen);
  useEffect(() => {
    if (prevFullscreenRef.current === fullscreen) return;
    prevFullscreenRef.current = fullscreen;
    if (!bbox) return;
    const timer = window.setTimeout(() => {
      mapRef.current?.resize();
      if (!fitMapToBbox(bbox)) pendingBboxRef.current = bbox;
    }, 80);
    return () => window.clearTimeout(timer);
  }, [fullscreen, bbox, fitMapToBbox]);

  // Fit bounds when the (unfiltered) bbox changes (may need to wait for map to
  // be ready) — deliberately keyed on `bbox` (the server-computed extent of
  // every loaded record), not a filtered subset: re-fitting to whatever's left
  // after toggling a filter checkbox felt jarring, since the view would jump
  // every time. The map now only re-fits on genuinely new data (a new species,
  // or loading a larger sample), not on filter changes.
  useEffect(() => {
    if (!bbox) return;
    const key = bbox.join(",");
    if (fittedBboxRef.current === key) return;
    if (fitMapToBbox(bbox)) {
      fittedBboxRef.current = key;
      pendingBboxRef.current = null;
    } else {
      // Map not ready yet — store as pending for onLoad
      pendingBboxRef.current = bbox;
    }
  }, [bbox, fitMapToBbox]);

  // Called when the MapGL component finishes loading
  /**
   * Fit whenever a map instance loads, not only when a fit was left pending.
   *
   * The panel swaps the map out for a spinner while occurrences are fetching,
   * so every refetch — fetching the records without coordinates, loading more —
   * mounts a brand new map at its default world view. The fit-once-per-bbox
   * guard then skips it, because that bbox was already fitted on the previous
   * instance, and the species' records end up as specks somewhere off-centre.
   */
  const handleMapLoad = useCallback(() => {
    const target = pendingBboxRef.current ?? bbox;
    if (!target) return;
    if (fitMapToBbox(target)) {
      fittedBboxRef.current = target.join(",");
      pendingBboxRef.current = null;
    }
  }, [bbox, fitMapToBbox]);

  // Map event handlers
  /**
   * Opening a point from the imported file.
   *
   * Where it matched a record on the map, that record's panel opens — it
   * carries the import folded into it, and says where the two disagree. Where
   * it matched nothing, the row gets its own small popup: it has no line in
   * the table to send you to. Called by the point's own marker, since the
   * file's points are drawn as diamonds rather than as a map layer.
   */
  const openPointFileRow = useCallback(
    (row: number, lng: number, lat: number, panelId: string) => {
      const comparison = pointFileComparisonRef.current?.rows.find((r) => r.point.row === row);
      const merged = comparison?.matched
        ? occurrencesByGbifIdRef.current.get(comparison.matched.gbifID)
        : undefined;
      if (merged) {
        if (tooltipPinned && hoveredFeature?.properties.gbifID === merged.properties.gbifID) {
          closeTooltip();
          return;
        }
        setPointFileHover(null);
        cancelHoverClear();
        setHoverSource("map");
        // The imported point is where the panel hangs when the record has no
        // position of its own, which is the usual case for a matched row: a
        // coordinate GBIF never published is why the assessor georeferenced it
        // into the file in the first place.
        setHoverAnchor({ gbifID: merged.properties.gbifID, lng, lat });
        setGroupIndex(0);
        setHoveredFeature(merged);
        setHoveredPanel(panelId);
        pinTooltip();
        return;
      }
      if (pointFileHover?.row === row) {
        closeTooltip();
        return;
      }
      setHoveredFeature(null);
      setHoveredPanel(null);
      setPointFileHover({ row, lat, lng, panelId });
      pinTooltip();
    },
    [cancelHoverClear, closeTooltip, pinTooltip, tooltipPinned, hoveredFeature, pointFileHover]
  );

  const handleMapClick = useCallback((e: MapLayerMouseEvent, panelId: string) => {
    // A marker's own click is not the map's. MapLibre listens on the whole map
    // container, so a click on an imported point's diamond — or on anything
    // else drawn as a marker — reaches this handler too, still carrying
    // whatever GBIF circle happens to lie under it. That made clicking a
    // diamond sitting on a record open the record's panel and then close it
    // again in the same click, so nothing appeared to happen.
    if ((e.originalEvent?.target as HTMLElement | null)?.closest(".maplibregl-marker")) return;
    // Measuring owns the left click while it's on. Two points, never more —
    // and a third click doesn't move the far end, it becomes the new near one.
    // Walking a coastline or a valley is a chain of hops, and pinning the
    // origin made every hop after the first a measurement from the wrong place.
    if (measure) {
      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      setMeasure(measure.length < 2 ? [...measure, point] : [measure[1], point]);
      return;
    }
    const features = e.features;
    // A neighbour's cross, before anything else: it is drawn above the map's
    // own records, so a click that reaches one is aimed at it rather than at
    // whatever green circle happens to lie underneath.
    const crosses = (features ?? []).filter((f) =>
      String(f.layer?.id ?? "").startsWith(`nearby-points-circle-`)
    );
    if (crosses.length > 0) {
      const group = groupNearbyFeatures(crosses, nearbyPoints);
      if (group.length > 0) {
        // Clicking the same stack again closes it, the way a record's own panel
        // behaves.
        setNearbyShownGroup((prev) =>
          prev.length === group.length && prev.every((p, n) => p.gbifID === group[n].gbifID) ? [] : group
        );
        setNearbyShownIndex(0);
        closeTooltip();
        return;
      }
    }
    if (features && features.length > 0) {
      const gbifID = Number(features[0].properties?.gbifID);
      if (gbifID) {
        // The same point again closes what it opened. A click is the gesture
        // that opens a record, so it should be the one that puts it away —
        // the close button is for when the panel has drifted from its point.
        if (tooltipPinned && hoveredFeature?.properties.gbifID === gbifID) {
          closeTooltip();
          return;
        }
        const known = occurrencesByGbifIdRef.current.get(gbifID);
        if (known) {
          cancelHoverClear();
          setHoverSource("map");
          setHoveredFeature(known);
          setHoveredPanel(panelId);
          pinTooltip();
        }
        return;
      }
    }
    setPointQuery(null);
    // Same bargain as the protected areas: with the overlay on, the shapes are
    // right there, so clicking one should tell you which it is. Answered from
    // the polygons already loaded, so there's nothing to wait for. Clicking off
    // every ecoregion clears the selection rather than leaving it stranded.
    if (showEcoregions && ecoregions) {
      const point: GeoJSON.Feature<GeoJSON.Point> = {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [e.lngLat.lng, e.lngLat.lat] },
      };
      const hit = ecoregions.features.find((f) => booleanPointInPolygon(point, f));
      setSelectedEcoregion(
        hit
          ? {
              properties: hit.properties,
              geometry: hit.geometry,
              lng: e.lngLat.lng,
              lat: e.lngLat.lat,
              panelId,
            }
          : null
      );
    }
    // The habitat map is a raster, so there's no feature to hit-test: the
    // service that drew the tiles answers an identify at a point, which means
    // the answer can't disagree with what's on screen.
    if (showHabitat) {
      const { lng, lat } = e.lngLat;
      const query = ++habitatQueryId.current;
      setClickedHabitat({ habitat: null, loading: true, panelId });
      identifyHabitat(lng, lat)
        .then((habitat) => {
          if (query !== habitatQueryId.current) return;
          setClickedHabitat({ habitat, loading: false, panelId });
        })
        .catch(() => {
          if (query !== habitatQueryId.current) return;
          setClickedHabitat({ habitat: null, loading: false, panelId });
        });
    }
    // Same bargain again for the forest layers, and the one that most needed
    // it: a 1 km driver cell is a colour with no name on it until you click.
    // Asked of the rasters rather than the picture of them, and answered as
    // three parts — what the loss was for, when, and how wooded the ground was
    // before it — because the last is what keeps the first two honest.
    if (showLossDrivers || showForestLoss) {
      const { lng, lat } = e.lngLat;
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
    // shapes are right there, so clicking one should answer for it. Everything
    // else about a location is on the right button.
    if (!showProtectedAreas) return;
    const map = e.target;
    const bounds = map.getBounds();
    const canvas = map.getCanvas();
    const { lng, lat } = e.lngLat;
    const query = ++pointQueryId.current;
    identifyProtectedAreas({
      lng,
      lat,
      bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    })
      .then((areas) => {
        // Nothing opens for a spot that isn't protected: the overlay already
        // shows that, and a popup saying so on every click is noise.
        if (query !== pointQueryId.current || areas.length === 0) return;
        setPointQuery({
          kind: "areas",
          panelId,
          lng,
          lat,
          elevation: null,
          elevationLoading: false,
          areas,
          areasLoading: false,
          highlight: 0,
        });
      })
      .catch(() => {
        // Only the current query speaks for the service: an aborted one says
        // nothing about whether it is up.
        if (query === pointQueryId.current) setProtectedAreasDown(true);
      });
  }, [
    showForestLoss,
    showLossDrivers,
    measure,
    showProtectedAreas,
    showEcoregions,
    ecoregions,
    showHabitat,
    // Left out until now, which is why clicking a record never pinned its
    // panel: the handler was memoised on the first render, and the callbacks
    // it had closed over were the first render's. The records themselves come
    // from a ref for the same reason — the map of them is built below this.
    cancelHoverClear,
    pinTooltip,
    closeTooltip,
    tooltipPinned,
    hoveredFeature,
    nearbyPoints,
  ]);

  /**
   * Right-click asks what this spot is: its coordinates, the ground elevation,
   * the habitat class where that overlay is on, and the way into measuring.
   *
   * On the right button because that's where a map's "what is this" lives —
   * Google Maps put it there and everyone learned it — and because the left
   * click is spoken for: a record opens on GBIF, a protected area names itself.
   */
  /**
   * Ask what a spot is — from a right click, or from a long press.
   *
   * Split out from the right-click handler because a phone has no right button:
   * holding a finger on the map is the gesture that means the same thing, and
   * both need the identical query rather than a second, thinner one.
   */
  const openPointQuery = useCallback((lng: number, lat: number, panelId: string) => {
    if (measure) return;
    const query = ++pointQueryId.current;
    // A second right-click while the first is in flight wins; without the guard
    // a slow answer would overwrite the panel you're already reading.
    const isCurrent = () => query === pointQueryId.current;
    setCopiedPoint(false);
    setPointQuery({
      kind: "point",
      panelId,
      lng,
      lat,
      elevation: null,
      elevationLoading: true,
      areas: [],
      areasLoading: false,
      highlight: 0,
    });

    elevationAt(lng, lat)
      .then((metres) => {
        if (!isCurrent()) return;
        setPointQuery((prev) => (prev ? { ...prev, elevation: metres, elevationLoading: false } : prev));
      })
      .catch(() => {
        if (!isCurrent()) return;
        setPointQuery((prev) => (prev ? { ...prev, elevation: null, elevationLoading: false } : prev));
      });

  }, [measure]);

  const handleMapContextMenu = useCallback(
    (e: MapLayerMouseEvent, panelId: string) => {
      e.originalEvent?.preventDefault();
      openPointQuery(e.lngLat.lng, e.lngLat.lat, panelId);
    },
    [openPointQuery]
  );

  /**
   * A held finger opens the same panel a right click does.
   *
   * Cancelled by movement, because a hold that drifts is a pan — MapLibre is
   * already interpreting it as one, and answering "what is here" about wherever
   * the finger started would be an answer to a question nobody asked.
   */
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  const cancelLongPress = useCallback(() => {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  }, []);
  const handleTouchStart = useCallback(
    (e: MapTouchEvent, panelId: string) => {
      if (e.points.length !== 1) return cancelLongPress();
      const { lng, lat } = e.lngLat;
      const [{ x, y }] = e.points;
      cancelLongPress();
      longPress.current = {
        x,
        y,
        timer: window.setTimeout(() => {
          longPress.current = null;
          openPointQuery(lng, lat, panelId);
        }, 550),
      };
    },
    [cancelLongPress, openPointQuery]
  );
  const handleTouchMove = useCallback((e: MapTouchEvent) => {
    const held = longPress.current;
    if (!held || e.points.length !== 1) return;
    const [{ x, y }] = e.points;
    // A few pixels of wobble is a finger resting, not a pan.
    if (Math.hypot(x - held.x, y - held.y) > 10) {
      window.clearTimeout(held.timer);
      longPress.current = null;
    }
  }, []);

  const copyPoint = useCallback((lat: number, lng: number) => {
    navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lng.toFixed(5)}`).then(
      () => {
        setCopiedPoint(true);
        window.setTimeout(() => setCopiedPoint(false), 1500);
      },
      () => setCopiedPoint(false)
    );
  }, []);

  // Escape ends measuring, the way it dismisses every other mode here.
  useEffect(() => {
    if (!measure) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMeasure(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [measure]);

  // Loaded records by gbifID — the map hands back only what it stored on a
  // feature, which for the assessor-georeference layer is just an id.
  const occurrencesByGbifId = useMemo(
    () => new Map(occurrences.map((o) => [o.properties.gbifID, o])),
    [occurrences]
  );
  // Read by the click handler, which is declared above this and so can't take
  // the map itself as a dependency.
  occurrencesByGbifIdRef.current = occurrencesByGbifId;

  /** Loaded records by catalogue number, for tying a point file row to one. */
  const occurrencesByCatalogNo = useMemo(() => {
    const index = new Map<string, OccurrenceFeature>();
    for (const o of occurrences) {
      const key = normaliseCatalogNumber(o.properties.catalogNumber as string | undefined);
      // First wins: two records under one catalogue number can't be told apart
      // by it, so guessing between them would be worse than the id match.
      if (key && !index.has(key)) index.set(key, o);
    }
    return index;
  }, [occurrences]);

  /**
   * Tie a point in the file back to a record on the map.
   *
   * The occurrence id is tried first and is not enough on its own: GBIF
   * reissues ids when a dataset is re-indexed, so a file compiled a few months
   * earlier cites ids that no longer resolve. On the Dioscorea biplicata file
   * five of twelve points still matched by id, where seven matched on
   * catalogue number — and the five were a subset of the seven.
   */
  const matchPointToRecord = useCallback(
    (point: IucnPoint): MatchedRecord | null => {
      const at = (o: OccurrenceFeature, via: MatchVia): MatchedRecord => {
        const coords = o.geometry?.coordinates;
        return {
          gbifID: o.properties.gbifID,
          lat: coords ? coords[1] : null,
          lon: coords ? coords[0] : null,
          via,
        };
      };
      const byId = point.gbifID == null ? undefined : occurrencesByGbifId.get(point.gbifID);
      if (byId) return at(byId, "gbif-id");
      const byCatalog = occurrencesByCatalogNo.get(normaliseCatalogNumber(point.fields.catalog_no));
      return byCatalog ? at(byCatalog, "catalog-no") : null;
    },
    [occurrencesByGbifId, occurrencesByCatalogNo]
  );

  /**
   * Where each point in the file sits relative to what's on the map — against
   * GBIF's published coordinate, and against the assessor's own georeference
   * for the same record.
   */
  const pointFileComparisonRef = useRef<PointFileComparison | null>(null);
  const pointFileComparison = useMemo(
    () => (pointFile ? comparePointFile(pointFile.points, matchPointToRecord, georeferences) : null),
    [pointFile, matchPointToRecord, georeferences]
  );
  // Read by the click handler, which is declared above this.
  pointFileComparisonRef.current = pointFileComparison;

  /**
   * The point file as a map layer.
   *
   * Every point in the file is drawn, including the ones whose GBIF record
   * isn't in the loaded sample and the ones with no GBIF record at all —
   * filtering it to what the map already knows would quietly hide the parts of
   * the assessment that came from somewhere else.
   */
  const pointFileGeoJson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: (pointFileComparison?.rows ?? []).map((r) => ({
        type: "Feature" as const,
        // The matched record's id, not the file's: a row that matched on
        // catalogue number cites an id GBIF has since retired, and opening
        // that would land on a missing record. Falls back to the cited id when
        // nothing matched, since that is still where the assessor got it.
        properties: { row: r.point.row, gbifID: r.matched?.gbifID ?? r.point.gbifID ?? null },
        geometry: { type: "Point" as const, coordinates: [r.point.longitude, r.point.latitude] },
      })),
    }),
    [pointFileComparison]
  );

  /**
   * The ecoregion containing the right-clicked point.
   *
   * A linear scan of 847 polygons with a bounding-box reject first, which is
   * fast enough to run during render and avoids carrying a spatial index for a
   * lookup that happens once per click.
   */
  /** The effort cell under the right-clicked point, if the layer is on. */
  const effortCellAtPoint = useMemo(
    () =>
      pointQuery && effortLayer && showSamplingEffort
        ? effortCell(effortLayer, pointQuery.lng, pointQuery.lat)
        : null,
    [pointQuery, effortLayer, showSamplingEffort]
  );
  const {
    count: gbifCellCount,
    byBasis: gbifCellByBasis,
    loading: gbifCellCountLoading,
  } = useGbifCellCount(
    effortCellAtPoint?.bounds ?? null,
    effortLayer?.group ?? null
  );

  const hoveredPointFileRow = useMemo(
    () =>
      pointFileHover
        ? (pointFileComparison?.rows.find((r) => r.point.row === pointFileHover.row) ?? null)
        : null,
    [pointFileHover, pointFileComparison]
  );

  const importPointFile = useCallback(
    (imported: PointFileImport) => {
      setPointFile(imported);
      setShowPointFile(true);
      if (!savePointFile(speciesKey, imported)) {
        setGeorefMessage({
          kind: "error",
          text: "The point file is on the map but couldn't be saved to this browser's storage — it won't survive a reload.",
        });
        return;
      }
    },
    [speciesKey]
  );

  const removePointFile = useCallback(() => {
    setPointFile(null);
    clearPointFile(speciesKey);
    setPointFileOpen(false);
  }, [speciesKey]);

  const handleMapMouseMove = useCallback((e: MapLayerMouseEvent, panelId: string) => {
    if (isTouchDevice) return;
    const features = e.features;
    // Set from the same hit test that drives the tooltip, so the cursor and
    // the panel can never disagree about whether there's a record here.
    setHoveringPoint(!!features && features.length > 0);
    // A pinned panel is one you asked for. Hovering doesn't take it away and
    // doesn't swap it for the next record the pointer crosses — it goes when
    // you close it, or when you click somewhere else, which pins whatever you
    // clicked on instead.
    if (tooltipPinnedRef.current) return;
    if (features && features.length > 0) {
      const props = features[0].properties;
      if (props) {
        // Prefer the record we already hold: the assessor-georeference layer
        // carries nothing but a gbifID, and even the occurrence layer's own
        // properties arrive flattened (arrays stringified) through MapLibre.
        const known = occurrencesByGbifId.get(Number(props.gbifID));
        if (known) {
          cancelHoverClear();
          setHoverSource("map");
              if (known.properties.gbifID !== hoveredFeature?.properties.gbifID) setGroupIndex(0);
          setHoveredFeature(known);
          setHoveredPanel(panelId);
          return;
        }
        // Reconstruct the OccurrenceFeature from the queried feature
        setHoverSource("map");
        const coords = (features[0].geometry as GeoJSON.Point).coordinates as [number, number];
        setHoveredFeature({
          type: "Feature",
          properties: {
            gbifID: props.gbifID,
            species: props.species,
            eventDate: props.eventDate,
            country: props.country,
            countryCode: props.countryCode,
            basisOfRecord: props.basisOfRecord,
            datasetKey: props.datasetKey,
            datasetName: props.datasetName,
            publishingOrgKey: props.publishingOrgKey,
            coordinateUncertaintyInMeters: props.coordinateUncertaintyInMeters,
            year: props.year,
            month: props.month,
            institutionCode: props.institutionCode,
            qualityFlags: typeof props.qualityFlags === "string" ? JSON.parse(props.qualityFlags) : props.qualityFlags,
          },
          geometry: { type: "Point", coordinates: coords },
        });
        setHoveredPanel(panelId);
      }
    } else if (!tooltipHeld) {
      clearHoverSoon();
    }
  }, [isTouchDevice, occurrencesByGbifId, tooltipHeld, hoveredFeature, clearHoverSoon, cancelHoverClear]);

  const handleMapMouseLeave = useCallback(() => {
    setHoveringPoint(false);
    if (tooltipHeld) return;
    clearHoverSoon();
  }, [tooltipHeld, clearHoverSoon]);

  // Dragging the divider between map and list. Pointer capture keeps the drag
  // alive when the pointer outruns the handle, which it will — the handle is
  // only a few pixels tall.
  const handleDividerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingDivider(true);
  }, []);

  const handleDividerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingDivider) return;
    const container = splitRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const span = panelLayout === "rows" ? rect.height : rect.width;
    if (span === 0) return;
    const pct = panelLayout === "rows"
      ? ((e.clientY - rect.top) / span) * 100
      : ((e.clientX - rect.left) / span) * 100;
    setMapHeightPct(Math.min(FULLSCREEN_MAX_MAP_PCT, Math.max(FULLSCREEN_MIN_MAP_PCT, pct)));
  }, [draggingDivider, panelLayout]);

  const handleDividerPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDraggingDivider(false);
    // MapLibre tracks its container's size itself, but ask once at the end so
    // the final frame is definitely drawn at the size it settled on.
    mapRef.current?.resize();
  }, []);

  // Arrow keys move the divider too, so it isn't mouse-only.
  const handleDividerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowUp" ? -5 : e.key === "ArrowDown" ? 5 : 0;
    if (step === 0) return;
    e.preventDefault();
    setMapHeightPct((pct) =>
      Math.min(FULLSCREEN_MAX_MAP_PCT, Math.max(FULLSCREEN_MIN_MAP_PCT, pct + step))
    );
  }, []);

  /**
   * Hovering a row in the record list highlights that record on the map, using
   * the same hoveredFeature the map's own hover sets — so the link works in
   * both directions, and the map's tooltip appears for a row you're only
   * pointing at in the table. Rows GBIF has no coordinates for still set it
   * (the list highlights), there's simply nothing on the map to grow.
   */
  const handleHoverRow = useCallback(
    (feature: OccurrenceFeature | null) => {
      // A panel you opened is yours until you close it. Hovering the list used
      // to unpin it, so picking a row and then moving towards the panel it
      // opened took the panel away before you got there.
      if (tooltipPinnedRef.current) return;
      if (!feature) {
        clearHoverSoon();
        return;
      }
      cancelHoverClear();
      unpinTooltip();
      setGroupIndex(0);
      setHoverSource("list");
      setHoveredFeature(feature);
      setHoveredPanel("main");
    },
    [clearHoverSoon, cancelHoverClear, unpinTooltip]
  );

  // Handle view state change for split view sync
  const handleMoveForSync = useCallback((e: ViewStateChangeEvent) => {
    setSharedViewState({
      longitude: e.viewState.longitude,
      latitude: e.viewState.latitude,
      zoom: e.viewState.zoom,
    });
  }, []);

  /**
   * EOO and AOO over the records the assessor has actually kept.
   *
   * That's the difference from running the same numbers in GeoCAT: the
   * coordinate-cleaning checks, the hand-struck records and their reasons, the
   * native-range restriction, the date window and any georeferences the
   * assessor placed have all already been applied — which is what the
   * Guidelines ask for when using aggregated data (§12.1.12.1) and what nobody
   * wants to redo in a second tool.
   */
  /**
   * The points EOO and AOO are measured over: whichever record layers are
   * switched on.
   *
   * Following the layers rather than always using GBIF's is what makes the
   * figures checkable. Compared against GeoCAT on the same thirteen-point file
   * this read 839,266 km² and 32 km² where GeoCAT gave 839,580.502 and 48 —
   * not because the maths differed (fed the same points it agrees exactly) but
   * because the uploaded file was never among the points. Turning GBIF's
   * records off and leaving the point file on now reproduces GeoCAT.
   */
  const rangeMetricPoints = useMemo(() => {
    const points: { lon: number; lat: number }[] = [];
    let ownCount = 0;
    if (showGbif || drawMyGeoreferences) {
      for (const o of includedOccurrences) {
        // The assessor's own coordinates first, and — the part that matters —
        // whether or not GBIF has any. A record georeferenced by hand is
        // precisely one GBIF couldn't place, so requiring GBIF geometry dropped
        // exactly the points the georeferencing work exists to add.
        const mine = georeferences[o.properties.gbifID];
        if (mine) {
          if (drawMyGeoreferences) {
            points.push({ lon: mine.decimalLongitude, lat: mine.decimalLatitude });
            ownCount += 1;
          }
          continue;
        }
        if (showGbif && o.geometry) {
          points.push({ lon: o.geometry.coordinates[0], lat: o.geometry.coordinates[1] });
        }
      }
    }
    if (drawPointFile && pointFile) {
      for (const point of pointFile.points) {
        points.push({ lon: point.longitude, lat: point.latitude });
      }
    }
    return { points, ownCount, fromPointFile: drawPointFile && pointFile ? pointFile.points.length : 0 };
  }, [includedOccurrences, georeferences, showGbif, drawMyGeoreferences, drawPointFile, pointFile]);

  const rangeMetrics = useMemo(() => {
    if (!showRangeMetrics || rangeMetricPoints.points.length === 0) return null;
    return {
      eoo: computeEoo(rangeMetricPoints.points),
      aoo: computeAoo(rangeMetricPoints.points, aooCellKm * 1000),
      ownCount: rangeMetricPoints.ownCount,
    };
  }, [showRangeMetrics, rangeMetricPoints, aooCellKm]);

  /**
   * The habitat class under the last left click, while that overlay is on.
   *
   * Its own state rather than a field on the right-click query: habitat is a
   * layer you click to interrogate, like the protected areas and the
   * ecoregions, and it answers into the same docked panel they do.
   */
  const [clickedHabitat, setClickedHabitat] = useState<{
    habitat: HabitatClass | null;
    loading: boolean;
    panelId: string;
  } | null>(null);

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
  const [clickedForest, setClickedForest] = useState<{
    point: ForestPoint | null;
    loading: boolean;
    panelId: string;
    lng: number;
    lat: number;
  } | null>(null);

  /** The ecoregion clicked on the map, outlined and named until dismissed. */
  const [selectedEcoregion, setSelectedEcoregion] = useState<{
    properties: EcoregionProperties;
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    /** Where it was clicked — the popup opens there, not in a corner. */
    lng: number;
    lat: number;
    panelId: string;
  } | null>(null);

  const selectedEcoregionGeoJson = useMemo<GeoJSON.Feature | null>(
    () =>
      selectedEcoregion
        ? { type: "Feature", properties: {}, geometry: selectedEcoregion.geometry }
        : null,
    [selectedEcoregion]
  );

  // A different species is a different map; an ecoregion picked out on the last
  // one has nothing to say about this one.
  useEffect(() => setSelectedEcoregion(null), [speciesKey]);

  /**
   * Every protected area under the clicked point, each carrying its own colour.
   *
   * All of them at once rather than one at a time: the whole question a click
   * on overlapping designations asks is how many there are and where each one
   * ends, and that can't be answered by a shape that changes under the pointer.
   * The one being pointed at is drawn heavier, so hover still says which row is
   * which — it just isn't the only thing that does.
   */
  const highlightedAreaGeoJson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!pointQuery) return null;
    // Indexed before filtering, so a point-only site (which has no geometry to
    // draw) doesn't shift the colours of the ones after it away from their
    // swatches in the list.
    const features = pointQuery.areas
      .map((area, index) => ({ area, index }))
      .filter(({ area }) => area.geometry)
      .map(({ area, index }) => ({
        type: "Feature" as const,
        properties: {
          sitePid: area.sitePid,
          colour: highlightColour(index),
          active: index === pointQuery.highlight,
        },
        geometry: area.geometry as GeoJSON.MultiPolygon,
      }));
    if (features.length === 0) return null;
    return { type: "FeatureCollection", features };
  }, [pointQuery]);

  // Where a hovered record sits on the map: the assessor's own coordinates
  // when they've supplied any, otherwise GBIF's. Null for a record with
  // neither, which is the one case with nothing to point at.
  const hoveredPosition = useMemo<[number, number] | null>(() => {
    if (!hoveredFeature) return null;
    const mine = georeferences[hoveredFeature.properties.gbifID];
    if (mine) return [mine.decimalLongitude, mine.decimalLatitude];
    if (hoveredFeature.geometry?.coordinates) return hoveredFeature.geometry.coordinates;
    return hoverAnchor && hoverAnchor.gbifID === hoveredFeature.properties.gbifID
      ? [hoverAnchor.lng, hoverAnchor.lat]
      : null;
  }, [hoveredFeature, georeferences, hoverAnchor]);

  /**
   * Records sharing a position, keyed by rounded coordinates.
   *
   * Duplicate sheets from one collection, or a series collected at one camp,
   * land on the same pixel and hide each other. Grouping them lets the tooltip
   * page through what's actually under the cursor instead of showing whichever
   * one happened to be on top.
   */
  const coLocatedByPosition = useMemo(() => {
    const groups = new Map<string, OccurrenceFeature[]>();
    for (const o of includedOccurrences) {
      const position = georeferences[o.properties.gbifID]
        ? [georeferences[o.properties.gbifID].decimalLongitude, georeferences[o.properties.gbifID].decimalLatitude]
        : o.geometry?.coordinates;
      if (!position) continue;
      const key = `${position[0].toFixed(4)},${position[1].toFixed(4)}`;
      const group = groups.get(key);
      if (group) group.push(o);
      else groups.set(key, [o]);
    }
    return groups;
  }, [includedOccurrences, georeferences]);

  const hoveredGroup = useMemo(() => {
    if (!hoveredFeature || !hoveredPosition) return [];
    const key = `${hoveredPosition[0].toFixed(4)},${hoveredPosition[1].toFixed(4)}`;
    return coLocatedByPosition.get(key) ?? [hoveredFeature];
  }, [hoveredFeature, hoveredPosition, coLocatedByPosition]);

  /**
   * Escape closes an open panel; nothing else does but its own close button.
   *
   * Clicking off it used to close it too, which made every click on the map —
   * to measure, to ask what a protected area is, to reach the record you were
   * comparing this one against — take the panel away with it. Reading a record
   * and using the map are the same activity, so the panel stays until it's
   * dismissed, or until another record replaces it.
   */
  /**
   * Institution names from GrSciColl, for the records whose panel has been
   * opened. Looked up one at a time, when a panel asks for one.
   */
  const [institutionNames, setInstitutionNames] = useState<Record<string, string>>({});
  const shownRecord = hoveredGroup[Math.min(groupIndex, hoveredGroup.length - 1)] ?? hoveredFeature;
  const shownInstitutionKey = shownRecord?.properties.institutionKey;
  useEffect(() => {
    if (!shownInstitutionKey || knownInstitutionName(shownInstitutionKey) !== undefined) return;
    let live = true;
    fetchInstitutionName(shownInstitutionKey).then((name) => {
      // Stored by key rather than by record: one herbarium holds many of a
      // species' sheets, and the panel for each of them wants the same name.
      if (live && name) setInstitutionNames((prev) => ({ ...prev, [shownInstitutionKey]: name }));
    });
    return () => {
      live = false;
    };
  }, [shownInstitutionKey]);

  useEffect(() => {
    if (!tooltipPinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTooltip();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tooltipPinned, closeTooltip]);

  // Reusable map panel renderer (used once in normal mode, twice in split view)
  const renderMapPanel = (
    panelOccurrences: OccurrenceFeature[],
    panelBbox: [number, number, number, number] | null,
    label: string | null,
    panelId: string = "main",
  ) => {
    const styledGeoJson = buildStyledFeatureCollection(panelOccurrences);

    // Circle layer paint properties (data-driven from feature properties)
    const circleLayerStyle = {
      id: `occ-circles-${panelId}`,
      type: "circle" as const,
      paint: {
        "circle-radius": ["get", "_radius"] as unknown as number,
        "circle-color": ["get", "_fillColor"] as unknown as string,
        "circle-opacity": ["get", "_fillOpacity"] as unknown as number,
        "circle-stroke-color": ["get", "_strokeColor"] as unknown as string,
        "circle-stroke-width": ["get", "_strokeWidth"] as unknown as number,
        "circle-stroke-opacity": ["get", "_strokeOpacity"] as unknown as number,
      },
    };

    const mapProps = splitView
      ? {
          longitude: sharedViewState.longitude,
          latitude: sharedViewState.latitude,
          zoom: sharedViewState.zoom,
          onMove: handleMoveForSync,
        }
      : {
          initialViewState: { longitude: 0, latitude: 20, zoom: 1.5 },
        };

    return (
      <div className={`occurrence-map flex-1 flex flex-col rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700 relative isolate z-0${fullscreen ? " min-h-0" : ""}`}>
        <div className={`${
          fullscreen
            ? "flex-1 min-h-[240px]"
            : splitView
              ? "h-[250px] sm:h-auto sm:min-h-[400px]"
              : "h-[300px] sm:h-auto sm:min-h-[450px]"
        } sm:flex-1 relative`}>
          {loadingOccurrences ? (
            <div className="flex items-center justify-center h-full bg-zinc-100 dark:bg-zinc-800">
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Loading occurrences...
              </div>
            </div>
          ) : mounted ? (
            <MapGL
              ref={panelId === "main" || panelId === "before" || !splitView ? mapRef : undefined}
              {...mapProps}
              // A tile that won't load is the earliest signal a source is down,
              // and the only one for a layer nobody has clicked yet. MapLibre
              // reports these per source, so it costs nothing to name the one
              // whose absence would otherwise be read as an answer.
              onError={(e) => {
                const sourceId = (e as unknown as { sourceId?: string }).sourceId;
                if (sourceId?.startsWith("wdpa-")) setProtectedAreasDown(true);
              }}
              style={{ width: "100%", height: "100%" }}
              mapStyle={BASEMAP_STYLES[basemap].style}
              interactiveLayerIds={[
                `occ-circles-${panelId}`,
                `georef-point-${panelId}`,
                `nearby-points-circle-${panelId}`,
              ]}
              onClick={(e: MapLayerMouseEvent) => handleMapClick(e, panelId)}
              onContextMenu={(e: MapLayerMouseEvent) => handleMapContextMenu(e, panelId)}
              onTouchStart={(e: MapTouchEvent) => handleTouchStart(e, panelId)}
              onTouchMove={handleTouchMove}
              onTouchEnd={cancelLongPress}
              onTouchCancel={cancelLongPress}
              onMouseMove={(e: MapLayerMouseEvent) => handleMapMouseMove(e, panelId)}
              onMouseLeave={handleMapMouseLeave}
              onLoad={panelId === "main" || panelId === "before" || !splitView ? handleMapLoad : undefined}
              // The ordinary arrow at rest, four-way arrows while panning and
              // a crosshair while measuring — the map cursor everyone already
              // knows from Google Maps. The hand it replaces claimed the map
              // was one big button.
              cursor={
                measure
                  ? "crosshair"
                  : panning
                    ? "move"
                    : hoveringPoint
                      ? "pointer"
                      : "default"
              }
              onDragStart={() => setPanning(true)}
              onDragEnd={() => setPanning(false)}
            >
              <ScaleControl position="bottom-right" />
              {/* Inside the map, because it positions itself against a shape
                  the map has projected. */}
              {renderClickInfo(panelId)}
              {/* The map's tools, behind one cog above its bottom-right
                  controls: the EOO/AOO switch and its figures, and measuring.
                  Both were panels of their own in opposite corners, which is a
                  lot of standing furniture for two things used occasionally. */}
              {panelId === "main" || !splitView ? (
                <MapToolsMenu
                  open={toolsOpen}
                  onToggle={() => setToolsOpen((v) => !v)}
                  measuring={!!measure}
                  onMeasureToggle={() => setMeasure(measure ? null : [])}
                >
                  {renderRangeMetrics()}
                </MapToolsMenu>
              ) : null}
              {/* Sampling effort — the very bottom of the stack. It answers
                  whether a blank area is empty because the species isn't there
                  or because nobody has looked, which is context for everything
                  drawn above it.

                  An image source rather than a raster one: the PNG is a single
                  world-wide Web Mercator image, and MapLibre maps an image
                  source linearly in Mercator space between its corners, which
                  is exactly the projection it's already in. At 10 km per source
                  cell it is deliberately coarse — the pattern is the point, not
                  any one pixel. */}
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
                    type="raster"
                    paint={{ "raster-opacity": 0.6, "raster-fade-duration": 0 }}
                  />
                </Source>
              )}
              {/* Ecoregions (Dinerstein et al. 2017), drawn in the dataset's
                  own biome colours. Fill kept faint and the boundary strong:
                  the useful thing is where one ecoregion ends and the next
                  begins, and a heavy fill hides the ground being compared. */}
              {showEcoregions && ecoregions && (
                <Source
                  id={`ecoregions-${panelId}`}
                  type="geojson"
                  data={ecoregions}
                  attribution={ECOREGIONS_ATTRIBUTION}
                >
                  <Layer
                    id={`ecoregions-fill-${panelId}`}
                    type="fill"
                    paint={{ "fill-color": ["get", "biomeColor"], "fill-opacity": 0.22 }}
                  />
                  <Layer
                    id={`ecoregions-line-${panelId}`}
                    type="line"
                    paint={{ "line-color": ["get", "biomeColor"], "line-width": 1, "line-opacity": 0.9 }}
                  />
                </Source>
              )}
              {/* The clicked ecoregion, outlined. Same treatment as a clicked
                  protected area — white casing under a strong line, so the
                  boundary reads over whatever basemap is underneath. */}
              {showEcoregions && selectedEcoregionGeoJson && (
                <Source id={`ecoregion-highlight-${panelId}`} type="geojson" data={selectedEcoregionGeoJson}>
                  <Layer
                    id={`ecoregion-highlight-fill-${panelId}`}
                    type="fill"
                    paint={{ "fill-color": "#059669", "fill-opacity": 0.18 }}
                  />
                  <Layer
                    id={`ecoregion-highlight-casing-${panelId}`}
                    type="line"
                    paint={{ "line-color": "#ffffff", "line-width": 4.5, "line-opacity": 0.9 }}
                  />
                  <Layer
                    id={`ecoregion-highlight-line-${panelId}`}
                    type="line"
                    paint={{ "line-color": "#059669", "line-width": 2 }}
                  />
                </Source>
              )}
              {/* Habitat types (Jung et al.) — bottom of the overlay stack: it
                  covers whole continents, so anything drawn over it stays
                  readable and it never hides a boundary or a point. */}
              {showHabitat && (
                <Source
                  id={`habitat-${panelId}`}
                  type="raster"
                  tiles={[HABITAT_TILE_URL]}
                  tileSize={256}
                  attribution={HABITAT_ATTRIBUTION}
                >
                  <Layer id={`habitat-layer-${panelId}`} type="raster" paint={{ "raster-opacity": 0.55 }} />
                </Source>
              )}
              {/* Global Forest Watch tree cover loss, year-coded. Above the
                  habitat map, below everything else: the question is what
                  happened inside a range, so it sits under the range and the
                  records rather than over them. */}
              {showForestLoss && (
                <Source
                  // The year range is baked into the tile URL, so a change of
                  // range is a different source rather than a repaint of this
                  // one — keyed so it is torn down and rebuilt instead of
                  // holding the tiles it already fetched.
                  key={`forest-loss-${lossYears[0]}-${lossYears[1]}`}
                  id={`forest-loss-${panelId}`}
                  type="raster"
                  tiles={[forestLossTileUrl(lossYears[0], lossYears[1])]}
                  tileSize={256}
                  maxzoom={FOREST_LOSS_MAX_ZOOM}
                  attribution={FOREST_LOSS_ATTRIBUTION}
                >
                  {/* No hue rotation any more: these tiles are already the
                      pink the old ramp was rotated into. */}
                  <Layer
                    id={`forest-loss-layer-${panelId}`}
                    type="raster"
                    paint={{ "raster-opacity": 0.85 }}
                  />
                </Source>
              )}
              {/* What the loss was for, at 1 km. Drawn as the platform draws
                  it — their tiles, their colours — because the legend has to
                  be true of the pixels, and above the loss layer, since where
                  both are on this is the one that answers "why". */}
              {showLossDrivers && (
                <Source
                  id={`loss-drivers-${panelId}`}
                  type="raster"
                  tiles={[FOREST_LOSS_DRIVERS_TILE_URL]}
                  tileSize={256}
                  maxzoom={FOREST_LOSS_DRIVERS_MAX_ZOOM}
                  attribution={FOREST_LOSS_DRIVERS_ATTRIBUTION}
                >
                  <Layer id={`loss-drivers-layer-${panelId}`} type="raster" paint={{ "raster-opacity": 0.85 }} />
                </Source>
              )}
              {/* Protected areas overlay (WDPA) — rendered before the occurrence
                  circles so the points draw on top of the shaded PA polygons */}
              {showProtectedAreas && (
                <Source
                  id={`wdpa-${panelId}`}
                  type="raster"
                  tiles={[PROTECTED_AREAS_TILE_URL]}
                  tileSize={256}
                  maxzoom={PROTECTED_AREAS_MAX_ZOOM}
                  attribution={PROTECTED_AREAS_ATTRIBUTION}
                >
                  {/* Recoloured here rather than by the server: the tiles are
                      WDPA's own green, which disappears against the terrain
                      basemap. See PROTECTED_AREAS_HUE_ROTATION. */}
                  <Layer
                    id={`wdpa-layer-${panelId}`}
                    type="raster"
                    paint={{
                      "raster-opacity": 0.55,
                      "raster-hue-rotate": PROTECTED_AREAS_HUE_ROTATION,
                      "raster-saturation": 0.2,
                    }}
                  />
                </Source>
              )}
              {/* The clicked area, outlined. A boundary you can see the whole
                  of answers "does my point sit inside this?" in a way a name in
                  a popup can't — and with several designations stacked at one
                  spot, it's the only way to tell which one you're reading. The
                  white casing keeps it legible over satellite imagery. */}
              {highlightedAreaGeoJson && pointQuery?.panelId === panelId && (
                <Source id={`wdpa-highlight-${panelId}`} type="geojson" data={highlightedAreaGeoJson}>
                  <Layer
                    id={`wdpa-highlight-fill-${panelId}`}
                    type="fill"
                    paint={{
                      "fill-color": ["get", "colour"],
                      // Light, because these stack: three overlapping fills at
                      // the old opacity turned the shared ground opaque and
                      // hid the records the question was about.
                      "fill-opacity": ["case", ["get", "active"], 0.2, 0.08],
                    }}
                  />
                  <Layer
                    id={`wdpa-highlight-casing-${panelId}`}
                    type="line"
                    paint={{ "line-color": "#ffffff", "line-width": 4.5, "line-opacity": 0.9 }}
                  />
                  <Layer
                    id={`wdpa-highlight-line-${panelId}`}
                    type="line"
                    paint={{
                      "line-color": ["get", "colour"],
                      "line-width": ["case", ["get", "active"], 3, 1.75],
                    }}
                  />
                </Source>
              )}
              {/* POWO / IUCN native-range overlays — shade the countries each
                  source considers native, purely informational (independent of
                  the "Native range only" occurrence filter). Distinct colors
                  since both can be shown at once to compare them directly. */}
              {showPowoRangeOverlay && powoRangeGeoJson && (
                <Source id={`powo-range-${panelId}`} type="geojson" data={powoRangeGeoJson}>
                  <Layer id={`powo-range-fill-${panelId}`} type="fill" paint={{ "fill-color": "#3b82f6", "fill-opacity": 0.25 }} />
                  <Layer id={`powo-range-line-${panelId}`} type="line" paint={{ "line-color": "#2563eb", "line-width": 1 }} />
                </Source>
              )}
              {showIucnRangeOverlay && iucnRangeGeoJson && (
                <Source id={`iucn-range-${panelId}`} type="geojson" data={iucnRangeGeoJson}>
                  <Layer id={`iucn-range-fill-${panelId}`} type="fill" paint={{ "fill-color": "#f59e0b", "fill-opacity": 0.25 }} />
                  <Layer id={`iucn-range-line-${panelId}`} type="line" paint={{ "line-color": "#d97706", "line-width": 1 }} />
                </Source>
              )}
              {/* Occurrence circles (GeoJSON source + circle layer) */}
              {showGbif && (
                <Source id={`occurrences-${panelId}`} type="geojson" data={styledGeoJson}>
                  <Layer {...circleLayerStyle} />
                </Source>
              )}
              {/* The IUCN point file, when one is loaded — the assessment's
                  delivered answer, in a colour of its own. Drawn above GBIF's
                  points and below the assessor's, which is the order they were
                  produced in. A hollow ring rather than a filled dot so a point
                  sitting exactly on top of the record it came from still shows
                  the record underneath it. */}
              {drawPointFile &&
                pointFileGeoJson.features.map((feature) => {
                  const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
                  const row = Number(feature.properties?.row);
                  return (
                    <MapLibreMarker key={`pointfile-${row}`} longitude={lng} latitude={lat} anchor="center">
                      <span
                        onClick={() => openPointFileRow(row, lng, lat, panelId)}
                        title={`Point ${row - 1} of the imported file`}
                        style={{ background: POINT_FILE_COLOR }}
                        className="block w-[9px] h-[9px] rotate-45 border-[1.5px] border-white shadow-sm cursor-pointer"
                      />
                    </MapLibreMarker>
                  );
                })}
                              {/* The radius the nearby panel is describing, drawn to scale.
                    Under the record layers rather than over them: it is the
                    question's boundary, not a thing to read. */}
                {nearbyAt && (
                  <Source
                    id={`nearby-radius-${panelId}`}
                    type="geojson"
                    data={{
                      type: "Feature",
                      properties: {},
                      geometry: uncertaintyCircle(nearbyAt.lat, nearbyAt.lng, nearbyRadiusKm * 1000),
                    }}
                  >
                    <Layer
                      id={`nearby-radius-fill-${panelId}`}
                      type="fill"
                      paint={{ "fill-color": NEARBY_SEARCH_COLOR, "fill-opacity": 0.08 }}
                    />
                    <Layer
                      id={`nearby-radius-line-${panelId}`}
                      type="line"
                      paint={{ "line-color": NEARBY_SEARCH_COLOR, "line-width": 1.5, "line-dasharray": [3, 2] }}
                    />
                  </Source>
                )}
              {/* The picked neighbour's own records. Above the radius they sit
                  inside and below everything the assessor is deciding about —
                  they are context for this map, not one of its own layers. */}
              {nearbyAt && nearbyPicked.length > 0 && nearbyPointsGeoJson.features.length > 0 && (
                <Source id={`nearby-points-${panelId}`} type="geojson" data={nearbyPointsGeoJson}>
                  {/* Dots, in colours no other layer here uses — see
                      NEARBY_PICKED_COLORS. They sit above the map's own records
                      and carry a white ring, so a neighbour reads as a separate
                      thing rather than merging into the points underneath. */}
                  <Layer
                    id={`nearby-points-circle-${panelId}`}
                    type="circle"
                    paint={{
                      "circle-radius": 4.5,
                      // One layer draws every picked species; the colour comes
                      // off the feature so they don't need a layer each.
                      "circle-color": ["get", "color"],
                      "circle-stroke-width": 1.5,
                      "circle-stroke-color": "#ffffff",
                    }}
                  />
                </Source>
              )}
              {/* Where the browser says you are. A map that flies somewhere and
                  marks nothing leaves you to guess which pixel it meant, which
                  is the one thing a locate button exists to settle. */}
              {myLocation && (
                <MapLibreMarker longitude={myLocation.lng} latitude={myLocation.lat} anchor="center">
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-60" />
                    <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-white bg-blue-600 shadow" />
                  </span>
                </MapLibreMarker>
              )}
              {/* The centre the radius is measured from. The ring alone says
                  roughly where, and "roughly where" is what a reader is trying
                  to pin down when they ask what is near a point. */}
              {nearbyAt && (
                <MapLibreMarker longitude={nearbyAt.lng} latitude={nearbyAt.lat} anchor="bottom">
                  <svg
                    className="h-5 w-5 drop-shadow"
                    viewBox="0 0 24 24"
                    fill={NEARBY_SEARCH_COLOR}
                    stroke="#ffffff"
                    strokeWidth={1.5}
                  >
                    <path d="M12 22s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z" />
                    <circle cx="12" cy="10" r="2.4" fill="#ffffff" stroke="none" />
                  </svg>
                </MapLibreMarker>
              )}
              {/* The assessor's own georeferences — drawn above the GBIF points
                  in a colour used nowhere else, with the uncertainty radius to
                  scale. They are never merged into the GBIF layer or into any
                  GBIF count: one person's reading of a locality description
                  shouldn't become indistinguishable from a published record. */}
              {drawMyGeoreferences && visibleGeoreferences.length > 0 && (
                <>
                  <Source id={`georef-circles-${panelId}`} type="geojson" data={georeferenceCirclesGeoJson}>
                    <Layer
                      id={`georef-circle-fill-${panelId}`}
                      type="fill"
                      paint={{ "fill-color": "#7c3aed", "fill-opacity": 0.12 }}
                    />
                    <Layer
                      id={`georef-circle-line-${panelId}`}
                      type="line"
                      paint={{ "line-color": "#7c3aed", "line-width": 1, "line-dasharray": [2, 2] }}
                    />
                  </Source>
                  {visibleGeoreferences.map((g) => (
                    <MapLibreMarker
                      key={g.gbifID}
                      longitude={g.decimalLongitude}
                      latitude={g.decimalLatitude}
                      anchor="center"
                      draggable
                      onDragEnd={(e) => handleGeoreferenceDragged(g.gbifID, e.lngLat.lat, e.lngLat.lng)}
                    >
                      {/* Clicking opens the record on GBIF, as clicking any
                          other point on this map does — your own point is
                          still a GBIF record, and behaving differently from
                          its neighbours is its own small trap. Correcting the
                          position is dragging it, or the tooltip's own edit. */}
                      <GeoreferenceMarkerDot
                        hovered={hoveredFeature?.properties.gbifID === g.gbifID}
                        onClick={() => {
                          handleMarkerHover(g.gbifID);
                          pinTooltip();
                        }}
                        onEnter={() => handleMarkerHover(g.gbifID)}
                        onLeave={() => handleHoverRow(null)}
                      />
                    </MapLibreMarker>
                  ))}
                </>
              )}
              {/* Highlighted dot when hovering an iNat thumbnail (only in the correct split panel) */}
              {hoveredObs && hoveredObs.decimalLatitude != null && hoveredObs.decimalLongitude != null && (
                !splitView || (
                  panelId === "main" ||
                  (panelId === "before" && (!hoveredObs.date || hoveredObs.date <= splitDate)) ||
                  (panelId === "after" && hoveredObs.date && hoveredObs.date > splitDate)
                )
              ) && (
                <>
                  <MapLibreMarker
                    longitude={hoveredObs.decimalLongitude}
                    latitude={hoveredObs.decimalLatitude}
                    anchor="center"
                  >
                    <div style={{
                      width: 18, height: 18, borderRadius: "50%",
                      background: "rgba(59, 130, 246, 0.5)",
                      border: "2.5px solid #1d4ed8",
                    }} />
                  </MapLibreMarker>
                  {hoveredObs.imageUrl && (
                    <MapImageTooltip
                      lat={hoveredObs.decimalLatitude!}
                      lng={hoveredObs.decimalLongitude!}
                      imageUrl={getThumbUrl(hoveredObs.imageUrl)}
                    />
                  )}
                </>
              )}
              {/* Hover tooltip for map markers. A record you've georeferenced
                  yourself gets one too, anchored to your point — it's on the
                  map, so hovering its row should say something. Your
                  coordinates win over GBIF's where you've supplied both (you
                  only ever georeference a record GBIF got wrong or left
                  blank). */}
              {tooltipPinned && hoveredFeature && hoveredPosition && !hoveredObs && hoverSource === "map" && hoveredPanel === panelId && (() => {
                const [hLon, hLat] = hoveredPosition;
                const shown = hoveredGroup[Math.min(groupIndex, hoveredGroup.length - 1)] ?? hoveredFeature;
                const hInat = inatPhotosByGbifId.get(shown.properties.gbifID);
                const mine = georeferences[shown.properties.gbifID];
                // Built here because this is where the assessor's own
                // coordinates, the cleaning flags and the native-range check
                // all live.
                const editorBelow = fullscreen && (isGeoreferenceable(shown.properties) || !!mine);
                const { fields, notes } = recordFields(shown, mine, hInat, { editorBelow });
                return (
                  <MapOccurrenceTooltip
                    lat={hLat}
                    lng={hLon}
                    fields={fields}
                    notes={notes}
                    mark={recordMarks(shown)}
                    typeStatus={shown.properties.typeStatus}
                    images={shown.properties.images}
                    page={
                      hoveredGroup.length > 1
                        ? {
                            index: Math.min(groupIndex, hoveredGroup.length - 1),
                            total: hoveredGroup.length,
                            onPrev: () => {
                              pinTooltip();
                              setGroupIndex((i) => (i - 1 + hoveredGroup.length) % hoveredGroup.length);
                            },
                            onNext: () => {
                              pinTooltip();
                              setGroupIndex((i) => (i + 1) % hoveredGroup.length);
                            },
                          }
                        : undefined
                    }
                    onPointerEnter={() => {
                      cancelHoverClear();
                      setTooltipHeld(true);
                    }}
                    onPointerLeave={() => {
                      setTooltipHeld(false);
                      clearHoverSoon();
                    }}
                    // Always offered, not only once clicked: they're what the
                    // panel is for, and hiding them behind a second gesture
                    // meant hovering told you about a record and gave you no
                    // way to act on it. Clicking only pins the panel, so the
                    // buttons stay put while you reach for them.
                    // Georeferencing without leaving the map: deciding where a
                    // locality description points means reading the river, the
                    // records around it and the boundary it falls inside, all
                    // of which are under this panel.
                    editor={
                      editorBelow ? (
                        <MapGeoreferenceEditor
                          key={shown.properties.gbifID}
                          initial={{
                            lat: mine?.decimalLatitude,
                            lon: mine?.decimalLongitude,
                            radius: mine?.coordinateUncertaintyInMeters,
                            // The note store is what's edited; a georeference
                            // saved before it existed still carries its own.
                            note:
                              assessorNotes[shown.properties.gbifID]?.text ?? mine?.georeferenceRemarks,
                          }}
                          defaultRadius={DEFAULT_GEOREFERENCE_RADIUS_M}
                          mine={!!mine}
                          onSave={(edit) => saveGeoreferenceInline(shown, edit)}
                          onSaveNote={(text) => saveAssessorNote(shown, text)}
                          onClear={mine ? () => clearGeoreference(shown) : undefined}
                        />
                      ) : undefined
                    }
                    actions={renderRecordActions(shown.properties.gbifID, { showInTable: true })}
                    // Always there, pinned or not. It used to appear only
                    // once the panel was pinned, and since these controls are
                    // right-aligned, it arrived exactly where the next-record
                    // arrow had been — so paging to the second record put a
                    // close button under a pointer that was mid-page.
                    onClose={closeTooltip}
                  />
                );
              })()}
              {/* A picked neighbour's record, in the same panel the map's own
                  records get. It is a GBIF occurrence like any other and the
                  question you have about it is the same one — what is it, who
                  collected it, where does it say it is — so it should not
                  answer in some lesser tooltip of its own. The fields are built
                  here rather than by recordFields, which expects a record this
                  map is deciding about: no georeference to edit, no cleaning
                  flags of ours, no exclusion. */}
              {nearbyShown && (
                <MapOccurrenceTooltip
                  lat={nearbyShown.lat}
                  lng={nearbyShown.lng}
                  // The same photographs the map's own records show. For a
                  // great many records the image is the evidence — a herbarium
                  // sheet, a camera-trap frame — and a neighbour's panel was
                  // quietly poorer than the one beside it without them.
                  images={nearbyShown.images}
                  fields={[
                    {
                      label: "Species",
                      value:
                        nearbyShown.species ??
                        nearbyPicked.find((p) => nearbyPoints[p.key]?.points.includes(nearbyShown))?.name ??
                        "",
                    },
                    ...(nearbyShown.basis
                      ? [{ label: "Basis", value: nearbyShown.basis.replace(/_/g, " ").toLowerCase() }]
                      : []),
                    ...(nearbyShown.eventDate || nearbyShown.year
                      ? [{ label: "Date", value: nearbyShown.eventDate ?? String(nearbyShown.year) }]
                      : []),
                    ...(nearbyShown.locality ? [{ label: "Locality", value: nearbyShown.locality }] : []),
                    ...(nearbyShown.countryCode ? [{ label: "Country", value: nearbyShown.countryCode }] : []),
                    {
                      label: "Coordinates",
                      value: `${nearbyShown.lat.toFixed(5)}, ${nearbyShown.lng.toFixed(5)}`,
                    },
                    ...(nearbyShown.uncertaintyMetres != null
                      ? [{ label: "GPS uncertainty", value: formatDistance(nearbyShown.uncertaintyMetres) }]
                      : []),
                    ...(nearbyShown.catalogNumber
                      ? [{ label: "Catalogue no.", value: nearbyShown.catalogNumber }]
                      : []),
                    ...(nearbyShown.recordedBy ? [{ label: "Recorded by", value: nearbyShown.recordedBy }] : []),
                    ...(nearbyShown.identifiedBy
                      ? [{ label: "Identified by", value: nearbyShown.identifiedBy }]
                      : []),
                    ...(nearbyShown.datasetName ? [{ label: "Dataset", value: nearbyShown.datasetName }] : []),
                  ]}
                  page={
                    nearbyShownGroup.length > 1
                      ? {
                          index: Math.min(nearbyShownIndex, nearbyShownGroup.length - 1),
                          total: nearbyShownGroup.length,
                          onPrev: () =>
                            setNearbyShownIndex(
                              (i) => (i - 1 + nearbyShownGroup.length) % nearbyShownGroup.length
                            ),
                          onNext: () => setNearbyShownIndex((i) => (i + 1) % nearbyShownGroup.length),
                        }
                      : undefined
                  }
                  onClose={() => setNearbyShownGroup([])}
                  actions={
                    nearbyShown.gbifID ? (
                      <a
                        href={`https://www.gbif.org/occurrence/${nearbyShown.gbifID}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex w-full items-center gap-1.5 px-1 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5L10 14M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-3" />
                        </svg>
                        Open on GBIF
                      </a>
                    ) : undefined
                  }
                />
              )}
              {/* Where the search landed. Pinned rather than just flown to:
                  the point of looking a locality up is to compare it against
                  the records, which means both have to be on screen at once. */}
              {previewPlace && !pinnedPlaces.some((p) => p.id === previewPlace.id) && (
                <MapLibreMarker
                  key={`preview-${previewPlace.id}`}
                  longitude={previewPlace.lng}
                  latitude={previewPlace.lat}
                  anchor="bottom"
                >
                  <div className="flex flex-col items-center -mb-1 opacity-80">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-500/80 text-white text-[10px] whitespace-nowrap max-w-[14rem] truncate">
                      {previewPlace.name}
                    </span>
                    <svg className="w-5 h-5 -mt-0.5 text-zinc-500" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z" />
                    </svg>
                  </div>
                </MapLibreMarker>
              )}
              {/* Drawn in either mode. They were fullscreen-only on the
                  reasoning that a pin is read against a locality description
                  and there is none outside fullscreen — but a pin you dropped
                  yourself is worth seeing wherever you dropped it, and the
                  Records legend carries its toggle in both modes, so it can
                  still be taken off. They keep their place in storage either
                  way. */}
              {showPins && pinnedPlaces.map((place) => (
                <MapLibreMarker key={place.id} longitude={place.lng} latitude={place.lat} anchor="bottom">
                  <div className="flex flex-col items-center -mb-1">
                    {!place.nameHidden && (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-900/80 text-white text-[10px] whitespace-nowrap">
                      {renamingPin === place.id ? (
                        // Keystrokes stop here: MapLibre listens for keys on
                        // the container this marker is portalled into, so
                        // typing "e" would otherwise pan the map east.
                        <input
                          autoFocus
                          defaultValue={place.name}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") setRenamingPin(null);
                          }}
                          onBlur={(e) => {
                            const name = e.currentTarget.value.trim();
                            if (name) {
                              setPinnedPlaces(
                                (prev) => prev.map((p) => (p.id === place.id ? { ...p, name } : p)),
                                `Rename pin to ${name}`
                              );
                            }
                            setRenamingPin(null);
                          }}
                          className="w-28 bg-transparent border-b border-white/40 text-white text-[10px] focus:outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => setRenamingPin(place.id)}
                          title="Rename this pin"
                          className="max-w-[12rem] truncate hover:underline decoration-dotted"
                        >
                          {place.name}
                        </button>
                      )}
                      {/* Each pin is dismissed on its own, so several can stand
                          at once and none goes away by accident. */}
                      <button
                        onClick={() =>
                          setPinnedPlaces(
                            (prev) => prev.filter((p) => p.id !== place.id),
                            `Remove pin ${place.name}`
                          )
                        }
                        title="Remove this pin"
                        className="shrink-0 -mr-0.5 px-0.5 text-white/70 hover:text-white"
                      >
                        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                    )}
                    {/* The pin itself folds its own label away. Half a dozen
                        pins around one locality description cover the records
                        they were placed to be read against, and by then you
                        know which pin is which. */}
                    <button
                      onClick={() =>
                        setPinnedPlaces(
                          (prev) =>
                            prev.map((p) => (p.id === place.id ? { ...p, nameHidden: !p.nameHidden } : p)),
                          place.nameHidden ? `Show pin ${place.name}` : `Hide pin ${place.name}`
                        )
                      }
                      title={place.nameHidden ? `Show this pin's name — ${place.name}` : "Hide this pin's name"}
                      aria-label={place.nameHidden ? "Show this pin's name" : "Hide this pin's name"}
                      data-pin-toggle={place.id}
                      className="-mt-0.5 cursor-pointer text-zinc-900 hover:text-zinc-700"
                    >
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z" />
                      </svg>
                    </button>
                  </div>
                </MapLibreMarker>
              ))}
              {/* Extent of occurrence and area of occupancy, drawn so the
                  numbers can be checked against the ground rather than taken on
                  trust — a hull reaching across an ocean usually means an
                  outlier that should have been struck out. */}
              {rangeMetrics?.eoo.hull && (
                <Source
                  id={`eoo-${panelId}`}
                  type="geojson"
                  data={{ type: "Feature", properties: {}, geometry: rangeMetrics.eoo.hull }}
                >
                  <Layer id={`eoo-fill-${panelId}`} type="fill" paint={{ "fill-color": "#0ea5e9", "fill-opacity": 0.07 }} />
                  <Layer
                    id={`eoo-line-${panelId}`}
                    type="line"
                    paint={{ "line-color": "#0369a1", "line-width": 1.5, "line-dasharray": [3, 2] }}
                  />
                </Source>
              )}
              {rangeMetrics && rangeMetrics.aoo.cells.length > 0 && (
                <Source
                  id={`aoo-${panelId}`}
                  type="geojson"
                  data={{
                    type: "FeatureCollection",
                    features: rangeMetrics.aoo.cells.map((cell) => ({
                      type: "Feature" as const,
                      properties: {},
                      geometry: cell,
                    })),
                  }}
                >
                  <Layer id={`aoo-fill-${panelId}`} type="fill" paint={{ "fill-color": "#0369a1", "fill-opacity": 0.35 }} />
                  <Layer id={`aoo-line-${panelId}`} type="line" paint={{ "line-color": "#0369a1", "line-width": 0.6 }} />
                </Source>
              )}
              {/* The measured path. Drawn above everything so the line stays
                  readable over the rasters it's being measured against. */}
              {/* The distance on the line it measures. It used to be in a
                  chip at the far corner of the map, which meant reading the
                  answer somewhere other than where the question was drawn. */}
              {measure && measure.length > 1 && (
                <MapLibreMarker
                  longitude={(measure[0][0] + measure[1][0]) / 2}
                  latitude={(measure[0][1] + measure[1][1]) / 2}
                  anchor="bottom"
                >
                  <div className="px-1.5 py-0.5 -translate-y-1 rounded bg-zinc-900/85 text-white text-[11px] font-medium tabular-nums whitespace-nowrap shadow">
                    {formatDistance(pathLengthMetres(measure))}
                  </div>
                </MapLibreMarker>
              )}
              {measure && measure.length > 0 && (
                <Source
                  id={`measure-${panelId}`}
                  type="geojson"
                  data={{
                    type: "FeatureCollection",
                    features: [
                      ...(measure.length > 1
                        ? [{
                            type: "Feature" as const,
                            properties: {},
                            geometry: { type: "LineString" as const, coordinates: measure },
                          }]
                        : []),
                      ...measure.map((point, index) => ({
                        type: "Feature" as const,
                        // The origin is drawn larger, so which end is pinned is
                        // visible rather than something you have to remember.
                        properties: { anchor: index === 0 },
                        geometry: { type: "Point" as const, coordinates: point },
                      })),
                    ],
                  }}
                >
                  <Layer
                    id={`measure-casing-${panelId}`}
                    type="line"
                    filter={["==", ["geometry-type"], "LineString"]}
                    paint={{ "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.9 }}
                  />
                  <Layer
                    id={`measure-line-${panelId}`}
                    type="line"
                    filter={["==", ["geometry-type"], "LineString"]}
                    paint={{ "line-color": "#111827", "line-width": 2, "line-dasharray": [2, 1.5] }}
                  />
                  <Layer
                    id={`measure-points-${panelId}`}
                    type="circle"
                    filter={["==", ["geometry-type"], "Point"]}
                    paint={{
                      "circle-radius": ["case", ["get", "anchor"], 6, 4],
                      "circle-color": "#111827",
                      "circle-stroke-color": "#ffffff",
                      "circle-stroke-width": 2,
                    }}
                  />
                </Source>
              )}
              {/* None of the popups below sets an anchor. MapLibre then picks
                  the side with room, so one opened near the top of the map
                  flips underneath its point instead of being cut off by the
                  map's edge — which is where the answer was least readable. */}
              {/* A hovered point from the loaded file. Its own popup because it
                  is not a GBIF record: there is no row for it in the table, and
                  the two distances are the only reason it's on the map. */}
              {pointFileHover && pointFileHover.panelId === panelId && hoveredPointFileRow && (
                <MapPopup
                  longitude={pointFileHover.lng}
                  latitude={pointFileHover.lat}
                  offset={10}
                  maxWidth="290px"
                  // Its own close button, now that clicking off a panel
                  // leaves it alone: this one is opened by a click like the
                  // record panel, and needs the same way out.
                  closeButton
                  closeOnClick={false}
                  onClose={closeTooltip}
                  className="occurrence-popup"
                >
                  <div className="text-[11px] text-zinc-700 dark:text-zinc-200 space-y-1">
                    <div className="flex items-center gap-1.5 font-medium">
                      <span className="w-2 h-2 rotate-45 shrink-0" style={{ background: POINT_FILE_COLOR }} />
                      Imported record
                      {/* Counting the points, not the spreadsheet's lines:
                          the table beneath the map numbers them the same way,
                          and a header is not a point. */}
                      <span className="font-normal text-zinc-400">point {hoveredPointFileRow.point.row - 1}</span>
                    </div>
                    {pointSummary(hoveredPointFileRow.point).slice(0, 5).map((s) => (
                      <div key={s.label} className="flex gap-1.5">
                        <span className="text-zinc-400 shrink-0">{s.label}</span>
                        <span className="truncate">{s.value}</span>
                      </div>
                    ))}
                    {(hoveredPointFileRow.fromGbif != null || hoveredPointFileRow.fromMine != null) && (
                      <div className="pt-1 mt-1 border-t border-zinc-200 dark:border-zinc-700 space-y-0.5">
                        {hoveredPointFileRow.fromGbif != null && (
                          <div className="flex gap-1.5">
                            <span className="text-zinc-400 shrink-0">From GBIF&apos;s coordinate</span>
                            <span className="tabular-nums">{formatDistance(hoveredPointFileRow.fromGbif)}</span>
                          </div>
                        )}
                        {hoveredPointFileRow.fromMine != null && (
                          <div className="flex gap-1.5">
                            <span className="text-zinc-400 shrink-0">From your georeference</span>
                            <span className="tabular-nums font-medium">{formatDistance(hoveredPointFileRow.fromMine)}</span>
                          </div>
                        )}
                      </div>
                    )}
                    {hoveredPointFileRow.matched && (
                      <a
                        href={`https://www.gbif.org/occurrence/${hoveredPointFileRow.matched.gbifID}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block pt-0.5 text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        Open this record on GBIF
                      </a>
                    )}
                  </div>
                </MapPopup>
              )}
              {/* What's here: the ground's height, and what protects it. */}
              {pointQuery?.panelId === panelId && pointQuery.kind === "point" && (
                <MapPopup
                  longitude={pointQuery.lng}
                  latitude={pointQuery.lat}
                  offset={10}
                  maxWidth="290px"
                  closeOnClick={false}
                  onClose={() => setPointQuery(null)}
                  className="occurrence-popup"
                >
                  <div className="text-[11px] text-zinc-700 dark:text-zinc-200 space-y-1.5">
                    <div className="text-zinc-500 dark:text-zinc-400">
                      {/* Click the coordinates to copy them — the reason you
                          right-clicked a spot is usually to paste it somewhere
                          else, so it shouldn't need selecting by hand. */}
                      <button
                        onClick={() => copyPoint(pointQuery.lat, pointQuery.lng)}
                        title="Copy these coordinates"
                        className="tabular-nums hover:text-zinc-800 dark:hover:text-zinc-100 hover:underline decoration-dotted"
                      >
                        {pointQuery.lat.toFixed(5)}, {pointQuery.lng.toFixed(5)}
                      </button>
                      {copiedPoint && <span className="ml-1 text-emerald-600 dark:text-emerald-400">copied</span>}
                      {" · "}
                      {pointQuery.elevationLoading ? (
                        <span className="text-zinc-400">reading elevation…</span>
                      ) : pointQuery.elevation == null ? (
                        <span className="text-zinc-400">elevation unavailable</span>
                      ) : (
                        <span
                          className="font-medium text-zinc-700 dark:text-zinc-200"
                          title={ELEVATION_ATTRIBUTION}
                        >
                          {formatElevation(pointQuery.elevation)}
                        </span>
                      )}
                    </div>
                    {/* How much collecting has happened here at all. The
                        counts came down with the layer, so this is a lookup in
                        an array rather than a request — the reason for shipping
                        values instead of a picture. */}
                    {showSamplingEffort && effortLayer && effortCellAtPoint && (
                      <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
                        {(() => {
                          const records = effortAt(effortLayer, pointQuery.lng, pointQuery.lat);
                          return (
                            <>
                              <span className="font-medium text-zinc-700 dark:text-zinc-200">
                                {records == null
                                  ? `No ${EFFORT_GROUP_LABELS[effortLayer.group].toLowerCase()} records when this was published`
                                  : formatEffort(records, effortCellAtPoint.widthKm)}
                              </span>
                              <span className="block text-zinc-400">
                                {EFFORT_GROUP_LABELS[effortLayer.group]}, all years
                              </span>
                              {/* The layer is a snapshot published with the
                                  paper; this is what GBIF holds today. They
                                  differ by a lot and neither is wrong, so both
                                  are shown and both are labelled. */}
                              <span className="block text-zinc-500 dark:text-zinc-400">
                                {gbifCellCountLoading
                                  ? "Counting on GBIF…"
                                  : gbifCellCount == null
                                    ? ""
                                    : `${gbifCellCount.toLocaleString()} on GBIF today`}
                              </span>
                              {/* Broken down, because the total alone doesn't
                                  say what kind of looking happened here. A
                                  cell of photographs and a cell of herbarium
                                  sheets are different evidence about whether
                                  a plant would have been collected if it were
                                  present. */}
                              {gbifCellByBasis.length > 0 && (
                                <span className="block pl-2 border-l border-zinc-200 dark:border-zinc-700">
                                  {/* Each kind is its own search. Whether the
                                      looking here was photographs or herbarium
                                      sheets is usually the question, so the
                                      answer should be one click rather than a
                                      filter to set again on GBIF. */}
                                  {gbifCellByBasis.slice(0, 4).map((b) => (
                                    <a
                                      key={b.basis}
                                      href={gbifSearchUrl(effortCellAtPoint.bounds, effortLayer.group, [b.basis])}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="block text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
                                    >
                                      <span className="tabular-nums">{b.count.toLocaleString()}</span>{" "}
                                      {(BASIS_LABELS[b.basis] ?? b.basis.replace(/_/g, " ").toLowerCase())}
                                    </a>
                                  ))}
                                </span>
                              )}
                              <a
                                href={gbifSearchUrl(effortCellAtPoint.bounds, effortLayer.group)}
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
                    )}
                    {/* Silent when the point isn't protected: the overlay is
                        already showing you that, and a line saying so on every
                        click is noise on the answer you did ask for. */}
                    {/* Offered on the dashboard's map as well as fullscreen.
                        These were fullscreen-only because a pin dropped outside
                        it was never drawn and had no legend row to take it off
                        again — both of which now hold in either mode, so the
                        tools travel with them. */}
                    <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800 flex items-center gap-1">
                      <input
                        value={newPinLabel}
                        onChange={(e) => setNewPinLabel(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            addPin(pointQuery.lng, pointQuery.lat, newPinLabel);
                            setNewPinLabel("");
                            setPointQuery(null);
                          }
                        }}
                        placeholder="Label a pin here"
                        className="flex-1 min-w-0 px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-[11px] text-zinc-800 dark:text-zinc-100"
                      />
                      <button
                        onClick={() => {
                          addPin(pointQuery.lng, pointQuery.lat, newPinLabel);
                          setNewPinLabel("");
                          setPointQuery(null);
                        }}
                        title="Drop a pin at this spot"
                        className="shrink-0 px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                      >
                        Pin
                      </button>
                      {/* Measuring from the spot you just right-clicked, rather
                          than from the tools menu and then hunting for it
                          again. The first end is this point; the next click on
                          the map is the far one. */}
                      <button
                        onClick={() => {
                          setMeasure([[pointQuery.lng, pointQuery.lat]]);
                          setPointQuery(null);
                        }}
                        title="Measure from here — click the map for the far end"
                        className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                      >
                        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" d="M3 21L21 3M7 13l2 2M11 9l2 2M15 5l2 2" />
                        </svg>
                        Measure
                      </button>
                    </div>
                    {/* The same search a record's panel offers, from bare
                        ground. Anchored to a record it could only answer
                        "what is near this specimen"; the question people
                        actually arrive with is often "what is near here" —
                        a valley, a proposed site, where they are standing. */}
                    <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
                      <button
                        onClick={() => {
                          setNearbyAt({ lng: pointQuery.lng, lat: pointQuery.lat, recordName: "" });
                          setNearbyRadiusKm(NEARBY_RADIUS_DEFAULT);
                          setNearbyPicked([]);
                          setPointQuery(null);
                        }}
                        title="Threatened and Near Threatened species with GBIF records around this point"
                        className="w-full flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-left"
                      >
                        <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <circle cx="12" cy="12" r="3" />
                          <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
                        </svg>
                        Find nearby threatened species
                      </button>
                    </div>
                  </div>
                </MapPopup>
              )}
              {/* IUCN Range Map layer */}
              {showRange && assessmentId && canViewRangeMap && (
                <RangeMapLayer
                  assessmentId={assessmentId}
                  visible={showRange}
                  panelId={panelId}
                  onLoadingChange={setRangeLoading}
                  onCategoriesChange={(cats) => {
                    setRangeCategories(cats);
                    // Default to showing only Extant (Native) if it exists
                    if (cats.some((c) => c.key === "1-1")) {
                      setVisibleCategories(new Set(["1-1"]));
                    }
                  }}
                  onNotFound={setRangeNotFound}
                  onSimplificationChange={setRangeSimplification}
                  onPolygonsChange={setRangePolygons}
                  visibleCategories={visibleCategories}
                />
              )}
              {/* AOH layer */}
              {showAoh && sisTaxonId && taxonGroup && (
                <AohMapLayer
                  sisTaxonId={sisTaxonId}
                  taxonGroup={taxonGroup}
                  visible={showAoh}
                  panelId={panelId}
                  mapRef={mapRef}
                  onLoadingChange={setAohLoading}
                />
              )}
            </MapGL>
          ) : null}
          {/* Bottom-left stack: which records are drawn, what they measure,
              then what each overlay's colours mean. Stacked in a column so a
              legend that only appears with its overlay can't land on top of
              another. */}
          <div className="absolute bottom-2 left-2 z-[1000] flex flex-col items-start gap-1.5 max-w-[90%]">
          {!loadingOccurrences && mounted && renderRecordLayers(label)}
          {/* The measuring tool's running total. First in the stack because
              it's a live mode, not a legend. */}
          {measure && (
            <div className="bg-white dark:bg-zinc-800 px-2 py-1.5 rounded shadow text-[11px] text-zinc-700 dark:text-zinc-200 flex items-center gap-2">
              {measure.length < 2 && (
                <span className="text-zinc-400">
                  {measure.length === 0 ? "click the first point" : "click the second point"}
                </span>
              )}
              <button
                onClick={() => setMeasure(null)}
                title="Finish measuring (or press Escape)"
                className="text-zinc-500 dark:text-zinc-400 hover:underline"
              >
                Done
              </button>
            </div>
          )}
          {/* One key for the layers that are on, laid out as a table: name on
              the left, its colours on the right, its source at the end. Four
              separate cards each with its own arrangement read as four notices
              rather than one legend, and nothing lined up with anything.

              Each name is its own disclosure where there's more to say — the
              biomes, the habitat classes, what tree cover loss does and doesn't
              mean. */}
          {!loadingOccurrences &&
            (showSamplingEffort || showEcoregions || showForestLoss || showLossDrivers || showHabitat) && (
            <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-md border border-zinc-200 dark:border-zinc-700 py-1 text-[11px] text-zinc-600 dark:text-zinc-300 max-w-full">
              <div className="px-2 pb-0.5 text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Overlays
              </div>
              {showEcoregions && ecoregions && (
                <div>
                  <div className="flex items-center gap-2 px-2 py-0.5">
                    <button
                      onClick={() => setBiomeLegendOpen((v) => !v)}
                      title={biomeLegendOpen ? "Hide the biomes" : "Show what the ecoregion colours mean"}
                      className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-100"
                    >
                      <span className="truncate">Terrestrial ecoregions</span>
                      <span className="text-[9px] text-zinc-400">{biomeLegendOpen ? "▾" : "▸"}</span>
                    </button>
                    <span className="flex rounded-sm overflow-hidden shrink-0">
                      {BIOMES.slice(0, 8).map((biome) => (
                        <span key={biome.name} className="w-2 h-2.5" style={{ background: biome.color }} />
                      ))}
                    </span>
                    <a
                      href={ECOREGIONS_PAPER_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Dinerstein et al. 2017, RESOLVE Ecoregions 2017 (CC BY 4.0)"
                      className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
                    >
                      <FaInfoCircle className="w-3 h-3" />
                    </a>
                  </div>
                  {biomeLegendOpen && (
                    <div className="px-2 pb-1 pl-3 space-y-0.5">
                      {BIOMES.map((biome) => (
                        <div key={biome.name} className="flex items-center gap-1.5">
                          <span
                            className="w-2.5 h-2.5 rounded-sm shrink-0 border border-black/10"
                            style={{ background: biome.color }}
                          />
                          <span className="truncate text-[10px]">{biome.name}</span>
                        </div>
                      ))}
                      <div className="text-[10px] text-zinc-400 pt-0.5">
                        {ecoregions.features.length} ecoregions in 14 biomes
                      </div>
                    </div>
                  )}
                </div>
              )}
              {showHabitat && (
                <div>
                  <div className="flex items-center gap-2 px-2 py-0.5">
                    <button
                      onClick={() => setHabitatLegendOpen((v) => !v)}
                      title={habitatLegendOpen ? "Hide the habitat classes" : "Show what the habitat colours mean"}
                      className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-100"
                    >
                      <span className="truncate">IUCN habitat types</span>
                      <span className="text-[9px] text-zinc-400">{habitatLegendOpen ? "▾" : "▸"}</span>
                    </button>
                    <span className="flex rounded-sm overflow-hidden shrink-0">
                      {HABITAT_LEGEND.slice(0, 8).map((entry) => (
                        <span key={entry.code} className="w-2 h-2.5" style={{ background: entry.color }} />
                      ))}
                    </span>
                    <a
                      href={HABITAT_SCHEME_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="IUCN Habitats Classification Scheme — Jung et al. 2020 (CC BY 4.0). Click the map for the class at a point."
                      className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
                    >
                      <FaInfoCircle className="w-3 h-3" />
                    </a>
                  </div>
                  {habitatLegendOpen && (
                    <div className="px-2 pb-1 pl-3 space-y-0.5 max-w-xs">
                      {HABITAT_LEGEND.map((entry) => (
                        <div key={entry.code} className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: entry.color }} />
                          <span className="truncate text-[10px]">{entry.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {showForestLoss && (
                <div>
                  <div className="flex items-center gap-2 px-2 py-0.5">
                    <button
                      onClick={() => setForestLossNotesOpen((v) => !v)}
                      title={forestLossNotesOpen ? "Hide what this layer does and doesn't mean" : "What this layer does and doesn't mean"}
                      className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-100"
                    >
                      <span className="truncate">Tree cover loss</span>
                      <span className="text-[9px] text-zinc-400">{forestLossNotesOpen ? "▾" : "▸"}</span>
                    </button>
                    {/* One swatch, not a ramp: the tiles are a single colour
                        whatever year the loss is from. The years are set on
                        the track below, where a range can be dragged. */}
                    <span className="flex items-center gap-1 shrink-0 text-[9px] tabular-nums text-zinc-400">
                      <span
                        className="h-2.5 w-4 rounded-sm"
                        style={{ background: FOREST_LOSS_COLOR }}
                        title={`Loss between ${lossYears[0]} and ${lossYears[1]}`}
                      />
                    </span>
                    <a
                      href={FOREST_LOSS_DATASET_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={FOREST_LOSS_SOURCE_NOTE}
                      className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
                    >
                      <FaInfoCircle className="w-3 h-3" />
                    </a>
                  </div>
                  {/* Always out, not behind the disclosure: narrowing the
                      years is the thing you do with this layer, not a note
                      about it. */}
                  <YearRangeSlider
                    min={FOREST_LOSS_FIRST_YEAR}
                    max={FOREST_LOSS_LAST_YEAR}
                    value={lossYears}
                    onChange={setLossYears}
                    color={FOREST_LOSS_COLOR}
                    label="Years of tree cover loss to show"
                  />
                  {forestLossNotesOpen && (
                    <div className="px-2 pb-1 pl-3 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400 max-w-md">
                      <div>
                        <span className="font-medium">Loss is disturbance, not deforestation.</span>{" "}
                        {FOREST_LOSS_CAVEAT}
                      </div>
                      <div className="pt-0.5">{FOREST_LOSS_THRESHOLD_NOTE}</div>
                    </div>
                  )}
                </div>
              )}
              {showLossDrivers && (
                <div>
                  <div className="flex items-center gap-2 px-2 py-0.5">
                    <button
                      onClick={() => setLossDriverNotesOpen((v) => !v)}
                      title={lossDriverNotesOpen ? "Hide what this layer does and doesn't mean" : "What this layer does and doesn't mean"}
                      className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-100"
                    >
                      <span className="truncate">Tree cover loss by dominant driver</span>
                      <span className="text-[9px] text-zinc-400">{lossDriverNotesOpen ? "▾" : "▸"}</span>
                    </button>
                    {/* Seven classes, so the swatches carry their names on
                        hover rather than in a column that would be taller than
                        the map. Opened, each one says what it covers. */}
                    <span className="flex items-center gap-0.5 shrink-0">
                      {FOREST_LOSS_DRIVERS.map((driver) => (
                        <DriverSwatch key={driver.label} driver={driver} />
                      ))}
                    </span>
                    <a
                      href={FOREST_LOSS_DRIVERS_PAPER_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Sims et al. (2025), Global drivers of forest loss at 1 km resolution — the paper this classification comes from."
                      className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
                    >
                      <FaInfoCircle className="w-3 h-3" />
                    </a>
                  </div>
                  {lossDriverNotesOpen && (
                    <div className="px-2 pb-1 pl-3 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400 max-w-md">
                      <div className="grid grid-cols-1 gap-y-0.5 pb-1">
                        {FOREST_LOSS_DRIVERS.map((driver) => (
                          <div key={driver.label} className="flex gap-1.5">
                            <span
                              className="mt-[3px] h-2 w-2 shrink-0 rounded-sm"
                              style={{ background: driver.color }}
                            />
                            <span>
                              <span className="font-medium text-zinc-600 dark:text-zinc-300">{driver.label}</span>{" "}
                              {driver.description}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div>{FOREST_LOSS_DRIVERS_CAVEAT}</div>
                    </div>
                  )}
                </div>
              )}
              {showSamplingEffort && effortLayer && (
                <div className="flex items-center gap-2 px-2 py-0.5">
                  <span className="flex-1 min-w-0 truncate" title="GBIF records per 10 km cell. A gap here means nobody has looked, which is not the same as the species being absent.">
                    GBIF sampling effort
                    <span className="text-zinc-400"> · {EFFORT_GROUP_LABELS[effortLayer.group]}</span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0 text-[9px] text-zinc-400">
                    less
                    <span className="flex rounded-sm overflow-hidden">
                      {EFFORT_LEGEND.map((step) => (
                        <span key={step} className="w-2 h-2.5" style={{ background: step }} />
                      ))}
                    </span>
                    more
                  </span>
                  <a
                    href={EFFORT_PAPER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Global sampling effort of GBIF biodiversity data — El-Gabbas 2026, Diversity and Distributions"
                    className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
                  >
                    <FaInfoCircle className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          )}
          </div>
          {/* This session's edits, newest first. Clicking one steps back to it,
              which is undo applied until it's reached. */}
          {historyOpen && editHistory.length > 0 && (
            <div className="absolute top-2 right-2 z-[1001] w-72 max-h-[60%] overflow-y-auto rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-lg text-[11px]">
              <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-700 sticky top-0 bg-white dark:bg-zinc-800">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">This session</span>
                <button
                  onClick={() => setHistoryOpen(false)}
                  className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {editHistory.map((line, i) => (
                <button
                  key={`${line.at}-${i}`}
                  onClick={() => {
                    if (line.undone) redoEdit();
                    else if (line.stepsBack > 0) jumpBackEdits(line.stepsBack);
                  }}
                  disabled={line.stepsBack === 0}
                  className={`flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:hover:bg-transparent ${
                    line.undone ? "text-zinc-400 line-through" : "text-zinc-700 dark:text-zinc-200"
                  }`}
                  title={
                    line.undone
                      ? "Undone — click to put it back"
                      : line.stepsBack === 0
                        ? "Where you are now"
                        : `Step back to just after this`
                  }
                >
                  <span className="flex-1 min-w-0 truncate">{line.label}</span>
                  {line.stepsBack === 0 && !line.undone && (
                    <span className="shrink-0 text-[9px] text-emerald-600 dark:text-emerald-400">now</span>
                  )}
                  <span className="shrink-0 tabular-nums text-[9px] text-zinc-400">
                    {line.at ? new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* Top-left: the split-view label, then the place search — where a
              map's search box lives everywhere else. */}
          <div className="absolute top-2 left-2 z-[1000] flex flex-col items-start gap-1.5">
            {label && (
              <div className="bg-zinc-900/80 text-white text-[11px] font-medium px-2.5 py-1 rounded-full shadow-md">
                {label}
              </div>
            )}
            {/* On the dashboard's map as well as fullscreen. Looking a locality
                up is how you check whether a record's coordinates match what
                its label says, and that question is the same size on either
                map — the pins it drops are drawn in both modes now, so there is
                nothing left that only fullscreen could show. Still not in split
                view, where two maps would race to answer one search. */}
            {mounted && !splitView && (
              <MapPlaceSearch
                getCentre={() => {
                  const map = mapRef.current;
                  if (!map) return undefined;
                  const centre = map.getCenter();
                  return { lat: centre.lat, lng: centre.lng, zoom: map.getZoom() };
                }}
                onSelect={goToPlace}
                onPreview={setPreviewPlace}
              />
            )}
          </div>
          {/* Top-right stack: what's loaded, then the basemap choice. Stacked
              in a flex column rather than each guessing the other's offset —
              the counts panel grows a line when there are records without
              coordinates, and at fixed offsets it covered the first basemap
              button whenever it did. */}
          <div className="absolute top-2 right-2 z-[1000] flex flex-col items-end gap-1.5 max-w-[85%]">
            {/* What GBIF holds for this species and how much of it is here.
                One panel, both record sets: they're two halves of the same
                answer — the ones the map can draw, and the ones only the list
                can show — and reading them as two badges made the second look
                like a warning about the first.

                Solid background (not translucent) in both themes: it sits over
                arbitrary map tiles, not a plain page background, so a tinted/
                translucent fill (as used elsewhere in the toolbar) reads with
                poor contrast in dark mode against light-colored tiles. */}
            {!loadingOccurrences &&
              ((!splitView && totalOccurrences != null) ||
                (fullscreen && (recordSetTotals?.missing ?? 0) > 0)) && (
              <div className="px-2 py-1 rounded-lg shadow-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-[11px] space-y-0.5">
                {!splitView && totalOccurrences != null && (
                  <div className="text-emerald-700 dark:text-emerald-400">
                    {isFullSample ? (
                      <>All <strong>{(georeferencedTotal ?? 0).toLocaleString()}</strong> GBIF records with coordinates loaded.</>
                    ) : (
                      <>Loaded <strong>{georeferencedLoadedCount.toLocaleString()}</strong> of <strong>{(georeferencedTotal ?? 0).toLocaleString()}</strong> GBIF records with coordinates.</>
                    )}
                    {!isFullSample && (
                      <>
                        {" "}
                        <button
                          onClick={loadMoreOverall}
                          disabled={loadingMoreOverall}
                          className="underline decoration-dotted hover:decoration-solid disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {loadingMoreOverall
                            ? "Loading…"
                            : `Click to load ${Math.min(OVERALL_LOAD_MORE_BATCH, (georeferencedTotal ?? 0) - georeferencedLoadedCount).toLocaleString()} more`}
                        </button>
                      </>
                    )}
                    {georeferencedFilteredCount < georeferencedLoadedCount && (
                      <> Showing <strong>{georeferencedFilteredCount.toLocaleString()}</strong> after filters.</>
                    )}
                  </div>
                )}
                {/* Records with no coordinates only get a line when there are
                    more to fetch. "All N loaded" was a fact with nothing to do
                    about it — they're in the table either way. */}
                {fullscreen && missingLoadedCount < (recordSetTotals?.missing ?? 0) && (
                  <div className="text-amber-700 dark:text-amber-400">
                    <>
                        Loaded <strong>{missingLoadedCount.toLocaleString()}</strong> of{" "}
                        <strong>{(recordSetTotals?.missing ?? 0).toLocaleString()}</strong> without coordinates.{" "}
                        <button
                          onClick={loadMoreMissing}
                          disabled={loadingMoreMissing}
                          className="underline decoration-dotted hover:decoration-solid disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {loadingMoreMissing
                            ? "Loading…"
                            : `Click to load ${Math.min(sampleSize, (recordSetTotals?.missing ?? 0) - missingLoadedCount).toLocaleString()} more`}
                        </button>
                    </>
                  </div>
                )}
              </div>
            )}
            {/* The basemap, on the map it paints. */}
            {!loadingOccurrences && mounted && (
              basemapOpen ? (
                <div className="flex flex-col gap-0.5 bg-white dark:bg-zinc-800 rounded-lg shadow-md border border-zinc-200 dark:border-zinc-700 p-1">
                  {(Object.entries(BASEMAP_STYLES) as [BasemapKey, (typeof BASEMAP_STYLES)[BasemapKey]][]).map(([key, opt]) => (
                    <button
                      key={key}
                      onClick={() => {
                        setBasemap(key);
                        // Choosing puts the list away: the map is what you
                        // wanted to see.
                        setBasemapOpen(false);
                      }}
                      className={`px-2 py-0.5 rounded text-left text-[10px] transition-colors ${
                        basemap === key
                          ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium"
                          : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  onClick={() => setBasemapOpen(true)}
                  title={`Basemap: ${BASEMAP_STYLES[basemap].label}. Click to change.`}
                  aria-label="Choose a basemap"
                  className="p-1.5 rounded-lg bg-white dark:bg-zinc-800 shadow-md border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  {/* The stacked-sheets mark every map uses for this. */}
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l9 5 9-5" />
                  </svg>
                </button>
              )
            )}
            {/* Under the basemap button, in the stack of things that act on the
                map rather than describe it. The crosshair-in-a-ring every map
                uses for this, and no label — a control this conventional does
                not need one. */}
            {mounted && !splitView && (
              <button
                onClick={findMe}
                disabled={locating === "asking"}
                title={
                  locating === "denied"
                    ? "Your browser wouldn't share a location"
                    : "Go to your location"
                }
                aria-label="Go to your location"
                className={`p-1.5 rounded-lg bg-white dark:bg-zinc-800 shadow-md border border-zinc-200 dark:border-zinc-700 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-60 ${
                  locating === "denied" ? "text-amber-600 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                <svg
                  className={`w-3.5 h-3.5 ${locating === "asking" ? "animate-pulse" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <circle cx="12" cy="12" r="3.5" />
                  <circle cx="12" cy="12" r="8" />
                  <path strokeLinecap="round" d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Georeferenced records — the ones GBIF has coordinates for, whether or not
  // it flags them. Counted apart from `occurrences.length`, which can also hold
  // records fetched with no coordinates at all and would otherwise make a
  // partial sample look complete.
  const georeferencedLoadedCount = useMemo(
    () => occurrences.filter(hasPosition).length,
    [occurrences]
  );
  const missingLoadedCount = useMemo(
    () => occurrences.filter((o) => o.properties.coordinateStatus === "missing").length,
    [occurrences]
  );
  const georeferencedTotal = recordSetTotals
    ? recordSetTotals.mapped + recordSetTotals.issue
    : totalOccurrences;

  // Once every GBIF record for this species is loaded (no more to page in), the
  // basis-of-record dropdown's "total" and "loaded" columns are always identical —
  // collapse them into one column rather than showing the same number twice.
  const isFullSample = georeferencedTotal == null || georeferencedTotal <= georeferencedLoadedCount;

  // What's in the Overlays dropdown, for its "N of M" badge. Context layers
  // only now: the species' own records have their own panel on the map, and
  // EOO/AOO is drawn from them there too.
  const overlayToggleValues = [
    ...(assessmentId && canViewRangeMap ? [showRange] : []),
    ...(isAohAvailable ? [showAoh] : []),
    showProtectedAreas,
    showForestLoss,
    showLossDrivers,
    showHabitat,
    showEcoregions,
    showPowoRangeOverlay,
    ...(hasIucnNativeRange ? [showIucnRangeOverlay] : []),
    ...(nativeEffortGroup ? [showSamplingEffort] : []),
  ];

  /**
   * The record layers, shown on the map rather than in a dropdown.
   *
   * These are the species' own data — GBIF's points, the assessor's own
   * coordinates, an uploaded point file, the published range — and switching
   * between them is the actual work, done while looking at the map. They used
   * to sit in Overlays alongside protected areas and habitat classes, which
   * made them one more piece of context rather than the subject.
   *
   * A function rather than a const so it can be called from renderMap without
   * caring which of the values below it are declared by then.
   */
  /**
   * EOO and AOO, and the switch that turns them on.
   *
   * In the same column as the record layers, directly under them, because
   * that's what they measure: turn the point file off and the figures follow.
   * They sat bottom-left before, diagonally opposite the toggles that decide
   * what goes into them.
   */
  const renderRangeMetrics = () => (
    <>
    {/* EOO and AOO, laid out the way GeoCAT lays them out — the tool
        an assessor will be checking these numbers against. Its switch
        comes with it: the toggle used to live in the Overlays dropdown,
        two clicks away from the figures it governs.

        The badge is the threshold the area reaches, not a category.
        Criterion B also requires at least two of (a) severe
        fragmentation or few locations, (b) continuing decline, (c)
        extreme fluctuations, and none of those come from points on a
        map — so where GeoCAT shows a green LC, this shows nothing. */}
    {!loadingOccurrences && (
      <div className="text-[11px] text-zinc-700 dark:text-zinc-200">
        <button
          onClick={() => {
            setShowRangeMetrics((v) => !v);
            // Switching them off is the end of using them, so the menu folds
            // back to its button rather than sitting open over the map.
            if (showRangeMetrics) setToolsOpen(false);
          }}
          className={`flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-[11px] transition-colors ${
            showRangeMetrics
              ? "bg-blue-600 text-white"
              : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          }`}
          title={
            "Extent of occurrence (minimum convex polygon) and area of occupancy, computed from the record layers currently switched on \u2014 GeoCAT's method, so the two can be compared directly."
          }
        >
          <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7l7-4 4 2 7-3v15l-7 3-4-2-7 3V7z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 3v15M14 5v15" />
          </svg>
          {showRangeMetrics ? "Hide EOO/AOO" : "Compute EOO/AOO"}
        </button>
        {rangeMetrics && (
          <div className="mt-2 space-y-2">
            {([
              {
                label: "Extent of Occurrence",
                areaKm2: rangeMetrics.eoo.areaKm2,
                threshold: b1Threshold(rangeMetrics.eoo.areaKm2),
                criterion: "B1",
              },
              {
                label: "Area of Occupancy",
                areaKm2: rangeMetrics.aoo.areaKm2,
                threshold: b2Threshold(rangeMetrics.aoo.areaKm2),
                criterion: "B2",
              },
            ] as const).map((metric) => (
              <div key={metric.label} className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-zinc-500 dark:text-zinc-400">{metric.label}</div>
                  <div
                    className="font-semibold tabular-nums"
                    title={`${metric.areaKm2.toLocaleString(undefined, { maximumFractionDigits: 3 })} km\u00b2`}
                  >
                    {formatAreaKm2(metric.areaKm2)}
                  </div>
                </div>
                {metric.threshold && (
                  <span
                    className="shrink-0 w-7 h-7 rounded-full grid place-items-center text-[10px] font-bold text-white"
                    style={{ background: CATEGORY_COLORS[metric.threshold] }}
                    title={`Meets criterion ${metric.criterion}'s area threshold for ${metric.threshold}. On its own that is not a listing.`}
                  >
                    {metric.threshold}
                  </span>
                )}
              </div>
            ))}
            <div className="text-[10px] text-zinc-400 leading-snug">
              AOO based on user defined cell width ({aooCellKm} km),{" "}
              <button
                onClick={() => setAooCellOpen((v) => !v)}
                className="underline text-amber-600 dark:text-amber-500 hover:text-amber-700"
              >
                change
              </button>
              {aooCellOpen && (
                <span className="flex items-center gap-1 pt-1">
                  <input
                    type="number"
                    min={0.1}
                    step={0.5}
                    value={aooCellKm}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      if (Number.isFinite(next) && next > 0) setAooCellKm(next);
                    }}
                    className="w-14 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-[10px] tabular-nums"
                  />
                  <span>km</span>
                  {aooCellKm !== 2 && (
                    <button
                      onClick={() => setAooCellKm(2)}
                      className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
                      title="2 km is the Red List standard \u2014 the only width comparable with a published assessment"
                    >
                      reset to 2 km
                    </button>
                  )}
                </span>
              )}
            </div>
            <div className="text-[10px] text-zinc-400 leading-snug">
              {rangeMetrics.aoo.cellCount.toLocaleString()} cells ·{" "}
              {rangeMetrics.eoo.pointCount.toLocaleString()} records
              {rangeMetricPoints.fromPointFile > 0 && (
                <span style={{ color: POINT_FILE_COLOR }}>
                  {" "}· {rangeMetricPoints.fromPointFile.toLocaleString()} imported
                </span>
              )}
              {rangeMetrics.ownCount > 0 && (
                <span className="text-violet-600 dark:text-violet-400">
                  {" "}· {rangeMetrics.ownCount.toLocaleString()} yours
                </span>
              )}
              {!isFullSample && <span className="text-amber-600 dark:text-amber-400"> · partial sample</span>}
            </div>
          </div>
        )}
        {showRangeMetrics && !rangeMetrics && (
          <div className="mt-1.5 text-[10px] text-zinc-400">
            No records on the map to measure.
          </div>
        )}
      </div>
    )}
    </>
  );

  /**
   * The context layers, as a panel on the map rather than a dropdown.
   *
   * They were behind a button in the toolbar, which meant every comparison —
   * does this gap sit inside a protected area, is it forest that has gone,
   * has anyone collected here at all — cost a click to open, a click to
   * toggle, and a click somewhere else to get the menu out of the way of the
   * map you were trying to read.
   */
  /**
   * What the last click landed on — the protected areas, the ecoregion — docked
   * rather than anchored where you clicked.
   *
   * Both of these draw the boundary of the thing they name, and a popup pinned
   * to the click sat on top of that boundary: you asked which park this is, and
   * the answer covered the edge you were trying to see. The highlight on the map
   * is what ties the panel to the ground, so the text doesn't have to be there
   * too.
   */
  /**
   * What you can do with a record you've clicked, drawn at the foot of its
   * tooltip.
   *
   * A click used to open gbif.org outright — one of four things you might
   * want, and the only one that leaves the page. The rest have no other way in
   * from the map: reading every field means finding the row in the table,
   * striking a record out means finding it there too, and settling which of a
   * stack of duplicate sheets is the real one had no single gesture at all.
   */
  /**
   * A record's fields as label/value pairs, in the order an assessor reads
   * them: what it is, where and when, who says so, then the caveats.
   *
   * What GBIF publishes, and nothing else: the cleaning flags and the
   * native-range check are marks on the map beside the point they concern,
   * where they can be seen without opening anything.
   */
  const pointFileByGbifId = useMemo(() => {
    const map = new Map<number, PointComparison>();
    for (const row of pointFileComparison?.rows ?? []) {
      if (row.matched) map.set(row.matched.gbifID, row);
    }
    return map;
  }, [pointFileComparison]);

  /**
   * What this dashboard has to say about a record, as one line of hover text
   * for the flag in the corner of its panel.
   *
   * A mark rather than rows of prose: that a record is questioned is worth
   * seeing at a glance, and six cleaning tests spelled out cost more of the
   * panel than the record's own fields.
   */
  const recordMarks = useCallback(
    (feature: OccurrenceFeature) => {
      const p = feature.properties;
      const marks = (p.qualityFlags ?? []).map((f) => QUALITY_FLAG_LABELS[f as QualityFlag] || f);
      if (isOutsideNativeRange(p.countryCode, effectiveNativeCountries)) {
        // Named for the source, as in the table: POWO and the Red List can
        // disagree about where a species is native.
        marks.push(
          `Outside ${nativeRangeSourceLabel} native range${p.country ? ` (recorded in ${p.country})` : ""}`
        );
      }
      return marks.length ? marks.join(" · ") : null;
    },
    [effectiveNativeCountries, nativeRangeSourceLabel]
  );

  const recordFields = useCallback(
    (
      feature: OccurrenceFeature,
      mine?: Georeference,
      inat?: InatObservation,
      // Set where the georeference editor is drawn under these fields: what
      // the assessor supplied is in the boxes there, and repeating it in the
      // table above them made the panel say everything twice.
      opts: { editorBelow?: boolean } = {}
    ) => {
      const p = feature.properties;
      const position = mine
        ? [mine.decimalLongitude, mine.decimalLatitude]
        : feature.geometry?.coordinates;
      const uncertainty = mine?.coordinateUncertaintyInMeters ?? p.coordinateUncertaintyInMeters;
      // What GBIF publishes about the record, and what this dashboard says
      // about it, kept apart. Mixed together, "Outside native range" read as
      // another field off the record rather than a call we made about it.
      const rows: { label: string; value: string; link?: boolean }[] = [];
      const notes: { label: string; value: string; flag?: boolean }[] = [];
      const text = (value: unknown) =>
        (Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value)).trim();
      const add = (label: string, value: unknown, link = false) => {
        const t = text(value);
        if (t) rows.push({ label, value: t, link });
      };

      add("Species", p.species);
      add("Basis", formatBasisOfRecord(p.basisOfRecord));
      // The assessor's own reading of the label wins over GBIF's transcription,
      // and says so — the same bargain as their coordinates.
      const myDate = assessorDates[p.gbifID];
      add("Date", myDate ? `${myDate.eventDate} · your date` : (p.eventDate ?? p.year));
      if (myDate && (p.eventDate ?? p.year)) add("Date on GBIF", p.eventDate ?? p.year);
      add("Type", p.typeStatus);
      add("Locality", p.locality || p.verbatimLocality);
      add("Country", p.country);
      // With the editor below, this table goes back to being what GBIF
      // published: its coordinates where it has any, its uncertainty, and
      // nothing about the position you supplied.
      const ownFields = opts.editorBelow && mine;
      const shownPosition = ownFields ? feature.geometry?.coordinates : position;
      const shownUncertainty = ownFields ? p.coordinateUncertaintyInMeters : uncertainty;
      if (shownPosition) {
        add("Coordinates", `${shownPosition[1].toFixed(4)}, ${shownPosition[0].toFixed(4)}`);
      }
      add(
        mine && !ownFields ? "Radius" : "GPS uncertainty",
        shownUncertainty == null
          ? null
          : shownUncertainty >= 1000
            ? `${(shownUncertainty / 1000).toFixed(1)} km`
            : `${shownUncertainty} m`
      );
      if (mine && !ownFields) {
        add("Coordinates by", "You");
        add("Method", mine.georeferenceProtocol);
        // The reasoning is where an address gets written down — the GEOLocate
        // result, the herbarium's page for the sheet — so it is the one field
        // whose links are worth following from here.
        add("Note", assessorNotes[p.gbifID]?.text ?? mine.georeferenceRemarks, true);
      }
      if (p.basisOfRecord === "PRESERVED_SPECIMEN") {
        // Two fields, not one joined pair. A record can carry a collection
        // without an institution code — GBIF names the holder through its
        // GrSciColl key instead — and joining them labelled the collection as
        // the institution: Naturalis's sheets read "Institution: Botany".
        //
        // The registry's name for the holder beats the code where we have it:
        // "Naturalis Biodiversity Center" says who has the sheet, and "K"
        // only says so to someone who already knows.
        const holder = p.institutionKey
          ? institutionNames[p.institutionKey] ?? knownInstitutionName(p.institutionKey) ?? undefined
          : undefined;
        add("Institution", holder ?? p.institutionCode);
        add("Collection", p.collectionCode);
      }
      add("Catalogue no.", p.catalogNumber);
      add("Recorded by", p.recordedBy ?? inat?.observer);
      add("Identified by", p.identifiedBy);
      add("Elevation", p.elevation ?? p.verbatimElevation);
      add("Dataset", p.datasetName);
      add("GBIF id", p.gbifID);

      /*
       * The imported point for this record, folded in rather than given a
       * panel of its own.
       *
       * Two tooltips for one specimen — GBIF's and the assessment's — made you
       * hold both in your head and diff them by eye, which is the whole task.
       * Only what differs is listed, and nothing is said at all where the two
       * agree: agreement is the expected case, and a row announcing it on
       * every matched record buries the one line that matters.
       */
      const imported = pointFileByGbifId.get(p.gbifID);
      if (imported) {
        const point = imported.point;
        const drift = imported.fromGbif;
        if (drift != null && drift >= 100) {
          notes.push({
            label: "Imported position",
            value: `${drift >= 1000 ? `${(drift / 1000).toFixed(1)} km` : `${Math.round(drift)} m`} from GBIF's`,
            flag: true,
          });
        }
        // Only a real disagreement is worth a row. The two sides spell the
        // same value differently — "PreservedSpecimen" against GBIF's
        // "PRESERVED_SPECIMEN", "J. Smith" against "J Smith" — so they're
        // compared with case, spacing and punctuation taken out.
        const same = (x: string, y: string) =>
          x.toLowerCase().replace(/[^a-z0-9]/g, "") === y.toLowerCase().replace(/[^a-z0-9]/g, "");
        const differs = (label: string, csv: unknown, gbif: unknown) => {
          const a = String(csv ?? "").trim();
          const b = String(gbif ?? "").trim();
          if (!a || same(a, b)) return;
          notes.push({ label: `Imported ${label}`, value: b ? `${a} — GBIF: ${b}` : a, flag: !!b });
        };
        differs("year", point.fields.event_year, p.year);
        differs("catalogue no.", point.fields.catalog_no, p.catalogNumber);
        differs("recorded by", point.fields.recordedby, p.recordedBy);
        differs("basis", point.fields.basisofrec, p.basisOfRecord);
      }
      return { fields: rows, notes };
    },
    [pointFileByGbifId, institutionNames, assessorDates, assessorNotes]
  );

  /**
   * The record lists under the map, and what each holds.
   *
   * Counted records, the ones set aside, and — when there is one — the
   * imported file. Three lists because they are three different judgements
   * about a record, not three filters on one table.
   */
  const countedOccurrences = useMemo(
    () => occurrences.filter((o) => !exclusions[o.properties.gbifID]),
    [occurrences, exclusions]
  );
  const excludedOccurrences = useMemo(
    () => occurrences.filter((o) => exclusions[o.properties.gbifID]),
    [occurrences, exclusions]
  );
  const listTabs = useMemo(() => {
    const tabs: { key: "gbif" | "excluded" | "file" | "nearby"; label: string; count: number; title: string; dot?: string }[] = [
      {
        key: "gbif",
        label: "GBIF records",
        count: countedOccurrences.length,
        title: "The records being counted",
      },
    ];
    if (nearbyAt) {
      tabs.push({
        key: "nearby",
        label: "Nearby threatened species",
        count: 0,
        title: "Threatened species with GBIF records around the point you asked about",
      });
    }
    if (excludedOccurrences.length > 0) {
      tabs.push({
        key: "excluded",
        label: "Excluded GBIF records",
        count: excludedOccurrences.length,
        title: "Records you've set aside, with the reason you gave — and a way to put them back",
      });
    }
    if (pointFile && pointFileComparison) {
      tabs.push({
        key: "file",
        label: "Imported records",
        count: pointFile.points.length,
        title: `The rows of ${pointFile.fileName}, as imported`,
        dot: POINT_FILE_COLOR,
      });
    }
    return tabs;
  }, [countedOccurrences, excludedOccurrences, pointFile, pointFileComparison, nearbyAt]);

  // A tab that empties — the last excluded record put back, the file removed —
  // takes its list with it, so the reader is left on the one that's still there.
  useEffect(() => {
    if (!listTabs.some((t) => t.key === listTab)) setListTab("gbif");
    else if (nearbyAt && fullscreen && listTab !== "nearby" && !nearbyTabSeen.current) setListTab("nearby");
    nearbyTabSeen.current = !!nearbyAt;
  }, [listTabs, listTab, nearbyAt, fullscreen]);

  useEffect(() => {
    setConfirmPutAllBack(false);
  }, [listTab]);

  /**
   * The record menu opened by right-clicking a row, at the pointer.
   *
   * The same buttons the map panel carries: a row and a point are the same
   * record, and what you can do with one you can do with the other. The left
   * click is spoken for — it shows the record on the map — so this takes the
   * right, where a menu is expected anyway.
   */
  const [rowMenu, setRowMenu] = useState<{ gbifID: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!rowMenu) return;
    const dismiss = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-row-menu]")) return;
      setRowMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRowMenu(null);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [rowMenu]);

  /**
   * The records set aside as duplicates, by the record each was kept in
   * favour of.
   *
   * Read back out of the exclusions rather than stored: a duplicate is an
   * excluded record whose reason names the one kept, so there is nothing to
   * keep in step and nothing to migrate.
   */
  const duplicatesByPrimary = useMemo(
    () => groupDuplicates(occurrences, (o) => o.properties.gbifID, exclusions),
    [occurrences, exclusions]
  );

  /**
   * Keeps one record of a group and sets the others aside as duplicates of it.
   *
   * The one gesture behind all three ways of saying it: dragging a row onto
   * another, "keep this one of N" on a point with records stacked under it,
   * and handing primacy to a record that was itself a duplicate. Each is the
   * same statement — this is the sheet, those are copies of it.
   *
   * Whatever the record kept was before, it is counted afterwards. Without
   * that, using "keep this one" on a record that was itself a duplicate left
   * every record in the group excluded and the whole locality vanished from
   * the list. And where it was a duplicate, the group it belonged to comes
   * with it: its siblings are re-pointed at it rather than left pointing at a
   * record that is now a duplicate itself.
   */
  const keepRecord = useCallback(
    (primaryGbifID: number, alsoDuplicates: number[] = []) => {
      const next = keepRecordIn({
        exclusions,
        gbifIDs: occurrences.map((o) => o.properties.gbifID),
        primaryGbifID,
        alsoDuplicates,
        stamp: { excludedAt: new Date().toISOString(), excludedBy: accountEmail || undefined },
      });
      const setAside = Object.values(next).filter(
        (e) => duplicateOf(e.justification) === primaryGbifID
      ).length;
      commitEdits(
        { exclusions: next },
        `keep GBIF ${primaryGbifID}, set ${setAside} aside as duplicate${setAside === 1 ? "" : "s"}`
      );
    },
    [exclusions, occurrences, accountEmail, commitEdits]
  );

  const markDuplicates = useCallback(
    (gbifIDs: number[], primaryGbifID: number) => keepRecord(primaryGbifID, gbifIDs),
    [keepRecord]
  );

  /**
   * Saving the work to a file, and reading one back.
   *
   * The edits live in this browser and nowhere else, which is the right
   * default for one person's interpretation and a bad single point of failure:
   * clearing site data takes a fortnight of georeferencing with it and no undo
   * reaches across a reload. This is the way out — one file, written by hand,
   * read back by hand.
   */
  const saveWork = useCallback(() => {
    const savedAt = new Date().toISOString();
    const backup = buildEditsBackup({
      speciesKey,
      scientificName,
      savedAt,
      georeferences,
      exclusions,
      dates: assessorDates,
      notes: assessorNotes,
      pointFile,
      pins: pinnedPlaces,
    });
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = backupFileName(scientificName, savedAt);
    link.click();
    URL.revokeObjectURL(url);
    setLastSavedAt(savedAt);
  }, [speciesKey, scientificName, georeferences, exclusions, assessorDates, assessorNotes, pointFile, pinnedPlaces]);

  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  /** How many records the assessor has touched. */
  const editCount = useMemo(
    () =>
      new Set([
        ...Object.keys(georeferences),
        ...Object.keys(exclusions),
        ...Object.keys(assessorDates),
        ...Object.keys(assessorNotes),
      ]).size,
    [georeferences, exclusions, assessorDates, assessorNotes]
  );
  /**
   * Everything the file would carry, not just the edited records.
   *
   * A morning spent pinning the places a locality description might mean, or
   * an imported point file, is work in exactly the sense this button exists
   * for — and both were leaving it greyed out.
   */
  const savableSummary = useMemo(() => {
    const parts: string[] = [];
    if (editCount > 0) parts.push(`${editCount} record${editCount === 1 ? "" : "s"} edited`);
    if (pinnedPlaces.length > 0)
      parts.push(`${pinnedPlaces.length} pin${pinnedPlaces.length === 1 ? "" : "s"}`);
    if (pointFile) parts.push("an imported point file");
    return parts.join(", ");
  }, [editCount, pinnedPlaces.length, pointFile]);
  const hasWorkToSave = savableSummary !== "";
  const [pendingRestore, setPendingRestore] = useState<EditsBackup | null>(null);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const readRestoreFile = useCallback(
    async (file: File) => {
      const result = readEditsBackup(await file.text(), speciesKey);
      if ("error" in result) {
        setGeorefMessage({ kind: "error", text: result.error });
        return;
      }
      setPendingRestore(result.backup);
    },
    [speciesKey]
  );

  /**
   * Puts a file back, as one undoable edit.
   *
   * Restoring is itself an edit — if the file turns out to be the wrong one,
   * or older than you thought, undo takes you back to what was here. The pins
   * ride in the same commit as the rest, since they are part of the document
   * now. The point file is still set separately: it isn't in the document the
   * history is kept over, so undo doesn't reach it. The dialog counts it
   * before it asks, so nothing goes quietly.
   */
  const applyRestore = useCallback(
    (backup: EditsBackup) => {
      commitEdits(
        {
          georeferences: backup.georeferences,
          exclusions: backup.exclusions,
          dates: backup.dates,
          notes: backup.notes ?? {},
          pins: backup.pins ?? [],
        },
        `restore the work saved ${backup.savedAt.slice(0, 10)}`
      );
      if (backup.pointFile) importPointFile(backup.pointFile);
      setPendingRestore(null);
    },
    [commitEdits, importPointFile]
  );

  /** Whether the "put all back" dialog is up. */
  const [confirmPutAllBack, setConfirmPutAllBack] = useState(false);
  const putAllBack = useCallback(() => {
    const count = Object.keys(exclusions).length;
    if (count === 0) return;
    commitEdits({ exclusions: {} }, `put all ${count} record${count === 1 ? "" : "s"} back`);
  }, [exclusions, commitEdits]);

  /**
   * A record the table should scroll to and pick out.
   *
   * Cleared before it's set so that asking twice takes you back to it: the
   * table only scrolls when the id it's given changes.
   */
  const [focusRecord, setFocusRecord] = useState<number | null>(null);
  /**
   * A date the assessor read off the label, and taking it back.
   *
   * Held with the georeferences and the exclusions, so one undo covers it and
   * one export carries it: it is the same kind of thing — the assessor's own
   * reading of a specimen, kept apart from what GBIF published.
   */
  const saveAssessorDate = useCallback(
    (feature: OccurrenceFeature, eventDate: string, note?: string) => {
      const gbifID = feature.properties.gbifID;
      commitEdits(
        {
          dates: {
            ...assessorDates,
            [gbifID]: {
              gbifID,
              eventDate,
              remarks: note || undefined,
              addedAt: new Date().toISOString(),
              addedBy: accountEmail || undefined,
            },
          },
        },
        `date GBIF ${gbifID} as ${eventDate}`
      );
    },
    [assessorDates, accountEmail, commitEdits]
  );

  /**
   * The reasoning about a locality, saved whether or not it has been placed.
   *
   * Often it is written first — "two villages of this name; the collector's
   * route says the eastern one" is how you arrive at the coordinates — and
   * sometimes it is all there is to say: a locality nobody can place is still
   * worth recording as one, with why.
   *
   * Copied onto the georeference as its remarks where there is one, so an
   * exported row carries the reasoning to whoever reads it outside this
   * dashboard. This store is the copy that gets edited.
   */
  const saveAssessorNote = useCallback(
    (feature: OccurrenceFeature, text: string) => {
      const gbifID = feature.properties.gbifID;
      const note = text.trim();
      const nextNotes = { ...assessorNotes };
      if (note) {
        nextNotes[gbifID] = {
          gbifID,
          text: note,
          addedAt: new Date().toISOString(),
          addedBy: accountEmail || undefined,
        };
      } else {
        delete nextNotes[gbifID];
      }
      const mine = georeferences[gbifID];
      commitEdits(
        {
          notes: nextNotes,
          ...(mine
            ? { georeferences: { ...georeferences, [gbifID]: { ...mine, georeferenceRemarks: note || undefined } } }
            : {}),
        },
        note ? `note how you read GBIF ${gbifID}` : `drop your note on GBIF ${gbifID}`
      );
    },
    [assessorNotes, georeferences, accountEmail, commitEdits]
  );

  const clearAssessorDate = useCallback(
    (feature: OccurrenceFeature) => {
      const next = { ...assessorDates };
      delete next[feature.properties.gbifID];
      commitEdits({ dates: next }, `drop your date for GBIF ${feature.properties.gbifID}`);
    },
    [assessorDates, commitEdits]
  );

  const showRecordInTable = useCallback(
    (gbifID: number) => {
      // On whichever list holds it. A record you've set aside is in the other
      // tab, and sending the table to a row that isn't in it does nothing.
      setListTab(exclusions[gbifID] ? "excluded" : "gbif");
      setFocusRecord(null);
      window.setTimeout(() => setFocusRecord(gbifID), 0);
    },
    [exclusions]
  );

  /** Clicking a row shows that record on the map, if it has anywhere to be. */
  const showRecordOnMap = useCallback(
    (feature: OccurrenceFeature) => {
      cancelHoverClear();
      setGroupIndex(0);
      setHoverSource("map");
      setHoveredFeature(feature);
      setHoveredPanel("main");
      pinTooltip();
      // A record off the edge of the current view gets the view widened to
      // reach it, rather than the panel opening for a point that isn't there.
      // Widened rather than moved: what you were looking at is what you're
      // comparing this record against, so it stays on screen — and the zoom
      // only ever goes out, never in.
      const map = mapRef.current?.getMap();
      const mine = georeferences[feature.properties.gbifID];
      const position = mine
        ? ([mine.decimalLongitude, mine.decimalLatitude] as [number, number])
        : feature.geometry?.coordinates;
      if (!map || !position) return;
      const bounds = map.getBounds();
      if (bounds.contains(position)) return;
      map.fitBounds(bounds.extend(position), {
        padding: 60,
        maxZoom: map.getZoom(),
        duration: 700,
      });
    },
    [cancelHoverClear, pinTooltip, georeferences]
  );

  /**
   * The counted records with a position, as IUCN point rows.
   *
   * The assessor's own georeference wins over GBIF's coordinate, which is the
   * point of having made it — and the row says so, since the file otherwise
   * gives no sign of which points a person placed.
   */
  const exportablePoints = useMemo(
    () =>
      includedOccurrences.flatMap((o) => {
        const p = o.properties;
        const mine = georeferences[p.gbifID];
        const position = mine
          ? ([mine.decimalLongitude, mine.decimalLatitude] as [number, number])
          : o.geometry?.coordinates;
        if (!position) return [];
        return [{
          gbifID: p.gbifID,
          species: p.species,
          latitude: position[1],
          longitude: position[0],
          // Their date if they gave one: a point file's event_year is the
          // year the specimen was collected, not the year GBIF managed to
          // transcribe.
          year: assessorDates[p.gbifID] ? null : p.year,
          eventDate: assessorDates[p.gbifID]?.eventDate ?? p.eventDate,
          basisOfRecord: p.basisOfRecord,
          catalogNumber: p.catalogNumber,
          recordedBy: p.recordedBy,
          recordNumber: (p as Record<string, unknown>).recordNumber as string | undefined,
          georeferenced: !!mine,
        }];
      }),
    [includedOccurrences, georeferences, assessorDates]
  );

  /**
   * Open before writing, so the file's one un-derivable column gets filled.
   * Everything else in it comes from the records; the compiler is a person.
   */
  const [compilerPrompt, setCompilerPrompt] = useState(false);

  const saveAsPointFile = useCallback((compiler: string) => {
    if (exportablePoints.length === 0) return;
    const csv = buildIucnPointFileCsv(exportablePoints, {
      compiler,
      yearCompiled: new Date().getFullYear(),
    });
    const name = (scientificName || "records").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}_IUCN_point_file.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [exportablePoints, scientificName]);

  const renderRecordActions = (
    gbifID: number,
    opts: { showOnMap?: boolean; showInTable?: boolean } = {}
  ) => {
    const record = occurrencesByGbifId.get(gbifID);
    const excluded = !!exclusions[gbifID];
    // Keyed off the record's own coordinates rather than the clicked feature's:
    // MapLibre hands back geometry that has been through its tile encoding, and
    // the rounding no longer lands on the key the grouping was built with.
    const mine = georeferences[gbifID];
    const position = mine
      ? [mine.decimalLongitude, mine.decimalLatitude]
      : record?.geometry?.coordinates;
    const key = position ? `${position[0].toFixed(4)},${position[1].toFixed(4)}` : null;
    const stacked = (key && coLocatedByPosition.get(key)) || [];
    const others = stacked.filter((o) => o.properties.gbifID !== gbifID);
    /**
     * The other records carrying this collector's number.
     *
     * The same gathering split between herbaria is the commonest duplicate
     * there is, and the sheets rarely agree on anything else: the institutions
     * differ by definition, the collector's name is written five ways, and
     * only some of them were ever georeferenced. The number on the label is
     * what they do agree on.
     *
     * Records already set aside for a reason of their own are left out — that
     * reason is someone's judgement, and this shouldn't overwrite it.
     */
    const recordNo = normaliseCatalogNumber(record?.properties.recordNumber);
    const sameNumber = recordNo
      ? occurrences.filter((o) => {
          const id = o.properties.gbifID;
          if (id === gbifID) return false;
          if (normaliseCatalogNumber(o.properties.recordNumber) !== recordNo) return false;
          const reason = exclusions[id]?.justification;
          return !reason || duplicateOf(reason) != null;
        })
      : [];
    const close = () => closeTooltip();
    return (
      <>
        {/* Only from a row's menu: on the map panel you are already looking
            at the point this would take you to. */}
        {opts.showOnMap && record && (
          <button
            onClick={() => {
              setRowMenu(null);
              showRecordOnMap(record);
            }}
            title={
              position
                ? "Open this record's panel on the map, widening the view to reach it if it's off the edge"
                : "GBIF gave this record no coordinates, so there is nowhere on the map to show it"
            }
            disabled={!position}
            className="flex w-full items-center gap-1.5 px-1 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.5 2V6L9 4m0 16l6-2m-6 2V4m6 14l5.5 2V4L15 6m0 12V6m0 0L9 4" />
            </svg>
            Show on map
          </button>
        )}
                {/* Only on a record that is already a duplicate of another:
                    this is how the group changes its mind about which sheet is
                    the one to keep. */}
                {duplicateOf(exclusions[gbifID]?.justification) != null && (
                  <button
                    onClick={() => {
                      setRowMenu(null);
                      keepRecord(gbifID);
                    }}
                    title="Count this record instead, and set the others in its group aside as duplicates of it"
                    className="flex w-full items-start gap-1.5 px-1 py-1 rounded text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg className="w-3 h-3 mt-0.5 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l2.4 5.3 5.6.6-4.2 3.9 1.2 5.7L12 15.6 6.99 18.5l1.2-5.7L4 8.9l5.6-.6z" />
                    </svg>
                    Make this the record kept
                  </button>
                )}
                {/* The mirror of the row menu's "Show on map": the panel says
                    where a record is, the table says everything else about it.
                    Not offered from a row's own menu, where you are already on
                    the row it would scroll to. */}
                {/* What else has been assessed around this record. On the
                    record's own panel because that is what a click opens, and
                    a click is the gesture for "tell me about this one" — the
                    right-click answers about the ground, which is a different
                    question and was the wrong home for this. */}
                {record && position && (
                  <button
                    onClick={() => {
                      setRowMenu(null);
                      close();
                      setNearbyAt({
                        // The record's own coordinates, so the radius is
                        // centred on the collection locality itself.
                        lng: position[0],
                        lat: position[1],
                        recordName: String(record.properties.species || "this record"),
                      });
                      setNearbyRadiusKm(NEARBY_RADIUS_DEFAULT);
                      setNearbyPicked([]);
                    }}
                    title="Threatened and Near Threatened species with GBIF records around this one, and the threats their assessments cite"
                    className="flex w-full items-center gap-1.5 px-1 py-1 rounded text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <circle cx="12" cy="12" r="3" />
                      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
                    </svg>
                    Find nearby threatened species
                  </button>
                )}
                {opts.showInTable && fullscreen && (
                  <button
                    onClick={() => showRecordInTable(gbifID)}
                    title="Scroll the table to this record and pick it out"
                    className="flex w-full items-center gap-1.5 px-1 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <rect x="3" y="4" width="18" height="16" rx="1.5" />
                      <path strokeLinecap="round" d="M3 9h18M9 9v11" />
                    </svg>
                    Show in table
                  </button>
                )}
                <button
                  onClick={() => {
                    window.open(`https://www.gbif.org/occurrence/${gbifID}`, "_blank", "noopener,noreferrer");
                    close();
                  }}
                  className="flex w-full items-center gap-1.5 px-1 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14 3h7v7M10 14L21 3M21 14v7h-7M3 10V3h7" />
                  </svg>
                  Open on GBIF
                </button>
                <button
                  onClick={() => {
                    if (excluded) includeAgain([gbifID]);
                    else setPendingExclusion([gbifID]);
                    close();
                  }}
                  className="flex w-full items-center gap-1.5 px-1 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={excluded ? "M5 13l4 4L19 7" : "M6 18L18 6M6 6l12 12"} />
                  </svg>
                  {excluded ? "Put this record back" : "Exclude this record"}
                </button>
                {/* Not offered on a record that is already a duplicate: its
                    menu has "Make this the record kept", which says the same
                    thing about the group it belongs to, and two ways to say it
                    on one menu only invited the question of how they differed. */}
                {others.length > 0 && duplicateOf(exclusions[gbifID]?.justification) == null && (
                  <button
                    onClick={() => {
                      keepRecord(gbifID, others.map((o) => o.properties.gbifID));
                      close();
                    }}
                    title="Everything else at this exact position is struck out as a duplicate of this one, with the reason recorded and undoable"
                    className="flex w-full items-start gap-1.5 px-1 py-1 rounded text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg className="w-3 h-3 mt-0.5 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <rect x="9" y="9" width="12" height="12" rx="2" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15V5a2 2 0 012-2h10" />
                    </svg>
                    Keep this one of {stacked.length} at this point, mark the rest as duplicates
                  </button>
                )}
                {sameNumber.length > 0 && duplicateOf(exclusions[gbifID]?.justification) == null && (
                  <button
                    onClick={() => {
                      keepRecord(gbifID, sameNumber.map((o) => o.properties.gbifID));
                      close();
                    }}
                    title={`Every other loaded record carrying record no. ${record?.properties.recordNumber} is struck out as a duplicate of this one, with the reason recorded and undoable`}
                    className="flex w-full items-start gap-1.5 px-1 py-1 rounded text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg className="w-3 h-3 mt-0.5 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h10" />
                    </svg>
                    Keep this one of {sameNumber.length + 1} with record no.{" "}
                    {record?.properties.recordNumber}, mark the rest as duplicates
                  </button>
                )}
      </>
    );
  };

  const renderClickInfo = (panelId: string) => {
    const areasHere =
      pointQuery?.panelId === panelId && pointQuery.kind === "areas" ? pointQuery : null;
    const eco =
      showEcoregions && selectedEcoregion?.panelId === panelId ? selectedEcoregion : null;
    const hab = showHabitat && clickedHabitat?.panelId === panelId ? clickedHabitat : null;
    const forest =
      (showLossDrivers || showForestLoss) && clickedForest?.panelId === panelId
        ? clickedForest
        : null;
    if (!areasHere && !eco && !hab && !forest) return null;

    // The extent of everything being highlighted, so the callout can sit
    // outside it. Habitat has no shape — it's a raster read at a point — so on
    // its own it anchors to the click.
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
    const at =
      areasHere ?? eco ?? forest ?? { lng: pointQuery?.lng ?? 0, lat: pointQuery?.lat ?? 0 };

    return (
      <MapShapeCallout bounds={bounds} lng={at.lng} lat={at.lat}>
      <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-md border border-zinc-200 dark:border-zinc-700 px-2 py-1.5 text-[11px] text-zinc-700 dark:text-zinc-200 space-y-1.5">
        {areasHere && (
          <div>
            <div className="flex items-baseline gap-1 pb-0.5">
              <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Protected areas
              </span>
              <button
                onClick={() => setPointQuery(null)}
                title="Close"
                className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
      <div className="space-y-1">
        {/* Says up front that there is more than one, before
            you have to infer it from the length of the list. */}
        {areasHere.areas.length > 1 && (
          <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
            {areasHere.areas.length} overlapping designations here
          </div>
        )}
        {areasHere.areas.map((area, index) => (
          <div
            key={area.sitePid}
            onMouseEnter={() => setPointQuery((prev) => (prev ? { ...prev, highlight: index } : prev))}
            className={`-mx-1 px-1 py-0.5 rounded flex gap-1.5 ${
              index === areasHere.highlight ? "bg-zinc-100 dark:bg-zinc-800" : ""
            }`}
          >
            {/* The swatch is what ties this row to its outline
                on the map. Only drawn when there's more than
                one site — a single colour keyed to nothing is
                just decoration. */}
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
            </div>
          </div>
        ))}
      </div>
          </div>
        )}
        {hab && (
          <div className={areasHere ? "pt-1.5 border-t border-zinc-100 dark:border-zinc-700" : ""}>
            <div className="flex items-baseline gap-1 pb-0.5">
              <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Habitat
              </span>
              <button
                onClick={() => setClickedHabitat(null)}
                title="Close"
                className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
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
          <div className={areasHere || hab ? "pt-1.5 border-t border-zinc-100 dark:border-zinc-700" : ""}>
            <div className="flex items-baseline gap-1 pb-0.5">
              <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Forest
              </span>
              <button
                onClick={() => setClickedForest(null)}
                title="Close"
                className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {forest.loading ? (
              <span className="text-zinc-400">Reading the rasters…</span>
            ) : forest.point == null || !hasForestAnswer(forest.point) ? (
              <span className="text-zinc-400">No tree cover loss recorded here.</span>
            ) : (
              <div className="space-y-0.5">
                {/* The class, and nothing else about it. What each driver
                    covers is a sentence long and lives in the legend, a
                    hover away on the same swatch — repeating it here made a
                    two-line answer into a paragraph. */}
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
                    forest.point.canopyPercent != null
                      ? `${forest.point.canopyPercent}% canopy 2000`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {/* The three qualifiers as one line.
                    All of them still need saying — a driver is the dominant
                    one for a 1 km cell, the point query answers for ground
                    the layers leave blank, and the loss it was measured from
                    is 30 m so a spot can sit in a cell without having lost
                    anything. As three sentences they were most of the card,
                    and a caveat that long stops being read. */}
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
          <div className={areasHere || hab || forest ? "pt-1.5 border-t border-zinc-100 dark:border-zinc-700" : ""}>
            <div className="flex items-baseline gap-1 pb-0.5">
              <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Ecoregion
              </span>
              <button
                onClick={() => setSelectedEcoregion(null)}
                title="Close"
                className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
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
      </div>
      </MapShapeCallout>
    );
  };

  const renderOverlayLayers = () => (
    <div className="flex flex-col py-1 w-[20rem]">
      <>
      {assessmentId && canViewRangeMap && (
        <>
          <label
            className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]"
            title="Toggle IUCN range map overlay. Range maps are indicative only and may not reflect current distributions."
          >
            <input
              type="checkbox"
              checked={showRange}
              onChange={() => setShowRange((v) => !v)}
              className="w-3 h-3 rounded accent-rose-500 shrink-0"
            />
            <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 flex items-center gap-1 truncate">
              IUCN range map
              {rangeLoading && (
                <svg className="w-3 h-3 animate-spin text-zinc-400 shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
            </span>
            {showRange && rangeCategories.length > 1 && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRangeCategoriesExpanded(!rangeCategoriesExpanded); }}
                title="Show the range map's own categories"
                className="shrink-0 text-zinc-400 hover:text-zinc-600"
              >
                {rangeCategoriesExpanded ? "▴" : "▾"}
              </button>
            )}
          </label>
          {showRange && rangeNotFound && (
            <span className="block px-2 pb-0.5 text-[10px] text-zinc-400 italic">Not yet available</span>
          )}
          {showRange && !rangeNotFound && rangeSimplification && (
            <span
              className="flex items-center gap-1 px-2 pb-0.5 text-[10px] text-amber-600 dark:text-amber-400 cursor-help"
              title={`This range map has been simplified at ${rangeSimplification.tolerance}° (~${Math.round(rangeSimplification.tolerance * 111)}km) to reduce file size. Fine-scale boundary details may be lost.`}
            >
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              Simplified to {rangeSimplification.tolerance}°
            </span>
          )}
          {showRange && rangeCategoriesExpanded && rangeCategories.length > 0 && (
            <div className="flex flex-col gap-0.5 px-2 pb-0.5 pl-6">
              {rangeCategories.map((cat) => {
                const isVisible = !visibleCategories || visibleCategories.has(cat.key);
                return (
                  <button
                    key={cat.key}
                    onClick={() => {
                      setVisibleCategories((prev) => {
                        const next = new Set(prev ?? rangeCategories.map((c) => c.key));
                        if (next.has(cat.key)) next.delete(cat.key);
                        else next.add(cat.key);
                        return next;
                      });
                    }}
                    className={`flex items-center gap-1 py-0.5 rounded text-[10px] text-left transition-colors ${
                      isVisible ? "text-zinc-700 dark:text-zinc-300" : "text-zinc-400 dark:text-zinc-500 line-through"
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ background: cat.color, opacity: isVisible ? 1 : 0.3 }}
                    />
                    {cat.label} ({cat.count})
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
      {isAohAvailable && (
        <label
          className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]"
          title="Toggle Area of Habitat overlay"
        >
          <input
            type="checkbox"
            checked={showAoh}
            onChange={() => setShowAoh((v) => !v)}
            className="w-3 h-3 rounded accent-green-500 shrink-0"
          />
          <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 flex items-center gap-1">
            AOH
            {aohLoading && (
              <svg className="w-3 h-3 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            )}
          </span>
        </label>
      )}
      <label
        className="flex items-center gap-2 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]"
        title="Overlay the World Database on Protected Areas (WDPA) — UNEP-WCMC & IUCN. With it on, clicking the map names the areas covering that point and links each to Protected Planet."
      >
        <input
          type="checkbox"
          checked={showProtectedAreas}
          onChange={() => {
            setShowProtectedAreas((v) => !v);
            setPointQuery(null);
            // A fresh attempt: the service may have come back since.
            setProtectedAreasDown(false);
          }}
          className="w-3 h-3 rounded accent-emerald-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">Protected areas</span>
        {/* Said where the layer is switched on, because the blank map it
            leaves behind reads as "nothing here is protected". */}
        {protectedAreasDown && (
          <span
            title="UNEP-WCMC's map service isn't answering, so this layer can't be drawn and clicking the map won't name any sites. A blank map here doesn't mean the area is unprotected. Their outage, not yours — try again later."
            className="shrink-0 cursor-help text-[10px] text-amber-600 dark:text-amber-500"
          >
            source unavailable
          </span>
        )}
        <SourceCitation
          href="https://www.protectedplanet.net"
          cite="WDPA"
          title="World Database on Protected Areas — UNEP-WCMC & IUCN, via Protected Planet"
        />
      </label>
      <label
        className="flex items-center gap-2 px-2 py-0.5 text-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
        title={`${FOREST_LOSS_SOURCE_NOTE} Showing ${lossYears[0]}\u2013${lossYears[1]}; narrow the years in the legend. ${FOREST_LOSS_CAVEAT} ${FOREST_LOSS_THRESHOLD_NOTE} Click the map with this on to read the loss year and canopy cover at a point.`}
      >
        <input
          type="checkbox"
          checked={showForestLoss}
          onChange={() => setShowForestLoss((v) => !v)}
          className="w-3 h-3 rounded accent-emerald-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">Tree cover loss</span>
        <SourceCitation
          href={FOREST_LOSS_DATASET_URL}
          cite="Hansen et al. 2013"
          title="High-Resolution Global Maps of 21st-Century Forest Cover Change — Hansen et al. 2013, Science. The Global Forest Change dataset these tiles are drawn from."
        />
      </label>
      {/* Next to the loss layer, because it answers the question that one
          raises: a cleared block inside a range means something different if
          it is a soy field, a logging rotation or a fire. */}
      <label
        className="flex items-center gap-2 px-2 py-0.5 text-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
        title={`Why the trees went, at 1 km: Sims et al. (2025), via Global Nature Watch. Loss ${FOREST_LOSS_DRIVERS_FIRST_YEAR}\u2013${FOREST_LOSS_DRIVERS_LAST_YEAR}, cut at ${DRIVERS_CANOPY_THRESHOLD}% canopy cover. ${FOREST_LOSS_DRIVERS_CAVEAT}`}
      >
        <input
          type="checkbox"
          checked={showLossDrivers}
          onChange={() => setShowLossDrivers((v) => !v)}
          className="w-3 h-3 rounded accent-emerald-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">Tree cover loss by dominant driver</span>
        <SourceCitation
          href={FOREST_LOSS_DRIVERS_PAPER_URL}
          cite="Sims et al. 2025"
          title="Global drivers of forest loss at 1 km resolution — Sims et al. 2025, Environmental Research Letters."
        />
      </label>
      <label
        className="flex items-center gap-2 px-2 py-0.5 text-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
        title="IUCN habitat classes from Jung et al. (2020), the 100m map behind Area of Habitat. Coloured by level 1; click the map for the exact class."
      >
        <input
          type="checkbox"
          checked={showHabitat}
          onChange={() => {
            setShowHabitat((v) => !v);
            setPointQuery(null);
          }}
          className="w-3 h-3 rounded accent-emerald-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">IUCN habitat types</span>
        <SourceCitation
          href="https://zenodo.org/records/4058819"
          cite="Jung et al. 2020"
          title="A global map of terrestrial habitat types — Jung et al. 2020. The 100 m map behind Area of Habitat."
        />
      </label>
      <label
        className="flex items-center gap-2 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]"
        title="Terrestrial ecoregions and biomes (Dinerstein et al. 2017) — the ecosystem a record sits in. Right-click anywhere to name it."
      >
        <input
          type="checkbox"
          checked={showEcoregions}
          onChange={() => setShowEcoregions((v) => !v)}
          className="w-3 h-3 rounded accent-emerald-600 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 flex items-center gap-1">
          Terrestrial ecoregions
          {ecoregionsLoading && (
            <svg className="w-3 h-3 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
        </span>
        {ecoregionsFailed && (
          <span className="text-[10px] text-red-500 shrink-0">unavailable</span>
        )}
        <SourceCitation
          href={ECOREGIONS_PAPER_URL}
          cite="Dinerstein et al. 2017"
          title="An Ecoregion-Based Approach to Protecting Half the Terrestrial Realm — Dinerstein et al. 2017, BioScience. The RESOLVE Ecoregions 2017 layer, CC BY 4.0."
        />
      </label>
      <label
        className={`flex items-center gap-2 px-2 py-0.5 text-[11px] ${
          nativeCountriesWcvp && nativeCountriesWcvp.length > 0
            ? "hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
            : "opacity-50 cursor-not-allowed"
        }`}
        title="Shade the countries Kew's POWO/World Checklist of Vascular Plants considers this species native to"
      >
        <input
          type="checkbox"
          checked={showPowoRangeOverlay}
          disabled={!(nativeCountriesWcvp && nativeCountriesWcvp.length > 0)}
          onChange={() => setShowPowoRangeOverlay((v) => !v)}
          className="w-3 h-3 rounded accent-blue-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">POWO native range</span>
        {wcvpPowoId && (
          <SourceCitation
            href={`https://powo.science.kew.org/taxon/urn:lsid:ipni.org:names:${wcvpPowoId}`}
            cite="POWO"
            title="This species on Plants of the World Online — Kew's World Checklist of Vascular Plants, which is where these countries come from."
          />
        )}
      </label>
{hasIucnNativeRange && (
      <label
        className="flex items-center gap-2 px-2 py-0.5 text-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
        title="Shade the countries this species' IUCN Red List assessment lists as native range"
      >
        <input
          type="checkbox"
          checked={showIucnRangeOverlay}
          onChange={() => setShowIucnRangeOverlay((v) => !v)}
          className="w-3 h-3 rounded accent-amber-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">IUCN native countries</span>
        {sisTaxonId && assessmentId && (
          <SourceCitation
            href={`https://www.iucnredlist.org/species/${sisTaxonId}/${assessmentId}`}
            cite="IUCN Red List"
            title="This species' Red List assessment, which is where these countries are listed."
          />
        )}
      </label>
      )}
      {/* Withheld entirely where the dataset has no matching
          taxon — see lib/mapping/sampling-effort.ts. A fish
          judged against seabird effort is worse than no layer. */}
      {nativeEffortGroup && (
        <div>
          <label
            className="flex items-center gap-2 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]"
            title="GBIF records per 10 km cell (El-Gabbas 2026). Shows whether a gap in the records is genuinely empty or merely unvisited — the caveat behind a record-based AOO."
          >
            <input
              type="checkbox"
              checked={showSamplingEffort}
              onChange={() => setShowSamplingEffort((v) => !v)}
              className="w-3 h-3 rounded accent-yellow-500 shrink-0"
            />
            <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 flex items-center gap-1">
              GBIF sampling effort
              {effortLoading && (
                <svg className="w-3 h-3 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
            </span>
            <SourceCitation
              href={EFFORT_PAPER_URL}
              cite="El-Gabbas 2026"
              title="Global sampling effort of GBIF biodiversity data — El-Gabbas 2026, Diversity and Distributions."
            />
          </label>
          {/* One taxon at a time, not several: two effort
              surfaces drawn over each other give a colour that
              can't be read back to either. */}
          {showSamplingEffort && (
            <select
              value={effortGroup ?? nativeEffortGroup}
              onChange={(e) => setEffortGroup(e.target.value as EffortGroup)}
              className="mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-1.5 py-1 text-[11px] text-zinc-700 dark:text-zinc-200"
              title="Which taxon's collecting effort to show. All taxa is dominated by birds and casual observation, so the matching group is usually the honest comparison."
            >
              {EFFORT_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {EFFORT_GROUP_LABELS[g]}
                  {g === nativeEffortGroup ? " (this species)" : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      </>
    </div>
  );

  const renderRecordLayers = (label: string | null) => (
    // Wide enough for the GBIF row to carry its name, its colour ramp and its
    // count on one line, which is what that row is: one layer, described.
    <div className="flex flex-col bg-white dark:bg-zinc-800 rounded-lg shadow-md border border-zinc-200 dark:border-zinc-700 py-1 w-64">
      <div className="px-2 pb-0.5 text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        Records
      </div>
      {/* The assessor's own layers first, GBIF's last. These are the ones you
          are deciding about; GBIF's points are the ground they're decided
          against, and they carry the most explanation, so they anchor the
          bottom rather than pushing everything else down. */}
      {fullscreen && visibleGeoreferences.length > 0 && (
        <label className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]">
          <input
            type="checkbox"
            checked={showMyGeoreferences}
            onChange={() => setShowMyGeoreferences((v) => !v)}
            className="w-3 h-3 rounded accent-violet-600 shrink-0"
          />
          {/* The colour the markers are actually drawn in, so the row is a key
              rather than a label. */}
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0 border-[1.5px] border-white shadow-sm"
            style={{ background: "#7c3aed" }}
          />
          <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 truncate">
            Your georeferences
          </span>
          <span className="tabular-nums text-[10px] text-zinc-400">
            {visibleGeoreferences.length.toLocaleString()}
          </span>
        </label>
      )}
      {pinnedPlaces.length > 0 && (
        <label className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]">
          <input
            type="checkbox"
            checked={showPins}
            onChange={() => setShowPins((v) => !v)}
            className="w-3 h-3 rounded accent-zinc-700 shrink-0"
          />
          {/* The glyph they're drawn as, so the row names what's on the map. */}
          <svg className="w-3 h-3 shrink-0 text-zinc-900 dark:text-zinc-200" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z" />
          </svg>
          <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 truncate">
            Pinned localities
          </span>
          <span className="tabular-nums text-[10px] text-zinc-400">
            {pinnedPlaces.length.toLocaleString()}
          </span>
        </label>
      )}
      {fullscreen && pointFile && (
        <label className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]">
          <input
            type="checkbox"
            checked={showPointFile}
            onChange={() => setShowPointFile((v) => !v)}
            className="w-3 h-3 rounded accent-blue-600 shrink-0"
          />
          {/* The shape they're drawn in, so the legend names what's on the
              map rather than what colour it is. */}
          <span className="w-2 h-2 rotate-45 shrink-0" style={{ background: POINT_FILE_COLOR }} />
          <span
            title={pointFile.fileName}
            className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 truncate"
          >
            Imported records
          </span>
          <span className="tabular-nums text-[10px] text-zinc-400">
            {pointFile.points.length.toLocaleString()}
          </span>
        </label>
      )}
      <label className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]">
        <input
          type="checkbox"
          checked={showGbif}
          onChange={() => setShowGbif((v) => !v)}
          className="w-3 h-3 rounded accent-blue-500 shrink-0"
        />
        {/* One circle, in the green the recent end of the scale draws — the
            points themselves run a ramp, and the ramp is on the right of this
            row where there is room to label both ends. This is here so every
            row in the panel is led by the thing it draws. */}
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: "#4ade80", border: "1.5px solid #16a34a" }}
        />
        <span className="shrink-0 text-zinc-700 dark:text-zinc-200">GBIF points</span>
        {/* What to do with this layer, behind one icon: the two colourings and
            the split. They were a link under the row and a card of their own
            below the panel, which spent three lines of a legend on controls
            rather than on the key. */}
        {!label && assessmentYear && (
          <span ref={gbifOptionsRef} className="relative shrink-0">
            <button
              onClick={(e) => {
                // Inside the row's <label>, so a plain click would land on the
                // checkbox and take the layer off the map.
                e.preventDefault();
                e.stopPropagation();
                setGbifOptionsOpen((v) => !v);
              }}
              title="How these points are coloured, and split view"
              aria-label="GBIF points options"
              className="block text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4a4 4 0 0 0-5-5l2.9 2.9-2.1 2.1-2.9-2.9a4 4 0 0 0 5 5z"
                />
              </svg>
            </button>
            {gbifOptionsOpen && (
              <span
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                className="absolute left-0 bottom-5 z-[1002] block w-max rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
              >
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setColorByDate(!colorByDate);
                    setGbifOptionsOpen(false);
                  }}
                  className="block w-full rounded px-1.5 py-1 text-left text-[11px] text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  {colorByDate ? "Colour by assessment date" : "Colour by date"}
                </button>
                {!splitView && (
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!splitDate && assessmentDate) setSplitDate(assessmentDate.split("T")[0]);
                      setSplitView(true);
                      setGbifOptionsOpen(false);
                    }}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <rect x="1" y="2" width="14" height="12" rx="1.5" />
                      <line x1="8" y1="2" x2="8" y2="14" />
                    </svg>
                    Split view
                  </button>
                )}
              </span>
            )}
          </span>
        )}
        {/* The colour key on the same row as the name it belongs to, which is
            what the panel was widened for. */}
        {showGbif && !label && colorByDate && (
          <span className="flex items-center gap-0.5 min-w-0 text-[9px] tabular-nums text-zinc-400">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: dateToColor(minDateNum).fill, border: `1.5px solid ${dateToColor(minDateNum).stroke}` }}
            />
            {minDateLabel}
            <span>→</span>
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: dateToColor(maxDateNum).fill, border: `1.5px solid ${dateToColor(maxDateNum).stroke}` }}
            />
            {maxDateLabel}
          </span>
        )}
        <span className="ml-auto tabular-nums text-[10px] text-zinc-400">
          {(mappedPositionedCount - struckOutCount).toLocaleString()}
        </span>
      </label>
        {/* Struck-out records get their own row rather than being folded into
          the one above: the count that matters is what's still counted, and
          the greyed points need a key of their own to be read as deliberate. */}
      {showGbif && struckOutCount > 0 && (
        <label className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]">
          <input
            type="checkbox"
            checked={showExcludedOnMap}
            onChange={() => setShowExcludedOnMap((v) => !v)}
            className="w-3 h-3 rounded accent-zinc-400 shrink-0"
          />
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0 border-[1.5px]"
            style={{ background: "transparent", borderColor: "#6b7280", opacity: 0.85 }}
          />
          <span className="flex-1 min-w-0 text-zinc-500 dark:text-zinc-400 truncate">Excluded points</span>
          <span className="tabular-nums text-[10px] text-zinc-400">
            {struckOutCount.toLocaleString()}
          </span>
        </label>
      )}
      {/* What the GBIF points' colours mean, under the row that draws them —
          for every species, assessed or not.
          An assessed species used to have this in a bar of its own below the
          panel, which made two legends about one layer: the row that draws the
          points here, the key to their colours there. The colouring is a
          property of that row, so it belongs under it, and the toggle that
          switches between the two schemes belongs with the key it changes. */}
      {/* Only in the before/after scheme: the date ramp has its own key inline
          on the row above, where both ends can be labelled. */}
      {showGbif && !label && assessmentYear && !colorByDate && (
        <div className="px-2 pb-0.5 pl-6 text-[10px] text-zinc-500 dark:text-zinc-400">
          {(
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-gray-400 border-[1.5px] border-gray-500" />
                ≤{assessmentDate?.split("T")[0] ?? assessmentYear}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-green-400 border-[1.5px] border-green-600" />
                After {assessmentDate?.split("T")[0] ?? assessmentYear}
              </span>
            </div>
          )}
        </div>
      )}
      {/* The neighbours currently drawn — last, under GBIF's own points.
          Sitting above them it read as a heading over the whole legend, so
          "Records / Recorded nearby / <a species> / GBIF points" left it
          genuinely unclear which rows the heading spoke for. These are the
          outermost layer here — not this species, not this map's own data — so
          the bottom is where they belong. */}
      {nearbyPicked.length > 0 && (
        <div className="px-2 pt-1 pb-0.5 border-t border-zinc-100 dark:border-zinc-700">
          {/* Rolled up when the list gets long: opening six neighbours puts six
              rows in a legend that also has to show the map's own layers. */}
          <button
            onClick={() => setNearbyLegendOpen((v) => !v)}
            className="flex w-full items-center gap-1 pb-0.5 text-[9px] uppercase tracking-wide text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
          >
            <svg
              className={`w-2.5 h-2.5 shrink-0 transition-transform ${nearbyLegendOpen ? "rotate-90" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Other species nearby
            <span className="ml-auto tabular-nums">{nearbyPicked.length}</span>
          </button>
          {nearbyLegendOpen && nearbyPicked.map((p) => (
            <label
              key={p.key}
              className="flex items-start gap-1.5 px-0 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px] rounded"
            >
              <input
                type="checkbox"
                checked={!nearbyHidden.has(p.key)}
                onChange={() =>
                  setNearbyHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(p.key)) next.delete(p.key);
                    else next.add(p.key);
                    return next;
                  })
                }
                className="w-3 h-3 rounded shrink-0 mt-0.5"
                style={{ accentColor: nearbyColors[p.key] }}
              />
              <span
                className="shrink-0 w-2 h-2 rounded-full border border-white mt-1"
                style={{ backgroundColor: nearbyColors[p.key] }}
              />
              <span className="min-w-0 flex-1 text-zinc-700 dark:text-zinc-200">
                <span className="italic">{p.name}</span>
                {p.commonName && <span className="text-zinc-400"> ({p.commonName})</span>}
              </span>
              <span className="shrink-0 tabular-nums text-zinc-400">
                {nearbyPoints[p.key] ? nearbyPoints[p.key].points.length : "…"}
              </span>
              {/* The checkbox hides a layer; this takes it off the map for
                  good. Two different things, and a legend that only offered the
                  first left the list growing with every species opened. */}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleNearbyPicked(p);
                }}
                title={`Remove ${p.name} from the map`}
                className="shrink-0 text-zinc-300 hover:text-red-600 dark:text-zinc-600 dark:hover:text-red-400"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5h6v2m-7 0v12h8V7" />
                </svg>
              </button>
            </label>
          ))}
        </div>
      )}
    </div>
  );

  /**
   * The nearby-species panel, under the map and the iNat column both.
   *
   * Beside the map it squeezed the very thing it describes — in fullscreen the
   * map column is already half the page, and a panel in it left the map 238px
   * wide. Underneath, across the full width, the map keeps its size and the
   * table gets room for its columns.
   */
  const NEARBY_PANEL = nearbyAt ? (
    <div className="w-full">
      <NearbySpeciesPanel
                    lat={nearbyAt.lat}
                    lng={nearbyAt.lng}
                    recordName={nearbyAt.recordName}
                    excludeGbifKey={speciesKey}
                    radiusKm={nearbyRadiusKm}
                    onRadiusChange={setNearbyRadiusKm}
                    picked={nearbyPicked.map((p) => ({
                      key: p.key,
                      color: nearbyColors[p.key],
                      drawn: nearbyPoints[p.key]
                        ? { shown: nearbyPoints[p.key].points.length, total: nearbyPoints[p.key].total }
                        : null,
                    }))}
                    onTogglePick={toggleNearbyPicked}
                    onClose={() => {
                      setNearbyAt(null);
                      setNearbyPicked([]);
                    }}
                  />
    </div>
  ) : null;

  return (
    <div
      className={
        fullscreen
          ? "flex flex-col h-full min-h-0 bg-white dark:bg-zinc-900"
          : "bg-zinc-50 dark:bg-zinc-800/50"
      }
    >
      {pointFileOpen && (
        <PointFileDialog
          imported={pointFile}
          comparison={pointFileComparison}
          onImported={importPointFile}
          onRemove={removePointFile}
          scientificName={scientificName}
          onClose={() => setPointFileOpen(false)}
        />
      )}
      {compilerPrompt && (
        <CompilerDialog
          count={exportablePoints.length}
          scientificName={scientificName}
          onSave={(compiler) => {
            setCompilerPrompt(false);
            saveAsPointFile(compiler);
          }}
          onClose={() => setCompilerPrompt(false)}
        />
      )}
      {pendingExclusion && (
        <ExclusionDialog
          gbifIDs={pendingExclusion}
          {...(pendingExclusion.length === 1 && occurrencesByGbifId.get(pendingExclusion[0])
            ? recordFields(
                occurrencesByGbifId.get(pendingExclusion[0])!,
                georeferences[pendingExclusion[0]],
                inatPhotosByGbifId.get(pendingExclusion[0])
              )
            : {})}
          existingJustification={
            pendingExclusion.length === 1 ? exclusions[pendingExclusion[0]]?.justification : undefined
          }
          onConfirm={confirmExclusion}
          onCancel={() => setPendingExclusion(null)}
        />
      )}
      {/* The modal is the fallback for a viewport with nowhere to dock; the
          docked panel is rendered beside the map further down. */}
      <div className={fullscreen ? "p-2 flex-1 min-h-0 flex flex-col" : "p-2"}>
        <div className={`flex flex-col gap-2${fullscreen ? " flex-1 min-h-0" : ""}`}>
          {/* Filter dropdowns + sample-size summary, merged into one row (summary on
              the left) — sit above the map itself, not a separate header bar */}
          <div className="p-2 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700">
            {/* `relative` here is what the dropdowns anchor to below lg — see
                the `lg:relative` on each control's wrapper. */}
            <div className="relative flex flex-wrap items-center gap-2">
              {/* Basis of Record — dropdown checklist */}
              <div className="lg:relative" ref={filtersRef}>
                <button
                  onClick={() => setFiltersOpen(!filtersOpen)}
                  title="Basis of Record — which kinds of evidence to include"
                  aria-label="Basis of Record"
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                    filtersOpen
                      ? "bg-zinc-100 dark:bg-zinc-800 border-zinc-400 dark:border-zinc-500"
                      : "border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  } text-zinc-700 dark:text-zinc-300`}
                >
                  <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  <span className="hidden lg:inline">Basis of Record</span>
                  {!loadingBreakdown && (
                    <span className="hidden lg:inline text-[10px] text-zinc-400 tabular-nums">
                      Selected {pillDefs.filter(p => checkedTypes[p.key]).length} of {pillDefs.length}
                    </span>
                  )}
                  <svg className={`w-3 h-3 text-zinc-400 transition-transform ${filtersOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {filtersOpen && !loadingBreakdown && (
                  <div className="absolute left-0 right-0 lg:right-auto top-full mt-1 z-50 lg:w-[25rem] max-w-[calc(100vw-1.5rem)] bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-lg py-1">
                    <div className="flex items-center gap-2 px-3 pb-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                      <span className="flex-1 min-w-0 flex items-center gap-2">
                        <button
                          onClick={() => setCheckedTypes((prev) => {
                            const next = { ...prev };
                            for (const p of pillDefs) next[p.key] = true;
                            return next;
                          })}
                          className="hover:text-zinc-600 dark:hover:text-zinc-300 hover:underline"
                        >
                          Select all
                        </button>
                        <span className="text-zinc-300 dark:text-zinc-600">·</span>
                        <button
                          onClick={() => setCheckedTypes((prev) => {
                            const next = { ...prev };
                            for (const p of pillDefs) next[p.key] = false;
                            return next;
                          })}
                          className="hover:text-zinc-600 dark:hover:text-zinc-300 hover:underline"
                        >
                          Deselect all
                        </button>
                      </span>
                      {!isFullSample && <span className="w-14 text-right shrink-0">Total</span>}
                      <span className="w-16 text-right shrink-0">{isFullSample ? "Total" : "Loaded"}</span>
                      <span className="w-12 text-right shrink-0">Cleaned</span>
                    </div>
                    {pillDefs.map((pill) => {
                      const active = checkedTypes[pill.key];
                      const loadedShown = basisLoadedShownCounts[pill.key] ?? { loaded: 0, shown: 0 };
                      const canLoadMore = pill.count > loadedShown.loaded;
                      const isLoadingMore = loadingMoreCategory === pill.key;
                      const loadMoreCount = Math.min(BASIS_OF_RECORD_LOAD_MORE_BATCH, pill.count - loadedShown.loaded);
                      return (
                        <div key={pill.key}>
                        <label
                          className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer text-xs"
                          title={`${pill.count.toLocaleString()} total across all of GBIF. ${loadedShown.loaded.toLocaleString()} loaded in your current sample. ${loadedShown.shown.toLocaleString()} of those also pass your other active filters (cleaned).`}
                        >
                          <input
                            type="checkbox"
                            checked={active}
                            onChange={() => toggleType(pill.key)}
                            className="w-3 h-3 rounded accent-emerald-500 shrink-0"
                          />
                          <span className={`flex-1 min-w-0 truncate ${active ? "text-zinc-700 dark:text-zinc-200" : "text-zinc-400 dark:text-zinc-500"}`}>
                            {pill.label}
                          </span>
                          {!isFullSample && (
                            <span className="w-14 text-right tabular-nums shrink-0 text-zinc-400 dark:text-zinc-500">
                              {pill.count.toLocaleString()}
                            </span>
                          )}
                          <span className="w-16 text-right tabular-nums shrink-0 text-zinc-400 dark:text-zinc-500">
                            {(isFullSample ? pill.count : loadedShown.loaded).toLocaleString()}
                          </span>
                          <span className={`w-12 text-right tabular-nums shrink-0 ${active ? "text-emerald-500 dark:text-emerald-400" : "text-zinc-400 dark:text-zinc-500"}`}>
                            {loadedShown.shown.toLocaleString()}
                          </span>
                        </label>
                        {canLoadMore && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              loadMoreForCategory(pill.key);
                            }}
                            disabled={loadingMoreCategory != null}
                            className="block pl-8 pr-3 -mt-1 pb-1.5 text-[10px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {isLoadingMore ? "(loading…)" : `(load ${loadMoreCount.toLocaleString()} more)`}
                          </button>
                        )}
                        </div>
                      );
                    })}
                    {(() => {
                      const totalCount = pillDefs.reduce((sum, p) => sum + p.count, 0);
                      const totalLoaded = pillDefs.reduce((sum, p) => sum + (basisLoadedShownCounts[p.key]?.loaded ?? 0), 0);
                      const totalShown = pillDefs.reduce((sum, p) => sum + (basisLoadedShownCounts[p.key]?.shown ?? 0), 0);
                      return (
                        <div className="flex items-center gap-2 px-3 py-1.5 mt-1 border-t border-zinc-100 dark:border-zinc-800 text-xs font-medium">
                          <span className="w-3 shrink-0" />
                          <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">Total</span>
                          {!isFullSample && (
                            <span className="w-14 text-right tabular-nums shrink-0 text-zinc-500 dark:text-zinc-400">
                              {totalCount.toLocaleString()}
                            </span>
                          )}
                          <span className="w-12 text-right tabular-nums shrink-0 text-zinc-500 dark:text-zinc-400">
                            {(isFullSample ? totalCount : totalLoaded).toLocaleString()}
                          </span>
                          <span className="w-12 text-right tabular-nums shrink-0 text-emerald-600 dark:text-emerald-400">
                            {totalShown.toLocaleString()}
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
              {/* Separator */}
              <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-0.5 hidden sm:block" />
              {/* Coordinate cleaning — dropdown: max GPS uncertainty + one checkbox per check */}
              <div className="lg:relative" ref={cleaningFilterRef}>
                <button
                  onClick={() => setCleaningFilterOpen(!cleaningFilterOpen)}
                  aria-label="Coordinate cleaning"
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                    cleaningFilterOpen
                      ? "bg-zinc-100 dark:bg-zinc-800 border-zinc-400 dark:border-zinc-500"
                      : "border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  } text-zinc-700 dark:text-zinc-300`}
                  title="Filter by GPS uncertainty and hide records flagged by coordinate-cleaning checks (e.g. zero coordinates, GBIF headquarters, duplicates)"
                >
                  {/* A crosshair, not the funnel Basis of Record uses: with the
                      labels hidden below lg the two would be indistinguishable. */}
                  <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="7" strokeLinecap="round" strokeLinejoin="round" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                  </svg>
                  <span className="hidden lg:inline">Coordinate cleaning</span>
                  <span className="hidden lg:inline text-[10px] text-zinc-400 tabular-nums">
                    {/* Counts every row in the dropdown, GBIF's own verdict included */}
                    Applied {flagDefs.filter((d) => appliedChecks[d.key]).length + (hideGbifFlagged ? 1 : 0) + (hasNativeRangeData && nativeRangeOnly ? 1 : 0)} of {flagDefs.length + 1 + (hasNativeRangeData ? 1 : 0)}
                    {maxUncertainty != null && ` · ≤ ${formatUncertainty(maxUncertainty)}`}
                  </span>
                  <svg className={`w-3 h-3 text-zinc-400 transition-transform ${cleaningFilterOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {cleaningFilterOpen && (
                  <div className="absolute left-0 right-0 lg:right-auto top-full mt-1 z-50 lg:w-80 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-lg py-1">
                    <div className="flex items-center px-3 pb-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                      <button
                        onClick={() => {
                          setAppliedChecks((prev) => {
                            const next = { ...prev };
                            for (const d of flagDefs) next[d.key] = true;
                            return next;
                          });
                          setHideGbifFlagged(true);
                          if (hasNativeRangeData) setNativeRangeOnly(true);
                        }}
                        className="hover:text-zinc-600 dark:hover:text-zinc-300 hover:underline"
                      >
                        Select all
                      </button>
                      <span className="text-zinc-300 dark:text-zinc-600 mx-2">·</span>
                      <button
                        onClick={() => {
                          setAppliedChecks((prev) => {
                            const next = { ...prev };
                            for (const d of flagDefs) next[d.key] = false;
                            return next;
                          });
                          setHideGbifFlagged(false);
                          if (hasNativeRangeData) setNativeRangeOnly(false);
                        }}
                        className="hover:text-zinc-600 dark:hover:text-zinc-300 hover:underline"
                      >
                        Deselect all
                      </button>
                    </div>
                    {flagDefs.map((def) => {
                      const active = appliedChecks[def.key]; // checked = currently hides matching records
                      const impact = flagShownCounts[def.key] ?? 0; // how many would flip visibility if toggled
                      const hasImpact = impact > 0;
                      return (
                        <label
                          key={def.key}
                          className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer text-xs"
                          title={def.description}
                        >
                          <input
                            type="checkbox"
                            checked={active}
                            onChange={() => toggleCheck(def.key)}
                            className="w-3 h-3 rounded accent-emerald-500 shrink-0"
                          />
                          <span className={`flex-1 min-w-0 ${hasImpact ? "text-zinc-700 dark:text-zinc-200" : "text-zinc-400 dark:text-zinc-500"}`}>
                            {def.label}
                          </span>
                          {def.source && (
                            <a
                              href={def.source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Reference data source: ${def.source.label}`}
                              onClick={(e) => {
                                // Prevent the enclosing <label>'s native click-forwarding from
                                // toggling the checkbox, without also losing the link's own
                                // navigation (preventDefault suppresses both, so re-trigger it
                                // manually).
                                e.preventDefault();
                                e.stopPropagation();
                                window.open(def.source!.url, "_blank", "noopener,noreferrer");
                              }}
                              className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
                            >
                              <FaInfoCircle className="w-3 h-3" />
                            </a>
                          )}
                          <span className={`ml-auto tabular-nums shrink-0 text-[11px] font-medium ${hasImpact ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-300 dark:text-zinc-600"}`}>
                            {!hasImpact
                              ? "0 records"
                              : active
                                ? `${impact.toLocaleString()} record${impact === 1 ? "" : "s"} hidden`
                                : `Hide ${impact.toLocaleString()} record${impact === 1 ? "" : "s"}`}
                          </span>
                        </label>
                      );
                    })}
                    {/* GBIF's own verdict on a record's coordinates, sitting
                        with the checks rather than apart from them: it's the
                        same kind of judgement — this point looks wrong — just
                        made upstream. Flagged records are always fetched, so
                        this only ever hides or shows what's already loaded. */}
                    <label
                      className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
                        gbifFlaggedCounts.loaded > 0
                          ? "hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer"
                          : "opacity-50 cursor-not-allowed"
                      }`}
                      title="GBIF flags these coordinates as suspect — zero coordinates, a country that doesn't match the position, swapped or negated latitude/longitude. Shown in amber on the map when not hidden."
                    >
                      <input
                        type="checkbox"
                        checked={hideGbifFlagged}
                        disabled={gbifFlaggedCounts.loaded === 0}
                        onChange={() => setHideGbifFlagged((v) => !v)}
                        className="w-3 h-3 rounded accent-emerald-500 shrink-0"
                      />
                      <span className={`flex-1 min-w-0 ${gbifFlaggedCounts.shown > 0 ? "text-zinc-700 dark:text-zinc-200" : "text-zinc-400 dark:text-zinc-500"}`}>
                        Flagged by GBIF
                      </span>
                      <a
                        href="https://techdocs.gbif.org/en/openapi/"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Reference: GBIF's own geospatial occurrence issues"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          window.open("https://techdocs.gbif.org/en/openapi/", "_blank", "noopener,noreferrer");
                        }}
                        className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
                      >
                        <FaInfoCircle className="w-3 h-3" />
                      </a>
                      <span className={`ml-auto tabular-nums shrink-0 text-[11px] font-medium ${gbifFlaggedCounts.shown > 0 ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-300 dark:text-zinc-600"}`}>
                        {gbifFlaggedCounts.shown === 0
                          ? "0 records"
                          : hideGbifFlagged
                            ? `${gbifFlaggedCounts.shown.toLocaleString()} record${gbifFlaggedCounts.shown === 1 ? "" : "s"} hidden`
                            : `Hide ${gbifFlaggedCounts.shown.toLocaleString()} record${gbifFlaggedCounts.shown === 1 ? "" : "s"}`}
                      </span>
                    </label>
                    {hasNativeRangeData && (
                      <>
                        <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                        <label
                          className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer text-xs"
                          title={
                            nativeRangeSource === "wcvp"
                              ? "Hide occurrences reported in a country outside this species' native range, per Kew's World Checklist of Vascular Plants / Plants of the World Online (POWO). Records with no reported country can't be checked."
                              : "Hide occurrences reported in a country outside this species' native range, per its IUCN Red List assessment (e.g. cultivated botanical-garden specimens). Records with no reported country can't be checked."
                          }
                        >
                          <input
                            type="checkbox"
                            checked={nativeRangeOnly}
                            onChange={() => setNativeRangeOnly((v) => !v)}
                            className="w-3 h-3 rounded accent-emerald-500 shrink-0"
                          />
                          <span className={`flex-1 min-w-0 ${nativeRangeOnly ? "text-zinc-700 dark:text-zinc-200" : "text-zinc-400 dark:text-zinc-500"}`}>
                            Native range only
                          </span>
                          {/* Source picker — only when BOTH sources have real data for this
                              species, since they can genuinely disagree (issue #82 follow-up:
                              "we need the powo one for plants too and user can choose") */}
                          {hasBothNativeRangeSources && (
                            <div className="flex items-center rounded border border-zinc-300 dark:border-zinc-600 overflow-hidden text-[10px] shrink-0">
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setNativeRangeSource("wcvp");
                                }}
                                title="Native range per Kew's World Checklist of Vascular Plants (POWO)"
                                className={`px-1.5 py-0.5 transition-colors ${
                                  nativeRangeSource === "wcvp"
                                    ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100 font-medium"
                                    : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                                }`}
                              >
                                POWO
                              </button>
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setNativeRangeSource("redlist");
                                }}
                                title="Native range per the IUCN Red List assessment's locations"
                                className={`px-1.5 py-0.5 transition-colors border-l border-zinc-300 dark:border-zinc-600 ${
                                  nativeRangeSource === "redlist"
                                    ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100 font-medium"
                                    : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                                }`}
                              >
                                IUCN
                              </button>
                            </div>
                          )}
                          <span className={`ml-auto tabular-nums shrink-0 text-[11px] font-medium ${nativeRangeHiddenCount > 0 ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-300 dark:text-zinc-600"}`}>
                            {nativeRangeHiddenCount === 0
                              ? "0 records"
                              : nativeRangeOnly
                                ? `${nativeRangeHiddenCount.toLocaleString()} record${nativeRangeHiddenCount === 1 ? "" : "s"} hidden`
                                : `Hide ${nativeRangeHiddenCount.toLocaleString()} record${nativeRangeHiddenCount === 1 ? "" : "s"}`}
                          </span>
                        </label>
                        {loadingWcvpRange && isVascularPlantTaxonGroup(taxonGroup) && (
                          <div className="px-3 pb-1 text-[10px] text-zinc-400">Checking POWO…</div>
                        )}
                      </>
                    )}
                    <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                    <div className="flex items-center gap-2 px-3 py-1.5 text-xs" title="Only show records with a GPS uncertainty at or below this radius">
                      <span className="w-3 shrink-0" />
                      <span className="text-zinc-700 dark:text-zinc-200">Max GPS uncertainty</span>
                      {customUncertaintyMode ? (
                        <span className="ml-auto flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            autoFocus
                            value={customUncertaintyInput}
                            placeholder="meters"
                            onChange={(e) => {
                              const raw = e.target.value;
                              setCustomUncertaintyInput(raw);
                              const n = raw === "" ? null : Math.max(0, parseInt(raw));
                              setMaxUncertainty(n != null && !Number.isNaN(n) ? n : null);
                            }}
                            className="w-16 text-xs px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
                          />
                          <span className="text-zinc-400">m</span>
                          <button
                            onClick={() => {
                              setCustomUncertaintyMode(false);
                              setCustomUncertaintyInput("");
                              setMaxUncertainty(null);
                            }}
                            title="Back to preset options"
                            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </span>
                      ) : (
                        <select
                          value={maxUncertainty ?? ""}
                          onChange={(e) => {
                            if (e.target.value === "custom") {
                              setCustomUncertaintyMode(true);
                              setCustomUncertaintyInput("");
                              setMaxUncertainty(null);
                            } else {
                              setMaxUncertainty(e.target.value ? parseInt(e.target.value) : null);
                            }
                          }}
                          className="ml-auto text-xs px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
                        >
                          {UNCERTAINTY_OPTIONS.map((opt) => (
                            <option key={opt.label} value={opt.value ?? ""}>
                              {opt.label}
                            </option>
                          ))}
                          <option value="custom">Custom…</option>
                        </select>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {/* Date range — client-side slider filtering the currently loaded sample
                  to an eventDate window. The track spans whatever the filters above
                  allow through (dateFilterableOccurrences), not the species' full GBIF
                  history — the "Load N more" button next to the map's "Loaded X of Y"
                  badge is what extends that span. GBIF's search API has no server-side
                  date sort/filter of its own (see api/occurrences/route.ts), so this
                  operates entirely on what's already been paged in. */}
              <div className="lg:relative" ref={dateRangeRef}>
                <button
                  onClick={() => setDateRangeOpen(!dateRangeOpen)}
                  aria-label="Date range"
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                    dateRangeOpen
                      ? "bg-zinc-100 dark:bg-zinc-800 border-zinc-400 dark:border-zinc-500"
                      : "border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  } text-zinc-700 dark:text-zinc-300`}
                  title="Filter the loaded sample to an observation date range"
                >
                  <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="3" y="4" width="18" height="17" rx="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9h18M8 2v4M16 2v4" />
                  </svg>
                  <span className="hidden lg:inline">Date range</span>
                  <span className="hidden lg:inline text-[10px] text-zinc-400 tabular-nums">
                    {dateRangeFrom == null && dateRangeTo == null
                      ? "All dates"
                      : `${dateRangeFrom ?? sliderMinDate} – ${dateRangeTo ?? sliderMaxDate}`}
                  </span>
                  <svg className={`w-3 h-3 text-zinc-400 transition-transform ${dateRangeOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {dateRangeOpen && (
                  <div className="absolute left-0 right-0 lg:right-auto top-full mt-1 z-50 lg:w-80 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-lg p-3">
                    {sliderMinDate === sliderMaxDate ? (
                      <p className="text-xs text-zinc-400 dark:text-zinc-500">Not enough dated records loaded to filter by range.</p>
                    ) : (
                      (() => {
                        const totalDays = Math.max(1, Math.round((new Date(sliderMaxDate).getTime() - new Date(sliderMinDate).getTime()) / 86400000));
                        const fromDays = dateRangeFrom != null
                          ? Math.round((new Date(dateRangeFrom).getTime() - new Date(sliderMinDate).getTime()) / 86400000)
                          : 0;
                        const toDays = dateRangeTo != null
                          ? Math.round((new Date(dateRangeTo).getTime() - new Date(sliderMinDate).getTime()) / 86400000)
                          : totalDays;
                        const dayOffsetToDate = (days: number) => {
                          const d = new Date(sliderMinDate);
                          d.setDate(d.getDate() + days);
                          return d.toISOString().slice(0, 10);
                        };
                        const pct = (days: number) => Math.max(0, Math.min(100, (days / totalDays) * 100));

                        // Assessment markers, positioned against this same track's day
                        // offsets. Most assessments predate the currently-loaded GBIF
                        // window (GBIF's own paging is recency-biased — see the comment
                        // on the outer wrapper), so "before"/"after" the visible track
                        // are the common case, not an edge case — collapse those into a
                        // single count badge at the relevant edge rather than a pile of
                        // off-track dots.
                        const markerDays = assessmentMarkers.map((m) => ({
                          ...m,
                          days: Math.round((new Date(m.date).getTime() - new Date(sliderMinDate).getTime()) / 86400000),
                        }));
                        const inRangeMarkers = markerDays.filter((m) => m.days >= 0 && m.days <= totalDays);
                        const beforeMarkers = markerDays.filter((m) => m.days < 0);
                        const afterMarkers = markerDays.filter((m) => m.days > totalDays);
                        const markerLabel = (m: (typeof markerDays)[number]) =>
                          `${m.date}${m.category ? ` — ${m.category}${m.criteria ? ` (${m.criteria})` : ""}` : ""}${m.isCurrent ? " (current)" : ""}`;
                        const titleFor = (list: typeof markerDays) => list.map(markerLabel).join("\n");

                        // Snap a handle onto a nearby in-range assessment marker (within
                        // ~1.5% of the track) so it's easy to trim exactly to "everything
                        // since this assessment" rather than fighting day-by-day precision.
                        // Returns the marker itself (not just its day offset) so callers can
                        // use its exact date string — going back through dayOffsetToDate's
                        // UTC-parsed-diff/local-reconstructed round trip can drift by a day.
                        const snapThresholdDays = Math.max(1, Math.round(totalDays * 0.015));
                        const snapToMarker = (days: number) => {
                          let closest: (typeof inRangeMarkers)[number] | null = null;
                          let closestDist = Infinity;
                          for (const m of inRangeMarkers) {
                            const dist = Math.abs(m.days - days);
                            if (dist <= snapThresholdDays && dist < closestDist) {
                              closest = m;
                              closestDist = dist;
                            }
                          }
                          return closest;
                        };

                        return (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300">
                              <span className="font-medium">{dateRangeFrom ?? sliderMinDate}</span>
                              <span className="text-zinc-400">to</span>
                              <span className="font-medium">{dateRangeTo ?? sliderMaxDate}</span>
                            </div>
                            {/* Timeline: assessment markers above a single track with two
                                overlapping trim handles — see the .dual-range-thumb rules
                                in globals.css for how the inputs stack without one
                                swallowing the other's clicks. Markers and track share the
                                same relative coordinate space so their % positions line up. */}
                            <div className={`relative ${assessmentMarkers.length > 0 ? "pt-4" : ""}`}>
                              {assessmentMarkers.length > 0 && (
                                <div className="absolute inset-x-0 top-0 h-4">
                                  {inRangeMarkers.map((m) => {
                                    const color = m.category ? CATEGORY_COLORS[m.category] : null;
                                    const solidText = m.category === "EX" || m.category === "EW";
                                    return (
                                      <div
                                        key={m.date}
                                        className="absolute bottom-0"
                                        style={{ left: `${pct(m.days)}%`, transform: "translateX(-50%)" }}
                                        title={`Assessed ${markerLabel(m)}`}
                                      >
                                        {color ? (
                                          <span
                                            className={`block px-1 rounded-sm text-[8px] leading-[11px] font-semibold whitespace-nowrap ${
                                              m.isCurrent ? "ring-1 ring-offset-1 ring-zinc-400 dark:ring-zinc-500 dark:ring-offset-zinc-900" : ""
                                            }`}
                                            style={
                                              solidText
                                                ? { backgroundColor: color, color: "#fff" }
                                                : { backgroundColor: `${color}20`, color }
                                            }
                                          >
                                            {m.category}
                                          </span>
                                        ) : (
                                          <div className={`w-1.5 h-1.5 rounded-full mx-auto ${m.isCurrent ? "bg-amber-500" : "bg-amber-400/70 dark:bg-amber-500/60"}`} />
                                        )}
                                        <div className={`w-px h-1 mx-auto ${m.isCurrent ? "bg-amber-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
                                      </div>
                                    );
                                  })}
                                  {beforeMarkers.length > 0 && (
                                    <div
                                      className="absolute bottom-0 left-0 text-[9px] leading-none text-amber-600 dark:text-amber-400 cursor-default"
                                      title={`Assessed before ${sliderMinDate}:\n${titleFor(beforeMarkers)}`}
                                    >
                                      ‹{beforeMarkers.length}
                                    </div>
                                  )}
                                  {afterMarkers.length > 0 && (
                                    <div
                                      className="absolute bottom-0 right-0 text-[9px] leading-none text-amber-600 dark:text-amber-400 cursor-default"
                                      title={`Assessed after ${sliderMaxDate}:\n${titleFor(afterMarkers)}`}
                                    >
                                      {afterMarkers.length}›
                                    </div>
                                  )}
                                </div>
                              )}
                              <div className="relative h-5 flex items-center">
                                <div className="absolute inset-x-0 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                                <div
                                  className="absolute h-1.5 rounded-full bg-blue-500"
                                  style={{
                                    left: `${pct(Math.min(fromDays, toDays))}%`,
                                    right: `${100 - pct(Math.max(fromDays, toDays))}%`,
                                  }}
                                />
                                <input
                                  type="range"
                                  min={0}
                                  max={totalDays}
                                  value={Math.min(fromDays, toDays)}
                                  onChange={(e) => {
                                    const raw = Math.min(parseInt(e.target.value, 10), toDays);
                                    const snapped = snapToMarker(raw);
                                    if (snapped) {
                                      setDateRangeFrom(snapped.days <= 0 ? null : snapped.date);
                                    } else {
                                      setDateRangeFrom(raw <= 0 ? null : dayOffsetToDate(raw));
                                    }
                                  }}
                                  onPointerDown={() => setActiveDateHandle("from")}
                                  style={{ zIndex: activeDateHandle === "from" ? 5 : 3 }}
                                  className="dual-range-thumb"
                                  aria-label="From date"
                                />
                                <input
                                  type="range"
                                  min={0}
                                  max={totalDays}
                                  value={Math.max(toDays, fromDays)}
                                  onChange={(e) => {
                                    const raw = Math.max(parseInt(e.target.value, 10), fromDays);
                                    const snapped = snapToMarker(raw);
                                    if (snapped) {
                                      setDateRangeTo(snapped.days >= totalDays ? null : snapped.date);
                                    } else {
                                      setDateRangeTo(raw >= totalDays ? null : dayOffsetToDate(raw));
                                    }
                                  }}
                                  onPointerDown={() => setActiveDateHandle("to")}
                                  style={{ zIndex: activeDateHandle === "to" ? 5 : 4 }}
                                  className="dual-range-thumb"
                                  aria-label="To date"
                                />
                              </div>
                              <div className="flex items-center justify-between text-[9px] text-zinc-400 dark:text-zinc-500 tabular-nums">
                                <span>{sliderMinDate}</span>
                                <span>{sliderMaxDate}</span>
                              </div>
                            </div>
                            {assessmentMarkers.length > 0 && (
                              <div className="text-[9px] text-zinc-400 dark:text-zinc-500">
                                Marked dates are Red List assessments, colored by category — drag a handle near one to snap to it.
                              </div>
                            )}
                            {(dateRangeFrom != null || dateRangeTo != null) && (
                              <button
                                onClick={() => { setDateRangeFrom(null); setDateRangeTo(null); }}
                                className="self-start text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:underline"
                              >
                                Reset to all dates
                              </button>
                            )}
                          </div>
                        );
                      })()
                    )}
                  </div>
                )}
              </div>
              {/* Overlays — context layers, back in the toolbar with the
                  filters. On the map they were a panel covering the ground
                  they describe, which on the dashboard's half-width map was a
                  third of it. */}
              <div className="lg:relative" ref={overlaysRef}>
                <button
                  onClick={() => setOverlaysOpen(!overlaysOpen)}
                  aria-label="Overlays"
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                    overlaysOpen
                      ? "bg-zinc-100 dark:bg-zinc-800 border-zinc-400 dark:border-zinc-500"
                      : "border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  } text-zinc-700 dark:text-zinc-300`}
                  title="Context layers: protected areas, tree cover loss, IUCN habitat types, terrestrial ecoregions, POWO/IUCN native countries, GBIF sampling effort"
                >
                  <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l9 5 9-5" />
                  </svg>
                  <span className="hidden lg:inline">Overlays</span>
                  <span className="hidden lg:inline text-[10px] text-zinc-400 tabular-nums">
                    {overlayToggleValues.filter(Boolean).length} of {overlayToggleValues.length}
                  </span>
                  <svg className={`w-3 h-3 text-zinc-400 transition-transform ${overlaysOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {overlaysOpen && (
                  <div className="absolute left-0 right-0 lg:right-auto top-full mt-1 z-50 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-lg">
                    {renderOverlayLayers()}
                  </div>
                )}
              </div>
              {/* Everything to the right of the filters: actions rather
                  than filters, kept together so they don't scatter when
                  some of them are hidden. */}
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                                <div className="flex items-center gap-1.5 shrink-0">
                    {georefMessage && (
                      <span
                        className={`max-w-[11rem] truncate text-[10px] ${
                          georefMessage.kind === "ok"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                        title={georefMessage.text}
                      >
                        {georefMessage.text}
                      </span>
                    )}

                    {/* Editing tools, on the page that has something to
                        edit: undo, redo and the CSV import all act on the
                        record list, and that list only exists in fullscreen. */}
                    {fullscreen && (
                      <>
                      {/* Saving the work, and putting a saved file back. First
                          in the row and not in a menu: the edits live in this
                          browser only, and the button that gets them out of it
                          should be the one you can see. */}
                      <div className="inline-flex rounded border border-zinc-300 dark:border-zinc-600 overflow-hidden">
                        <button
                          onClick={saveWork}
                          disabled={!hasWorkToSave}
                          title={
                            !hasWorkToSave
                              ? "Nothing to save yet — georeference, date or set aside a record, or pin a place"
                              : `Save your work for this species to a file — ${savableSummary}${
                                  lastSavedAt ? `, last saved ${lastSavedAt.slice(11, 16)}` : ", never saved"
                                }`
                          }
                          aria-label="Save your work to a file"
                          className={`flex items-center gap-1 px-1.5 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed ${
                            hasWorkToSave && !lastSavedAt ? "text-amber-600 dark:text-amber-500" : "text-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                          </svg>
                          {/* Named, where the rest of the toolbar is icons:
                              this is the one button whose job is to get the
                              work out of a browser that could lose it, and an
                              arrow nobody recognises isn't an invitation. */}
                          <span className="text-xs">Save</span>
                        </button>
                        <button
                          onClick={() => restoreInputRef.current?.click()}
                          title="Put back the work from a file you saved earlier"
                          aria-label="Restore your work from a file"
                          className="px-1.5 py-1 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 border-l border-zinc-200 dark:border-zinc-700"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21V9m0 0l-4 4m4-4l4 4M4 7V5a2 2 0 012-2h12a2 2 0 012 2v2" />
                          </svg>
                        </button>
                        <input
                          ref={restoreInputRef}
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file) readRestoreFile(file);
                          }}
                        />
                      </div>
                      {/* Undo, redo, and what they'd act on. The label matters
                          more than usual here: the table can hide the very rows an
                          edit touched, so an unlabelled undo would act off-screen
                          with nothing to say for itself. */}
                      <div className="flex items-center rounded border border-zinc-300 dark:border-zinc-600 overflow-hidden">
                        <button
                          onClick={undoEdit}
                          disabled={!canUndo}
                          title={canUndo ? `Undo ${undoLabel ?? "the last edit"} (\u2318Z)` : "Nothing to undo"}
                          className="px-1.5 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" />
                          </svg>
                        </button>
                        <button
                          onClick={redoEdit}
                          disabled={!canRedo}
                          title={canRedo ? `Redo ${redoLabel ?? "the last undone edit"} (\u21e7\u2318Z)` : "Nothing to redo"}
                          className="px-1.5 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed border-l border-zinc-200 dark:border-zinc-700"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" />
                          </svg>
                        </button>
                        {editHistory.length > 0 && (
                          <button
                            onClick={() => setHistoryOpen((v) => !v)}
                            title="Everything you've changed this session"
                            className="px-1.5 py-1 text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 border-l border-zinc-200 dark:border-zinc-700"
                          >
                            {editHistory.filter((h) => !h.undone).length}
                          </button>
                        )}
                      </div>
                      <button
                        onClick={() => setPointFileOpen(true)}
                        title={
                          pointFile
                            ? `${pointFile.fileName} — ${pointFile.points.length.toLocaleString()} records on the map. Click to compare them against your own, or load a different file.`
                            : "Import a CSV of point records — one row per record, with decimal latitude and longitude columns. It goes on the map as its own layer, to compare against."
                        }
                        aria-label="Import CSV records"
                        className="inline-flex items-center px-1.5 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                      >
                        {/* An upload arrow rather than a map pin: the button's
                            job is getting the file in, and a pin said "another
                            layer" beside a row of layer toggles. Icon only, like
                            the undo and redo it sits beside; it turns the point
                            file's own colour once one is loaded, which is the
                            only state it has to report. */}
                        <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                             style={pointFile ? { color: POINT_FILE_COLOR } : undefined}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 8l5-5 5 5M12 3v12" />
                        </svg>
                      </button>
                      </>
                    )}
                </div>
                {/* The map/list arrangement is chosen from the table's own
                    footer, beside the column picker — it's a question about
                    reading the table, and it belongs with the other one. */}
                {/* Fullscreen is a page of its own, so this is a real link:
                    it can be copied, opened in a new tab, and shared, and the
                    page it opens skips every dashboard query. In fullscreen the
                    same slot becomes the way out — one button, not two. */}
                {fullscreen ? (
                  <Link
                    href={dashboardHref}
                    title="Back to this species on the dashboard"
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors shrink-0"
                  >
                    <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 4H6a2 2 0 00-2 2v3m0 6v3a2 2 0 002 2h3m6 0h3a2 2 0 002-2v-3m0-6V6a2 2 0 00-2-2h-3" />
                    </svg>
                    Exit fullscreen
                  </Link>
                ) : (
                  <Link
                    href={`/mapping/${encodeURIComponent(speciesKey)}`}
                    title="Open the map and record list fullscreen, on their own shareable page"
                    className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors shrink-0"
                  >
                    <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V5a1 1 0 011-1h3m8 0h3a1 1 0 011 1v3m0 8v3a1 1 0 01-1 1h-3m-8 0H5a1 1 0 01-1-1v-3" />
                    </svg>
                    <span className="hidden lg:inline">Fullscreen</span>
                  </Link>
                )}
              </div>
            </div>
          </div>

          {/* ── Left sidebar (iNat photos + contributors) + Map (right) ── */}
          <div
            ref={splitRef}
            className={
              fullscreen
                ? `flex flex-1 min-h-0 ${panelLayout === "rows" ? "flex-col" : "flex-row"}`
                : "flex flex-col sm:flex-row sm:items-stretch gap-2"
            }
          >
            {/* Left column — iNat photo gallery only (hidden if no iNat data); narrow
                since it's just a 2-col thumbnail grid now, leaving more room for the map.
                Ordered after the map on mobile (order-2) since the map is the primary
                content there; back to its normal DOM order (first, on the left) at sm+. */}
            {/* Hidden in fullscreen — that view is the map and the record list
                and nothing else, and the photo grid plays the same
                hover-to-highlight role the list does there. */}
            {/* Hidden while the nearby search is open: on the dashboard the row
                has room for two columns, and the panel is the one being read. */}
            {!fullscreen && !nearbyAt && (!breakdown || breakdown.iNaturalist > 0) && (
            <div className="order-2 sm:order-none sm:w-44 shrink-0 flex flex-col gap-2">
              {/* iNat photo grid — only shown when photos exist or loading */}
              {(inatPhotos.length > 0 || loadingInatPhotos) && (
                <div className="flex flex-col bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden relative z-10">
                  {/* Header */}
                  <div className="px-2 py-1.5 text-xs sm:text-[10px] font-medium text-zinc-500 dark:text-zinc-400 text-center border-b border-zinc-100 dark:border-zinc-800">
                    iNaturalist Observations
                  </div>
                  {inatPhotos.length > 0 ? (
                    <>
                      {/* Photos — 5-col x 2-row grid on mobile (full-width column there),
                          2-col x 5-row once the sidebar narrows to w-44 at sm+ */}
                      <div className={`grid grid-cols-5 sm:grid-cols-2 gap-1 p-1.5 ${loadingInatPhotos ? "opacity-50" : ""}`}>
                        {inatPhotos.slice(0, pageSize).map((obs, idx) => (
                          <div key={`${inatPage}-${idx}`} className="aspect-square">
                            <InatPhotoWithPreview
                              obs={obs}
                              idx={idx}
                              onHover={() => setHoveredObs(obs)}
                              onLeave={() => setHoveredObs(null)}
                            />
                          </div>
                        ))}
                      </div>
                      {/* Pagination */}
                      {inatTotalCount > pageSize && (
                        <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-t border-zinc-100 dark:border-zinc-800">
                          <button
                            onClick={() => {
                              const newPage = inatPage - 1;
                              setInatPage(newPage);
                              fetchInatPhotos(newPage, pageSize);
                            }}
                            disabled={inatPage === 0 || loadingInatPhotos}
                            className="p-1.5 sm:p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Previous page"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                            </svg>
                          </button>
                          <span className="text-xs sm:text-[10px] text-zinc-400 tabular-nums">
                            {inatPage + 1}/{Math.ceil(inatTotalCount / pageSize)}
                          </span>
                          <button
                            onClick={() => {
                              const newPage = inatPage + 1;
                              setInatPage(newPage);
                              fetchInatPhotos(newPage, pageSize);
                            }}
                            disabled={(inatPage + 1) * pageSize >= inatTotalCount || loadingInatPhotos}
                            className="p-1.5 sm:p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Next page"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center justify-center py-6">
                      <svg className="w-4 h-4 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    </div>
                  )}
                </div>
              )}
            </div>
            )}

            {/* Map(s) — takes remaining width, stretches to match left column */}
            <div
              className={`order-1 sm:order-none flex-1 min-w-0 flex flex-col gap-2${fullscreen ? " min-h-0" : ""}`}
              // Two thirds by default, and whatever the divider has been
              // dragged to after that.
              style={
                fullscreen || (nearbyAt && !splitView) ? { flex: `0 0 ${mapHeightPct}%` } : undefined
              }
            >
                {splitView && splitDate ? (
                  <div className="flex flex-col gap-2">
                    {/* Split view control bar */}
                    <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg text-xs text-zinc-600 dark:text-zinc-300">
                      <span className="font-medium">Split view</span>
                      <span className="text-zinc-400">|</span>
                      <span className="text-zinc-500 dark:text-zinc-400 whitespace-nowrap">Date: <span className="font-medium text-zinc-700 dark:text-zinc-200">{splitDate}</span></span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, Math.round((new Date(sliderMaxDate).getTime() - new Date(sliderMinDate).getTime()) / 86400000))}
                        value={Math.max(0, Math.round((new Date(splitDate).getTime() - new Date(sliderMinDate).getTime()) / 86400000))}
                        onChange={(e) => {
                          const days = parseInt(e.target.value, 10);
                          const d = new Date(sliderMinDate);
                          d.setDate(d.getDate() + days);
                          setSplitDate(d.toISOString().slice(0, 10));
                        }}
                        className="flex-1 min-w-[100px] h-2.5 sm:h-1.5 accent-blue-500"
                      />
                      {assessmentDate && splitDate !== assessmentDate.split("T")[0] && (
                        <button
                          onClick={() => setSplitDate(assessmentDate.split("T")[0])}
                          className="text-xs sm:text-[10px] px-2 py-1 sm:px-1.5 sm:py-0.5 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-zinc-700 transition-colors whitespace-nowrap"
                        >
                          Reset to assessment date
                        </button>
                      )}
                      <button
                        onClick={() => setSplitView(false)}
                        className="ml-auto p-1.5 sm:p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                        title="Close split view"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      {renderMapPanel(preAssessmentOccs, bbox, `Before ${splitDate} (${preAssessmentOccs.length})`, "before")}
                      {renderMapPanel(postAssessmentOccs, bbox, `After ${splitDate} (${postAssessmentOccs.length})`, "after")}
                    </div>
                  </div>
                ) : (
                  renderMapPanel(mappedOccurrences, bbox, null)
                )}
                {/* In-range/out-of-range breakdown vs. the currently-visible IUCN
                    range polygons — one table covering Total plus (when a split
                    date is available — defaults to the assessment date, but
                    tracks wherever the split view slider is dragged to) Before/
                    After rows, regardless of whether split view is open.
                    Auto-updates with every occurrence filter and every range
                    category toggle. Rendered in-flow below the map(s) (not
                    floated over them) — it collides with the bottom legend/
                    toolbar row when floated, since that row can grow wide
                    enough to reach the corner. */}
                {showRange && rangeCoverageStats && rangeCoverageStats.total.total > 0 && (
                  <div className="w-full px-3 py-2 rounded-lg shadow-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-300">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          <th className="text-left font-medium text-zinc-700 dark:text-zinc-200 pr-3 pb-1 w-2/5">GBIF vs. range map</th>
                          <th className="text-right font-medium text-zinc-400 dark:text-zinc-500 px-2 pb-1 w-[15%]"># Total</th>
                          <th className="text-right font-medium text-zinc-400 dark:text-zinc-500 px-2 pb-1 w-[15%]"># In range</th>
                          <th className="text-right font-medium text-zinc-400 dark:text-zinc-500 px-2 pb-1 w-[15%]"># Out range</th>
                          <th className="text-right font-medium text-zinc-400 dark:text-zinc-500 pl-2 pb-1 w-[15%]">% In range</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          [
                            ["Total", rangeCoverageStats.total, true],
                            ...(rangeCoverageStats.before ? [[`Before ${splitDate}`, rangeCoverageStats.before, false] as const] : []),
                            ...(rangeCoverageStats.after ? [[`After ${splitDate}`, rangeCoverageStats.after, false] as const] : []),
                          ] as [string, { inRange: number; outRange: number; total: number }, boolean][]
                        ).map(([rowLabel, stats, isTotal]) => (
                          <tr
                            key={rowLabel}
                            className={
                              isTotal
                                ? "border-t border-b-2 border-zinc-200 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-900/40 font-semibold text-zinc-800 dark:text-zinc-100"
                                : "border-t border-zinc-100 dark:border-zinc-700"
                            }
                          >
                            <td className="text-left pr-3 py-1">{rowLabel}</td>
                            <td className="text-right px-2 py-1">{stats.total.toLocaleString()}</td>
                            <td className="text-right px-2 py-1">{stats.inRange.toLocaleString()}</td>
                            <td className="text-right px-2 py-1">{stats.outRange.toLocaleString()}</td>
                            <td className="text-right pl-2 py-1">
                              {stats.total > 0 ? `${Math.round((stats.inRange / stats.total) * 100)}%` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>

            {/* Record list — only in fullscreen, where there's room to read it
                against the map. Hovering a row highlights that record's point
                and vice versa: the table carries the locality and collection
                detail, the map carries the position. Stacks below the map on
                narrow screens. */}
            {(fullscreen || (nearbyAt && !splitView)) && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize map and record list"
                aria-valuenow={Math.round(mapHeightPct)}
                aria-valuemin={FULLSCREEN_MIN_MAP_PCT}
                aria-valuemax={FULLSCREEN_MAX_MAP_PCT}
                tabIndex={0}
                onPointerDown={handleDividerPointerDown}
                onPointerMove={handleDividerPointerMove}
                onPointerUp={handleDividerPointerUp}
                onPointerCancel={handleDividerPointerUp}
                onKeyDown={handleDividerKeyDown}
                title="Drag to resize the map and the list"
                className={`order-2 sm:order-none group relative shrink-0 touch-none flex items-center justify-center ${
                  panelLayout === "rows" ? "w-full h-3 cursor-row-resize" : "h-full w-3 cursor-col-resize"
                } ${
                  draggingDivider ? "bg-blue-100 dark:bg-blue-900/40" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                } focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 rounded`}
              >
                <div
                  className={`rounded-full transition-colors ${panelLayout === "rows" ? "h-0.5 w-10" : "w-0.5 h-10"} ${
                    draggingDivider
                      ? "bg-blue-500"
                      : "bg-zinc-300 dark:bg-zinc-600 group-hover:bg-zinc-400 dark:group-hover:bg-zinc-500"
                  }`}
                />
              </div>
            )}
            {/* Beside the map on the dashboard, sharing the row the photo grid
                gave up. In fullscreen it is a tab on the record list instead —
                that column is the only one with room for a second table. */}
            {!fullscreen && nearbyAt && !splitView && (
              <div className="order-3 sm:order-none flex min-w-0 flex-1 flex-col">{NEARBY_PANEL}</div>
            )}
            {fullscreen && (
              <div className="order-3 sm:order-none flex flex-col gap-2 min-w-0 flex-1 min-h-0">
                <div className="flex items-center gap-1 shrink-0 text-[11px] border-b border-zinc-200 dark:border-zinc-700">
                  {listTabs.map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => setListTab(tab.key)}
                      title={tab.title}
                      className={`flex items-center gap-1.5 px-2 py-1 -mb-px border-b-2 max-w-[16rem] ${
                        listTab === tab.key
                          ? "border-blue-500 text-zinc-700 dark:text-zinc-200"
                          : "border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                      }`}
                    >
                      {tab.dot && (
                        <span className="w-2 h-2 rotate-45 shrink-0" style={{ background: tab.dot }} />
                      )}
                      <span className="truncate">{tab.label}</span>
                      {tab.key !== "nearby" && (
                        <span className="tabular-nums text-[10px] text-zinc-400">{tab.count.toLocaleString()}</span>
                      )}
                    </button>
                  ))}
                  <ListZoomControl zoom={listZoom} onChange={setListZoom} />
                </div>
                {listTab === "nearby" ? (
                  // In fullscreen the list column is the only place with room
                  // for a second table, so the search takes a tab on it rather
                  // than a third column squeezed beside the map.
                  <div className="min-h-0 flex-1 overflow-hidden p-1">{NEARBY_PANEL}</div>
                ) : pointFile && pointFileComparison && listTab === "file" ? (
                  <PointFileTable
                    comparison={pointFileComparison}
                    fileName={pointFile.fileName}
                    extraColumns={pointFile.extraColumns}
                    zoom={listZoom}
                    fillHeight
                  />
                ) : (
                <OccurrenceListTable
                  occurrences={listTab === "excluded" ? excludedOccurrences : countedOccurrences}
                  variant={listTab === "excluded" ? "excluded" : "records"}
                  loading={loadingOccurrences}
                  isOutsideNativeRange={isOutsideNativeRangeForList}
                  nativeRangeSourceLabel={nativeRangeSourceLabel}
                  georeferences={georeferences}
                  onSaveGeoreference={saveGeoreferenceInline}
                  onClearGeoreference={clearGeoreference}
                  localityNotes={assessorNotes}
                  onSaveLocalityNote={saveAssessorNote}
                  hoveredGbifId={hoveredFeature?.properties.gbifID ?? null}
                  onHoverRow={handleHoverRow}
                  focusGbifId={focusRecord}
                  dates={assessorDates}
                  onSaveDate={saveAssessorDate}
                  onClearDate={clearAssessorDate}
                  duplicates={listTab === "gbif" ? duplicatesByPrimary : undefined}
                  onMarkDuplicate={listTab === "gbif" ? markDuplicates : undefined}
                  onRowContextMenu={(feature, at) =>
                    setRowMenu({ gbifID: feature.properties.gbifID, x: at.x, y: at.y })
                  }
                  footerExtra={
                    // Only the counted records make a point file, so only that
                    // list offers to save one.
                    listTab === "gbif" ? (
                      <button
                        onClick={() => setCompilerPrompt(true)}
                        disabled={exportablePoints.length === 0}
                        title={`Save the ${exportablePoints.length.toLocaleString()} counted records that have a position as an IUCN point file (CSV)`}
                        className="p-1 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                        </svg>
                      </button>
                    ) : listTab === "excluded" ? (
                      <button
                        onClick={() => setConfirmPutAllBack(true)}
                        title="Count every excluded record again, forgetting the reasons given"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 text-[10px] text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M4 10a8 8 0 1 1 2 5.3" />
                        </svg>
                        Put all back
                      </button>
                    ) : undefined
                  }
                  excludedIds={excludedIds}
                  exclusions={exclusions}
                  onExclude={setPendingExclusion}
                  onInclude={includeAgain}
                  panelLayout={panelLayout}
                  onTogglePanelLayout={() => setPanelLayout((v) => (v === "rows" ? "columns" : "rows"))}
                  zoom={listZoom}
                  fillHeight
                />
                )}
              </div>
            )}
            {/* A restore replaces what's here, so it says what it holds and what
                it would replace before it does. Undoable either way — but a
                dialog is cheaper than finding the undo button afterwards. */}
            {pendingRestore && createPortal(
              <div
                className="fixed inset-0 z-[10001] flex items-center justify-center p-4 bg-black/40"
                onClick={() => setPendingRestore(null)}
              >
                <div
                  className="w-full max-w-md rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
                    <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      Put back the work saved on {pendingRestore.savedAt.slice(0, 10)}?
                    </h2>
                  </div>
                  <div className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300 space-y-1.5">
                    <p>
                      The file holds {summariseBackup(pendingRestore)}.
                    </p>
                    <p>
                      {editCount === 0
                        ? "There is nothing here to replace."
                        : `It replaces what this browser holds for ${scientificName ?? "this species"} — ${editCount} record${
                            editCount === 1 ? "" : "s"
                          } edited. Undo puts that back.`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
                    <button
                      onClick={() => setPendingRestore(null)}
                      className="ml-auto px-3 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => applyRestore(pendingRestore)}
                      className="px-3 py-1 rounded bg-zinc-800 dark:bg-zinc-200 hover:bg-zinc-900 dark:hover:bg-white text-xs text-white dark:text-zinc-900 font-medium transition-colors"
                    >
                      Restore
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}
            {/* Asked in a dialog rather than in the footer, because this undoes
                every judgement on the list at once and one of them may have
                taken a paragraph of reasoning to arrive at. Undo brings them
                back, but only for as long as this session lasts. */}
            {confirmPutAllBack && createPortal(
              <div
                className="fixed inset-0 z-[10001] flex items-center justify-center p-4 bg-black/40"
                onClick={() => setConfirmPutAllBack(false)}
              >
                <div
                  className="w-full max-w-md rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
                    <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      Put all {excludedOccurrences.length.toLocaleString()} record
                      {excludedOccurrences.length === 1 ? "" : "s"} back?
                    </h2>
                  </div>
                  <div className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300 space-y-1.5">
                    <p>
                      Every record you&apos;ve set aside is counted again, and the reasons you gave
                      go with them — including the ones that record which of a stack of duplicates
                      you kept.
                    </p>
                    <p className="text-zinc-400">
                      Undo will bring them back for as long as this tab stays open.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
                    <button
                      onClick={() => setConfirmPutAllBack(false)}
                      className="ml-auto px-3 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        setConfirmPutAllBack(false);
                        putAllBack();
                      }}
                      className="px-3 py-1 rounded bg-zinc-800 dark:bg-zinc-200 hover:bg-zinc-900 dark:hover:bg-white text-xs text-white dark:text-zinc-900 font-medium transition-colors"
                    >
                      Put all back
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}
            {/* The record menu for a right-clicked row, drawn at the pointer.
                Kept out of the table so it can carry the same buttons the map
                panel does, which are built here. */}
            {rowMenu && createPortal(
              <div
                data-row-menu
                style={{
                  position: "fixed",
                  left: Math.min(rowMenu.x, window.innerWidth - 220),
                  top: Math.min(rowMenu.y, window.innerHeight - 140),
                  zIndex: 10002,
                }}
                className="w-52 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-lg p-1 space-y-0.5 text-[11px] text-zinc-700 dark:text-zinc-200"
              >
                {renderRecordActions(rowMenu.gbifID, { showOnMap: true })}
              </div>,
              document.body
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
