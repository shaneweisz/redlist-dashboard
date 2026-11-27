/**
 * The CoL taxa a species' GBIF records are counted under, for the live
 * occurrence panels: the map, its record list and its record-type counts.
 *
 * In one sentence: ask GBIF for every taxon the count claims (the sync's
 * assessment_link rows that count), not only the species' one GBIF key.
 *
 * Why: the count follows docs/specs/matching.md, and a Red List species can
 * count several CoL taxa. *Butorides striata* counts 3.4M records, because CoL
 * splits it into *B. striata* and *B. virescens*; asked by its key alone, the
 * map showed only *B. striata*'s 287k. Each link row that counts names the
 * taxon it claims: the CoL species for *is* and *split into*, the record itself
 * for *part of* (its records, not the rest of its species).
 *
 * The rest of a *part of* record's species is the context: records the count
 * leaves to another species, which the map can draw beside the species' own
 * when asked (*Pararge xiphioides* is filed under *P. aegeria*: its 4.9k
 * records count, *P. aegeria*'s other 3.5M don't).
 *
 * Anything that fails falls back to the key alone, which is what the panels
 * asked for before this existed.
 */
import { getConn, parquetUri } from "@/lib/data/species-duckdb";
import { liveGbifKeys } from "@/lib/gbif-live-keys";

export type CountedRelation = "is" | "split into" | "part of";

/** One taxon the count claims. */
export interface CountedTaxon {
  /** The CoL id GBIF is asked with (taxonKey). */
  key: string;
  relation: CountedRelation;
  /** The CoL species it leads to (its own key for is and split into). */
  speciesKey: string;
}

export interface OccurrenceTaxa {
  counted: CountedTaxon[];
  /** The species of the part-of records: their other records count elsewhere. */
  context: string[];
}

const TTL = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<OccurrenceTaxa> }>();

/** The species' link rows that count, as taxa to ask GBIF for. */
export async function loadOccurrenceTaxa(gbifSpeciesKey: string): Promise<OccurrenceTaxa> {
  const conn = await getConn();
  // An assessed species by its GBIF key, as getSpeciesByGbifKey finds it; an
  // NE species has no link rows, and counts its own key.
  const sql = `
    WITH s AS (SELECT id FROM read_parquet('${parquetUri("assessed.parquet")}') WHERE gbif_species_key = $key LIMIT 1)
    SELECT l.relation, l.col_species_id, l.col_taxon_id
    FROM read_parquet('${parquetUri("assessment_link.parquet")}') l JOIN s ON l.sis_taxon_id = s.id
    WHERE l.counted AND l.relation IN ('is', 'split into', 'part of')
    ORDER BY l.role = 'primary' DESC, l.relation, l.col_taxon_id`;
  const rows = (await conn.runAndReadAll(sql, { key: gbifSpeciesKey })).getRowObjects();
  return taxaFromLinkRows(gbifSpeciesKey, rows.map((r) => ({
    relation: String(r.relation) as CountedRelation,
    col_species_id: r.col_species_id == null ? null : String(r.col_species_id),
    col_taxon_id: r.col_taxon_id == null ? null : String(r.col_taxon_id),
  })));
}

/** Link rows → taxa, the species' own key first. Pure, for tests. */
export function taxaFromLinkRows(
  gbifSpeciesKey: string,
  rows: { relation: CountedRelation; col_species_id: string | null; col_taxon_id: string | null }[],
): OccurrenceTaxa {
  const counted: CountedTaxon[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.relation === "part of" ? r.col_taxon_id : r.col_species_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    counted.push({ key, relation: r.relation, speciesKey: r.col_species_id ?? key });
  }
  if (counted.length === 0) return { counted: [{ key: gbifSpeciesKey, relation: "is", speciesKey: gbifSpeciesKey }], context: [] };
  counted.sort((a, b) => Number(b.key === gbifSpeciesKey) - Number(a.key === gbifSpeciesKey));
  const whole = new Set(counted.filter((t) => t.relation !== "part of").map((t) => t.speciesKey));
  const context = [...new Set(counted.filter((t) => t.relation === "part of" && !whole.has(t.speciesKey)).map((t) => t.speciesKey))];
  return { counted, context };
}

/** Cached per key for an hour; the key alone when the lookup fails. */
export function occurrenceTaxa(gbifSpeciesKey: string): Promise<OccurrenceTaxa> {
  const hit = cache.get(gbifSpeciesKey);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = loadOccurrenceTaxa(gbifSpeciesKey).catch((e) => {
    console.error("occurrence-taxa: falling back to the species key", e);
    cache.delete(gbifSpeciesKey);
    return { counted: [{ key: gbifSpeciesKey, relation: "is" as const, speciesKey: gbifSpeciesKey }], context: [] };
  });
  cache.set(gbifSpeciesKey, { at: Date.now(), value });
  return value;
}

/**
 * The species keys GBIF facets records by, mapped to the assessed species whose
 * count takes each whole (its *is* or *split into* rows): the other direction
 * of occurrenceTaxa. Nearby species uses it so records under a split's other
 * species are credited to the Red List species that counts them (*Butorides
 * virescens*'s records to *B. striata*), not dropped for matching no key.
 * Keys nothing counts whole are left out.
 */
export async function ownersOfSpeciesKeys(keys: readonly string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const conn = await getConn();
  const list = keys.map((k) => `'${String(k).replace(/'/g, "''")}'`).join(",");
  const rows = (await conn.runAndReadAll(`
    SELECT l.col_species_id AS key, min(a.gbif_species_key) AS owner
    FROM read_parquet('${parquetUri("assessment_link.parquet")}') l
    JOIN read_parquet('${parquetUri("assessed.parquet")}') a ON a.id = l.sis_taxon_id
    WHERE l.counted AND l.relation IN ('is', 'split into') AND l.col_species_id IN (${list})
    GROUP BY 1`)).getRowObjects();
  return new Map(rows.filter((r) => r.owner != null).map((r) => [String(r.key), String(r.owner)]));
}

/** Facet counts by species key → counts by the species that owns them. Pure, for tests. */
export function creditToOwners(byKey: Map<string, number>, owners: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, n] of byKey) {
    const owner = owners.get(key) ?? key;
    out.set(owner, (out.get(owner) ?? 0) + n);
  }
  return out;
}

/** The live GBIF ids for every taxon a species' count claims: what a route asks GBIF for. */
export async function countedGbifKeys(gbifSpeciesKey: string): Promise<string[]> {
  const { counted } = await occurrenceTaxa(gbifSpeciesKey);
  return [...new Set((await Promise.all(counted.map((t) => liveGbifKeys(t.key)))).flat())];
}
