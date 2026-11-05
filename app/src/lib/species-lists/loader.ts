/**
 * Browser loader for the pre-built per-group species-list files
 * (scripts/build/build-species-lists.ts → public/species-lists/<sync>/).
 *
 * A species-list request (the same `/api/redlist/species?taxon=…[&category=NE]` URL the
 * cache has always been keyed on) is answered by fetching the static files for the
 * taxon_groups that taxon needs and concatenating them. Every deeper drilldown is then
 * a local filter over rows already in memory (RedListView's speciesMatchesNode), so the
 * server never runs a species-list query for the dashboard.
 *
 * Group files are cached here at module level, so every URL, every compare-mode panel
 * and the TaxaSummary species popover share one download per group. There is no
 * background prefetch: a cold click costs ~0.3-2.6s (plants, the largest), and loading
 * every group up front would cost hundreds of MB of browser memory and bandwidth nobody
 * asked for.
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


const SYNC = process.env.NEXT_PUBLIC_SPECIES_LISTS_SYNC ?? "";
const base = () => `/prebuilt/${SYNC}/species-lists`;

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

// ─── Group files ──────────────────────────────────────────────────────────

const groupLoads = new Map<string, Promise<RedListSpecies[]>>();

/** Load one group file, sharing any download already started for it. */
export function loadGroup(group: string, kind: SpeciesListKind): Promise<RedListSpecies[]> {
  const key = `${group}.${kind}`;
  let load = groupLoads.get(key);
  if (!load) {
    load = fetch(`${base()}/${speciesListFileName(group, kind)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`species-list ${group}.${kind} returned ${res.status}`);
        return res.json() as Promise<ColumnarSpeciesList>;
      })
      .then((data) => decodeColumns<RedListSpecies>(data));
    load.catch(() => groupLoads.delete(key)); // a later request retries
    groupLoads.set(key, load);
  }
  return load;
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
export async function speciesEntryFromFiles(url: string): Promise<SpeciesCacheEntry | null> {
  const req = parseSpeciesUrl(url);
  if (!req) return null;
  const manifest = await loadManifest();
  if (!manifest) return null;
  const groups = groupsForTaxon(req.taxon, manifest);
  if (!groups) return null;
  const kind: SpeciesListKind = req.ne ? "ne" : "assessed";

  // No size cap: the live route caps Not Evaluated lists at 400k rows (it can't build a
  // bigger response), but the files load any group in full — all 1.3M NE invertebrates
  // open in ~3.6s and use ~470MB in a desktop browser, with charts drawn ~2s later.
  const parts = await Promise.all(groups.map((g) => loadGroup(g, kind)));
  const species = parts.length === 1 ? parts[0] : parts.flat();
  return { species, truncated: false, tooLarge: false, neTotal: null };
}

/** Test hook: forget every cached manifest and group download. */
export function __resetSpeciesListLoader() {
  manifestPromise = null;
  groupLoads.clear();
}
