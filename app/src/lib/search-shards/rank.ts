/**
 * Search ranking shared by the server (species-duckdb's tier-0 prefix search), the
 * build step that pre-ranks the two-letter shards (scripts/build/build-search-shards.ts), and
 * the browser (lib/search-shards/client.ts) — one implementation, so all three agree.
 *
 * rankSpecies / rankTaxa reproduce, row for row, the ORDER BY + LIMIT of prefixSearch
 * and suggestTaxa's SQL; scripts/build/check-search-shards.ts proves it against that SQL.
 */
import type { SearchResult, TaxonSuggestion } from "@/lib/data/species-duckdb";

// One entry per species, in the order the hits arrived. unassessed.parquet is one row per
// GBIF species key, and CoL lumps some of those: 3,756 col_ids carry more than one key, so
// a name like Abutilon halophilum matched twice (keys VLWL9 and 8N4F) and listed twice in
// the dropdown — two rows that now resolve to the same species and would select the same
// table row. The NE list already shows one row per col_id (ne_gbif_by_col groups by it), so
// collapsing here is what makes search agree with the list it selects into. Keep the
// best-observed key of the group, which is the most useful one to preview from; ties keep
// the first, which is the better-ranked one. The name index adds a second way to arrive at
// the same species (a hit on its scientific name AND its epithet, say), and this collapses
// that too. Null keys are never collapsed — those species have no shared identity to merge on.
export function dedupeByRowKey<T extends Pick<SearchResult, "species_key" | "gbif_georeferenced_records_count">>(hits: T[]): T[] {
  const bestByKey = new Map<string, T>();
  for (const r of hits) {
    if (!r.species_key) continue;
    const prev = bestByKey.get(r.species_key);
    if (!prev || (r.gbif_georeferenced_records_count ?? -1) > (prev.gbif_georeferenced_records_count ?? -1)) {
      bestByKey.set(r.species_key, r);
    }
  }
  return hits.filter((r) => !r.species_key || bestByKey.get(r.species_key) === r);
}

/** A name-index row as shipped in a shard: the finished SearchResult plus its sort keys. */
export interface ShardSpeciesRow extends SearchResult {
  /** The searchable name, lowercased (name-index.parquet's name_lo). */
  n: string;
  /** lower(common_name) / lower(scientific_name), as DuckDB lowercases them. */
  cl: string | null;
  sl: string;
}

/** A rank-index row as shipped in a shard: the finished suggestion plus its sort keys. */
export interface ShardTaxonRow {
  /** The searchable name: the taxon's own (lowercased), or one of its common names. */
  name: string;
  rp: number;
  rank: TaxonSuggestion["rank"];
  nodeId: string | null;
  /** The taxon's lowercased scientific name — what a suggestion browses to. */
  taxon: string;
  /** The taxon's common name, for display ("Browse Adansonia (Baobabs)"), if any. */
  common: string | null;
}

/** How many rows a two-letter shard keeps per query: prefixSearch's over-fetch at the API's max limit (50). */
export const SPECIES_TOP_K = 50 * 3 + 5;
/** suggestTaxa's per-tier cap (twice its limit — see pickTaxa) at its max limit (10). */
export const TAXA_TOP_K = 20;

// SQL three-valued booleans under DuckDB's default NULLS LAST, as a DESC sort key:
// true (2) before false (1) before NULL (0).
const tri = (v: string | null, test: (s: string) => boolean) => (v == null ? 0 : test(v) ? 2 : 1);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * prefixSearch's ORDER BY over the rows whose name starts with q, cut to its LIMIT
 * (`lim * 3 + 5`, before the de-dup): (cl = q) DESC, (cl LIKE q%) DESC,
 * (sl LIKE q%) DESC, sl. The SQL leaves ties beyond that unordered; this breaks them
 * by the matched name, then the row key, so the browser is at least deterministic.
 */
