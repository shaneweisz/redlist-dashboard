/**
 * Browser loader for the pre-built per-group species-list files
 * (scripts/build-species-lists.ts → public/species-lists/<sync>/).
 *
 * A species-list request (the same `/api/redlist/species?taxon=…[&category=NE]` URL the
 * cache has always been keyed on) is answered by fetching the static files for the
 * taxon_groups that taxon needs and concatenating them. Every deeper drilldown is then
 * a local filter over rows already in memory (RedListView's speciesMatchesNode), so the
 * server never runs a species-list query for the dashboard.
 *
 * Group files are cached here at module level, so every URL, every compare-mode panel
 * and the TaxaSummary species popover share one download per group. Two priorities:
 *   - "high" — something the user is waiting on: starts at once.
 *   - "low"  — the background prefetch: one file at a time, and paused while any
 *     high-priority file is downloading, so a click never queues behind it. A click on
 *     a group the prefetch is already downloading reuses that download.
 *
 * Returns null whenever the files can't answer — no manifest (e.g. `next dev` without a
 * build-species-lists run, or an old tab whose sync's files are gone after a deploy), or
 * a taxon that isn't a tree node (an arbitrary rank like ?taxa=turdidae) — and the caller
 * falls back to the live API route, which still answers everything it always did.
 */
import { NODE_INDEX } from "@/lib/taxonomy-utils";
import { dynamicNodeFilter, isDynamicNodeId } from "@/lib/dynamic-taxon";
import { canonicalizeTaxonId } from "@/lib/data/taxonomy-constants";
import type { RedListSpecies } from "@/hooks/useRedListSpeciesQuery";
import type { SpeciesCacheEntry } from "@/contexts/species-cache-logic";
import {
  decodeColumns,
  speciesListFileName,
  type ColumnarSpeciesList,
  type SpeciesListKind,
  type SpeciesListManifest,
} from "./format";

/** Same cap the live route applies: a view needing more NE rows prompts a drilldown instead. */
export const NE_CAP = 400_000;

export type LoadPriority = "high" | "low";

const SYNC = process.env.NEXT_PUBLIC_SPECIES_LISTS_SYNC ?? "";
const base = () => `/species-lists/${SYNC}`;

// ─── Manifest ─────────────────────────────────────────────────────────────

let manifestPromise: Promise<SpeciesListManifest | null> | null = null;

export function loadManifest(): Promise<SpeciesListManifest | null> {
  if (!SYNC) return Promise.resolve(null);
  manifestPromise ??= fetch(`${base()}/manifest.json`)
    .then((res) => (res.ok ? (res.json() as Promise<SpeciesListManifest>) : null))
    .then((m) => (m && m.v === 1 && m.sync === SYNC ? m : null))
    .catch(() => null);
  return manifestPromise;
}

// ─── Which groups a taxon needs ───────────────────────────────────────────

/**
 * The taxon_groups whose files hold every row the live route would return for `taxon`,
 * or null when the files can't answer (not a tree node). Mirrors the route's
 * resolveWhere: a static node filters by its taxonGroups only (deeper narrowing happens
 * client-side), "all" is every group, and a dynamic drilldown node is its root's groups
 * — narrowed here, using the manifest's per-group class/order names, to the groups that
 * can contain the node's class or order (insects~order:coleoptera → beetles only).
 */
export function groupsForTaxon(taxon: string, manifest: SpeciesListManifest): string[] | null {
  const id = canonicalizeTaxonId(taxon);
  const all = Object.keys(manifest.groups);
  if (id === "all") return all;
  const node = NODE_INDEX.get(id);
  if (node) return node.filter.taxonGroups.filter((g) => manifest.groups[g]);
  if (isDynamicNodeId(id)) {
    const filter = dynamicNodeFilter(id);
    if (!filter) return null;
    const groups = filter.taxonGroups.filter((g) => manifest.groups[g]);
    // Narrow by the most specific of order/class the node pins. matchesFilter falls back
    // to class_name when order_name is empty, so a group qualifies if the value appears
    // as either — the manifest's `names` holds both.
    const pinned = filter.orderNames?.[0] ?? filter.classNames?.[0];
    if (!pinned) return groups;
    const v = pinned.toLowerCase();
    return groups.filter((g) => manifest.groups[g].names.includes(v));
  }
  return null;
}

// ─── Group files + priority queue ─────────────────────────────────────────

