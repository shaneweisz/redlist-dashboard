/**
 * The counting rule, as SQL over the core tables.
 *
 * A species' record count is the records on every usage that counts towards
 * it (taxa.species_id: its own, its synonyms', its infraspecifics', its BINs'),
 * leaving out usages a separately assessed species owns, and keeping only the
 * record types the species' kingdom counts: preserved specimens count for
 * plants, fungi and algae (herbarium sheets are their primary records), not for
 * animals (see INCLUDED_BASIS_OF_RECORD in src/lib/gbif.ts).
 *
 * Every number the dashboard shows from GBIF is this rule with a different
 * filter: georeferenced or all records, since an assessment date, per country.
 */

import { INCLUDED_BASIS_OF_RECORD, INCLUDED_BASIS_OF_RECORD_WITH_SPECIMENS } from "../../../src/lib/gbif";

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

/**
 * Is this record type counted for a species of this (lowercase CoL) kingdom?
 * An unknown kingdom counts what an animal would, the narrower set.
 */
export function countedBasisSql(basisCol: string, kingdomCol: string): string {
  return `(${basisCol} IN (${list(INCLUDED_BASIS_OF_RECORD)})
    OR (coalesce(${kingdomCol}, 'animalia') <> 'animalia' AND ${basisCol} IN (${list(INCLUDED_BASIS_OF_RECORD_WITH_SPECIMENS)})))`;
}

export interface CountSources {
  /** A relation with col_id, species_id, kingdom (taxa.parquet). */
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
    SELECT c.usage_key, u.species_id, ${s.dated ? "c.year, c.month, c.event_date" : "c.year"}, c.georef, c.n
    FROM ${s.counts} c
    JOIN ${s.taxa} u ON u.col_id = c.usage_key
    LEFT JOIN ${s.taxa} sp ON sp.col_id = u.species_id
    WHERE ${countedBasisSql("c.basis", "coalesce(sp.kingdom, u.kingdom)")}`;
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