export function rankSpeciesRows<T extends ShardSpeciesRow>(rows: readonly T[], q: string, take: number): T[] {
  const keyed = [];
  for (const r of rows) {
    if (!r.n.startsWith(q)) continue;
    keyed.push({ r, a: tri(r.cl, (s) => s === q), b: tri(r.cl, (s) => s.startsWith(q)), c: r.sl.startsWith(q) ? 2 : 1 });
  }
  keyed.sort((x, y) =>
    y.a - x.a || y.b - x.b || y.c - x.c || cmpStr(x.r.sl, y.r.sl) || cmpStr(x.r.n, y.r.n) ||
    cmpStr(x.r.species_key ?? "", y.r.species_key ?? ""));
  return keyed.slice(0, take).map((k) => k.r);
}

/** The finished species half of a search: ranked, de-duplicated, internal keys dropped. */
export function rankSpecies(rows: readonly ShardSpeciesRow[], q: string, limit: number): SearchResult[] {
  const lim = Math.min(Math.max(limit, 1), 50);
  const top = rankSpeciesRows(rows, q, lim * 3 + 5).map(({ n: _n, cl: _cl, sl: _sl, ...result }) => result as SearchResult);
  return dedupeByRowKey(top).slice(0, lim);
}

const GENUS_RP = 3; // SUGGEST_RANKS.indexOf("genus") — class, order, family, genus
const len = (s: string) => [...s].length; // DuckDB length() counts code points

/**
 * suggestTaxa's SQL — per tier (genus vs higher ranks), exact match first, then shortest
 * name, then alphabetical, capped at `perTier` — in its ORDER BY (higher ranks first).
 */
export function rankTaxonRows<T extends ShardTaxonRow>(rows: readonly T[], q: string, perTier: number): T[] {
  const order = (x: T, y: T) => Number(y.name === q) - Number(x.name === q) || len(x.name) - len(y.name) || cmpStr(x.name, y.name);
  const matching = rows.filter((r) => r.name.startsWith(q));
  const higher = matching.filter((r) => r.rp !== GENUS_RP).sort(order).slice(0, perTier);
  const genus = matching.filter((r) => r.rp === GENUS_RP).sort(order).slice(0, perTier);
  return [...higher, ...genus];
}

/**
 * suggestTaxa's choice from rows already in its SQL order (higher ranks, then genus,
 * each tier capped at twice the limit): one row per taxon — a taxon can be reached by
 * its own name and by a common name at once — then a slot reserved for the best genus,
 * an exact match first. Shared by the route and the browser, so both pick alike.
 */
export function pickTaxa(ranked: readonly ShardTaxonRow[], q: string, limit = 3): TaxonSuggestion[] {
  const lim = Math.min(Math.max(limit, 1), 10);
  const seen = new Set<string>();
  const unique = ranked.filter((r) => (seen.has(r.taxon) ? false : (seen.add(r.taxon), true)));
  const higher = unique.filter((r) => r.rp !== GENUS_RP);
  const genus = unique.filter((r) => r.rp === GENUS_RP);
  const genusSlots = genus.length === 0 ? 0 : Math.max(1, lim - higher.length);
  const chosen = [...higher.slice(0, lim - genusSlots), ...genus.slice(0, genusSlots)];
  chosen.sort((a, b) => Number(b.name === q) - Number(a.name === q));
  return chosen.map((r) => ({
    name: r.taxon.charAt(0).toUpperCase() + r.taxon.slice(1),
    rank: r.rank,
    taxon: r.taxon,
    nodeId: r.nodeId,
    common_name: r.common,
  }));
}

/** The finished taxon half of a search, in the browser: rankTaxonRows + pickTaxa. */
export function rankTaxa(rows: readonly ShardTaxonRow[], q: string, limit = 3): TaxonSuggestion[] {
  const lim = Math.min(Math.max(limit, 1), 10);
  return pickTaxa(rankTaxonRows(rows, q, lim * 2), q, lim);
}
