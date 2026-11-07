/**
 * lists/species/: one row per accepted CoL species the curated checklist keeps,
 * with its lineage, partitioned by taxon_group. The universe every "described"
 * and Not Evaluated count, list and search tier is drawn from.
 *
 * Built from: taxa, assessment_link, assessments (latest categories).
 *
 * Columns:
 *   col_id, scientific_name, authorship, described_year,
 *   kingdom, phylum, class_name, order_name, family, genus, extinct, in_base,
 *   described      the dashboard's universe (below)
 *   taxon_group    the partition
 *
 * Decisions:
 *   - described: in a curated Base source, extant (or extinct and assessed EX
 *     or EW, which IUCN agrees with), and not excluded (seeds/ne-excluded.tsv).
 *     This is the one definition: every reader filters on it, so no two counts
 *     can disagree about which species exist.
 *   - Accepted in the XR and not demoted by the checklist.
 */
import * as fs from "fs";
import { lit, openDuckDB } from "../sql";
import { parquet } from "../paths";

export async function buildSpecies(inputs: { taxa: string; link: string; assessments: string }, speciesDir: string): Promise<void> {
  const conn = await openDuckDB();
  fs.rmSync(speciesDir, { recursive: true, force: true });
  await conn.run(`CREATE TEMP TABLE ex_ew_linked AS
    SELECT DISTINCT l.col_id FROM ${parquet(inputs.link)} l
    JOIN ${parquet(inputs.assessments)} a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
    WHERE l.col_id IS NOT NULL AND a.category IN ('EX', 'EW')`);
  await conn.run(`COPY (
    SELECT col_id, scientific_name, authorship, described_year, kingdom, phylum, class_name, order_name, family, genus,
           extinct, in_base,
           in_base AND (extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ex_ew_linked)) AND ne_excluded IS NULL AS described,
           taxon_group
    FROM ${parquet(inputs.taxa)} WHERE rank = 'species' AND status = 'accepted' AND NOT demoted
    ORDER BY taxon_group, class_name, order_name, family, scientific_name
  ) TO ${lit(speciesDir)} (FORMAT parquet, PARTITION_BY (taxon_group), COMPRESSION zstd, ROW_GROUP_SIZE 20000)`);
}
