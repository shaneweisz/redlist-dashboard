/**
 * The search dropdown, answered in the browser from static prefix shards
 * (lib/search-shards/format.ts) instead of /api/search.
 *
 * A two-letter shard is fetched once (~tens of KB from the CDN) and every further
 * keystroke under it is a local filter + rank — no request at all. Ranking is
 * lib/search-shards/rank.ts, the same code the server's tier-0 search runs.
 *
 * The route stays for everything past tier 0: when the shards find no species whose
 * name STARTS with the query (a substring like "fox" inside "red fox", a CoL-only name,
 * a synonym), or when this deployment has no shards (`next dev` without a build), the
 * search falls back to /api/search, which still answers exactly as before.
 */
import type { SearchResult, TaxonSuggestion } from "@/lib/data/species-duckdb";
import { decodeColumns } from "@/lib/species-lists/format";
import { hexKey, prefixKey, type SearchShard, type SearchShardManifest } from "./format";
import { rankSpecies, rankTaxa, type ShardSpeciesRow, type ShardTaxonRow } from "./rank";

export interface SearchResponse {
  results: SearchResult[];
  taxa: TaxonSuggestion[];
}

const SYNC = process.env.NEXT_PUBLIC_SPECIES_LISTS_SYNC ?? "";
const base = () => `/prebuilt/${SYNC}/search-shards`;

let manifestPromise: Promise<SearchShardManifest | null> | null = null;
function loadManifest(): Promise<SearchShardManifest | null> {
  if (!SYNC) return Promise.resolve(null);
  manifestPromise ??= fetch(`${base()}/manifest.json`)
    .then((res) => (res.ok ? (res.json() as Promise<SearchShardManifest>) : null))
    .then((m) => (m && m.v === 1 && m.sync === SYNC ? m : null))
    .catch(() => null);
  return manifestPromise;
}

interface LoadedShard { complete: boolean; p3: Set<string>; species: ShardSpeciesRow[]; taxa: ShardTaxonRow[] }
const shards = new Map<string, Promise<LoadedShard>>();
function loadShard(path: string): Promise<LoadedShard> {
  let p = shards.get(path);
  if (!p) {
    p = fetch(`${base()}/${path}`)
      .then((res) => {
        if (!res.ok) throw new Error(`search shard ${path} returned ${res.status}`);
        return res.json() as Promise<SearchShard>;
      })
      .then((s) => ({
        complete: s.complete,
        p3: new Set(s.p3 ?? []),
        species: decodeColumns<ShardSpeciesRow>(s.species),
        taxa: decodeColumns<ShardTaxonRow>(s.taxa),
      }));
    p.catch(() => shards.delete(path)); // a later keystroke retries
    shards.set(path, p);
  }
  return p;
}

/**
 * The dropdown's answer from the shards, or null when they can't give it (no shards for
 * this deployment, or no species name starts with the query — the route's later tiers
 * take over). Throws only if a shard that should exist fails to load.
 */
export async function searchFromShards(query: string, limit = 10): Promise<SearchResponse | null> {
  // The route answers fewer than 2 UTF-16 units with nothing; match it exactly.
  if (query.length < 2) return { results: [], taxa: [] };
  const q = query.toLowerCase();
  const k2 = prefixKey(q, 2);
  if (!k2) return null; // one astral character (2 UTF-16 units) — let the route decide
  const manifest = await loadManifest();
  if (!manifest) return null;
  if (!(k2 in manifest.p2)) return null; // nothing starts with these two letters

  let shard = await loadShard(`p2/${hexKey(k2)}.json.br`);
  if (!shard.complete && q !== k2) {
    const k3 = prefixKey(q, 3)!;
    if (!shard.p3.has(k3)) return null;
    shard = await loadShard(`p3/${hexKey(k3)}.json.br`);
  }
  const results = rankSpecies(shard.species, q, limit);
  if (results.length === 0) return null;
  return { results, taxa: rankTaxa(shard.taxa, q) };
}

/** The search the dropdown runs: shards first, the live route for whatever they can't answer. */
export async function search(query: string, limit = 10, signal?: AbortSignal): Promise<SearchResponse> {
  try {
    const fromShards = await searchFromShards(query, limit);
    if (fromShards) return fromShards;
  } catch {
    // A shard failed to load — the route still answers.
  }
  signal?.throwIfAborted();
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`, { signal });
  if (!res.ok) throw new Error("Search failed");
  const data = await res.json();
  return { results: data.results ?? [], taxa: data.taxa ?? [] };
}

/** Test hook. */
export function __resetSearchShards() {
  manifestPromise = null;
  shards.clear();
}
