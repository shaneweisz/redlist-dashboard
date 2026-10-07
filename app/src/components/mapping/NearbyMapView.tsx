"use client";

/**
 * The map at /map: the species map's overlays, asked of a place rather than of
 * a species, and the nearby-species search from wherever you click.
 *
 * The nearby-species panel already existed, but only as something you could
 * reach from *inside* one species' occurrence map: you had to know a species,
 * open its map, find a record, click it. That is the wrong way round for the
 * question most people actually arrive with — "what threatened species are
 * near here" — which names a place and no species at all. This is the same
 * search and the same panel with the species-shaped doorway taken off the
 * front, and the same overlays, toolbar and callouts as the species map, so
 * the two read as one tool.
 *
 * A click is the question, as a click on a record is on the species map. It
 * opens a callout at the point with what the overlays say about it and the
 * offer to search around it; a protected area named there offers to search
 * inside its boundary instead. Nothing is searched until one of those is
 * pressed. The radius is four fixed distances rather than a slider, for the
 * reason NEARBY_RADII_KM gives — and the ring on the ground can be dragged to
 * pick between them.
 *
 * It deliberately does not draw every GBIF record in the circle. A radius in a
 * well-collected part of the world holds hundreds of thousands of them, and an
 * undifferentiated wash of dots answers nothing; the records that go on the map
 * are the ones for a species you picked out of the list, in that species'
 * colour. See NEARBY_PICKED_COLORS.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { MapRef, MapLayerMouseEvent } from "react-map-gl/maplibre";
import NearbySpeciesPanel from "@/components/mapping/NearbySpeciesPanel";
import MapOverlayMenu from "@/components/mapping/overlays/MapOverlayMenu";
import MapOverlayLegend from "@/components/mapping/overlays/MapOverlayLegend";
import { MAP_LAYER_SLOTS, slotId } from "@/components/mapping/overlays/layer-slots";
import { useMapOverlays } from "@/hooks/mapping/useMapOverlays";
import { BASEMAP_STYLES, type BasemapKey } from "@/lib/mapping/basemaps";
import { uncertaintyCircle } from "@/lib/mapping/georeferences";
import { nearbyPointFields } from "@/lib/mapping/nearby-point-fields";
import { ELEVATION_ATTRIBUTION, elevationAt, formatElevation } from "@/lib/mapping/elevation";
import { GEOCODER_ATTRIBUTION, type Place } from "@/lib/mapping/geocode";
import { geometryForGbif, type GbifGeometry } from "@/lib/mapping/gbif-geometry";
import { haversineMetres } from "@/lib/mapping/geo-distance";
import type { ProtectedArea } from "@/lib/mapping/protected-areas";
import {
  NEARBY_RADIUS_DEFAULT,
  type NearbyScope,
  NEARBY_SEARCH_COLOR,
  NEARBY_PICKED_COLORS,
  NEARBY_MAX_PICKED,
  groupNearbyFeatures,
  snapRadiusKm,
  type NearbyPoint,
  type NearbyRadiusKm,
} from "@/lib/mapping/nearby-species";

const MapGL = dynamic(() => import("react-map-gl/maplibre").then((mod) => mod.Map), { ssr: false });
const Source = dynamic(() => import("react-map-gl/maplibre").then((mod) => mod.Source), { ssr: false });
const Layer = dynamic(() => import("react-map-gl/maplibre").then((mod) => mod.Layer), { ssr: false });
const MapLibreMarker = dynamic(() => import("react-map-gl/maplibre").then((mod) => mod.Marker), { ssr: false });
const ScaleControl = dynamic(() => import("react-map-gl/maplibre").then((mod) => mod.ScaleControl), { ssr: false });
const MapPlaceSearch = dynamic(() => import("./MapPlaceSearch"), { ssr: false });
const MapOccurrenceTooltip = dynamic(() => import("./MapOccurrenceTooltip"), { ssr: false });
const MapOverlayLayers = dynamic(() => import("./overlays/MapOverlayLayers"), { ssr: false });
const MapOverlayCallout = dynamic(() => import("./overlays/MapOverlayCallout"), { ssr: false });

/** One map, so one set of layer ids. */
const PANEL = "main";

/** A species the reader has asked to see the records of, and where they are. */
type Picked = { key: string; name: string; commonName: string | null };

/** The point a search is about, and how wide it was asked. */
type Search = { lat: number; lng: number; radiusKm: NearbyRadiusKm };

/**
 * A protected area being searched instead of a radius.
 *
 * Carries both the boundary GBIF was given and the one it came from: `wkt` is
 * what was asked, `geometry` is what to draw, and they are the same thing, so
 * what the map outlines is exactly what the list describes. A site whose
 * boundary had to be cut down to fit is drawn cut down too — showing the true
 * outline and searching a smaller one would be the map quietly lying.
 */
type Area = {
  site: ProtectedArea;
  wkt: string;
  geometry: GeoJSON.MultiPolygon;
  simplified: boolean;
  polygons: number;
  sourcePolygons: number;
};

