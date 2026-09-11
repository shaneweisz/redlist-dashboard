"use client";

/**
 * What is threatened around here, asked of a place rather than of a species.
 *
 * The nearby-species panel already existed, but only as something you could
 * reach from *inside* one species' occurrence map: you had to know a species,
 * open its map, find a record, right-click it. That is the wrong way round for
 * the question most people actually arrive with — "what threatened species are
 * near me" — which names a place and no species at all. This is the same search
 * and the same panel with the species-shaped doorway taken off the front.
 *
 * It opens on wherever the browser says you are, because that is the answer to
 * "near me" and asking for it is one permission prompt. Everything else is a
 * way of choosing a different point: search a place by name, click the map,
 * paste a coordinate pair. The radius is four fixed distances rather than a
 * slider, for the reason NEARBY_RADII_KM gives — and the ring on the ground can
 * be dragged to pick between them.
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
import { BASEMAP_STYLES, type BasemapKey } from "@/lib/mapping/basemaps";
import { uncertaintyCircle } from "@/lib/mapping/georeferences";
import { haversineMetres } from "@/lib/mapping/geo-distance";
import { nearbyPointFields } from "@/lib/mapping/nearby-point-fields";
import { GEOCODER_ATTRIBUTION, type Place } from "@/lib/mapping/geocode";
import {
  NEARBY_RADII_KM,
  NEARBY_RADIUS_DEFAULT,
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

/** A species the reader has asked to see the records of, and where they are. */
type Picked = { key: string; name: string; commonName: string | null };

/** The point a search is about, and how wide it was asked. */
type Search = { lat: number; lng: number; radiusKm: NearbyRadiusKm };

const RING_LAYER = "near-radius-grab";
const POINTS_LAYER = "near-points-circle";

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

/** One drawn species' records, keyed by the circle they were fetched for. */
function pointsKey(search: Search, speciesKey: string) {
  return `${search.lat.toFixed(4)},${search.lng.toFixed(4)}|${search.radiusKm}|${speciesKey}`;
}

