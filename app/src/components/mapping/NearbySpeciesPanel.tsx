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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CATEGORY_COLORS, normalizeCategory } from "@/config/taxa";
import { findNode } from "@/lib/taxonomy-utils";
import { stripHtml } from "@/lib/html-text";
import { linkCitations, type AssessmentReference } from "@/lib/mapping/nearby-citations";
import TaxaIcon from "@/components/TaxaIcon";
import { cachedThumbnail, loadThumbnail, type InatThumbnail } from "@/lib/redlist/inat-thumbnail";
import {
  cachedAssessment,
  loadAssessment,
  narrativeLabel,
  type LoadedAssessment,
  type NarrativeField,
  type RedListAssessment,
} from "@/lib/redlist/assessment";
import {
  NEARBY_RADII_KM,
  NEARBY_RECORDS_NOTE,
  NEARBY_SEARCH_COLOR,
  THREAT_TOP_LEVEL,
  THREAT_SUB_LEVEL,
  compareThreatCodes,
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

/*
 * One assessment's prose, threats and bibliography come from
 * `lib/redlist/assessment` — the same module the dashboard's Red List
 * Assessments tab reads, so the response's shape, the names of its narrative
 * fields and the cache in front of the IUCN API are settled in one place. What
 * each of them does with it is their own business, and differs.
 */

/**
 * The sections of an assessment worth reading beside a neighbour's row.
 *
 * Threats first because that is what the panel is for; the rest are here
 * because once the request has been made they cost nothing, and an assessor
 * comparing neighbours wants the range and the habitat as often as not.
 */
/**
 * The tabs, in this panel's order: threats first, because the question the
 * panel exists to answer is what the neighbours are up against. The labels are
 * the short ones — a tab is a few characters wide — and both they and the field
 * list come from the shared module, so a narrative the route starts returning
 * cannot appear in the dashboard's tab and be missing here.
 */
const SECTION_ORDER = [
  "threats",
  "rationale",
  "range",
  "habitat",
  "use_trade",
  "conservation_actions",
] as const satisfies readonly NarrativeField[];
type SectionKey = (typeof SECTION_ORDER)[number];
const SECTIONS = SECTION_ORDER.map((field) => [field, narrativeLabel(field)] as const);

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
}: {
  assessmentId: number;
  assessmentYear: number | null;
  redListHref: string | null;
}) {
  const [state, setState] = useState<LoadedAssessment | null>(() => cachedAssessment(assessmentId) ?? null);
  const [section, setSection] = useState<SectionKey>("threats");
  /** Whether the scoring behind the threat summary is showing. */
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    if (cachedAssessment(assessmentId)) return;
    let live = true;
    loadAssessment(assessmentId).then((next) => {
      if (live) setState(next);
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

  const a = (state.assessment ?? {}) as Partial<RedListAssessment>;
  const refs = a.references ?? [];
  const rows =
    section === "threats"
      ? [...(a.threat_classification ?? [])].sort((x, y) => compareThreatCodes(x.code, y.code))
      : [];
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
    // By code. Sorted by weight the summary reordered itself between species
    // and you could not run your eye down the column to compare two.
    return [...byTop.entries()].sort((x, y) => compareThreatCodes(x[0], y[0]));
  })();

  return (
    <div className="space-y-1.5">
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

      {/* What was ticked comes before what was written about it. The
          classification is the assessment's own answer to "what is threatening
          this?" — a line of it — where the narrative is several paragraphs of
          argument, and a reader comparing neighbours wants the answer first and
          the argument underneath. */}
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
                // Just the pressure, named: "Pollution", "Climate change".
                // The code and the tally are what the table below is for, and
                // in the summary they turned a plain-English line into
                // something to be decoded.
                <span
                  key={code}
                  className="rounded bg-zinc-100 px-1 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200"
                  title={
                    `${code}. ${t.label} — ${t.leaves} scored` + (t.worst ? `, worst ${t.worst}` : "")
                  }
                >
                  {t.label}
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
                <tr className="text-left align-bottom text-zinc-400 dark:text-zinc-500">
                  <th className="pr-2 font-normal">Threat</th>
                  <th className="pr-2 font-normal">Timing</th>
                  <th className="pr-2 font-normal">Scope</th>
                  <th className="pr-2 font-normal">Severity</th>
                  <th className="font-normal">Impact</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => {
                  // "5_4_1" is a path, not a label: the assessment names only
                  // its own leaf, so the two levels above it come from the
                  // classification itself.
                  const parts = t.code.replace(/_/g, ".").split(".");
                  const top = parts[0];
                  const sub = parts.slice(0, 2).join(".");
                  const levels = [
                    { code: top, label: THREAT_TOP_LEVEL[top] },
                    parts.length > 1 ? { code: sub, label: THREAT_SUB_LEVEL[sub] } : null,
                    parts.length > 2 ? { code: parts.join("."), label: t.name } : null,
                  ].filter(Boolean) as { code: string; label?: string }[];
                  // A two-level code carries its own name at the second level.
                  if (parts.length === 2 && levels[1]) levels[1].label = levels[1].label ?? t.name;
                  return (
                    <tr key={`${t.code}-${i}`} className="align-top border-t border-zinc-50 dark:border-zinc-800/60">
                      <td className="py-0.5 pr-2 text-zinc-700 dark:text-zinc-200">
                        {levels.map((l, depth) => (
                          <span key={l.code} className="block" style={{ paddingLeft: depth * 10 }}>
                            <span className="tabular-nums text-zinc-400">{l.code}.</span> {l.label ?? "—"}
                          </span>
                        ))}
                        {t.named && (
                          <span className="block italic text-zinc-500 dark:text-zinc-400" style={{ paddingLeft: levels.length * 10 }}>
                            {t.named}
                          </span>
                        )}
                      </td>
                      <td className="py-0.5 pr-2 text-zinc-500 dark:text-zinc-400">{t.timing ?? "—"}</td>
                      <td className="py-0.5 pr-2 text-zinc-500 dark:text-zinc-400">{t.scope ?? "—"}</td>
                      <td className="py-0.5 pr-2 text-zinc-500 dark:text-zinc-400">{t.severity ?? "—"}</td>
                      <td className="py-0.5 text-zinc-500 dark:text-zinc-400">{t.score ?? "—"}</td>
                    </tr>
                  );
                })}
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

      {/* Last, after everything this panel can tell you: the point of the link
          is what to do once the panel has run out. */}
      {redListHref && (
        <a
          href={redListHref}
          target="_blank"
          rel="noopener noreferrer"
          className="block border-t border-zinc-100 pt-1 text-blue-700 hover:underline dark:border-zinc-800 dark:text-blue-400"
        >
          Open the full {assessmentYear ?? ""} Red List assessment →
        </a>
      )}
    </div>
  );
}

