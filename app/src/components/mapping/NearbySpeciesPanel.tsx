"use client";

/**
 * The species recorded around a point, and what their assessments blame.
 *
 * Opened by right-clicking a record, so the centre is a collection locality
 * someone actually cares about — this specimen, this observation — rather than
 * wherever the cursor happened to be. It takes the record's own coordinates,
 * not the click's.
 *
 * Threats lead and the species list follows. The summary is the reusable part:
 * "18 of the 41 species recorded within 25 km cite Agriculture" is a line that
 * sends someone to check a threat they hadn't written down, which is the whole
 * point of the panel. The species list underneath is the evidence for it, and
 * is what you read once the summary has told you where to look.
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
  onTogglePick: (species: { key: string; name: string }) => void;
  onClose: () => void;
}

/**
 * What a species' assessors actually wrote about its threats.
 *
 * The codes say which of twelve boxes were ticked; this says what is happening
 * — the plantation, the road, the year the dam went in. It is the sentence an
 * assessor is looking for when they open a neighbour at all, and it is not in
 * any of this dashboard's own data: narratives are fetched one assessment at a
 * time from the IUCN API, which is why this loads on demand rather than coming
 * down with the list.
 */
function ThreatNarrative({ assessmentId }: { assessmentId: number }) {
  const [state, setState] = useState<{ text?: string; error?: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/redlist/assessment/${assessmentId}`, { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
        setState({ text: body.threats ? stripHtml(String(body.threats)) : "" });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({ error: e instanceof Error ? e.message : "Could not load" });
      });
    return () => controller.abort();
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
 * drift apart.
 */
const ROW = "grid grid-cols-[10px_26px_minmax(0,1fr)_58px_54px_30px] gap-1 items-baseline";

/**
 * The panel's one busy indicator, used wherever it waits on GBIF.
 *
 * Both waits here are a second or so of nothing — long enough that a static
 * "looking…" reads as a state rather than as progress.
 */
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

export default function NearbySpeciesPanel({
  lat, lng, recordName, excludeGbifKey, radiusKm, onRadiusChange,
  picked, onTogglePick, onClose,
}: Props) {
  const pickedByKey = useMemo(() => new Map(picked.map((p) => [p.key, p])), [picked]);
  /** Which threat's species are expanded, if any. */
  const [openThreat, setOpenThreat] = useState<string | null>(null);
  /** Which species' threat narrative is open under a threat row. */
  const [openNarrative, setOpenNarrative] = useState<string | null>(null);
  /** Rolled up to its header bar, so the map underneath can be read. */
  const [collapsed, setCollapsed] = useState(false);
  /**
   * The size the reader has dragged it to, if any.
   *
   * Null means the default — a panel that has never been resized should track
   * the map's own height rather than being pinned to whatever pixels suited the
   * window it was first opened in.
   */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  /**
   * Drag the bottom-left corner to resize.
   *
   * The corner, because the panel is anchored top-right: those two edges are
   * fixed, so the free corner is the one that can move without the panel also
   * having to travel. Pointer capture rather than window listeners, so a drag
   * that leaves the panel — which is most of them, since resizing means going
   * outwards — keeps being delivered here.
   */
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const from = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    const onMove = (ev: PointerEvent) => {
      setSize({
        // Leftwards is wider, because the right edge is the fixed one.
        w: Math.max(260, Math.min(760, from.w - (ev.clientX - from.x))),
        h: Math.max(140, Math.min(window.innerHeight - 80, from.h + (ev.clientY - from.y))),
      });
    };
    const onUp = (ev: PointerEvent) => {
      e.currentTarget?.releasePointerCapture?.(ev.pointerId);
      e.currentTarget?.removeEventListener("pointermove", onMove);
      e.currentTarget?.removeEventListener("pointerup", onUp);
    };
    e.currentTarget.addEventListener("pointermove", onMove);
    e.currentTarget.addEventListener("pointerup", onUp);
  }, []);
  /**
   * Which half of the answer is showing.
   *
   * They were stacked, and with a dozen threat rows above it the species list
   * began below the fold of a panel nobody had reason to scroll — the heading
   * that would have told you it was there was itself out of view. Tabs put
   * both counts in permanent sight and give whichever you pick the full
   * height, which at 320px wide is the only way either list gets read.
   */
  const [tab, setTab] = useState<"species" | "threats">("species");
  /**
   * Which taxon's neighbours are listed, or null for all of them.
   *
   * A hundred-odd species across birds, amphibians and plants is a list nobody
   * reads end to end, and an assessor almost always wants one of those groups —
   * the comparable one. Derived from what actually came back rather than from
   * the full taxonomy, so the row only ever offers groups with something in it.
   */
  const [taxon, setTaxon] = useState<string | null>(null);

  /**
   * The answer, tagged with the question it answers.
   *
   * Loading isn't state of its own: it's "what I'm holding doesn't match what's
   * being asked", which the tag makes a comparison rather than a flag to keep in
   * step. That also settles what the panel shows mid-flight — switching 25 km to
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

  // A radius that returns no birds should not keep offering a Birds tab, so the
  // row is rebuilt from each answer and a selection that no longer exists is
  // dropped rather than silently filtering everything away.
  const taxonCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of result?.species ?? []) {
      counts.set(s.taxon_group, (counts.get(s.taxon_group) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [result]);

  // Derived, not corrected after the fact: a group that the new radius no
  // longer has simply stops being the selection, rather than being stored and
  // then filtering the whole list away until an effect catches up.
  const activeTaxon = taxon && taxonCounts.some(([g]) => g === taxon) ? taxon : null;

  const shownSpecies = useMemo(
    () => (result?.species ?? []).filter((s) => !activeTaxon || s.taxon_group === activeTaxon),
    [result, activeTaxon]
  );

  // Escape closes it, the way it dismisses every other mode on this map.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);

  return (
    <div
      className={`absolute top-2 right-2 z-[1001] flex flex-col rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-lg text-[11px] ${
        size ? "" : "w-[26rem] max-h-[75%]"
      }`}
      style={size ? { width: size.w, height: collapsed ? undefined : size.h } : undefined}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-700 shrink-0">
        {/* The same colour as the ring on the map, so the panel and the circle
            it drew read as one thing. */}
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke={NEARBY_SEARCH_COLOR} strokeWidth={2}>
          <circle cx="12" cy="12" r="3" fill={NEARBY_SEARCH_COLOR} stroke="none" />
          <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
        </svg>
        <span className="font-medium text-zinc-700 dark:text-zinc-200 shrink-0">Recorded near</span>
        <span className="italic text-zinc-500 dark:text-zinc-400 truncate" title={`${lat.toFixed(5)}, ${lng.toFixed(5)}`}>
          {recordName}
        </span>
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Show the results again" : "Roll up to the title bar"}
          className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
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
        <button
          onClick={onClose}
          title="Close"
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {!collapsed && (
      <>
      {/* The radius is the panel's one real control, so it sits above the
          answer rather than behind a menu. */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-700 shrink-0">
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
          <span className="ml-auto flex items-center gap-1 text-zinc-400">
            <Spinner />
            looking…
          </span>
        )}
      </div>

      <div className="overflow-y-auto px-2 py-1.5 space-y-2">
        {error && <p className="text-amber-600 dark:text-amber-400">{error}</p>}

        {result && !error && (
          <>
            <p className="text-zinc-500 dark:text-zinc-400">
              {result.species.length === 0 ? (
                <>No assessed threatened species recorded within {result.radiusKm} km.</>
              ) : (
                <>
                  <span className="font-medium text-zinc-700 dark:text-zinc-200">
                    {result.species.length}
                  </span>{" "}
                  threatened or Near Threatened species, from{" "}
                  <span className="tabular-nums">{result.categoryRecords.toLocaleString()}</span> of the{" "}
                  <span className="tabular-nums">{result.totalRecords.toLocaleString()}</span> records here.
                </>
              )}
            </p>

            {result.truncated && (
              <p className="text-amber-600 dark:text-amber-400">
                Only the most-recorded {result.species.length} are shown — there are more here.
              </p>
            )}

            {/* Both counts always visible, so neither list can be the one
                nobody knew was there. */}
            {(result.threats.length > 0 || result.species.length > 0) && (
              <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-700 -mx-2 px-2">
                {([
                  ["species", "Species", result.species.length],
                  ["threats", "Threats", result.threats.length],
                ] as const).map(([id, label, n]) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={`px-1.5 py-1 -mb-px border-b-2 ${
                      tab === id
                        ? "border-blue-500 text-zinc-800 dark:text-zinc-100 font-medium"
                        : "border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                    }`}
                  >
                    {label} <span className="tabular-nums text-zinc-400">{n}</span>
                  </button>
                ))}
              </div>
            )}

            {tab === "threats" && (<>
            {result.threats.length > 0 && (
              <div>
                {result.threats.map((t) => (
                  <div key={t.code}>
                    {/* Each row opens to name the species behind the count:
                        a bare "18 species" is a prompt, but the names are what
                        make it checkable. */}
                    <button
                      onClick={() => setOpenThreat(openThreat === t.code ? null : t.code)}
                      className="w-full flex items-center gap-1.5 py-0.5 text-left hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      <span className="tabular-nums text-zinc-500 dark:text-zinc-400 w-6 text-right shrink-0">
                        {t.species}
                      </span>
                      {/* A bar, because the shape of the list is the finding —
                          one dominant pressure reads differently from six even
                          ones, and the counts alone don't show that. */}
                      <span className="h-2 rounded-sm bg-blue-500/70 dark:bg-blue-400/70 shrink-0"
                        style={{ width: `${Math.max(4, (t.species / result.threats[0].species) * 72)}px` }}
                      />
                      <span className="truncate text-zinc-700 dark:text-zinc-200">{t.label}</span>
                    </button>
                    {/* One species per line, not a run-on sentence: these are
                        things to open, and a comma-joined list gives a reader
                        nothing to aim at. */}
                    {openThreat === t.code && (
                      <div className="pl-8 pb-1 leading-snug">
                        {t.examples.map((e) => (
                          <div key={e.key} className="py-px">
                            <button
                              onClick={() =>
                                setOpenNarrative((prev) => (prev === e.key ? null : e.key))
                              }
                              disabled={e.assessmentId == null}
                              title={
                                e.assessmentId == null
                                  ? "No assessment to read"
                                  : openNarrative === e.key
                                    ? "Hide what its assessment says about threats"
                                    : "Read what its assessment says about threats"
                              }
                              className="italic text-left text-zinc-600 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 disabled:hover:text-zinc-600 disabled:opacity-60"
                            >
                              {e.name}
                            </button>
                            {openNarrative === e.key && e.assessmentId != null && (
                              <div className="pl-2 mt-0.5 mb-1 border-l-2 border-zinc-200 dark:border-zinc-700 pl-2">
                                <ThreatNarrative assessmentId={e.assessmentId} />
                              </div>
                            )}
                          </div>
                        ))}
                        {t.species > t.examples.length && (
                          <div className="text-zinc-400 py-px">
                            and {t.species - t.examples.length} more
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            </>)}

            {tab === "species" && (<>
            {/* One row of groups, biggest first. Horizontally scrollable rather
                than wrapped: a wrapped row of a dozen groups would push the
                list itself back below the fold, which is the problem the tabs
                above exist to solve. */}
            {taxonCounts.length > 1 && (
              <div className="flex gap-1 overflow-x-auto pb-0.5 -mx-2 px-2">
                {([[null, "All", result.species.length], ...taxonCounts.map(
                  ([g, n]) => [g, taxonLabel(g), n] as const
                )] as readonly (readonly [string | null, string, number])[]).map(([id, label, n]) => (
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
              <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
                {/* A table, not a list of paragraphs: the reason to look at a
                    hundred neighbours at once is to compare them, and comparing
                    needs the record counts and the years under one another
                    rather than trailing each name. The header stays put while
                    the rows scroll under it. */}
                <div className={`${ROW} sticky top-0 bg-white dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 pb-0.5 border-b border-zinc-100 dark:border-zinc-800`}>
                  <span />
                  <span />
                  <span>Species</span>
                  <span>Taxon</span>
                  <span className="text-right">Recs</span>
                  <span className="text-right">Yr</span>
                </div>
                {shownSpecies.map((s) => {
                  const pick = pickedByKey.get(s.gbif_species_key);
                  return (
                    <div
                      key={s.gbif_species_key}
                      className={`${ROW} py-[3px] border-b border-zinc-50 dark:border-zinc-800/60 ${
                        pick ? "bg-zinc-50 dark:bg-zinc-700/40" : ""
                      }`}
                    >
                      {/* The dot the map is drawing it with, in its own colour
                          — the row and the mark have to be readable as the same
                          thing without counting positions. */}
                      <span className="flex items-center h-3">
                        {pick && (
                          <span
                            className="w-2 h-2 rounded-full border border-white"
                            style={{ backgroundColor: pick.color }}
                          />
                        )}
                      </span>
                      <span
                        className="px-1 rounded text-[9px] font-medium text-white tabular-nums text-center"
                        style={{ backgroundColor: CATEGORY_COLORS[normalizeCategory(s.category)] ?? "#6b7280" }}
                        title={s.criteria ? `Assessed ${s.category} under ${s.criteria}` : `Assessed ${s.category}`}
                      >
                        {s.category}
                      </span>
                      {/* Two lines. Side by side, the common name and the
                          binomial each ate the other's width and both ended as
                          stubs; stacked, the identifier gets the row and the
                          name most people hold the species by sits under it. */}
                      <span className="min-w-0">
                        <span className="flex items-baseline gap-1">
                          <button
                            onClick={() => onTogglePick({ key: s.gbif_species_key, name: s.scientific_name })}
                            title={pick ? "Stop drawing this species" : "Draw this species' records on the map"}
                            className="italic text-left truncate text-zinc-700 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400"
                          >
                            {s.scientific_name}
                          </button>
                          <a
                            href={nearbyGbifSiteUrl({ lat, lng, radiusKm: result.radiusKm, speciesKey: s.gbif_species_key })}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open these records on GBIF"
                            className="shrink-0 text-zinc-300 hover:text-blue-600 dark:text-zinc-600 dark:hover:text-blue-400"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5L10 14M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-3" />
                            </svg>
                          </a>
                        </span>
                        {s.common_name && (
                          <span className="block truncate text-zinc-400" title={s.common_name}>
                            {s.common_name}
                          </span>
                        )}
                      </span>
                      <span className="truncate text-zinc-400" title={taxonLabel(s.taxon_group)}>
                        {taxonLabel(s.taxon_group)}
                      </span>
                      <span className="text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                        {s.records}
                        {/* Under the count it qualifies: how many of them the
                            map is actually drawing. */}
                        {pick && (
                          <span
                            className="block whitespace-nowrap"
                            style={{ color: pick.color }}
                            title={
                              pick.drawn == null
                                ? "Drawing this species' records"
                                : pick.drawn.total > pick.drawn.shown
                                  ? `${pick.drawn.shown} of ${pick.drawn.total} records drawn on the map`
                                  : `All ${pick.drawn.shown} drawn on the map`
                            }
                          >
                            {pick.drawn == null
                              ? <Spinner />
                              : pick.drawn.total > pick.drawn.shown
                                ? `${pick.drawn.shown}/${pick.drawn.total}`
                                : `${pick.drawn.shown} ✓`}
                          </span>
                        )}
                      </span>
                      <span className="text-right tabular-nums text-zinc-400">
                        {s.assessment_year ?? "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            </>)}

            {result.unmatched > 0 && (
              <p className="text-zinc-400">
                {result.unmatched} more had no assessment in this dashboard&rsquo;s data.
              </p>
            )}

            <p className="pt-1 border-t border-zinc-100 dark:border-zinc-800 text-zinc-400 leading-snug">
              {NEARBY_RECORDS_NOTE} {NEARBY_STALENESS_NOTE}
            </p>
          </>
        )}
      </div>
      {/* The one corner that can move: the top and right edges are what the
          panel is anchored by. */}
      <div
        onPointerDown={startResize}
        title="Drag to resize"
        className="absolute bottom-0 left-0 w-3 h-3 cursor-nesw-resize text-zinc-300 dark:text-zinc-600"
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.2}>
          <path d="M11 1L1 11M11 5L5 11M11 9l-2 2" />
        </svg>
      </div>
      </>
      )}
    </div>
  );
}