/** The point last clicked, and what is known about it so far. */
type Clicked = {
  lng: number;
  lat: number;
  /** A place search's name for it, when that is how it was chosen. */
  name: string | null;
  elevation: number | null;
  elevationLoading: boolean;
};

const RING_LAYER = `nearby-radius-grab-${PANEL}`;
const POINTS_LAYER = `nearby-points-circle-${PANEL}`;

/** Where the map looks before it knows anything: the whole world, once. */
const WORLD_VIEW = { longitude: 10, latitude: 25, zoom: 1.4 };

/**
 * How far in the map sits on a point.
 *
 * Zoom 9 shows roughly a 50 km span on a laptop, which holds the widest circle
 * on offer at its edges and the tightest one comfortably. Landing closer meant
 * every first search at 25 km or more drew a ring larger than the viewport, so
 * the thing the panel was describing was off-screen in every direction.
 */
const PLACE_ZOOM = 9;

/** A real fix is worth waiting ten seconds for; a minute-old one is not stale
 *  for a question asked at 10 km and up. */
const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 60000,
};

/**
 * How finely WDPA is asked to draw a boundary here, in degrees (about 22 m).
 *
 * Fixed rather than derived from the map's pixel size, because this boundary is
 * going to be *searched* and not merely drawn. Left to the default, a phone
 * makes a pixel worth several hundred metres, and at that offset the service
 * returns a structurally different shape: Kruger came back as one 980-point
 * outline on a desktop and, on a phone, a coarser outline plus two zero-area
 * slivers. Whoever is looking should get the same answer.
 */
const SEARCH_BOUNDARY_OFFSET = 0.0002;

/**
 * The grid a search centre is snapped to, in degrees — about 110 m.
 *
 * Not cosmetic: it is what makes the hour-long edge cache in front of
 * /api/nearby-species worth having. A centre from a click or the browser's
 * geolocation is something like -33.92490000000001, so every visitor asked a
 * URL nobody had ever asked before and every single request went through to
 * GBIF. Rounded, everyone asking within the same hundred metres — and the same
 * person returning, or reloading — shares one cached answer.
 *
 * 110 m is small against even the tightest radius on offer. The marker showing
 * where you are is *not* snapped; only the circle that gets searched.
 */
const SEARCH_GRID_DECIMALS = 3;

const snapToGrid = (degrees: number) => Number(degrees.toFixed(SEARCH_GRID_DECIMALS));

/** What the search button offers, following the scope so it never promises
 *  threatened species and then hands back a list of starlings. */
const SCOPE_NOUN: Record<NearbyScope, string> = {
  threatened: "threatened species",
  assessed: "assessed species",
  all: "species",
};

/** West/south/east/north of a boundary, for framing it. */
function boundsOf(geometry: GeoJSON.MultiPolygon): [[number, number], [number, number]] | null {
  let [w, s, e, n] = [180, 90, -180, -90];
  for (const polygon of geometry.coordinates) {
    for (const [x, y] of polygon[0] ?? []) {
      w = Math.min(w, x); e = Math.max(e, x);
      s = Math.min(s, y); n = Math.max(n, y);
    }
  }
  return w <= e && s <= n ? [[w, s], [e, n]] : null;
}

/**
 * One drawn species' records, keyed by the ground they were fetched over.
 *
 * The ground is part of the key and not just the species, because a species'
 * records within 10 km are a different set from its records within 50 or its
 * records inside a national park, and all three are worth keeping.
 */
const pointsKey = (scope: string, speciesKey: string) => `${scope}|${speciesKey}`;

/** The search mark: a dashed ring around a dot, as the species map uses. */
const SearchIcon = () => (
  <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
  </svg>
);

/** A control on the map, styled as the species map styles its own. */
const mapButtonClass =
  "p-1.5 rounded-lg bg-white dark:bg-zinc-800 shadow-md border border-zinc-200 dark:border-zinc-700 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-60";

