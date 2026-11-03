/**
 * Column-oriented encoding for the pre-built per-group species-list files
 * (scripts/build-species-lists.ts writes them; lib/species-lists/loader.ts reads them).
 *
 * A row-per-object JSON array repeats every key on every row — about half the bytes
 * before compression. Storing one array per field instead is ~2.4x smaller raw and
 * compresses better too (flowering plants NE: 6.2MB → 5.8MB brotli, at a quality
 * that takes 1.3s instead of 144s), and is far less JSON for the browser to parse.
 *
 * Shape parity matters: the client was written against the API's row objects, and
 * assessed rows carry every field (null when empty) while NE rows carry only their
 * own slim subset (absent, not null — see querySpecies). Each file holds one row kind,
 * so every row in a file has the same key set; encoding takes the keys from the rows
 * themselves (union, in first-seen order) and decoding rebuilds rows with exactly those
 * keys. A key one row lacks but another has is recorded in `sparse` so decoding can
 * leave it absent rather than invent a null.
 */

export interface ColumnarSpeciesList {
  /** Format version — bump if the shape changes, so a stale client can refuse it. */
  v: 1;
  n: number;
  keys: string[];
  cols: unknown[][];
  /** Keys absent (not merely null) on some rows; their missing slots hold `undefined`→null in JSON, so track which. */
  sparse?: Record<string, number[]>;
}

export function encodeColumns(rows: readonly Record<string, unknown>[]): ColumnarSpeciesList {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const sparse: Record<string, number[]> = {};
  const cols = keys.map((k) => {
    const col = new Array<unknown>(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (k in r) col[i] = r[k] ?? null;
      else { col[i] = null; (sparse[k] ??= []).push(i); }
    }
    return col;
  });
  return Object.keys(sparse).length ? { v: 1, n: rows.length, keys, cols, sparse } : { v: 1, n: rows.length, keys, cols };
}

export function decodeColumns<T = Record<string, unknown>>(data: ColumnarSpeciesList): T[] {
  if (data.v !== 1) throw new Error(`Unsupported species-list format v${data.v}`);
  const { n, keys, cols } = data;
  if (!data.sparse) {
    // Build each row as ONE object literal from a generated constructor. V8 then lays
    // the row out with all fields in-object, as JSON.parse would; adding the same fields
    // one at a time (the loop below) leaves them in a separate, larger backing store —
    // measured ~40% more heap for the same rows (flowering plants: 237MB → 137MB).
    // new Function needs no CSP 'unsafe-eval' today; if one is ever added, it throws
    // and we take the slower path rather than break.
    try {
      const make = new Function("c", "i", `return {${keys.map((k, j) => `${JSON.stringify(k)}: c[${j}][i]`).join(",")}};`) as (c: unknown[][], i: number) => T;
      const out = new Array<T>(n);
      for (let i = 0; i < n; i++) out[i] = make(cols, i);
      return out;
    } catch {
      // fall through
    }
  }
  const absent = data.sparse ? keys.map((k) => (data.sparse![k] ? new Set(data.sparse![k]) : null)) : null;
  const out = new Array<T>(n);
  for (let i = 0; i < n; i++) {
    const r: Record<string, unknown> = {};
    for (let j = 0; j < keys.length; j++) {
      if (absent?.[j]?.has(i)) continue;
      r[keys[j]] = cols[j][i];
    }
    out[i] = r as T;
  }
  return out;
}

/** Path segment of one group file: `<group>.assessed.json.br` / `<group>.ne.json.br`. */
export type SpeciesListKind = "assessed" | "ne";
export const speciesListFileName = (group: string, kind: SpeciesListKind) => `${group}.${kind}.json.br`;

export interface SpeciesListManifest {
  v: 1;
  /** Sync timestamp the files were built from (= latest-sync.txt). */
  sync: string;
  groups: Record<string, {
    assessed: { rows: number; bytes: number };
    ne: { rows: number; bytes: number };
    /**
     * Every class and order name in the group, lowercased (assessed ∪ NE). Lets the
     * browser load only the groups a dynamic drilldown node can match — e.g.
     * insects~order:coleoptera needs beetles, not all eight insect groups.
     */
    names: string[];
  }>;
}
