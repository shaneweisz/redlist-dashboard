"use client";

import { useEffect, useRef, useState } from "react";
import {
  GEOCODER_ATTRIBUTION,
  formatKind,
  googleMapsSearchUrl,
  searchPlaces,
  type Place,
} from "@/lib/mapping/geocode";
import { parseCoordinatePair } from "@/lib/mapping/georeferences";

interface MapPlaceSearchProps {
  /** Where the map is looking, so results near it rank first. Read at search
   *  time rather than passed as state: the map moves constantly, and none of
   *  those moves should re-render this. */
  getCentre?: () => { lat: number; lng: number; zoom: number } | undefined;
  onSelect: (place: Place) => void;
  /** Pointing at a candidate marks it on the map, without moving the camera. */
  onPreview: (place: Place | null) => void;
}

/**
 * Finds the locality written on a specimen label.
 *
 * A magnifier until it is asked for, then a field. It stands over the map's
 * top-left corner — which on a species with a northern or western range is
 * where the records are — and it is reached for occasionally, where the map
 * under it is read constantly. Typed into, it stays open with whatever was
 * typed still in it; empty, Escape or a click on the map puts it away.
 *
 * Typing a coordinate pair works too — "1.1958, -76.9256" offers to fly
 * straight there. It isn't advertised in the placeholder, because a label
 * naming two different things it accepts is harder to read than one naming the
 * thing it's for; pasting coordinates is a habit people already have.
 */
export default function MapPlaceSearch({ getCentre, onSelect, onPreview }: MapPlaceSearchProps) {
  const [query, setQuery] = useState("");
  /** Whether the field is showing, or just the magnifier that opens it. */
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Held as a bare element, because it is the button when the field is
  // closed and the field's wrapper when it is open — the outside-click handler
  // wants whichever of the two is on screen.
  const rootRef = useRef<HTMLElement | null>(null);

  const coordinates = parseCoordinatePair(query);

  // Debounced, and never per-keystroke: Photon is a free service and a search
  // on every letter is both rude and slower than the typing.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2 || coordinates) {
      setResults([]);
      setFailed(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setFailed(false);
      const centre = getCentre?.();
      searchPlaces(trimmed, {
        lat: centre?.lat,
        lng: centre?.lng,
        zoom: centre?.zoom,
        signal: controller.signal,
      })
        .then((places) => {
          setResults(places);
          setLoading(false);
        })
        .catch((error) => {
          if (error?.name === "AbortError") return;
          setResults([]);
          setFailed(true);
          setLoading(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // The map moves constantly; re-searching because it did would be noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  /**
   * Clicking away puts the results list away, and the field with it when
   * nothing has been typed — a search you are part way through is not
   * something to lose by looking at the map it is about.
   */
  const [showResults, setShowResults] = useState(false);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setShowResults(false);
      if (query.trim() === "") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [query]);

  // Opened, it should be ready to type into: the click that opened it was the
  // reader already reaching for the keyboard.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const choose = (place: Place) => {
    onPreview(null);
    onSelect(place);
    setShowResults(false);
  };

  if (!open) {
    return (
      <button
        ref={rootRef as React.Ref<HTMLButtonElement>}
        onClick={() => setOpen(true)}
        title="Search for a locality"
        aria-label="Search for a locality"
        aria-expanded={false}
        className="p-1.5 rounded-lg bg-white dark:bg-zinc-800 shadow-md border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
        </svg>
      </button>
    );
  }

  return (
    <div ref={rootRef as React.Ref<HTMLDivElement>} className="w-56 max-w-[80vw]">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 shadow-md focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400 transition-colors">
        <svg className="w-4 h-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShowResults(true);
          }}
          onFocus={() => setShowResults(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setShowResults(false);
              // The first Escape drops the search, the second the field: a
              // mistyped locality shouldn't cost the box as well.
              if (query !== "") setQuery("");
              else setOpen(false);
              return;
            }
            if (e.key === "Enter") {
              if (coordinates) {
                choose({
                  id: "coords",
                  name: `${coordinates.lat}, ${coordinates.lon}`,
                  context: "",
                  lat: coordinates.lat,
                  lng: coordinates.lon,
                });
              } else if (results[0]) {
                choose(results[0]);
              }
            }
          }}
          placeholder="Search for a locality"
          className="flex-1 min-w-0 bg-transparent text-[13px] text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-500 dark:placeholder:text-zinc-400 focus:outline-none"
        />
        {query !== "" && (
          <>
            <button
              onClick={() => setQuery("")}
              title="Clear"
              className="shrink-0 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {/* The same search, run by Google. What's behind this box is
                OpenStreetMap's gazetteer, which is very good on what has been
                mapped and silent on what hasn't — and half the names on a
                herbarium label are known only to Google. */}
            <a
              href={googleMapsSearchUrl(query)}
              target="_blank"
              rel="noopener noreferrer"
              title="Run this search in Google Maps, in a new tab"
              aria-label="Search Google Maps for this locality"
              data-open-google-maps
              className="shrink-0 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              {/* Material Symbols' folded map (Apache 2.0): a map to open,
                  rather than Google Maps' own pin, which in here would read as
                  the pins this map already drops. */}
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z" />
              </svg>
            </a>
          </>
        )}
      </div>

      {showResults && (coordinates || results.length > 0 || loading || failed || query.trim().length >= 2) && (
        <div className="mt-1 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-lg overflow-hidden text-xs">
          {coordinates ? (
            <button
              onClick={() =>
                choose({
                  id: "coords",
                  name: `${coordinates.lat}, ${coordinates.lon}`,
                  context: "",
                  lat: coordinates.lat,
                  lng: coordinates.lon,
                })
              }
              className="block w-full text-left px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            >
              <span className="text-zinc-800 dark:text-zinc-100 tabular-nums">
                {coordinates.lat}, {coordinates.lon}
              </span>
              <span className="block text-[10px] text-zinc-400">Go to these coordinates</span>
            </button>
          ) : loading ? (
            <div className="px-2 py-1.5 text-zinc-400">Searching…</div>
          ) : failed ? (
            <div className="px-2 py-1.5 text-amber-600 dark:text-amber-400">Couldn&apos;t reach the search service.</div>
          ) : results.length === 0 ? (
            <div className="px-2 py-1.5 text-zinc-400">No places found.</div>
          ) : (
            <div onMouseLeave={() => onPreview(null)}>
              {results.map((place) => (
                <button
                  key={place.id}
                  onClick={() => choose(place)}
                  onMouseEnter={() => onPreview(place)}
                  onMouseLeave={() => onPreview(null)}
                  onFocus={() => onPreview(place)}
                  onBlur={() => onPreview(null)}
                  className="block w-full text-left px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 border-b border-zinc-100 dark:border-zinc-700 last:border-b-0"
                >
                  <span className="text-zinc-800 dark:text-zinc-100">{place.name}</span>
                  {place.kind && (
                    <span className="ml-1 text-[10px] text-zinc-400">{formatKind(place.kind)}</span>
                  )}
                  {place.context && (
                    <span className="block text-[10px] text-zinc-400 truncate">{place.context}</span>
                  )}
                </button>
              ))}
              <div className="px-2 py-1 text-[9px] text-zinc-400 bg-zinc-50 dark:bg-zinc-900/40">
                {GEOCODER_ATTRIBUTION}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