interface GroupLoad {
  promise: Promise<RedListSpecies[]>;
  state: "queued" | "running";
  begin: (asHigh: boolean) => void;
}

const groupLoads = new Map<string, GroupLoad>();
const lowQueue: GroupLoad[] = [];
let highInFlight = 0;
let lowInFlight = 0;

function pumpLowQueue() {
  if (highInFlight > 0 || lowInFlight > 0) return;
  lowQueue.shift()?.begin(false);
}

function fetchGroup(group: string, kind: SpeciesListKind, priority: LoadPriority): Promise<RedListSpecies[]> {
  return fetch(`${base()}/${speciesListFileName(group, kind)}`, { priority } as RequestInit)
    .then((res) => {
      if (!res.ok) throw new Error(`species-list ${group}.${kind} returned ${res.status}`);
      return res.json() as Promise<ColumnarSpeciesList>;
    })
    .then((data) => decodeColumns<RedListSpecies>(data));
}

/** Load one group file, sharing any download already started or queued for it. */
export function loadGroup(group: string, kind: SpeciesListKind, priority: LoadPriority): Promise<RedListSpecies[]> {
  const key = `${group}.${kind}`;
  const existing = groupLoads.get(key);
  if (existing) {
    if (priority === "high" && existing.state === "queued") {
      // A prefetch queued this file but hasn't started it, and now someone is waiting.
      lowQueue.splice(lowQueue.indexOf(existing), 1);
      existing.begin(true);
    }
    return existing.promise;
  }

  let resolve!: (rows: RedListSpecies[]) => void;
  let reject!: (err: unknown) => void;
  const load: GroupLoad = {
    promise: new Promise<RedListSpecies[]>((res, rej) => { resolve = res; reject = rej; }),
    state: "queued",
    begin: (asHigh) => {
      if (load.state === "running") return;
      load.state = "running";
      if (asHigh) highInFlight++; else lowInFlight++;
      fetchGroup(group, kind, asHigh ? "high" : "low")
        .then(resolve, (err) => { groupLoads.delete(key); reject(err); }) // a later request retries
        .finally(() => {
          if (asHigh) highInFlight--; else lowInFlight--;
          pumpLowQueue();
        });
    },
  };
  groupLoads.set(key, load);
  if (priority === "high") load.begin(true);
  else { lowQueue.push(load); pumpLowQueue(); }
  return load.promise;
}

// ─── A species-list request, answered from the files ──────────────────────

function parseSpeciesUrl(url: string): { taxon: string; ne: boolean } | null {
  const q = url.indexOf("?");
  if (q < 0) return null;
  const sp = new URLSearchParams(url.slice(q + 1));
  return { taxon: sp.get("taxon") || "all", ne: sp.get("category") === "NE" };
}

/**
 * Answer a `/api/redlist/species?…` URL from the group files: the same rows and flags
 * the route returns. Null means "can't — use the route" (see the module comment).
 */
export async function speciesEntryFromFiles(url: string, priority: LoadPriority = "high"): Promise<SpeciesCacheEntry | null> {
  const req = parseSpeciesUrl(url);
  if (!req) return null;
  const manifest = await loadManifest();
  if (!manifest) return null;
  const groups = groupsForTaxon(req.taxon, manifest);
  if (!groups) return null;
  const kind: SpeciesListKind = req.ne ? "ne" : "assessed";

  if (req.ne) {
    const neTotal = groups.reduce((s, g) => s + manifest.groups[g].ne.rows, 0);
    if (neTotal > NE_CAP) return { species: [], truncated: false, tooLarge: true, neTotal };
  }
  const parts = await Promise.all(groups.map((g) => loadGroup(g, kind, priority)));
  const species = parts.length === 1 ? parts[0] : parts.flat();
  return { species, truncated: false, tooLarge: false, neTotal: null };
}

/**
 * Whether a background prefetch is polite right now: not when the browser says the user
 * is saving data or on a cellular / very slow connection (where a silent multi-MB
 * download costs them money or crowds out what they're doing).
 */
export function prefetchAllowed(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string; effectiveType?: string } }).connection;
  return !(conn?.saveData || conn?.type === "cellular" || conn?.effectiveType === "2g" || conn?.effectiveType === "slow-2g");
}

/** Test hook: forget every cached manifest/group/queue entry. */
export function __resetSpeciesListLoader() {
  manifestPromise = null;
  groupLoads.clear();
  lowQueue.length = 0;
  highInFlight = 0;
  lowInFlight = 0;
}
