"use client";

/**
 * The species recorded around a record, and what their assessments blame.
 *
 * Opened from a record's own panel, so the centre is a collection locality
 * someone actually cares about — this specimen, this observation — rather than
 * wherever the cursor happened to be. It takes the record's own coordinates,
 * not the click's.
 *
 * It sits below the map rather than over it. Floated, it covered the very
 * ground it was describing: you cannot read "twelve species within 10 km" and
 * look at where they are when the list is on top of them. In flow it also gets
 * the full width, which is what lets the threats be a column rather than a tab
 * of their own.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CATEGORY_COLORS, normalizeCategory } from "@/config/taxa";
import { findNode } from "@/lib/taxonomy-utils";
import { stripHtml } from "@/lib/html-text";
import {
  NEARBY_RADII_KM,
  NEARBY_RECORDS_NOTE,
  NEARBY_SEARCH_COLOR,
  NEARBY_STALENESS_NOTE,
  nearbyGbifSiteUrl,
  type NearbyRadiusKm,
  type NearbyResult,
  type NearbySpecies,
} from "@/lib/mapping/nearby-species";

interface Props {
  lat: number;
  lng: number;
  /** The record the radius is centred on, named in the header. */
  recordName: string;
  /** The species whose map this is — never its own neighbour. */
  excludeGbifKey?: string | null;
  /** Controlled by the map, which draws this radius on the ground. */
  radiusKm: NearbyRadiusKm;
  onRadiusChange: (km: NearbyRadiusKm) => void;
  /** The neighbours the map is drawing, with the colour each was given. */
  picked: { key: string; color: string; drawn: { shown: number; total: number } | null }[];
  onTogglePick: (species: { key: string; name: string; commonName: string | null }) => void;
  onClose: () => void;
}

/**
 * Assessment narratives already fetched, for the life of the page.
 *
 * The route caches these for an hour and sets cache headers, but that is a
 * serverless function's memory and it is short. This is the one that stops the
 * IUCN API being asked twice for the same paragraph because someone closed a
 * row and opened it again — which, in a panel built for comparing neighbours,
 * is exactly what people do.
 */
const narrativeCache = new Map<number, { text?: string; error?: string }>();

/**
 * Fetches already in the air, so two mounts of the same row make one request.
 *
 * The cache above only helps once an answer has come back. React mounts an
 * effect twice in development, and re-opening a row while its first fetch is
 * still running is an ordinary thing to do — both would miss the cache and ask
 * the IUCN API again. Sharing the promise means the second caller waits on the
 * first rather than starting another.
 */
const narrativeInFlight = new Map<number, Promise<{ text?: string; error?: string }>>();

function fetchNarrative(assessmentId: number) {
  const running = narrativeInFlight.get(assessmentId);
  if (running) return running;
  // No abort signal, deliberately. The promise is shared, so tying it to one
  // caller's lifetime lets that caller's unmount cancel the fetch the next one
  // is waiting on — which is exactly what a double-mounted effect does, and it
  // left the row saying "reading the assessment…" forever. It is one small GET
  // whose answer is worth caching even if nobody is still looking.
  const p = fetch(`/api/redlist/assessment/${assessmentId}`)
    .then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
      const next = { text: body.threats ? stripHtml(String(body.threats)) : "" };
      narrativeCache.set(assessmentId, next);
      return next;
    })
    .finally(() => narrativeInFlight.delete(assessmentId));
  narrativeInFlight.set(assessmentId, p);
  return p;
}

/**
 * What a species' assessors actually wrote about its threats.
 *
 * The codes say which boxes were ticked; this says what is happening — the
 * plantation, the road, the year the dam went in. Not in this dashboard's own
 * data: narratives are fetched one assessment at a time from the IUCN API,
 * which is why this loads on demand rather than coming down with the list.
 */