/**
 * The table's column track, shared by the header and every row so the two can't
 * drift apart. Below the map there is width enough for threats to be a column.
 *
 * Name, what kind of thing it is, what it was assessed as, when, on how many
 * records, and under what — the order the questions are actually asked in, with
 * the taxon beside the name it qualifies.
 * The tracks carrying "Assessment Year" and "GBIF Records" are sized for those
 * headers rather than for their numbers, since a header that wraps puts the
 * whole row out of step with the rows under it.
 */
const ROW =
  "grid grid-cols-[20px_minmax(7rem,1fr)_5rem_2.25rem_6rem_5rem_minmax(9rem,2.6fr)] gap-2 items-center px-2";

/**
 * One filter as a dropdown of checkboxes, in the header.
 *
 * Several values at once, because the questions are: birds and mammals, or
 * everything citing agriculture and everything citing harvesting. Nothing
 * ticked means everything — the same convention the record list's own filters
 * use, and it keeps "no filter" from needing a row of its own.
 */
function FilterMenu({
  label, selected, onChange, options, total,
}: {
  label: string;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** [value, text, count, dot colour] — the dot is how a category keeps its. */
  options: [string, string, number, string?][];
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (options.length < 2) return null;
  const chosen = options.filter(([v]) => selected.has(v));
  const summary =
    chosen.length === 0
      ? `All (${total})`
      : chosen.length === 1
        ? `${chosen[0][1]} (${chosen[0][2]})`
        : `${chosen.length} of ${options.length} (${chosen.reduce((n, o) => n + o[2], 0)})`;

  return (
    <span ref={box} className="relative flex items-center gap-1">
      <span className="text-zinc-400">{label}</span>
      <button
        onClick={() => setOpen((v) => !v)}
        title={chosen.length ? chosen.map((o) => o[1]).join(", ") : `All ${label.toLowerCase()}`}
        className={`flex max-w-[11rem] items-center gap-1 rounded border px-1.5 py-0.5 ${
          chosen.length
            ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
            : "border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
        }`}
      >
        <span className="truncate">{summary}</span>
        <svg
          className={`h-2.5 w-2.5 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-[10001] mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <button
            onClick={() => onChange(new Set())}
            className="w-full px-2 pb-1 text-left text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            {selected.size ? "Clear" : "All"}
          </button>
          {options.map(([value, text, count, dot]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-1.5 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <input
                type="checkbox"
                checked={selected.has(value)}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(value)) next.delete(value);
                  else next.add(value);
                  onChange(next);
                }}
                className="h-3 w-3 shrink-0 rounded"
              />
              {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} />}
              <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-200">{text}</span>
              <span className="shrink-0 tabular-nums text-zinc-400">{count}</span>
            </label>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * A species' iNaturalist photo, fetched when its row is scrolled to.
 *
 * The same thumbnail the dashboard's species table shows, from the same route
 * and now the same cache — a neighbour you recognise on sight is worth more
 * than the binomial beside it, and this list is full of names an assessor
 * works next to without ever having seen.
 *
 * Only when the row comes into view: the list is not paginated, so a 50 km
 * radius in a well-collected place is a hundred rows, and asking iNaturalist
 * for a hundred photos to show the twelve on screen is most of a request
 * budget spent on nothing.
 */
function Thumbnail({ name, taxonGroup }: { name: string; taxonGroup: string }) {
  const [image, setImage] = useState<InatThumbnail | undefined>(() => cachedThumbnail(name));
  const [seen, setSeen] = useState(() => cachedThumbnail(name) !== undefined);
  const box = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (seen || !box.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      // A little ahead of the scroll, so a row is usually holding its photo by
      // the time it arrives rather than filling in under the reader.
      { rootMargin: "200px" }
    );
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen || image !== undefined) return;
    let live = true;
    loadThumbnail(name).then((next) => {
      if (live) setImage(next);
    });
    return () => {
      live = false;
    };
  }, [seen, image, name]);

  /**
   * Where to hang the big version, once it is being pointed at.
   *
   * Fixed to the viewport and rendered through a portal, because the row it
   * belongs to is inside a panel that scrolls and clips: anything grown in
   * place is cut off at the panel's edge, which is exactly where a 20px
   * thumbnail sits. Placed left of the row and flipped above the pointer near
   * the bottom of the window, so it never opens off screen.
   */
  const [preview, setPreview] = useState<{ top: number; left: number } | null>(null);
  const show = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const size = 176;
    setPreview({
      top: Math.max(8, Math.min(window.innerHeight - size - 8, r.top - size / 2 + r.height / 2)),
      left: Math.max(8, r.left - size - 10),
    });
  }, []);

  return (
    <span ref={box} className="flex h-5 w-5 shrink-0 items-center justify-center">
      {image?.squareUrl ? (
        <>
        <img
          src={image.squareUrl}
          alt=""
          title={name}
          onMouseEnter={show}
          onMouseLeave={() => setPreview(null)}
          className="h-5 w-5 cursor-zoom-in rounded object-cover hover:ring-2 hover:ring-blue-400"
          loading="lazy"
        />
        {preview &&
          createPortal(
            <span
              style={{ position: "fixed", top: preview.top, left: preview.left, zIndex: 10050 }}
              className="pointer-events-none block rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
            >
              <img
                src={image.mediumUrl ?? image.squareUrl}
                alt={name}
                className="block h-40 w-40 rounded object-cover"
              />
              <span className="block max-w-40 truncate pt-0.5 text-center text-[10px] italic text-zinc-500 dark:text-zinc-400">
                {name}
              </span>
            </span>,
            document.body
          )}
        </>
      ) : (
        // The taxon's own mark while the photo is coming, and instead of it for
        // a species iNaturalist has no photo of — a grey square that never
        // resolves reads as something broken.
        <span className="text-zinc-300 dark:text-zinc-600">
          <TaxaIcon taxonId={taxonGroup} size={13} />
        </span>
      )}
    </span>
  );
}

/** The panel's one busy indicator, used wherever it waits on a service. */
function Spinner() {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin"
      aria-hidden
    />
  );
}

/**
 * A species' threats rolled up to the twelve top-level categories.
 *
 * Returns [code, label, what it covers] — the third being the sub-level tags
 * that rolled into it, so the detail is a hover away rather than gone.
 */
function topThreats(s: NearbySpecies): [string, string, string][] {
  const byTop = new Map<string, string[]>();
  for (const t of s.threat_tags) {
    const top = t.code.split(".")[0];
    byTop.set(top, [...(byTop.get(top) ?? []), `${t.code} ${t.label}`]);
  }
  return [...byTop.entries()]
    .sort((a, b) => compareThreatCodes(a[0], b[0]))
    .map(([code, under]) => [code, THREAT_TOP_LEVEL[code] ?? code, under.join("\n")]);
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
  /**
   * What is being filtered to. Empty means everything, and several values in
   * one set are an "or" — birds and mammals — while the three sets are an
   * "and": birds and mammals, that are CR, that cite agriculture.
   */
  const [taxa, setTaxa] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [threats, setThreats] = useState<Set<string>>(new Set());
  /** Rolled up to its header bar, so the map above has the room back. */
  const [collapsed, setCollapsed] = useState(false);

  /**
   * Opening a row also puts the species on the map.
   *
   * Reading what an assessment says about a neighbour and seeing where that
   * neighbour actually is are the same question asked twice, and making the
   * second a separate button meant it mostly went unasked. Closing the row
   * leaves it drawn — the legend is where a layer is taken off, as it is for
   * every other layer on this map.
   */
  const openSpecies = useCallback(
    (sp: NearbySpecies) => {
      setOpenRow((prev) => (prev === sp.gbif_species_key ? null : sp.gbif_species_key));
      if (!pickedByKey.has(sp.gbif_species_key)) {
        onTogglePick({ key: sp.gbif_species_key, name: sp.scientific_name, commonName: sp.common_name });
      }
    },
    [onTogglePick, pickedByKey]
  );

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

  /**
   * The top-level threats these neighbours cite, with how many cite each.
   *
   * From the rows' own tags rather than the twelve-category list, so the filter
   * only ever offers a pressure something here is actually under.
   */
  const threatCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of result?.species ?? []) {
      for (const top of new Set(s.threat_tags.map((t) => t.code.split(".")[0]))) {
        counts.set(top, (counts.get(top) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => compareThreatCodes(a[0], b[0]));
  }, [result]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of result?.species ?? []) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return (["CR", "EN", "VU"] as const)
      .map((c) => [c, counts.get(c) ?? 0] as const)
      .filter(([, n]) => n > 0);
  }, [result]);

  // Derived, not corrected after the fact: a value the new radius no longer
  // offers simply stops counting as part of the selection.
  const keep = (chosen: Set<string>, offered: [string, number][]) =>
    new Set([...chosen].filter((v) => offered.some(([o]) => o === v)));
  const activeTaxa = keep(taxa, taxonCounts);
  const activeCategories = keep(categories, categoryCounts as [string, number][]);
  const activeThreats = keep(threats, threatCounts);

  const shownSpecies = useMemo(
    () =>
      (result?.species ?? []).filter(
        (s) =>
          (activeTaxa.size === 0 || activeTaxa.has(s.taxon_group)) &&
          (activeCategories.size === 0 || activeCategories.has(s.category)) &&
          (activeThreats.size === 0 ||
            s.threat_tags.some((t) => activeThreats.has(t.code.split(".")[0])))
      ),
    // Sets rebuilt each render, so the contents are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, [...activeTaxa].join(), [...activeCategories].join(), [...activeThreats].join()]
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

  /*
   * No resize grip of its own.
   *
   * The panel is a tab of the record panel now, and that panel is what the
   * reader sizes — from the divider in fullscreen, from its bottom edge on the
   * dashboard. A second grip inside it fought the first: dragging one left the
   * other holding a height nothing could see.
   */

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col rounded-lg border border-zinc-200 bg-white text-[11px] shadow-md dark:border-zinc-700 dark:bg-zinc-800"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-700 shrink-0">
        {/* The same colour as the ring on the map, so the panel and the circle
            it drew read as one thing. */}
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke={NEARBY_SEARCH_COLOR} strokeWidth={2}>
          <circle cx="12" cy="12" r="3" fill={NEARBY_SEARCH_COLOR} stroke="none" />
          <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
        </svg>
        {/* The coordinates, not the record's name. Named, it read as a list
            about that species — which is the one species it never contains.
            The record it was opened from follows in brackets when there was
            one, because that is provenance rather than subject. */}
        <span className="font-medium text-zinc-700 dark:text-zinc-200 shrink-0">Threatened species recorded near</span>
        <span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-300">
          {lat.toFixed(4)}, {lng.toFixed(4)}
        </span>
        {recordName && (
          <span className="max-w-[12rem] truncate italic text-zinc-400" title={recordName}>
            ({recordName})
          </span>
        )}

        {/* The filters, where the header has room the table hasn't. Every
            option is built from what came back, so one is never offered that
            would empty the table, and a filter with a single value to choose
            is not shown at all. */}
        {result && (
          <>
            <FilterMenu
              label="Taxon"
              selected={activeTaxa}
              onChange={setTaxa}
              total={result.species.length}
              options={taxonCounts.map(([g, n]) => [g, taxonLabel(g), n])}
            />
            <FilterMenu
              label="Category"
              selected={activeCategories}
              onChange={setCategories}
              total={result.species.length}
              options={categoryCounts.map(([c, n]) => [c, c, n, CATEGORY_COLORS[normalizeCategory(c)]])}
            />
            <FilterMenu
              label="Threat"
              selected={activeThreats}
              onChange={setThreats}
              total={result.species.length}
              // The pressure named, not its code: the number is the Red List's
              // filing system, and in a filter it was one more thing to decode.
              options={threatCounts.map(([c, n]) => [c, THREAT_TOP_LEVEL[c] ?? c, n])}
            />
          </>
        )}

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
          <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
            {error && <p className="px-2 text-amber-600 dark:text-amber-400">{error}</p>}

            {/* The body says it is working, not just the corner of the header.
                The panel opens empty while GBIF is asked, and an empty panel
                below a map reads as a panel with nothing in it. */}
            {loading && !error && (
              <p className="flex items-center gap-1.5 px-2 py-3 text-zinc-500 dark:text-zinc-400">
                <Spinner />
                Finding threatened species within {radiusKm} km…
              </p>
            )}

            {result && !error && (
              <>
                {shownSpecies.length > 0 && (
                  <div>
                    <div
                      className={`${ROW} sticky top-0 bg-white dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 pb-0.5 border-b border-zinc-100 dark:border-zinc-800`}
                    >
                      <span />
                      <span className="whitespace-nowrap">Species</span>
                      <span className="whitespace-nowrap">Taxon</span>
                      <span className="whitespace-nowrap">Category</span>
                      <span className="whitespace-nowrap text-right">Assessment Year</span>
                      <span className="whitespace-nowrap text-right">GBIF Records</span>
                      <span className="whitespace-nowrap">Threats</span>
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
                            onClick={() => openSpecies(s)}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              openSpecies(s);
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
                            // A picked species keeps its map colour on the row,
                            // now as the row's own left edge rather than on a
                            // chevron — it is what ties a row to the dots it put
                            // on the map without either having to be counted.
                            style={pick ? { boxShadow: `inset 2px 0 0 ${pick.color}` } : undefined}
                            className={`${ROW} cursor-pointer py-[3px] hover:bg-zinc-50 dark:hover:bg-zinc-700/40 ${
                              pick ? "bg-zinc-50 dark:bg-zinc-700/40" : ""
                            }`}
                          >
                            <Thumbnail name={s.scientific_name} taxonGroup={s.taxon_group} />

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

                            <span>
                              <span
                                className="rounded px-1 text-center text-[9px] font-medium tabular-nums text-white"
                                style={{ backgroundColor: CATEGORY_COLORS[normalizeCategory(s.category)] ?? "#6b7280" }}
                                title={s.criteria ? `Assessed ${s.category} under ${s.criteria}` : `Assessed ${s.category}`}
                              >
                                {s.category}
                              </span>
                            </span>

                            <span className="text-right tabular-nums text-zinc-400">{s.assessment_year ?? "—"}</span>

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

                            {/* The threats named, at the top level only. The
                                codes read as a filing reference — the reader had
                                to hold twelve numbers to compare two rows — and
                                the sub-levels multiplied the tags without
                                changing the answer to "what is this up
                                against?". The scoring is a row-opening away. */}
                            <span className="flex flex-wrap gap-0.5">
                              {topThreats(s).length === 0 && (
                                <span className="text-zinc-300 dark:text-zinc-600">—</span>
                              )}
                              {topThreats(s).map(([code, label, detail]) => (
                                <span
                                  key={code}
                                  title={detail}
                                  className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-700 dark:text-zinc-300"
                                >
                                  {label}
                                </span>
                              ))}
                            </span>
                          </div>

                          {openRow === s.gbif_species_key && (
                            <div className="px-2 pb-2 leading-snug">
                              {s.assessment_id == null ? (
                                <span className="text-zinc-400">
                                  This dashboard holds no assessment id for it, so there is nothing to read.
                                </span>
                              ) : (
                                <SpeciesDetail
                                  assessmentId={s.assessment_id}
                                  assessmentYear={s.assessment_year}
                                  redListHref={url}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <p className="px-2 pt-1.5 border-t border-zinc-100 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                  {result.species.length === 0 ? (
                    <>No threatened species recorded within {result.radiusKm} km.</>
                  ) : (
                    <>
                      <span className="font-medium text-zinc-700 dark:text-zinc-200">{result.species.length}</span>{" "}
                      threatened species (CR, EN, VU), from{" "}
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
                <p className="px-2 pt-1.5 leading-snug text-zinc-400">
                  {result.unmatched > 0 && `${result.unmatched} more had no assessment in this dashboard's data. `}
                  {NEARBY_RECORDS_NOTE} {NEARBY_STALENESS_NOTE}
                </p>
              </>
            )}
          </div>

        </>
      )}
    </div>
  );
}