export default function NearbyMapView({
  /** A point in the URL, so a search can be linked to. */
  initial,
}: {
  initial: { lat: number; lng: number; radiusKm: NearbyRadiusKm; scope: NearbyScope } | null;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>("streets");
  const [basemapOpen, setBasemapOpen] = useState(false);

  /**
   * The same overlays the species map has. Sampling effort opens on all taxa:
   * with no species here there is no group to match, and the reader can pick
   * one from the list under the row.
   */
  const overlays = useMapOverlays({ defaultEffortGroup: "all", areaBoundaryOffset: SEARCH_BOUNDARY_OFFSET });
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const overlaysRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!overlaysOpen) return;
    const handler = (e: MouseEvent) => {
      if (overlaysRef.current && !overlaysRef.current.contains(e.target as Node)) setOverlaysOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [overlaysOpen]);

  /** The question on screen: null until one has been asked. */
  const [search, setSearch] = useState<Search | null>(initial);
  /** The radius the next search will use, which the panel also edits. */
  const [radiusKm, setRadiusKm] = useState<NearbyRadiusKm>(initial?.radiusKm ?? NEARBY_RADIUS_DEFAULT);

  /** How much of what is here to ask about — see NEARBY_SCOPES. */
  const [scope, setScope] = useState<NearbyScope>(initial?.scope ?? "threatened");

  const [locating, setLocating] = useState<"idle" | "asking" | "denied">("idle");
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  /** Where a place search landed, marked so it can be compared with the ring. */
  const [placePin, setPlacePin] = useState<Place | null>(null);
  const [previewPlace, setPreviewPlace] = useState<Place | null>(null);
  /** The point the callout is about, until it is searched or put away. */
  const [clicked, setClicked] = useState<Clicked | null>(null);
  const elevationQueryId = useRef(0);

  const [picked, setPicked] = useState<Picked[]>([]);
  const [points, setPoints] = useState<Record<string, { points: NearbyPoint[]; total: number }>>({});
  /** The records under the last click, and which of them is showing. */
  const [shownGroup, setShownGroup] = useState<NearbyPoint[]>([]);
  const [shownIndex, setShownIndex] = useState(0);
  const shown = shownGroup[Math.min(shownIndex, shownGroup.length - 1)] ?? null;

  const [area, setArea] = useState<Area | null>(null);

  const [hoveringRing, setHoveringRing] = useState(false);
  const [hoveringPoint, setHoveringPoint] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [panning, setPanning] = useState(false);

  const pointsRef = useRef(points);
  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  /** A colour per picked species, by pick order — see NEARBY_PICKED_COLORS. */
  const colors = useMemo(() => {
    const taken = new Set<string>();
    const out: Record<string, string> = {};
    for (const p of picked) {
      const free = NEARBY_PICKED_COLORS.find((c) => !taken.has(c)) ?? NEARBY_PICKED_COLORS[0];
      taken.add(free);
      out[p.key] = free;
    }
    return out;
  }, [picked]);

  /**
   * Takes the map to a point — now, or as soon as there is a map.
   *
   * MapLibre is loaded with `ssr: false` and mounts a beat after the page does,
   * while the browser can answer a geolocation prompt it has already been
   * granted more or less instantly. Flying straight off `mapRef` therefore lost
   * the very first camera move about as often as it landed it. Whatever the
   * camera was last told is kept until the map says it is ready for it.
   */
  const mapReady = useRef(false);
  const pendingCentre = useRef<{ lat: number; lng: number; duration: number } | null>(null);
  const flyTo = useCallback((lat: number, lng: number, duration = 900) => {
    if (!mapReady.current) {
      pendingCentre.current = { lat, lng, duration };
      return;
    }
    mapRef.current?.flyTo({ center: [lng, lat], zoom: PLACE_ZOOM, duration });
  }, []);

  /**
   * Opens the callout at a point: its coordinates and elevation, what the
   * overlays say about it, and the offer to search around it.
   */
  const openAt = useCallback(
    (lng: number, lat: number, name: string | null = null) => {
      const map = mapRef.current?.getMap();
      const query = ++elevationQueryId.current;
      setClicked({ lng, lat, name, elevation: null, elevationLoading: true });
      if (map) overlays.queryAt(map, lng, lat, PANEL);
      elevationAt(lng, lat)
        .catch(() => null)
        .then((elevation) => {
          if (query !== elevationQueryId.current) return;
          setClicked((prev) => (prev ? { ...prev, elevation, elevationLoading: false } : prev));
        });
    },
    [overlays]
  );

  const closeCallout = useCallback(() => {
    ++elevationQueryId.current;
    setClicked(null);
    overlays.clearAnswers();
  }, [overlays]);

  /**
   * Asks about a point.
   *
   * Moving the centre drops whatever species were drawn, which changing the
   * radius deliberately does not: a species picked out of the list at one place
   * is a thing you chose to look at *there*, and carrying it to a search on
   * another continent left the legend naming a plant with no records anywhere
   * near the new circle. Widening the same circle is the same question asked
   * again, so the picks survive it.
   */
  const askAt = useCallback(
    (lat: number, lng: number, km: NearbyRadiusKm) => {
      setSearch({ lat: snapToGrid(lat), lng: snapToGrid(lng), radiusKm: km });
      setArea(null);
      setPicked([]);
      setShownGroup([]);
    },
    []
  );

  /**
   * Takes the map to where you are, and offers the search there.
   *
   * It stops at the offer rather than searching: the button is also how you
   * look around your own area first — at the protected areas near you, say —
   * and the search is one click away in the callout it opens.
   */
  const goToMe = useCallback(() => {
    if (!navigator.geolocation) {
      setLocating("denied");
      return;
    }
    setLocating("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating("idle");
        const { latitude: lat, longitude: lng } = pos.coords;
        setMyLocation({ lat, lng });
        setPlacePin(null);
        flyTo(lat, lng);
        openAt(lng, lat, "Your location");
      },
      () => setLocating("denied"),
      GEOLOCATION_OPTIONS
    );
  }, [flyTo, openAt]);

  /**
   * A link that carries its own coordinates already named a place, so it opens
   * on it with the search shown, having asked nobody for anything.
   */
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !initial) return;
    asked.current = true;
    flyTo(initial.lat, initial.lng, 0);
  }, [initial, flyTo]);

  /** The search in the address bar, so what is on screen can be sent to someone. */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (search) {
      url.searchParams.set("lat", search.lat.toFixed(5));
      url.searchParams.set("lng", search.lng.toFixed(5));
      url.searchParams.set("r", String(search.radiusKm));
      if (scope === "threatened") url.searchParams.delete("scope");
      else url.searchParams.set("scope", scope);
    } else {
      url.searchParams.delete("lat");
      url.searchParams.delete("lng");
      url.searchParams.delete("r");
      url.searchParams.delete("scope");
    }
    window.history.replaceState(null, "", url);
  }, [search, scope]);

  /**
   * Changing the radius moves the circle the current question is about — and
   * puts the question back on a circle, if it was on a boundary.
   */
  const changeRadius = useCallback((km: NearbyRadiusKm) => {
    setRadiusKm(km);
    setArea(null);
    setSearch((prev) => (prev ? { ...prev, radiusKm: km } : prev));
    setShownGroup([]);
  }, []);

  const togglePick = useCallback((species: Picked) => {
    setPicked((prev) =>
      prev.some((p) => p.key === species.key)
        ? prev.filter((p) => p.key !== species.key)
        : [...prev, species].slice(-NEARBY_MAX_PICKED)
    );
  }, []);

  /**
   * What ground the current question covers, as one string.
   *
   * Everything cached per-search hangs off this, so switching between a radius
   * and a boundary can't hand one's records to the other. Named `ground` and
   * not `scope`, which is a different thing entirely here — how much of what is
   * recorded on this ground to ask about.
   */
  const ground = useMemo(
    () =>
      area
        ? `area:${area.wkt}`
        : search
          ? `${search.lat.toFixed(4)},${search.lng.toFixed(4)}|${search.radiusKm}`
          : "",
    [area, search]
  );

  /** Each picked species' records inside the search, fetched once per search. */
  useEffect(() => {
    if (!search) return;
    const controller = new AbortController();
    for (const p of picked) {
      const key = pointsKey(ground, p.key);
      if (pointsRef.current[key]) continue;
      const params = new URLSearchParams({ speciesKey: p.key });
      if (area) {
        params.set("geometry", area.wkt);
      } else {
        params.set("lat", String(search.lat));
        params.set("lng", String(search.lng));
        params.set("radiusKm", String(search.radiusKm));
      }
      fetch(`/api/nearby-species/points?${params}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data) => setPoints((prev) => ({ ...prev, [key]: { points: data.points ?? [], total: data.total ?? 0 } })))
        // A species whose records won't load is drawn as nothing rather than
        // left fetching forever; the legend says "0 of —" and the row stays.
        .catch((e) => {
          if (e?.name === "AbortError") return;
          setPoints((prev) => ({ ...prev, [key]: { points: [], total: 0 } }));
        });
    }
    return () => controller.abort();
  }, [picked, search, area, ground]);

  const ringGeoJson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: search && !area
        ? [
            {
              type: "Feature" as const,
              properties: {},
              geometry: uncertaintyCircle(search.lat, search.lng, search.radiusKm * 1000),
            },
          ]
        : [],
    }),
    [search, area]
  );

  const pointsGeoJson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      // Keyed and indexed rather than carrying the record: MapLibre flattens
      // feature properties through its tile encoding, so this pair is what
      // survives to find the point again on a click.
      features: search
        ? picked.flatMap((p) =>
            (points[pointsKey(ground, p.key)]?.points ?? []).map((pt, i) => ({
              type: "Feature" as const,
              properties: { nearbyKey: pointsKey(ground, p.key), nearbyIndex: i, color: colors[p.key] },
              geometry: { type: "Point" as const, coordinates: [pt.lng, pt.lat] },
            }))
          )
        : [],
    }),
    [search, picked, points, colors, ground]
  );

  /** What the panel needs to know about each drawn species. */
  const pickedForPanel = useMemo(
    () =>
      picked.map((p) => {
        const got = search ? points[pointsKey(ground, p.key)] : undefined;
        return {
          key: p.key,
          color: colors[p.key],
          drawn: got ? { shown: got.points.length, total: got.total } : null,
        };
      }),
    [picked, points, colors, search, ground]
  );

  /**
   * Each clicked protected area's boundary, prepared for GBIF.
   *
   * Prepared when the callout opens rather than when its button is pressed:
   * not every site has one GBIF will take, and a button that silently does
   * nothing is worse than one that isn't offered. Preparing here means the
   * offer and the ability to honour it are decided by the same code.
   */
  const readyAreas = useMemo(() => {
    const out = new Map<string, GbifGeometry | null>();
    const clickedAreas = overlays.clickedAreas;
    if (!clickedAreas) return out;
    for (const site of clickedAreas.areas) {
      out.set(
        site.sitePid,
        site.geometry
          ? geometryForGbif(site.geometry, { baseUrlBytes: 400, focus: [clickedAreas.lng, clickedAreas.lat] })
          : null
      );
    }
    return out;
  }, [overlays.clickedAreas]);

  /**
   * Search one protected area rather than a circle.
   *
   * The boundary is prepared in the browser, and the *same* prepared boundary
   * is both drawn and sent — see gbif-geometry for why it can't simply be
   * forwarded whole.
   */
  const searchSite = useCallback(
    (site: ProtectedArea, ready: GbifGeometry, at: { lat: number; lng: number }) => {
      setArea({
        site,
        wkt: ready.wkt,
        geometry: ready.geometry,
        simplified: ready.simplified,
        polygons: ready.polygons,
        sourcePolygons: ready.sourcePolygons,
      });
      setSearch({ lat: snapToGrid(at.lat), lng: snapToGrid(at.lng), radiusKm });
      setPicked([]);
      setShownGroup([]);
      closeCallout();
      const map = mapRef.current?.getMap();
      const bounds = boundsOf(ready.geometry);
      if (map && bounds) map.fitBounds(bounds, { padding: 40, duration: 900 });
    },
    [radiusKm, closeCallout]
  );

  const onMapClick = useCallback(
    (e: MapLayerMouseEvent) => {
      // A marker's own click is not the map's: MapLibre listens on the whole
      // container, so a click on the place pin reaches here too.
      if ((e.originalEvent?.target as HTMLElement | null)?.closest(".maplibregl-marker")) return;
      const hits = (e.features ?? []).filter((f) => String(f.layer?.id ?? "") === POINTS_LAYER);
      if (hits.length) {
        const group = groupNearbyFeatures(hits, pointsRef.current);
        if (group.length) {
          setShownIndex(0);
          setShownGroup(group);
          return;
        }
      }
      // Anywhere else — including inside the ring — is a question about that
      // spot. The map is the control here, as a record is on the species map:
      // a click opens what is known about the point, and the search is one
      // more click from there.
      setShownGroup([]);
      setPlacePin(null);
      openAt(e.lngLat.lng, e.lngLat.lat);
    },
    [openAt]
  );

  const goToPlace = useCallback(
    (place: Place) => {
      setPlacePin(place);
      setPreviewPlace(null);
      flyTo(place.lat, place.lng);
      openAt(place.lng, place.lat, place.name);
    },
    [flyTo, openAt]
  );

  /** The callout's own part: the point, and the offer to search around it. */
  const calloutHeader = clicked && {
    lng: clicked.lng,
    lat: clicked.lat,
    content: (
      <div>
        <div className="flex items-baseline gap-1 pb-0.5">
          <span className="min-w-0 truncate font-medium text-zinc-700 dark:text-zinc-200">
            {clicked.name ?? "This point"}
          </span>
          <button
            onClick={closeCallout}
            title="Close"
            className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="text-zinc-500 dark:text-zinc-400 tabular-nums">
          {clicked.lat.toFixed(5)}, {clicked.lng.toFixed(5)}
          {" · "}
          {clicked.elevationLoading ? (
            <span className="text-zinc-400">reading elevation…</span>
          ) : clicked.elevation == null ? (
            <span className="text-zinc-400">elevation unavailable</span>
          ) : (
            <span className="text-zinc-700 dark:text-zinc-200" title={ELEVATION_ATTRIBUTION}>
              {formatElevation(clicked.elevation)}
            </span>
          )}
        </div>
        {/* The record panel's own action, from bare ground — same mark, same
            row, so it reads as the thing it is on the species map. */}
        <button
          onClick={() => {
            askAt(clicked.lat, clicked.lng, radiusKm);
            closeCallout();
          }}
          title={`${SCOPE_NOUN[scope][0].toUpperCase()}${SCOPE_NOUN[scope].slice(1)} with GBIF records within ${radiusKm} km of this point, and the threats their assessments cite`}
          className="mt-1 -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-700"
        >
          <SearchIcon />
          <span className="flex-1">Show nearby {SCOPE_NOUN[scope]}</span>
          <span className="shrink-0 tabular-nums text-[10px] text-zinc-400">{radiusKm} km</span>
        </button>
      </div>
    ),
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* The toolbar above the map, as on the species map: the overlays live
          here rather than as buttons on the map they describe. */}
      <div className="relative flex flex-wrap items-center gap-2">
        <div className="lg:relative" ref={overlaysRef}>
          <button
            onClick={() => setOverlaysOpen(!overlaysOpen)}
            aria-label="Overlays"
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
              overlaysOpen
                ? "bg-zinc-100 dark:bg-zinc-800 border-zinc-400 dark:border-zinc-500"
                : "border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            } text-zinc-700 dark:text-zinc-300`}
            title="Context layers: protected areas, tree cover loss, IUCN habitat types, terrestrial ecoregions, GBIF sampling effort"
          >
            <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l9 5 9-5" />
            </svg>
            <span>Overlays</span>
            <span className="text-[10px] text-zinc-400 tabular-nums">
              {overlays.toggleValues.filter(Boolean).length} of {overlays.toggleValues.length}
            </span>
            <svg className={`w-3 h-3 text-zinc-400 transition-transform ${overlaysOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {overlaysOpen && (
            <div className="absolute left-0 right-0 lg:right-auto top-full mt-1 z-50 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-lg">
              <div className="flex flex-col py-1 w-[20rem] max-w-full">
                <MapOverlayMenu overlays={overlays} />
              </div>
            </div>
          )}
        </div>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Click anywhere on the map to see what&apos;s there and show nearby {SCOPE_NOUN[scope]}.
        </span>
      </div>

      <div className="relative isolate z-0 min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
        <MapGL
          ref={mapRef}
          initialViewState={WORLD_VIEW}
          mapStyle={BASEMAP_STYLES[basemap].style}
          style={{ width: "100%", height: "100%" }}
          interactiveLayerIds={[POINTS_LAYER, RING_LAYER]}
          onClick={onMapClick}
          // A tile that won't load is the earliest signal WDPA is down, and the
          // only one before anybody clicks.
          onError={(e) => {
            const sourceId = (e as unknown as { sourceId?: string }).sourceId;
            if (sourceId?.startsWith("wdpa-")) overlays.setProtectedAreasDown(true);
          }}
          onLoad={() => {
            mapReady.current = true;
            const pending = pendingCentre.current;
            if (!pending) return;
            pendingCentre.current = null;
            mapRef.current?.flyTo({
              center: [pending.lng, pending.lat],
              zoom: PLACE_ZOOM,
              duration: pending.duration,
            });
          }}
          onDragStart={() => setPanning(true)}
          onDragEnd={() => setPanning(false)}
          // The species map's cursors: the arrow at rest, four-way arrows while
          // panning, a pointer over a record and a resize over the ring.
          cursor={dragging || hoveringRing ? "ew-resize" : panning ? "move" : hoveringPoint ? "pointer" : "default"}
          onMouseMove={(e: MapLayerMouseEvent) => {
            const ids = (e.features ?? []).map((f) => String(f.layer?.id ?? ""));
            setHoveringPoint(ids.includes(POINTS_LAYER));
            setHoveringRing(!ids.includes(POINTS_LAYER) && ids.includes(RING_LAYER));
          }}
          onMouseDown={(e: MapLayerMouseEvent) => {
            // Whether the ring is under the pointer comes from the hover, not
            // from this event: MapLibre hit-tests move and click but hands
            // mousedown no features at all.
            if (!search || !hoveringRing) return;
            // The map would otherwise pan under the drag, which is the one
            // gesture this takes over from it.
            e.preventDefault();
            const map = mapRef.current?.getMap();
            if (!map) return;
            map.dragPan.disable();
            setDragging(true);
            const centre = search;
            const rect = map.getCanvas().getBoundingClientRect();
            // Off the window rather than the map's own mousemove: that one is
            // throttled per frame and coalesces a quick drag down to its first
            // inch, which left the radius stopping twenty pixels in.
            const onMove = (ev: PointerEvent) => {
              // Kept on the map. Unprojecting a point past the edge
              // extrapolates, and it extrapolates fast.
              const x = Math.min(rect.width, Math.max(0, ev.clientX - rect.left));
              const y = Math.min(rect.height, Math.max(0, ev.clientY - rect.top));
              const at = map.unproject([x, y]);
              changeRadius(snapRadiusKm(haversineMetres([centre.lng, centre.lat], [at.lng, at.lat]) / 1000));
            };
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              map.dragPan.enable();
              setDragging(false);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp, { once: true });
          }}
        >
          <ScaleControl position="bottom-right" />
          {/* The species map's layer bands, so every overlay sits at the same
              height here as there. See MAP_LAYER_SLOTS. */}
          {MAP_LAYER_SLOTS.map((slot) => (
            <Layer key={slot} id={slotId(slot, PANEL)} type="background" layout={{ visibility: "none" }} />
          ))}
          <MapOverlayLayers overlays={overlays} panelId={PANEL} />

          {/* The boundary being searched, outlined. This is the geometry that
              went to GBIF and not the site's own — where it had to be cut down
              to fit, the reader can see exactly what was and wasn't asked.
              Drawn in the search colour rather than the overlay's pink: it is
              the same thing the dashed circle is, and over a map already washed
              pink with protected areas, a pink outline of the one being
              searched was indistinguishable from the hundred that aren't. */}
          {area && (
            <Source id="near-area" type="geojson" data={area.geometry}>
              <Layer id="near-area-fill" beforeId={slotId("nearby-radius", PANEL)} type="fill" paint={{ "fill-color": NEARBY_SEARCH_COLOR, "fill-opacity": 0.18 }} />
              <Layer id="near-area-casing" beforeId={slotId("nearby-radius", PANEL)} type="line" paint={{ "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.9 }} />
              <Layer id="near-area-line" beforeId={slotId("nearby-radius", PANEL)} type="line" paint={{ "line-color": NEARBY_SEARCH_COLOR, "line-width": 2.5 }} />
            </Source>
          )}

          {/* The circle the panel is describing, drawn to scale. */}
          {search && !area && (
            <Source id="near-radius" type="geojson" data={ringGeoJson}>
              <Layer
                id="near-radius-fill"
                beforeId={slotId("nearby-radius", PANEL)}
                type="fill"
                paint={{ "fill-color": NEARBY_SEARCH_COLOR, "fill-opacity": 0.08 }}
              />
              <Layer
                id="near-radius-line"
                beforeId={slotId("nearby-radius", PANEL)}
                type="line"
                paint={{
                  "line-color": NEARBY_SEARCH_COLOR,
                  "line-width": 1.5,
                  "line-dasharray": [3, 2],
                }}
              />
              {/* A wide, invisible line over the drawn one: the ring is dragged
                  to change the radius, and a 1.5px target is not something
                  anyone can catch. */}
              <Layer
                id={RING_LAYER}
                beforeId={slotId("nearby-radius", PANEL)}
                type="line"
                paint={{ "line-color": NEARBY_SEARCH_COLOR, "line-width": 14, "line-opacity": 0.01 }}
              />
            </Source>
          )}

          {/* A picked species' own records, in the colour the panel gave it. */}
          {pointsGeoJson.features.length > 0 && (
            <Source id="near-points" type="geojson" data={pointsGeoJson}>
              <Layer
                id={POINTS_LAYER}
                beforeId={slotId("nearby-points", PANEL)}
                type="circle"
                paint={{
                  "circle-radius": 4.5,
                  // One layer draws every picked species; the colour comes off
                  // the feature so they don't need a layer each.
                  "circle-color": ["get", "color"],
                  "circle-stroke-width": 1.5,
                  "circle-stroke-color": "#ffffff",
                }}
              />
            </Source>
          )}

          {/* Where the browser says you are. A map that flies somewhere and
              marks nothing leaves you to guess which pixel it meant. */}
          {myLocation && (
            <MapLibreMarker longitude={myLocation.lng} latitude={myLocation.lat} anchor="center">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-60" />
                <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-white bg-blue-600 shadow" />
              </span>
            </MapLibreMarker>
          )}

          {/* The centre the radius is measured from. The ring alone says roughly
              where, and "roughly where" is what a reader is trying to pin down. */}
          {search && (
            <MapLibreMarker longitude={search.lng} latitude={search.lat} anchor="center">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke={NEARBY_SEARCH_COLOR} strokeWidth={2}>
                <circle cx="12" cy="12" r="4" fill={NEARBY_SEARCH_COLOR} stroke="#ffffff" strokeWidth={2} />
              </svg>
            </MapLibreMarker>
          )}

          {/* The point the callout is about. The callout sits beside whatever
              boundaries it names, which can be some way from the click, so the
              spot itself is marked. */}
          {clicked && (
            <MapLibreMarker longitude={clicked.lng} latitude={clicked.lat} anchor="center">
              <span className="block h-3 w-3 rounded-full border-2 border-white bg-zinc-800 shadow dark:bg-zinc-200" />
            </MapLibreMarker>
          )}

          {/* A place that was searched for, and one that is only being pointed
              at in the results list — marked but not flown to. */}
          {[placePin, previewPlace].filter(Boolean).map((place, i) => (
            <MapLibreMarker key={`${place!.id}-${i}`} longitude={place!.lng} latitude={place!.lat} anchor="bottom">
              <span
                className={`block h-3 w-3 -translate-y-1 rotate-45 rounded-sm border-2 border-white shadow ${
                  i === 0 ? "bg-emerald-600" : "bg-emerald-400/70"
                }`}
                title={place!.name}
              />
            </MapLibreMarker>
          ))}

          {/* What is at the clicked point: the overlays' answers in the species
              map's own callout, with this map's search on top of them and under
              each protected area. */}
          <MapOverlayCallout
            overlays={overlays}
            panelId={PANEL}
            header={calloutHeader}
            // Wide enough for "Show nearby threatened species" and its radius
            // on one line.
            width={260}
            areaAction={(site) => {
              const at = overlays.clickedAreas;
              const ready = readyAreas.get(site.sitePid);
              if (!at) return null;
              return ready ? (
                <button
                  onClick={() => searchSite(site, ready, { lat: at.lat, lng: at.lng })}
                  title={`${SCOPE_NOUN[scope][0].toUpperCase()}${SCOPE_NOUN[scope].slice(1)} with GBIF records inside this site's boundary`}
                  className="mt-0.5 -mx-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  <SearchIcon />
                  Show {SCOPE_NOUN[scope]} in here
                </button>
              ) : (
                // Either WDPA holds this one as a point with no outline at all —
                // it does that for the smallest sites — or the boundary is past
                // anything GBIF will take in a query. Both are honest answers;
                // an unexplained dead button is not.
                <span className="block text-[10px] text-zinc-400">
                  {site.geometry
                    ? "Boundary too complex for GBIF to search — use a radius"
                    : "No boundary published — use a radius"}
                </span>
              );
            }}
          />

          {/* A neighbour's record answers in the same panel the occurrence map's
              own records do — same fields, same order. */}
          {shown && (
            <MapOccurrenceTooltip
              lat={shown.lat}
              lng={shown.lng}
              images={shown.images}
              fields={nearbyPointFields(
                shown,
                picked.find((p) => search && points[pointsKey(ground, p.key)]?.points.includes(shown))?.name
              )}
              page={
                shownGroup.length > 1
                  ? {
                      index: Math.min(shownIndex, shownGroup.length - 1),
                      total: shownGroup.length,
                      onPrev: () => setShownIndex((i) => (i - 1 + shownGroup.length) % shownGroup.length),
                      onNext: () => setShownIndex((i) => (i + 1) % shownGroup.length),
                    }
                  : undefined
              }
              onClose={() => setShownGroup([])}
              actions={
                shown.gbifID ? (
                  <a
                    href={`https://www.gbif.org/occurrence/${shown.gbifID}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center gap-1.5 rounded px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg className="h-3 w-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5L10 14M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-3" />
                    </svg>
                    Open on GBIF
                  </a>
                ) : undefined
              }
            />
          )}
        </MapGL>

        {/* Finding a different place, top-left, where the species map keeps the
            same control. */}
        <div className="absolute left-2 top-2 z-[1000] flex flex-col items-start gap-1.5">
          <MapPlaceSearch
            getCentre={() => {
              const map = mapRef.current;
              if (!map) return undefined;
              const c = map.getCenter();
              return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
            }}
            onSelect={goToPlace}
            onPreview={setPreviewPlace}
          />
        </div>

        {/* Top-right stack, as on the species map: the basemap, then the
            control that goes to where the reader is. */}
        <div data-map-corner="top-right" className="absolute right-2 top-2 z-[1000] flex flex-col items-end gap-1.5 max-w-[85%]">
          {basemapOpen ? (
            <div className="flex flex-col gap-0.5 bg-white dark:bg-zinc-800 rounded-lg shadow-md border border-zinc-200 dark:border-zinc-700 p-1">
              {(Object.entries(BASEMAP_STYLES) as [BasemapKey, (typeof BASEMAP_STYLES)[BasemapKey]][]).map(([key, opt]) => (
                <button
                  key={key}
                  onClick={() => {
                    setBasemap(key);
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
              className={`${mapButtonClass} text-zinc-500 dark:text-zinc-400`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l9 5 9-5" />
              </svg>
            </button>
          )}
          <button
            onClick={goToMe}
            disabled={locating === "asking"}
            title={locating === "denied" ? "Your browser wouldn't share a location" : "Go to your location"}
            aria-label="Go to your location"
            className={`${mapButtonClass} ${
              locating === "denied" ? "text-amber-600 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            <svg
              className={`w-3.5 h-3.5 ${locating === "asking" ? "animate-pulse" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="12" cy="12" r="3.5" />
              <circle cx="12" cy="12" r="8" />
              <path strokeLinecap="round" d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5" />
            </svg>
          </button>
        </div>

        {/* Bottom-left, as on the species map: what each overlay's colours
            mean. Bounded to the map and scrolled, so a tall legend on a short
            map can't climb out of it. */}
        <div className="absolute bottom-2 left-2 z-[1000] flex flex-col items-start gap-1.5 max-w-[90%] max-h-[calc(100%-1rem)] overflow-y-auto overscroll-contain [&>*]:shrink-0">
          {locating === "denied" && (
            <p className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 shadow dark:bg-amber-900/40 dark:text-amber-200">
              Your browser wouldn&apos;t share a location. Search for a place, or click anywhere on the map.
            </p>
          )}
          <MapOverlayLegend overlays={overlays} />
          <p className="text-[10px] text-zinc-500 dark:text-zinc-400">{GEOCODER_ATTRIBUTION}</p>
        </div>
      </div>

      {/* The answer, below the map rather than over it: you cannot read
          "twelve species within 10 km" and look at where they are when the list
          is on top of them. */}
      {search && (
        <div className="h-[45%] min-h-0 shrink-0">
          <NearbySpeciesPanel
            lat={search.lat}
            lng={search.lng}
            recordName={placePin?.name ?? ""}
            radiusKm={search.radiusKm}
            onRadiusChange={changeRadius}
            area={
              area && {
                name: area.site.name,
                wkt: area.wkt,
                simplified: area.simplified,
                polygons: area.polygons,
                sourcePolygons: area.sourcePolygons,
              }
            }
            scope={scope}
            onScopeChange={setScope}
            onClearArea={() => {
              setArea(null);
              setPicked([]);
              setShownGroup([]);
            }}
            picked={pickedForPanel}
            onTogglePick={togglePick}
            onClose={() => {
              setSearch(null);
              setArea(null);
              setPicked([]);
              setShownGroup([]);
            }}
          />
        </div>
      )}
    </div>
  );
}