function ThreatNarrative({ assessmentId }: { assessmentId: number }) {
  const [state, setState] = useState<{ text?: string; error?: string } | null>(
    () => narrativeCache.get(assessmentId) ?? null
  );

  useEffect(() => {
    if (narrativeCache.has(assessmentId)) return;
    let live = true;
    fetchNarrative(assessmentId)
      .then((next) => {
        if (live) setState(next);
      })
      .catch((e: unknown) => {
        // Deliberately not cached: a failure is usually the network rather than
        // the assessment, and should be retryable by opening the row again.
        if (live) setState({ error: e instanceof Error ? e.message : "Could not load" });
      });
    return () => {
      live = false;
    };
  }, [assessmentId]);

  if (state == null) {
    return (
      <span className="inline-flex items-center gap-1 text-zinc-400">
        <Spinner />
        reading the assessment…
      </span>
    );
  }
  if (state.error) return <span className="text-amber-600 dark:text-amber-400">{state.error}</span>;
  if (!state.text) return <span className="text-zinc-400">This assessment records no threats text.</span>;
  return <span className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">{state.text}</span>;
}

/**
 * The table's column track, shared by the header and every row so the two can't
 * drift apart. Below the map there is width enough for threats to be a column.
 */
const ROW =
  "grid grid-cols-[12px_28px_minmax(9rem,1.4fr)_5rem_minmax(8rem,2fr)_4.5rem_2.5rem] gap-2 items-baseline px-2";

/** The panel's one busy indicator, used wherever it waits on a service. */
function Spinner() {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin"
      aria-hidden
    />
  );
}

/** "flowering_plants" → "Flowering Plants", falling back to the raw group. */
function taxonLabel(taxonGroup: string): string {
  return findNode(taxonGroup)?.name ?? taxonGroup.replace(/_/g, " ");
}

/** The species' page on iucnredlist.org, where an assessment is read in full. */
function redListUrl(s: NearbySpecies): string | null {
  if (s.sis_taxon_id == null) return null;
  return s.assessment_id == null
    ? `https://www.iucnredlist.org/species/${s.sis_taxon_id}`
    : `https://www.iucnredlist.org/species/${s.sis_taxon_id}/${s.assessment_id}`;
}

