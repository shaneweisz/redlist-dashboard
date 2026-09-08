/**
 * One IUCN assessment, and the one way to ask for it.
 *
 * Two places in this app read `/api/redlist/assessment/[id]` — the dashboard's
 * Red List Assessments tab, which shows a species' whole assessment history,
 * and the nearby-species panel, which shows one neighbour's current assessment
 * in a narrow column. They present it very differently and should: one is a
 * history with a comparison view, the other is six tabs beside a map.
 *
 * What they have no business disagreeing about is the shape of the response,
 * what the narrative fields are called, and how many times the IUCN API gets
 * asked for the same paragraph. That is what lives here.
 */
import type { AssessmentReference } from "@/lib/mapping/nearby-citations";

/** The response, as `app/api/redlist/assessment/[id]/route.ts` builds it. */
export interface RedListAssessment {
  assessment_id: number;
  sis_taxon_id: number;
  url: string;
  /** Normalised to `{ code, description }`; a bare string is tolerated. */
  red_list_category: { code: string; description?: string | null } | string | null;
  criteria: string | null;
  assessment_date: string | null;
  year_published: string | null;
  possibly_extinct: boolean | null;
  possibly_extinct_in_the_wild: boolean | null;

  // The narratives. Every one of these is HTML — run it through stripHtml.
  rationale: string | null;
  population: string | null;
  habitat: string | null;
  threats: string | null;
  conservation_actions: string | null;
  use_trade: string | null;
  range: string | null;

  population_trend: { code: string; description?: string | null } | string | null;
  systems: ({ code: string; description?: string | null } | string)[] | null;
  scopes: ({ code: string; description?: string | null } | string)[] | null;
  /** The bibliography the narratives' in-text citations point into. */
  references?: AssessmentReference[];
  /** The scored threat classification: code, name, timing, scope, severity. */
  threat_classification?:
    | {
        code: string;
        name: string;
        timing: string | null;
        scope: string | null;
        severity: string | null;
        score: string | null;
        /** The species or pathogen named on an invasive-species threat. */
        named?: string | null;
      }[]
    | null;
  cached?: boolean;
  error?: string;
}

/**
 * The narrative fields, once.
 *
 * Both titles, because the two readers have different room: the dashboard tab
 * has a full-width heading and says "Habitat & Ecology", the panel has a tab
 * a few characters wide and says "Habitat". They are labels for the same
 * field, so they belong on the same line — a field added to the route should
 * not be able to appear in one reader and not the other. Order is a view's own
 * decision and stays with the view.
 */
export const ASSESSMENT_NARRATIVES = [
  { field: "rationale", title: "Rationale", short: "Rationale" },
  { field: "population", title: "Population", short: "Population" },
  { field: "habitat", title: "Habitat & Ecology", short: "Habitat" },
  { field: "threats", title: "Threats", short: "Threats" },
  { field: "conservation_actions", title: "Conservation Actions", short: "Actions" },
  { field: "use_trade", title: "Use & Trade", short: "Use & trade" },
  { field: "range", title: "Geographic Range", short: "Range" },
] as const;

export type NarrativeField = (typeof ASSESSMENT_NARRATIVES)[number]["field"];

/** The short label for a field, for a reader with no room for the long one. */
export function narrativeLabel(field: NarrativeField): string {
  return ASSESSMENT_NARRATIVES.find((n) => n.field === field)?.short ?? field;
}

export type LoadedAssessment = { assessment?: RedListAssessment; error?: string };

/**
 * Assessments already fetched, for the life of the page.
 *
 * The route caches for an hour and sets cache headers, but that is a
 * serverless function's memory and it is short. This is the cache that stops
 * the IUCN API being asked twice for the same paragraph because a row was
 * closed and opened again — which, in a panel built for comparing neighbours
 * and a tab built for stepping through a history, is exactly what people do.
 */
const cache = new Map<number, LoadedAssessment>();

/** Requests already in the air, so two callers make one request. */
const inFlight = new Map<number, Promise<LoadedAssessment>>();

/** What is already held for this assessment, if anything. */
export function cachedAssessment(id: number): LoadedAssessment | undefined {
  return cache.get(id);
}

/**
 * Fetch one assessment, at most once.
 *
 * No abort signal, deliberately. The promise is shared, so tying it to one
 * caller's lifetime lets that caller's unmount cancel the fetch the next one is
 * waiting on — which is what a double-mounted effect does, and it left rows
 * loading forever. It is one small GET worth caching either way.
 */
export function loadAssessment(id: number): Promise<LoadedAssessment> {
  const held = cache.get(id);
  if (held) return Promise.resolve(held);
  const running = inFlight.get(id);
  if (running) return running;

  const p = fetch(`/api/redlist/assessment/${id}`)
    .then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
      const next: LoadedAssessment = { assessment: body as RedListAssessment };
      cache.set(id, next);
      return next;
    })
    // A failure is usually the network rather than the assessment, so it is not
    // cached: opening the row again should try again.
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : "Could not load" }))
    .finally(() => inFlight.delete(id));

  inFlight.set(id, p);
  return p;
}
