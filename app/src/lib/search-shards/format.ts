/**
 * Static search shards (scripts/build/build-search-shards.ts → public/search-shards/<sync>/).
 *
 * Search is a prefix match over name-index.parquet (species) and rank-index.parquet
 * (class/order/family/genus suggestions), both sorted by name. Rather than read those off
 * R2 per keystroke (~1-2s in production), the build splits them by the query's leading
 * characters into small static files the browser fetches once and ranks itself:
 *
 *   p2/<hex("pa")>.json.br  — one per two-letter prefix. If the prefix has at most
 *                             COMPLETE_MAX species names, it holds EVERY row under it
 *                             (complete: true) and answers any longer query too. Else it
 *                             holds only the rows the two-letter query itself returns
 *                             (pre-ranked top-K), and longer queries use p3.
 *   p3/<hex("pan")>.json.br — all rows under a three-letter prefix, only for the
 *                             prefixes whose two-letter parent isn't complete.
 *   manifest.json           — which two-letter prefixes exist, and which are complete.
 *
 * Keys are the first 2/3 Unicode code points of the lowercased name (the same unit
 * DuckDB's range predicate compares), hex-encoded as UTF-8 so any character is a safe
 * file name.
 */
import type { ColumnarSpeciesList } from "@/lib/species-lists/format";

/** A two-letter prefix with at most this many species names ships complete in one file. */
export const COMPLETE_MAX = 4000;

export interface SearchShard {
  v: 1;
  complete: boolean;
  /** On an incomplete p2 shard: the three-letter keys that have a p3 file (others have no names). */
  p3?: string[];
  species: ColumnarSpeciesList;
  taxa: ColumnarSpeciesList;
}

export interface SearchShardManifest {
  v: 1;
  sync: string;
  /** Two-letter key (as typed, lowercased) → whether its p2 file is complete. Absent = no names start with it. */
  p2: Record<string, boolean>;
}

/** The first `n` code points of s (DuckDB's string unit), or null if s is shorter. */
export function prefixKey(s: string, n: number): string | null {
  const cps = [...s];
  return cps.length >= n ? cps.slice(0, n).join("") : null;
}

/** File-name-safe encoding of a prefix key: its UTF-8 bytes as lowercase hex. */
export function hexKey(key: string): string {
  return Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, "0")).join("");
}
