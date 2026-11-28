"use client";

/**
 * The Red List tab with a scope switch: a species' global assessments, or one
 * region's (lib/region-scope.ts), for each scope it has been assessed in.
 *
 * Opens on the page's scope when the species has it, else Global. Each scope's
 * history comes from /api/redlist/species/history (&scope=); the assessments
 * themselves load by id, as before, so a regional one reads like a global one.
 * A species assessed only globally (or a sync without regional files) gets no
 * switch: the tab is exactly what it was.
 */
import { useEffect, useState } from "react";
import RedListAssessments from "@/components/RedListAssessments";
import { CHART_SEGMENTED_CLASS, chartSegmentClass } from "@/components/redlist/chart-controls";
import { REGION_PARAM } from "@/lib/region-scope";

interface HistoryRow {
  id: number;
  year: string;
  category: string;
  assessors?: string | null;
  reviewers?: string | null;
  facilitators?: string | null;
  contributors?: string | null;
  institutions?: string | null;
}
interface ScopeInfo { scope: string | null; assessmentId: number; category: string; date: string | null }

interface ScopesAnswer { previous_assessments: HistoryRow[]; scopes: ScopeInfo[] }

// One request per species for the whole session, started when the species
// opens (RedListView calls loadAssessmentScopes), so the switch is usually
// ready before the tab is. `done` lets a tab opened later render it at once.
const requests = new Map<number, Promise<ScopesAnswer | null>>();
const done = new Map<number, ScopesAnswer>();
export function loadAssessmentScopes(sisTaxonId: number): Promise<ScopesAnswer | null> {
  let p = requests.get(sisTaxonId);
  if (!p) {
    p = fetch(`/api/redlist/species/history?id=${sisTaxonId}&scopes=1`)
      .then((r) => (r.ok ? (r.json() as Promise<ScopesAnswer>) : null))
      .then((d) => { if (d) done.set(sisTaxonId, d); else requests.delete(sisTaxonId); return d; })
      .catch(() => { requests.delete(sisTaxonId); return null; });
    requests.set(sisTaxonId, p);
  }
  return p;
}

// A region's history, once per species and region; prefetched for the page's scope.
const histories = new Map<string, Promise<HistoryRow[] | null>>();
export function loadScopeHistory(sisTaxonId: number, scope: string): Promise<HistoryRow[] | null> {
  const k = `${sisTaxonId}|${scope}`;
  let p = histories.get(k);
  if (!p) {
    p = fetch(`/api/redlist/species/history?id=${sisTaxonId}&${REGION_PARAM}=${encodeURIComponent(scope)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d ? (d.previous_assessments ?? []) as HistoryRow[] : null))
      .catch(() => null);
    p.then((rows) => { if (!rows) histories.delete(k); });
    histories.set(k, p);
  }
  return p;
}

const toTimeline = (rows: HistoryRow[]) => rows.map((a) => ({
  year: a.year, assessment_id: a.id, category: a.category, assessors: a.assessors, reviewers: a.reviewers,
  facilitators: a.facilitators, contributors: a.contributors, institutions: a.institutions,
}));

export default function ScopedRedListAssessments({ sisTaxonId, pageScope, current, globalHistory }: {
  sisTaxonId: number;
  /** The dashboard's scope: the tab opens on it when the species has it. */
  pageScope: string | null;
  /** The row's own assessment (the page scope's), shown until the scopes arrive. */
  current: { assessmentId: number; category: string; date: string | null };
  /** The global history the panel already fetched, if any. */
  globalHistory: HistoryRow[] | null;
}) {
  // Ready at once when the species' request has already come back (the usual case).
  const ready = done.get(sisTaxonId);
  const [loaded, setLoaded] = useState<ScopesAnswer | null>(ready ?? null);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [scopeHistories, setScopeHistories] = useState<Record<string, HistoryRow[]>>({});

  useEffect(() => {
    if (loaded) return;
    let live = true;
    loadAssessmentScopes(sisTaxonId).then((d) => { if (live && d) setLoaded(d); });
    return () => { live = false; };
  }, [sisTaxonId, loaded]);
  const scopes = loaded?.scopes ?? null;

  // The page's scope if the species has it, else Global, until a scope is clicked.
  const available = scopes ?? [];
  const opened = available.some((s) => s.scope === pageScope) ? pageScope : null;
  const scope = picked !== undefined ? picked : opened;
  const key = scope ?? "";

  useEffect(() => {
    if (!scope || scopeHistories[scope]) return;
    let live = true;
    loadScopeHistory(sisTaxonId, scope).then((rows) => { if (live && rows) setScopeHistories((prev) => ({ ...prev, [scope]: rows })); });
    return () => { live = false; };
  }, [scope, sisTaxonId, scopeHistories]);

  const info = available.find((s) => s.scope === scope);
  // Before the scopes arrive, the row's own assessment (whatever scope the page is in).
  const shown = info ?? { assessmentId: current.assessmentId, category: current.category, date: current.date };
  const history = scopeHistories[key] ?? (key === "" ? loaded?.previous_assessments : null)
    ?? (key === "" && pageScope == null ? globalHistory : null) ?? [];

  return (
    <div>
      {available.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Assessments</span>
          <div className={CHART_SEGMENTED_CLASS} role="group" aria-label="Assessment scope">
            {available.map((s) => (
              <button
                key={s.scope ?? ""}
                type="button"
                aria-pressed={s.scope === scope}
                onClick={() => setPicked(s.scope)}
                className={`${chartSegmentClass(s.scope === scope)} px-2`}
                title={s.scope ? `${s.scope} regional assessment: ${s.category}` : `Global assessment: ${s.category}`}
              >
                {s.scope ?? "Global"} <span className="opacity-60">{s.category}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <RedListAssessments
        key={key}
        sisTaxonId={sisTaxonId}
        currentAssessmentId={shown.assessmentId}
        currentCategory={shown.category}
        currentAssessmentDate={shown.date}
        previousAssessments={toTimeline(history)}
        speciesUrl={`https://www.iucnredlist.org/species/${sisTaxonId}/${shown.assessmentId}`}
      />
    </div>
  );
}
