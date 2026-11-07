/**
 * lists/assessed: one row per assessed species: its latest assessment, its GBIF
 * key and counts, its latest credits.
 *
 * Built from: assessments (latest), record_counts, lists/assessments (how many
 * years it was assessed in), common_names.
 *
 * Columns:
 *   id                       the SIS taxon id
 *   scientific_name, common_name, taxon_group, class_name, order_name, family
 *   iucn_category, assessment_id, assessment_date, year_published, criteria,
 *   population_trend, movement_pattern, possibly_extinct, possibly_extinct_in_the_wild
 *   countries, systems, growth_forms, threat_codes, habitat_codes
 *                            lists, ';'-joined (the app's filter SQL reads them so)
 *   gbif_species_key         see record_counts
 *   gbif_georeferenced_records_count, gbif_all_records_count
 *   gbif_georeferenced_records_since_assessment, gbif_all_records_since_assessment
 *   latest_assessors, latest_reviewers, latest_facilitators, latest_contributors,
 *   latest_institutions
 *   assessment_count         years with a published assessment
 *
 * Decisions:
 *   - Common name: IUCN's, else iNaturalist's.
 *   - A species with no GBIF records counts 0, and still has a since-assessment
 *     window (0) unless its assessment has none.
 */
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";
import { inatKingdomSql } from "../inputs/inat-names";

const semicolonList = (col: string) => `CASE WHEN ${col} IS NULL OR len(${col}) = 0 THEN NULL ELSE array_to_string(${col}, ';') END`;

export async function buildAssessed(
  inputs: { assessments: string; recordCounts: string; assessmentHistory: string; commonNames: string; today?: string },
  assessedFile: string,
): Promise<void> {
  const conn = await openDuckDB();
  const today = lit(inputs.today ?? new Date().toISOString().slice(0, 10));
  await conn.run(`COPY (
    SELECT latest.sis_taxon_id AS id, latest.scientific_name,
           coalesce(nullif(latest.common_name, ''), inat.name, latest.common_name) AS common_name,
           latest.taxon_group, latest.class_name, latest.order_name, latest.family,
           latest.category AS iucn_category, latest.assessment_id,
           CAST(latest.assessment_date AS VARCHAR) AS assessment_date, latest.year_published,
           ${semicolonList("latest.countries")} AS countries,
           gbif.gbif_species_key,
           coalesce(gbif.georef, 0) AS gbif_georeferenced_records_count,
           coalesce(gbif.all_records, 0) AS gbif_all_records_count,
           CASE WHEN gbif.sis_taxon_id IS NOT NULL THEN gbif.georef_since
                WHEN latest.assessment_date IS NOT NULL AND CAST(latest.assessment_date AS DATE) < ${today}::DATE THEN 0 END
             AS gbif_georeferenced_records_since_assessment,
           CASE WHEN gbif.sis_taxon_id IS NOT NULL THEN gbif.all_since
                WHEN latest.assessment_date IS NOT NULL AND CAST(latest.assessment_date AS DATE) < ${today}::DATE THEN 0 END
             AS gbif_all_records_since_assessment,
           latest.population_trend, ${semicolonList("latest.systems")} AS systems, ${semicolonList("latest.growth_forms")} AS growth_forms,
           latest.movement_pattern, latest.possibly_extinct, latest.possibly_extinct_in_the_wild, latest.criteria,
           ${semicolonList("latest.threat_codes")} AS threat_codes, ${semicolonList("latest.habitat_codes")} AS habitat_codes,
           latest.assessors AS latest_assessors, latest.reviewers AS latest_reviewers, latest.facilitators AS latest_facilitators,
           latest.contributors AS latest_contributors, latest.institutions AS latest_institutions,
           coalesce(history.n, 1)::BIGINT AS assessment_count
    FROM ${parquet(inputs.assessments)} latest
    LEFT JOIN ${parquet(inputs.recordCounts)} gbif ON gbif.sis_taxon_id = latest.sis_taxon_id
    LEFT JOIN (SELECT sis_taxon_id, count(*) AS n FROM ${parquet(inputs.assessmentHistory)} GROUP BY 1) history
      ON history.sis_taxon_id = latest.sis_taxon_id
    LEFT JOIN ${parquet(inputs.commonNames)} inat ON inat.source = 'inat' AND inat.kind = 'display'
      AND inat.scientific_name = latest.scientific_name AND inat.kingdom = ${inatKingdomSql("latest.taxon_group")}
    WHERE latest.is_latest
    ORDER BY latest.class_name, latest.order_name, latest.family, latest.scientific_name
  ) TO ${lit(output(assessedFile))} (FORMAT parquet, COMPRESSION zstd)`);
}