export default function NearbySpeciesPanel({
  lat, lng, recordName, excludeGbifKey, radiusKm, onRadiusChange,
  picked, onTogglePick, onClose,
}: Props) {
  const pickedByKey = useMemo(() => new Map(picked.map((p) => [p.key, p])), [picked]);
  /** Which species' action menu is open. */
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  /** Which species' threat narrative is showing under its row. */
  const [openNarrative, setOpenNarrative] = useState<string | null>(null);
  /** Which taxon's neighbours are listed, or null for all of them. */
  const [taxon, setTaxon] = useState<string | null>(null);
  /** Rolled up to its header bar, so the map above has the room back. */
  const [collapsed, setCollapsed] = useState(false);
  /** The height the reader has dragged it to; null means the default. */
  const [height, setHeight] = useState<number | null>(null);

  /**
   * The answer, tagged with the question it answers.
   *
   * Loading isn't state of its own: it's "what I'm holding doesn't match what's
   * being asked", which the tag makes a comparison rather than a flag to keep in
   * step. That also settles what the panel shows mid-flight — switching 10 km to
   * 50 km blanks the old list instead of leaving it up, labelled 50, until the
   * new one lands.
   */
  const [answer, setAnswer] = useState<{ key: string; result?: NearbyResult; error?: string } | null>(null);

  const key = `${lat},${lng},${radiusKm},${excludeGbifKey ?? ""}`;
  const loading = answer?.key !== key;
  const result = answer?.key === key ? answer.result : undefined;
  const error = answer?.key === key ? answer.error : undefined;

  useEffect(() => {
    // A radius switched twice quickly would otherwise be free to land in the
    // order the network felt like, not the order it was asked in.
    const controller = new AbortController();
    const params = new URLSearchParams({ lat: String(lat), lng: String(lng), radiusKm: String(radiusKm) });
    if (excludeGbifKey) params.set("exclude", excludeGbifKey);
    fetch(`/api/nearby-species?${params}`, { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
        setAnswer({ key, result: body as NearbyResult });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setAnswer({ key, error: e instanceof Error ? e.message : "Lookup failed" });
      });
    return () => controller.abort();
  }, [lat, lng, radiusKm, excludeGbifKey, key]);

  // A radius that returns no birds should not keep offering a Birds chip, so
  // the row is rebuilt from each answer.
  const taxonCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of result?.species ?? []) counts.set(s.taxon_group, (counts.get(s.taxon_group) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [result]);

  // Derived, not corrected after the fact: a group the new radius no longer has
  // simply stops being the selection.
  const activeTaxon = taxon && taxonCounts.some(([g]) => g === taxon) ? taxon : null;
  const shownSpecies = useMemo(
    () => (result?.species ?? []).filter((s) => !activeTaxon || s.taxon_group === activeTaxon),
    [result, activeTaxon]
  );

  // Escape backs out of the open menu first, and closes the panel only when
  // there is nothing smaller to dismiss.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openMenu) setOpenMenu(null);
      else onClose();
    },
    [onClose, openMenu]
  );
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);

  /**
   * Drag the bottom edge to make room.
   *
   * In flow under the map, width belongs to the layout — height is the only
   * dimension the reader has an opinion about, and a threat narrative is a
   * paragraph rather than a field.
   */
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const body = handle.previousElementSibling;
    if (!body) return;
    const from = { y: e.clientY, h: body.getBoundingClientRect().height };
    const onMove = (ev: PointerEvent) =>
      setHeight(Math.max(120, Math.min(window.innerHeight - 120, from.h + (ev.clientY - from.y))));
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }, []);

  return (
    <div className="w-full rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-md text-[11px] flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-700 shrink-0">
        {/* The same colour as the ring on the map, so the panel and the circle
            it drew read as one thing. */}
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke={NEARBY_SEARCH_COLOR} strokeWidth={2}>
          <circle cx="12" cy="12" r="3" fill={NEARBY_SEARCH_COLOR} stroke="none" />
          <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
        </svg>
        <span className="font-medium text-zinc-700 dark:text-zinc-200 shrink-0">Recorded near</span>
        <span
          className="italic text-zinc-500 dark:text-zinc-400 truncate"
          title={`${lat.toFixed(5)}, ${lng.toFixed(5)}`}
        >
          {recordName}
        </span>

        <span className="ml-auto flex items-center gap-1 shrink-0">
          <span className="text-zinc-500 dark:text-zinc-400">Within</span>
          {NEARBY_RADII_KM.map((r) => (
            <button
              key={r}
              onClick={() => onRadiusChange(r)}
              className={`px-1.5 py-0.5 rounded border tabular-nums ${
                r === radiusKm
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                  : "border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"
              }`}
            >
              {r} km
            </button>
          ))}
          {loading && (
            <span className="flex items-center gap-1 pl-1 text-zinc-400">
              <Spinner />
              looking…
            </span>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Show the results again" : "Roll up to the title bar"}
            className="pl-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <svg
              className={`w-3 h-3 transition-transform ${collapsed ? "" : "rotate-180"}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 15l-7-7-7 7" />
            </svg>
          </button>
          <button onClick={onClose} title="Close" className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      </div>

      {!collapsed && (
        <>
          <div
            className="overflow-y-auto py-1.5"
            style={height ? { height } : { maxHeight: "24rem" }}
          >
            {error && <p className="px-2 text-amber-600 dark:text-amber-400">{error}</p>}

            {result && !error && (
              <>
                <p className="px-2 pb-1 text-zinc-500 dark:text-zinc-400">
                  {result.species.length === 0 ? (
                    <>No assessed threatened species recorded within {result.radiusKm} km.</>
                  ) : (
                    <>
                      <span className="font-medium text-zinc-700 dark:text-zinc-200">{result.species.length}</span>{" "}
                      threatened or Near Threatened species, from{" "}
                      <span className="tabular-nums">{result.categoryRecords.toLocaleString()}</span> of the{" "}
                      <span className="tabular-nums">{result.totalRecords.toLocaleString()}</span> records here.
                      {result.truncated && (
                        <span className="text-amber-600 dark:text-amber-400">
                          {" "}
                          Only the most-recorded are shown — there are more here.
                        </span>
                      )}
                    </>
                  )}
                </p>

                {taxonCounts.length > 1 && (
                  <div className="flex flex-wrap gap-1 px-2 pb-1.5">
                    {(
                      [
                        [null, "All", result.species.length],
                        ...taxonCounts.map(([g, n]) => [g, taxonLabel(g), n] as const),
                      ] as readonly (readonly [string | null, string, number])[]
                    ).map(([id, label, n]) => (
                      <button
                        key={id ?? "all"}
                        onClick={() => setTaxon(id)}
                        className={`shrink-0 px-1.5 py-0.5 rounded-full border tabular-nums ${
                          activeTaxon === id
                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                            : "border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                        }`}
                      >
                        {label} <span className="text-zinc-400">{n}</span>
                      </button>
                    ))}
                  </div>
                )}

                {shownSpecies.length > 0 && (
                  <div>
                    <div
                      className={`${ROW} sticky top-0 bg-white dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 pb-0.5 border-b border-zinc-100 dark:border-zinc-800`}
                    >
                      <span />
                      <span />
                      <span>Species</span>
                      <span>Taxon</span>
                      <span>Threats</span>
                      <span className="text-right">Records</span>
                      <span className="text-right">Yr</span>
                    </div>
                    {shownSpecies.map((s) => {
                      const pick = pickedByKey.get(s.gbif_species_key);
                      const url = redListUrl(s);
                      return (
                        <div key={s.gbif_species_key} className="border-b border-zinc-50 dark:border-zinc-800/60">
                          <div className={`${ROW} py-[3px] ${pick ? "bg-zinc-50 dark:bg-zinc-700/40" : ""}`}>
                            {/* The dot the map is drawing it with, in its own
                                colour — the row and the mark have to read as the
                                same thing without counting positions. */}
                            <span className="flex h-3 items-center">
                              {pick && (
                                <span
                                  className="h-2 w-2 rounded-full border border-white"
                                  style={{ backgroundColor: pick.color }}
                                />
                              )}
                            </span>
                            <span
                              className="rounded px-1 text-center text-[9px] font-medium tabular-nums text-white"
                              style={{ backgroundColor: CATEGORY_COLORS[normalizeCategory(s.category)] ?? "#6b7280" }}
                              title={s.criteria ? `Assessed ${s.category} under ${s.criteria}` : `Assessed ${s.category}`}
                            >
                              {s.category}
                            </span>

                            {/* The name opens what can be done with this species
                                rather than doing one of those things. Drawing its
                                records used to happen on the click itself, which
                                left the assessment reachable only through a click
                                that also changed the map. */}
                            <span className="relative min-w-0">
                              <button
                                onClick={() =>
                                  setOpenMenu((prev) => (prev === s.gbif_species_key ? null : s.gbif_species_key))
                                }
                                title="What you can do with this species"
                                className="w-full truncate text-left italic text-zinc-700 hover:text-blue-600 dark:text-zinc-200 dark:hover:text-blue-400"
                              >
                                {s.scientific_name}
                              </button>
                              {s.common_name && (
                                <span className="block truncate text-zinc-400" title={s.common_name}>
                                  {s.common_name}
                                </span>
                              )}
                              {openMenu === s.gbif_species_key && (
                                <span className="absolute left-0 top-full z-[1002] mt-0.5 block w-max min-w-[13rem] rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                                  <button
                                    onClick={() => {
                                      onTogglePick({
                                        key: s.gbif_species_key,
                                        name: s.scientific_name,
                                        commonName: s.common_name,
                                      });
                                      setOpenMenu(null);
                                    }}
                                    className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-700"
                                  >
                                    <span
                                      className="h-2 w-2 shrink-0 rounded-full border border-white"
                                      style={{ backgroundColor: pick?.color ?? "#9ca3af" }}
                                    />
                                    {pick ? "Hide records from map" : "Show records on map"}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setOpenNarrative((prev) =>
                                        prev === s.gbif_species_key ? null : s.gbif_species_key
                                      );
                                      setOpenMenu(null);
                                    }}
                                    disabled={s.assessment_id == null}
                                    className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-zinc-700"
                                  >
                                    <svg
                                      className="h-3 w-3 shrink-0 text-zinc-400"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                      strokeWidth={2}
                                    >
                                      <path strokeLinecap="round" d="M4 6h16M4 10h16M4 14h10M4 18h7" />
                                    </svg>
                                    {openNarrative === s.gbif_species_key
                                      ? "Hide what it says about threats"
                                      : "What it says about threats"}
                                  </button>
                                  {url && (
                                    <a
                                      href={url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={() => setOpenMenu(null)}
                                      className="flex w-full items-center gap-1.5 rounded px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                                    >
                                      <svg
                                        className="h-3 w-3 shrink-0 text-zinc-400"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                      >
                                        <path
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          d="M14 5h5v5m0-5L10 14M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-3"
                                        />
                                      </svg>
                                      Open the Red List assessment
                                    </a>
                                  )}
                                  <a
                                    href={nearbyGbifSiteUrl({
                                      lat,
                                      lng,
                                      radiusKm: result.radiusKm,
                                      speciesKey: s.gbif_species_key,
                                    })}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => setOpenMenu(null)}
                                    className="flex w-full items-center gap-1.5 rounded px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                                  >
                                    <svg
                                      className="h-3 w-3 shrink-0 text-zinc-400"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                      strokeWidth={2}
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M14 5h5v5m0-5L10 14M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-3"
                                      />
                                    </svg>
                                    These records on GBIF
                                  </a>
                                </span>
                              )}
                            </span>

                            <span className="truncate text-zinc-400" title={taxonLabel(s.taxon_group)}>
                              {taxonLabel(s.taxon_group)}
                            </span>

                            {/* The threats as tags, which is what replaced a tab
                                of their own: on the row they can be compared down
                                the column instead of being a second thing to go
                                and look at. Two levels deep, so "5.4" reads as
                                Fishing & harvesting rather than as a leaf. */}
                            <span className="flex flex-wrap gap-0.5">
                              {s.threat_tags.length === 0 && (
                                <span className="text-zinc-300 dark:text-zinc-600">—</span>
                              )}
                              {s.threat_tags.map((t) => (
                                <span
                                  key={t.code}
                                  title={`${t.code} ${t.label}`}
                                  className="rounded bg-zinc-100 px-1 tabular-nums text-zinc-500 dark:bg-zinc-700 dark:text-zinc-300"
                                >
                                  {t.code}
                                </span>
                              ))}
                            </span>

                            <span className="text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                              {s.records}
                              {pick && (
                                <span
                                  className="block whitespace-nowrap"
                                  style={{ color: pick.color }}
                                  title={
                                    pick.drawn == null
                                      ? "Drawing this species' records"
                                      : pick.drawn.total > pick.drawn.shown
                                        ? `${pick.drawn.shown} of ${pick.drawn.total} records drawn`
                                        : `All ${pick.drawn.shown} drawn`
                                  }
                                >
                                  {pick.drawn == null ? (
                                    <Spinner />
                                  ) : pick.drawn.total > pick.drawn.shown ? (
                                    `${pick.drawn.shown}/${pick.drawn.total}`
                                  ) : (
                                    `${pick.drawn.shown} ✓`
                                  )}
                                </span>
                              )}
                            </span>
                            <span className="text-right tabular-nums text-zinc-400">{s.assessment_year ?? "—"}</span>
                          </div>

                          {openNarrative === s.gbif_species_key && s.assessment_id != null && (
                            <div className="px-2 pb-1.5 pl-12 leading-snug">
                              <ThreatNarrative assessmentId={s.assessment_id} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <p className="px-2 pt-1.5 leading-snug text-zinc-400">
                  {result.unmatched > 0 && `${result.unmatched} more had no assessment in this dashboard's data. `}
                  {NEARBY_RECORDS_NOTE} {NEARBY_STALENESS_NOTE}
                </p>
              </>
            )}
          </div>

          {/* Drag the bottom edge for more room; width belongs to the layout. */}
          <div
            onPointerDown={startResize}
            title="Drag to resize"
            className="h-1.5 shrink-0 cursor-ns-resize rounded-b-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-700 dark:hover:bg-zinc-600"
          />
        </>
      )}
    </div>
  );
}
