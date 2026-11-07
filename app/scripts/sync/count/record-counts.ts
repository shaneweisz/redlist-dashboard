/**
 * record_counts: one row per species with GBIF records, assessed or not, with
 * its counts in both record modes.
 *
 * Built from: usage_owner, occurrences, assessment_link (each row's verdict),
 * assessments (the latest assessment's date).
 *
 * Columns:
 *   sis_taxon_id      the assessed species, else NULL
 *   col_id            the unassessed CoL species, else NULL
 *   gbif_species_key  the usage the species' GBIF page is (assessed species)
 *   georef            records with coordinates and no geospatial issue
 *   all_records       every record
 *   georef_since, all_since
 *                     the same, since the latest assessment (assessed species;
 *                     NULL when there is no window)
 *
 * Decisions:
 *   - Every count is occurrences summed over the usages usage_owner gives the
 *     species.
 *   - The GBIF key is the counted usage with the most records, an own row's
 *     before a lumped one's, so Hylatomus pileatus links to Dryocopus pileatus'
 *     5M records rather than its own 156: CoL holds that bird twice, and both
 *     halves count.
 *   - Since the assessment means from the day after its date to the sync date.
 *     Later years count whatever their precision. In the assessment's own year a
 *     record counts if it is dated to a later day, or only to a later month; one
 *     dated only to that year, or only to the assessment's month, can't be placed
 *     either side and is left out.
 *   - No window for an undated assessment, or one dated on or after the sync
 *     date: nothing can postdate it yet.
 */
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

export async function buildRecordCounts(
  inputs: { usageOwner: string; occurrences: string; link: string; assessments: string; today?: string },
  recordCountsFile: string,
): Promise<void> {
  const conn = await openDuckDB();
  const d = lit(inputs.today ?? new Date().toISOString().slice(0, 10));
  await conn.run(`CREATE TEMP TABLE owner AS SELECT * FROM ${parquet(inputs.usageOwner)}`);
  await conn.run(`CREATE OR REPLACE VIEW occ AS SELECT * FROM ${parquet(inputs.occurrences)}`);

  // Per assessed species and link row: its usages' records, in total and since the assessment.
  await conn.run(`CREATE TEMP TABLE row_counts AS
    WITH rows AS (
      SELECT o.sis_taxon_id AS sis, o.link_usage_id AS usage_id, any_value(l.verdict) AS verdict,
             CAST(any_value(a.assessment_date) AS DATE) AS assessed_on
      FROM owner o
      JOIN ${parquet(inputs.link)} l ON l.sis_taxon_id = o.sis_taxon_id AND l.usage_id = o.link_usage_id AND l.counted
      JOIN ${parquet(inputs.assessments)} a ON a.sis_taxon_id = o.sis_taxon_id AND a.is_latest
      WHERE o.sis_taxon_id IS NOT NULL GROUP BY 1, 2)
    SELECT r.sis, r.usage_id, any_value(r.verdict) AS verdict, any_value(r.assessed_on) AS assessed_on,
           coalesce(sum(c.n) FILTER (c.georef), 0)::BIGINT AS georef,
           coalesce(sum(c.n), 0)::BIGINT AS all_records,
           coalesce(sum(c.n) FILTER (c.georef AND (${since("c", "r.assessed_on", d)})), 0)::BIGINT AS georef_since,
           coalesce(sum(c.n) FILTER (${since("c", "r.assessed_on", d)}), 0)::BIGINT AS all_since
    FROM rows r
    JOIN owner o ON o.sis_taxon_id = r.sis AND o.link_usage_id = r.usage_id
    JOIN occ c ON c.usage_key = o.usage_key
    GROUP BY r.sis, r.usage_id`);

  await conn.run(`COPY (
    SELECT sis AS sis_taxon_id, NULL::VARCHAR AS col_id,
           -- usage_id last: two usages with the same counts would otherwise swap between runs.
           arg_min(usage_id, (CASE verdict WHEN 'own' THEN 0 ELSE 1 END, -georef, -all_records, usage_id)) AS gbif_species_key,
           sum(georef)::BIGINT AS georef, sum(all_records)::BIGINT AS all_records,
           CASE WHEN any_value(assessed_on) IS NULL OR any_value(assessed_on) >= ${d}::DATE THEN NULL ELSE sum(georef_since)::BIGINT END AS georef_since,
           CASE WHEN any_value(assessed_on) IS NULL OR any_value(assessed_on) >= ${d}::DATE THEN NULL ELSE sum(all_since)::BIGINT END AS all_since
    FROM row_counts GROUP BY sis HAVING sum(all_records) > 0
    UNION ALL
    SELECT NULL, o.col_id, NULL, coalesce(sum(c.n) FILTER (c.georef), 0)::BIGINT, sum(c.n)::BIGINT, NULL, NULL
    FROM owner o JOIN occ c ON c.usage_key = o.usage_key
    WHERE o.col_id IS NOT NULL GROUP BY o.col_id HAVING sum(c.n) > 0
    ORDER BY sis_taxon_id, col_id
  ) TO ${lit(output(recordCountsFile))} (FORMAT parquet, COMPRESSION zstd)`);
}

/** A record counts since the assessment if dated after it and by the sync date (see the header). */
function since(c: string, assessedOn: string, today: string): string {
  return `(${c}.year > year(${assessedOn}) AND ${c}.year <= year(${today}::DATE))
    OR (${c}.year = year(${assessedOn}) AND CASE
          WHEN ${c}.event_date IS NOT NULL THEN ${c}.event_date > ${assessedOn} AND ${c}.event_date <= ${today}::DATE
          WHEN ${c}.month IS NOT NULL THEN ${c}.month > month(${assessedOn}) AND make_date(${c}.year, ${c}.month, 1) <= ${today}::DATE
          ELSE false END)`;
}
