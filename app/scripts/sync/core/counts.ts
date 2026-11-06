/**
 * The counting rule, as SQL over the core tables.
 *
 * A species' record count is the records on every usage that counts towards
 * it (taxa.species_id: its own, its synonyms', its infraspecifics', its BINs'),
 * leaving out usages a separately assessed species owns.
 *
 * All records counts every record, of any type. A georeferenced record has
 * coordinates, no geospatial issue and a record type that places the species
 * where it lives wild (GEOREFERENCED_BASIS_OF_RECORD in src/lib/gbif-records.ts),
 * the same for every kingdom. Every number the dashboard shows from GBIF is
 * this rule with a different filter: georeferenced or all records, since an
 * assessment date, per country.
 */

import { GEOREFERENCED_BASIS_OF_RECORD } from "../../../src/lib/gbif-records";

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

/** Is this aggregate row georeferenced, in the dashboard's sense? */
export function georeferencedSql(georefCol: string, basisCol: string): string {
  return `(${georefCol} AND ${basisCol} IN (${list(GEOREFERENCED_BASIS_OF_RECORD)}))`;
}

export interface CountSources {
  /** A relation with col_id and species_id (taxa.parquet). */
  taxa: string;
  /** usage_key, year, georef, basis, n (occurrence_counts.parquet), or with
   *  month and event_date too (occurrence_dates.parquet) when `dated`. */
  counts: string;
  dated?: boolean;
  /** Optional relation with a usage_key column: usages owned by an assessed species other than their species_id. */
  owned?: string;
}

/**
 * Counted records per usage, with the species they count towards and the
 * kingdom that decides their record types. The building block for both
 * per-species totals and a lumped species' own usage.
 */
export function usageCountsSql(s: CountSources): string {
  return `
    SELECT c.usage_key, u.species_id, ${s.dated ? "c.year, c.month, c.event_date" : "c.year"},
           ${georeferencedSql("c.georef", "c.basis")} AS georef, c.n
    FROM ${s.counts} c
    JOIN ${s.taxa} u ON u.col_id = c.usage_key`;
}

/** species_id → georef, all_records. */
export function speciesCountsSql(s: CountSources): string {
  return `
    WITH uc AS (${usageCountsSql(s)})
    SELECT species_id,
           sum(n) FILTER (georef)::BIGINT AS georef,
           sum(n)::BIGINT AS all_records
    FROM uc
    WHERE species_id IS NOT NULL
      ${s.owned ? `AND usage_key NOT IN (SELECT usage_key FROM ${s.owned})` : ""}
    GROUP BY species_id`;
}
