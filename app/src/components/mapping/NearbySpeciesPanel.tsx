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
import { linkCitations, type AssessmentReference } from "@/lib/mapping/nearby-citations";
import {
  NEARBY_RADII_KM,
  NEARBY_RECORDS_NOTE,
  NEARBY_SEARCH_COLOR,
  THREAT_TOP_LEVEL,
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
/** One assessment's prose and structured threats, as the route returns them. */
interface Assessment {
  rationale?: string | null;
  range?: string | null;
  habitat?: string | null;
  use_trade?: string | null;
  conservation_actions?: string | null;
  threats?: string | null;
  threat_classification?:
    | { code: string; name: string; timing: string | null; scope: string | null; severity: string | null; score: string | null }[]
    | null;
  references?: AssessmentReference[];
}

type Loaded = { assessment?: Assessment; error?: string };

/**
 * Assessments already fetched, for the life of the page.
 *
 * One request brings every section down together, so opening a row pays once
 * and the tabs are free after that. The route caches for an hour and sets cache
 * headers, but that is a serverless function's memory and it is short; this is
 * the one that stops the IUCN API being asked twice because a row was closed
 * and opened again — which, in a panel built for comparing neighbours, is
 * exactly what people do.
 */
const assessmentCache = new Map<number, Loaded>();

/** Requests already in the air, so two mounts of a row make one request. */
const assessmentInFlight = new Map<number, Promise<Loaded>>();

function fetchAssessment(assessmentId: number) {
  const running = assessmentInFlight.get(assessmentId);
  if (running) return running;
  // No abort signal, deliberately. The promise is shared, so tying it to one
  // caller's lifetime lets that caller's unmount cancel the fetch the next one
  // is waiting on — which is what a double-mounted effect does, and it left the
  // row loading forever. It is one small GET worth caching either way.
  const p = fetch(`/api/redlist/assessment/${assessmentId}`)
    .then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
      const next: Loaded = { assessment: body as Assessment };
      assessmentCache.set(assessmentId, next);
      return next;
    })
    .finally(() => assessmentInFlight.delete(assessmentId));
  assessmentInFlight.set(assessmentId, p);
  return p;
}

/**
 * The sections of an assessment worth reading beside a neighbour's row.
 *
 * Threats first because that is what the panel is for; the rest are here
 * because once the request has been made they cost nothing, and an assessor
 * comparing neighbours wants the range and the habitat as often as not.
 */
const SECTIONS = [
  ["threats", "Threats"],
  ["rationale", "Rationale"],
  ["range", "Range"],
  ["habitat", "Habitat"],
  ["use_trade", "Use & trade"],
  ["conservation_actions", "Actions"],
] as const;
type SectionKey = (typeof SECTIONS)[number][0];