export default function NearbyMapView({
  /** A point in the URL, so a search can be linked to. */
  initial,
}: {
  initial: { lat: number; lng: number; radiusKm: NearbyRadiusKm } | null;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>("streets");
  const [basemapOpen, setBasemapOpen] = useState(false);

  /** The question on screen: null until one has been asked. */
  const [search, setSearch] = useState<Search | null>(initial);
  /** The radius the next search will use, which the panel also edits. */
  const [radiusKm, setRadiusKm] = useState<NearbyRadiusKm>(initial?.radiusKm ?? NEARBY_RADIUS_DEFAULT);

  /**
   * Starts at "asking" when the page is going to ask on arrival.
   *
   * Set from the initial state rather than by the mount effect, because the
   * effect must not call setState synchronously — its only job is to talk to
   * the browser's geolocation, and every state change belongs in the callbacks
   * that come back from it. A link that already names a point never asks, and a
   * browser with no geolocation at all can't.
   */
  const [locating, setLocating] = useState<"idle" | "asking" | "denied">(() =>
    initial ? "idle" : typeof navigator !== "undefined" && navigator.geolocation ? "asking" : "denied"
  );
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  /** Where a place search landed, marked so it can be compared with the ring. */
  const [placePin, setPlacePin] = useState<Place | null>(null);
  const [previewPlace, setPreviewPlace] = useState<Place | null>(null);

  const [picked, setPicked] = useState<Picked[]>([]);
  const [points, setPoints] = useState<Record<string, { points: NearbyPoint[]; total: number }>>({});
  /** The records under the last click, and which of them is showing. */
  const [shownGroup, setShownGroup] = useState<NearbyPoint[]>([]);
  const [shownIndex, setShownIndex] = useState(0);
  const shown = shownGroup[Math.min(shownIndex, shownGroup.length - 1)] ?? null;

  const [hoveringRing, setHoveringRing] = useState(false);
  const [hoveringPoint, setHoveringPoint] = useState(false);
  const [dragging, setDragging] = useState(false);
  /**
   * Whether the map has been moved away from the point being described.
   *
   * Read from the map on every move rather than held as a view state: this view
   * never controls the camera as React state (it flies it), and a `viewState`
   * round-trip would fight `flyTo` for it.
   */
  const [movedAway, setMovedAway] = useState(false);

  /** The radius as of now, for the callbacks that must not depend on it —
   *  findMe is passed to a mount effect, and a new identity there would
   *  re-prompt for a location every time the radius changed. */
  const radiusKmRef = useRef(radiusKm);
  useEffect(() => {
    radiusKmRef.current = radiusKm;
  }, [radiusKm]);

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
   * the very first camera move about as often as it landed it: the panel filled
   * in with species from a point the map was still showing the whole world
   * around. Whatever the camera was last told is kept until the map says it is
   * ready for it.
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
   * Asks about a point.
   *
   * Moving the centre drops whatever species were drawn, which changing the
   * radius deliberately does not: a species picked out of the list at one place
   * is a thing you chose to look at *there*, and carrying it to a search on
   * another continent left the legend naming a plant with no records anywhere
   * near the new circle. Widening the same circle is the same question asked
   * again, so the picks survive it.
   *
   * `fly` is off for a point the reader chose on the map, where the camera is
   * already where they want it and moving it under the click is disorienting.
   */
  const askAt = useCallback(
    (lat: number, lng: number, km: NearbyRadiusKm, { fly = true }: { fly?: boolean } = {}) => {
      setSearch({ lat, lng, radiusKm: km });
      setPicked([]);
      setShownGroup([]);
      if (fly) flyTo(lat, lng);
    },
    [flyTo]
  );

  /**
   * A fix came back: mark it, and ask what is threatened around it.
   *
   * The occurrence map's own locate button deliberately stops at flying there,
   * because on that map the search is a separate question asked of a record.
   * Here it is the entire question the page exists for, so the two are one
   * thing: a page called "near me" that puts you on the map and then waits to
   * be asked a second time is asking you to press the same button twice.
   */
  const foundMe = useCallback(
    (pos: GeolocationPosition) => {
      setLocating("idle");
      const { latitude: lat, longitude: lng } = pos.coords;
      setMyLocation({ lat, lng });
      setPlacePin(null);
      askAt(lat, lng, radiusKmRef.current);
    },
    [askAt]
  );

  /** Denied, or no fix. Either way the map cannot help, and says so rather than
   *  leaving the button spinning. */
  const lostMe = useCallback(() => setLocating("denied"), []);

  const findMe = useCallback(() => {
    if (!navigator.geolocation) {
      setLocating("denied");
      return;
    }
    setLocating("asking");
    navigator.geolocation.getCurrentPosition(foundMe, lostMe, GEOLOCATION_OPTIONS);
  }, [foundMe, lostMe]);

  /**
   * Ask on arrival, unless the URL already said where.
   *
   * A page whose whole subject is "near me" opening on an empty world map, with
   * the thing it is for behind a button, wastes the one interaction everybody
   * arriving here was always going to make. A link carrying its own coordinates
   * is the exception: it named a place, and prompting for a different one would
   * be answering a question nobody asked.
   */
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    if (initial) {
      flyTo(initial.lat, initial.lng, 0);
      return;
    }
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(foundMe, lostMe, GEOLOCATION_OPTIONS);
  }, [foundMe, lostMe, initial, flyTo]);

  /** The search in the address bar, so what is on screen can be sent to someone. */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (search) {
      url.searchParams.set("lat", search.lat.toFixed(5));
      url.searchParams.set("lng", search.lng.toFixed(5));
      url.searchParams.set("r", String(search.radiusKm));
    } else {
      url.searchParams.delete("lat");
      url.searchParams.delete("lng");
      url.searchParams.delete("r");
    }
    window.history.replaceState(null, "", url);
  }, [search]);

  /** Changing the radius moves the circle the current question is about. */
  const changeRadius = useCallback((km: NearbyRadiusKm) => {
    setRadiusKm(km);
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

  /** Each picked species' records inside the circle, fetched once per circle. */
  useEffect(() => {
    if (!search) return;
    const controller = new AbortController();
    for (const p of picked) {
      const key = pointsKey(search, p.key);
      if (pointsRef.current[key]) continue;
      const params = new URLSearchParams({
        lat: String(search.lat),
        lng: String(search.lng),
        radiusKm: String(search.radiusKm),
        speciesKey: p.key,
      });
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
  }, [picked, search]);

  const ringGeoJson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: search
        ? [
            {
              type: "Feature" as const,
              properties: {},
              geometry: uncertaintyCircle(search.lat, search.lng, search.radiusKm * 1000),
            },
          ]
        : [],
    }),
    [search]
  );

  const pointsGeoJson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      // Keyed and indexed rather than carrying the record: MapLibre flattens
      // feature properties through its tile encoding, so this pair is what
      // survives to find the point again on a click.
      features: search
        ? picked.flatMap((p) =>
            (points[pointsKey(search, p.key)]?.points ?? []).map((pt, i) => ({
              type: "Feature" as const,
              properties: { nearbyKey: pointsKey(search, p.key), nearbyIndex: i, color: colors[p.key] },
              geometry: { type: "Point" as const, coordinates: [pt.lng, pt.lat] },
            }))
          )
        : [],
    }),
    [search, picked, points, colors]
  );

  /** What the panel needs to know about each drawn species. */
  const pickedForPanel = useMemo(
    () =>
      picked.map((p) => {
        const got = search ? points[pointsKey(search, p.key)] : undefined;
        return {
          key: p.key,
          color: colors[p.key],
          drawn: got ? { shown: got.points.length, total: got.total } : null,
        };
      }),
    [picked, points, colors, search]
  );

  const onMapClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const hits = (e.features ?? []).filter((f) => String(f.layer?.id ?? "") === POINTS_LAYER);
      if (hits.length) {
        const group = groupNearbyFeatures(hits, pointsRef.current);
        if (group.length) {
          setShownIndex(0);
          setShownGroup(group);
          return;
        }
      }
      // Bare ground moves the question. The map is the control here: there is
      // no record to right-click and no species whose map this is, so a plain
      // click is the least that could possibly work.
      setPlacePin(null);
      askAt(e.lngLat.lat, e.lngLat.lng, radiusKm, { fly: false });
    },
    [askAt, radiusKm]
  );

  const onMapMove = useCallback(() => {
    const centre = mapRef.current?.getCenter();
    if (!centre || !search) {
      setMovedAway(false);
      return;
    }
    // Half the radius: far enough that the ring is no longer what you're
    // looking at, close enough that nudging the map doesn't offer to re-ask.
    const away = haversineMetres([search.lng, search.lat], [centre.lng, centre.lat]);
    setMovedAway(away > search.radiusKm * 500);
  }, [search]);

  const goToPlace = useCallback(
    (place: Place) => {
      setPlacePin(place);
      setPreviewPlace(null);
      askAt(place.lat, place.lng, radiusKm);
    },
    [askAt, radiusKm]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <MapGL
          ref={mapRef}
          initialViewState={WORLD_VIEW}
          mapStyle={BASEMAP_STYLES[basemap].style}
          style={{ width: "100%", height: "100%" }}
          interactiveLayerIds={[POINTS_LAYER, RING_LAYER]}
          onClick={onMapClick}
          onMove={onMapMove}
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
          cursor={dragging || hoveringRing ? "ew-resize" : hoveringPoint ? "pointer" : "default"}
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

          {/* The circle the panel is describing, drawn to scale. */}
          {search && (
            <Source id="near-radius" type="geojson" data={ringGeoJson}>
              <Layer id="near-radius-fill" type="fill" paint={{ "fill-color": NEARBY_SEARCH_COLOR, "fill-opacity": 0.08 }} />
              <Layer
                id="near-radius-line"
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

          {/* A neighbour's record answers in the same panel the occurrence map's
              own records do — same fields, same order. */}
          {shown && (
            <MapOccurrenceTooltip
              lat={shown.lat}
              lng={shown.lng}
              images={shown.images}
              fields={nearbyPointFields(
                shown,
                picked.find((p) => search && points[pointsKey(search, p.key)]?.points.includes(shown))?.name
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

        {/* Finding a different place, top-left, where the occurrence map keeps
            the same control. */}
        <div className="absolute left-2 top-2 z-10">
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

        {/* The basemap, on the map it paints. Folded to one button until asked
            for, as on the occurrence map. */}
        <div className="absolute right-2 top-2 z-10 flex flex-col items-end gap-1">
          {basemapOpen ? (
            <div className="flex flex-col overflow-hidden rounded-md border border-zinc-300 bg-white text-[11px] shadow dark:border-zinc-600 dark:bg-zinc-800">
              {(Object.entries(BASEMAP_STYLES) as [BasemapKey, (typeof BASEMAP_STYLES)[BasemapKey]][]).map(([key, opt]) => (
                <button
                  key={key}
                  onClick={() => {
                    setBasemap(key);
                    setBasemapOpen(false);
                  }}
                  className={`px-2 py-1 text-left ${
                    basemap === key
                      ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                      : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-700"
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
              className="rounded-md border border-zinc-300 bg-white p-1.5 text-zinc-600 shadow hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.4-2.7A1 1 0 013 16.4V5.6a1 1 0 011.4-.9L9 7m0 13l6-3m-6 3V7m6 10l4.6 2.3a1 1 0 001.4-.9V7.6a1 1 0 00-.6-.9L15 4m0 13V4m0 0L9 7" />
              </svg>
            </button>
          )}
        </div>

        {/* The page's own controls, over the bottom of the map: the question,
            and the radius it will be asked at. Bottom-centre rather than in a
            bar above the map, because both of them are about the circle on the
            ground and belong next to it. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex flex-col items-center gap-2 px-2">
          {movedAway && search && (
            <button
              onClick={() => {
                const c = mapRef.current?.getCenter();
                if (!c) return;
                setPlacePin(null);
                askAt(c.lat, c.lng, radiusKm, { fly: false });
              }}
              className="pointer-events-auto rounded-full border border-zinc-300 bg-white/95 px-3 py-1 text-xs font-medium text-zinc-700 shadow backdrop-blur hover:bg-white dark:border-zinc-600 dark:bg-zinc-800/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Search here instead
            </button>
          )}
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-full border border-zinc-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-800/95">
            <button
              onClick={findMe}
              disabled={locating === "asking"}
              className="flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="7" />
                <path strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
              </svg>
              {locating === "asking" ? "Finding you…" : "Find threatened species near me"}
            </button>
            <span className="flex items-center gap-1 text-[11px]">
              <span className="text-zinc-500 dark:text-zinc-400">Within</span>
              {NEARBY_RADII_KM.map((r) => (
                <button
                  key={r}
                  onClick={() => changeRadius(r)}
                  className={`rounded border px-1.5 py-0.5 tabular-nums ${
                    r === radiusKm
                      ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                      : "border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  }`}
                >
                  {r} km
                </button>
              ))}
            </span>
          </div>
          {locating === "denied" && (
            <p className="pointer-events-auto max-w-md rounded-md bg-amber-50 px-2 py-1 text-center text-[11px] text-amber-800 shadow dark:bg-amber-900/40 dark:text-amber-200">
              Your browser wouldn&apos;t share a location. Search for a place above, or click anywhere on the map.
            </p>
          )}
          {!search && locating !== "denied" && (
            <p className="pointer-events-auto max-w-md rounded-md bg-white/90 px-2 py-1 text-center text-[11px] text-zinc-600 shadow backdrop-blur dark:bg-zinc-800/90 dark:text-zinc-300">
              Or search for a place, or click anywhere on the map.
            </p>
          )}
          <p className="pointer-events-none text-[10px] text-zinc-500 dark:text-zinc-400">{GEOCODER_ATTRIBUTION}</p>
        </div>
      </div>

      {/* The answer, below the map rather than over it: you cannot read
          "twelve species within 10 km" and look at where they are when the list
          is on top of them. */}
      {search && (
        <div className="h-[45%] min-h-0 shrink-0 p-2 pt-0">
          <NearbySpeciesPanel
            lat={search.lat}
            lng={search.lng}
            recordName={placePin?.name ?? ""}
            radiusKm={search.radiusKm}
            onRadiusChange={changeRadius}
            picked={pickedForPanel}
            onTogglePick={togglePick}
            onClose={() => {
              setSearch(null);
              setPicked([]);
              setShownGroup([]);
            }}
          />
        </div>
      )}
    </div>
  );
}