/** Prose with its in-text citations turned into things you can open. */
function Prose({ text, references }: { text: string; references: AssessmentReference[] }) {
  const [open, setOpen] = useState<number | null>(null);
  /**
   * Keep the reference on screen.
   *
   * A citation near the right edge opens a tooltip that runs off it, and
   * nothing in CSS alone knows how far. Measured in a ref callback rather than
   * an effect: it needs the laid-out box, and this way there is no state to
   * keep in step with it.
   */
  const place = useCallback((el: HTMLSpanElement | null) => {
    if (!el) return;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const overhang = r.right - (window.innerWidth - 12);
    if (overhang > 0) el.style.transform = `translateX(${-Math.min(overhang, r.left - 12)}px)`;
  }, []);

  const segments = linkCitations(text, references);
  return (
    <span className="block whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
      {segments.map((seg, i) =>
        seg.reference ? (
          <span key={i} className="relative">
            <button
              onClick={() => setOpen((prev) => (prev === i ? null : i))}
              title="Show this reference"
              className={`underline decoration-dotted underline-offset-2 ${
                open === i
                  ? "bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
                  : "text-blue-700 hover:text-blue-500 dark:text-blue-400"
              }`}
            >
              {seg.text}
            </button>
            {/* Beside the citation that asked for it: in prose this dense, a
                block at the foot of the paragraph left you working out which of
                six citations it had answered. Selectable, because the point of
                reaching a reference is usually to put it somewhere else. */}
            {open === i && (
              <span
                ref={place}
                className="absolute left-0 top-full z-[1003] mt-1 block w-max max-w-[26rem] rounded-md border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
              >
                <span className="block select-text text-zinc-700 dark:text-zinc-200">
                  {stripHtml(seg.reference.citation)}
                </span>
                <span className="mt-1 flex items-center gap-1">
                  <button
                    onClick={() => navigator.clipboard?.writeText(stripHtml(seg.reference!.citation))}
                    className="rounded px-1 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => setOpen(null)}
                    className="rounded px-1 py-0.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    Close
                  </button>
                </span>
              </span>
            )}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </span>
  );
}

/**
 * What an assessment says about a neighbour, under its row.
 *
 * Threats open first and carry the classification table as well as the prose:
 * the codes on the row say which pressures were ticked, and this says how each
 * was scored and what the assessors wrote about it.
 */
function SpeciesDetail({
  assessmentId,
  assessmentYear,
  redListHref,
  actions,
}: {
  assessmentId: number;
  assessmentYear: number | null;
  redListHref: string | null;
  actions: React.ReactNode;
}) {
  const [state, setState] = useState<Loaded | null>(() => assessmentCache.get(assessmentId) ?? null);
  const [section, setSection] = useState<SectionKey>("threats");
  /** Whether the scoring behind the threat summary is showing. */
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    if (assessmentCache.has(assessmentId)) return;
    let live = true;
    fetchAssessment(assessmentId)
      .then((next) => {
        if (live) setState(next);
      })
      .catch((e: unknown) => {
        // Not cached: a failure is usually the network rather than the
        // assessment, and should be retryable by opening the row again.
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

  const a = state.assessment ?? {};
  const refs = a.references ?? [];
  const rows = section === "threats" ? a.threat_classification ?? [] : [];
  const raw = a[section];
  const text = raw ? stripHtml(String(raw)) : "";

  /**
   * The classification rolled up to its twelve top-level categories.
   *
   * Opened straight into the full table, a species with a dozen scored leaves
   * buried the one thing a reader wants first — that this is an agriculture
   * problem, or a harvesting one. The summary answers that, and the table is
   * a click away for the scoring behind it.
   */
  const summary = (() => {
    const byTop = new Map<string, { label: string; leaves: number; worst: string | null }>();
    for (const r of rows) {
      const top = r.code.replace(/_/g, ".").split(".")[0];
      const at = byTop.get(top) ?? { label: THREAT_TOP_LEVEL[top] ?? top, leaves: 0, worst: null };
      at.leaves += 1;
      // "Low Impact: 5" — the number ranks them, and the highest is the one
      // the species is actually up against.
      const score = Number((r.score ?? "").match(/(\d+)\s*$/)?.[1] ?? NaN);
      const best = Number((at.worst ?? "").match(/(\d+)\s*$/)?.[1] ?? NaN);
      if (Number.isFinite(score) && (!Number.isFinite(best) || score > best)) at.worst = r.score;
      byTop.set(top, at);
    }
    return [...byTop.entries()].sort((x, y) => y[1].leaves - x[1].leaves || Number(x[0]) - Number(y[0]));
  })();

  return (
    <div className="space-y-1.5">
      {/* What you can do with this species, above the reading rather than under
          it: they are the reason the row was opened as often as the prose is,
          and at the foot of a long narrative they were a scroll away. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {actions}
        {redListHref && (
          <a
            href={redListHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-700 hover:underline dark:text-blue-400"
          >
            Open {assessmentYear ?? "the"} Red List assessment →
          </a>
        )}
      </div>

      {/* Every section, with the ones this assessment has nothing to say about
          left visibly empty rather than hidden — "no use and trade recorded" is
          itself worth knowing when you are comparing neighbours. */}
      <div className="flex flex-wrap gap-1 border-b border-zinc-100 pb-1 dark:border-zinc-800">
        {SECTIONS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={`rounded px-1.5 py-0.5 ${
              section === key
                ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                : `text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 ${
                    a[key] ? "" : "opacity-50"
                  }`
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {summary.length > 0 && (
        <div>
          <button
            onClick={() => setTableOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 text-left"
          >
            <svg
              className={`h-3 w-3 shrink-0 text-zinc-400 transition-transform ${tableOpen ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className="flex flex-wrap gap-1">
              {summary.map(([code, t]) => (
                <span
                  key={code}
                  className="rounded bg-zinc-100 px-1 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200"
                  title={t.worst ? `${t.leaves} scored — worst ${t.worst}` : `${t.leaves} scored`}
                >
                  <span className="tabular-nums text-zinc-400">{code}</span> {t.label}
                  {t.leaves > 1 && <span className="tabular-nums text-zinc-400"> ×{t.leaves}</span>}
                </span>
              ))}
            </span>
            <span className="ml-auto shrink-0 text-zinc-400">
              {tableOpen ? "Hide scoring" : "Show scoring"}
            </span>
          </button>

          {tableOpen && (
            <table className="mt-1 w-full border-collapse">
              <thead>
                <tr className="text-left text-zinc-400 dark:text-zinc-500">
                  <th className="pr-2 font-normal">Threat</th>
                  <th className="pr-2 font-normal">Timing</th>
                  <th className="pr-2 font-normal">Scope</th>
                  <th className="pr-2 font-normal">Severity</th>
                  <th className="font-normal">Impact</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => (
                  <tr key={`${t.code}-${i}`} className="align-top">
                    <td className="pr-2 text-zinc-700 dark:text-zinc-200">
                      {/* IUCN writes these codes with underscores in the API and
                          with dots everywhere a person reads them. */}
                      <span className="tabular-nums text-zinc-400">{t.code.replace(/_/g, ".")}</span> {t.name}
                    </td>
                    <td className="pr-2 text-zinc-500 dark:text-zinc-400">{t.timing ?? "—"}</td>
                    <td className="pr-2 text-zinc-500 dark:text-zinc-400">{t.scope ?? "—"}</td>
                    <td className="pr-2 text-zinc-500 dark:text-zinc-400">{t.severity ?? "—"}</td>
                    <td className="text-zinc-500 dark:text-zinc-400">{t.score ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {text ? (
        <Prose text={text} references={refs} />
      ) : (
        <span className="block text-zinc-400">
          This assessment records no {SECTIONS.find(([k]) => k === section)?.[1].toLowerCase()} text.
        </span>
      )}

    </div>
  );
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
  /** The row whose right-click menu is open, and where to draw it. */
  const [rowMenu, setRowMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
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
      if (openRow) setOpenRow(null);
      else onClose();
    },
    [onClose, openRow]
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-700 shrink-0">
        {/* The same colour as the ring on the map, so the panel and the circle
            it drew read as one thing. */}
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke={NEARBY_SEARCH_COLOR} strokeWidth={2}>
          <circle cx="12" cy="12" r="3" fill={NEARBY_SEARCH_COLOR} stroke="none" />
          <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
        </svg>
        <span className="font-medium text-zinc-700 dark:text-zinc-200 shrink-0">Recorded near</span>
        <span
          className="min-w-[6rem] flex-1 truncate italic text-zinc-500 dark:text-zinc-400"
          title={`${recordName} — ${lat.toFixed(5)}, ${lng.toFixed(5)}`}
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

      {/* Fixed at the pointer rather than inside the row: the table scrolls,
          and a menu anchored in it goes with the row it belongs to. */}
      {rowMenu && (
        <>
          <div className="fixed inset-0 z-[10001]" onClick={() => setRowMenu(null)} onContextMenu={(e) => { e.preventDefault(); setRowMenu(null); }} />
          <div
            style={{
              position: "fixed",
              left: Math.min(rowMenu.x, window.innerWidth - 230),
              top: Math.min(rowMenu.y, window.innerHeight - 120),
              zIndex: 10002,
            }}
            className="w-56 rounded-lg border border-zinc-200 bg-white p-1 text-[11px] shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          >
            {(() => {
              const s = result?.species.find((x) => x.gbif_species_key === rowMenu.key);
              if (!s) return null;
              const pick = pickedByKey.get(s.gbif_species_key);
              const url = redListUrl(s);
              return (
                <>
                  <button
                    onClick={() => {
                      onTogglePick({ key: s.gbif_species_key, name: s.scientific_name, commonName: s.common_name });
                      setRowMenu(null);
                    }}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full border border-white"
                      style={{ backgroundColor: pick?.color ?? "#9ca3af" }}
                    />
                    {pick ? "Hide records from map" : "Show records on map"}
                  </button>
                  <a
                    href={nearbyGbifSiteUrl({ lat, lng, radiusKm: radiusKm, speciesKey: s.gbif_species_key })}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setRowMenu(null)}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg className="h-3 w-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5L10 14M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-3" />
                    </svg>
                    Open these records on GBIF
                  </a>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setRowMenu(null)}
                      className="flex w-full items-center gap-1.5 rounded px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <svg className="h-3 w-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5L10 14M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-3" />
                      </svg>
                      Open {s.assessment_year ?? "the"} Red List assessment
                    </a>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}

      {!collapsed && (
        <>
          <div
            className="overflow-y-auto py-1.5"
            style={height ? { height } : { maxHeight: "26rem" }}
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
                          {/* The whole row opens the menu. Hanging it off the
                              name alone made the rest of a row — the tags, the
                              counts, the taxon — dead space you could click at
                              and get nothing, which in a table of 120 rows is
                              most of the target anybody aims for. */}
                          <div
                            role="button"
                            tabIndex={0}
                            aria-expanded={openRow === s.gbif_species_key}
                            onClick={() =>
                              setOpenRow((prev) => (prev === s.gbif_species_key ? null : s.gbif_species_key))
                            }
                            onKeyDown={(e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              setOpenRow((prev) => (prev === s.gbif_species_key ? null : s.gbif_species_key));
                            }}
                            // Right-click reaches the same two actions without
                            // opening the assessment first — the same bargain
                            // the record list makes on its own rows.
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setRowMenu({ key: s.gbif_species_key, x: e.clientX, y: e.clientY });
                            }}
                            // Kept for the menu below, which needs the row it
                            // was opened on without re-finding it.
                            data-species={s.gbif_species_key}
                            className={`${ROW} cursor-pointer py-[3px] hover:bg-zinc-50 dark:hover:bg-zinc-700/40 ${
                              pick ? "bg-zinc-50 dark:bg-zinc-700/40" : ""
                            }`}
                          >
                            {/* A chevron, so a row reads as something that opens
                                — a table of names gives no sign of it otherwise.
                                It carries the drawn dot's colour when the species
                                is on the map, which is also how the row and the
                                mark are tied together without counting positions. */}
                            <span className="flex h-3 items-center">
                              <svg
                                className={`h-3 w-3 shrink-0 transition-transform ${
                                  openRow === s.gbif_species_key ? "rotate-90" : ""
                                }`}
                                style={{ color: pick?.color ?? undefined }}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                              </svg>
                            </span>
                            <span
                              className="rounded px-1 text-center text-[9px] font-medium tabular-nums text-white"
                              style={{ backgroundColor: CATEGORY_COLORS[normalizeCategory(s.category)] ?? "#6b7280" }}
                              title={s.criteria ? `Assessed ${s.category} under ${s.criteria}` : `Assessed ${s.category}`}
                            >
                              {s.category}
                            </span>

                            <span className="min-w-0">
                              <span className="block truncate italic text-zinc-700 dark:text-zinc-200">
                                {s.scientific_name}
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

                          {openRow === s.gbif_species_key && (
                            <div className="px-2 pb-2 pl-6 leading-snug">
                              {s.assessment_id == null ? (
                                <span className="text-zinc-400">
                                  This dashboard holds no assessment id for it, so there is nothing to read.
                                </span>
                              ) : (
                                <SpeciesDetail
                                  assessmentId={s.assessment_id}
                                  assessmentYear={s.assessment_year}
                                  redListHref={url}
                                  actions={
                                    <>
                                      <button
                                        onClick={() =>
                                          onTogglePick({
                                            key: s.gbif_species_key,
                                            name: s.scientific_name,
                                            commonName: s.common_name,
                                          })
                                        }
                                        className="flex items-center gap-1.5 text-zinc-600 hover:text-blue-600 dark:text-zinc-300 dark:hover:text-blue-400"
                                      >
                                        <span
                                          className="h-2 w-2 shrink-0 rounded-full border border-white"
                                          style={{ backgroundColor: pick?.color ?? "#9ca3af" }}
                                        />
                                        {pick ? "Hide records from map" : "Show records on map"}
                                      </button>
                                      <a
                                        href={nearbyGbifSiteUrl({
                                          lat,
                                          lng,
                                          radiusKm: result.radiusKm,
                                          speciesKey: s.gbif_species_key,
                                        })}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-zinc-600 hover:text-blue-600 dark:text-zinc-300 dark:hover:text-blue-400"
                                      >
                                        Open these records on GBIF
                                      </a>
                                    </>
                                  }
                                />
                              )}
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
