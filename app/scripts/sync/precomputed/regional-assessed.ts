/**
 * lists/regional-assessed: assessed.parquet's columns for regional assessments,
 * plus region. What the dashboard reads under a regional scope (?scope=Europe):
 * the same rows, filters and charts as the global view, from the region's
 * assessments.
 *
 * Built from: sources/regional_assessments (sources/assessments.ts, scope
 * "regional") and lists/assessed.parquet.
 *
 * Columns: region, then exactly assessed.parquet's, in its order.
 *
 * Decisions:
 *   - One row per species and region: its latest assessment in that region.
 *   - The assessment's own columns (category, dates, criteria, countries,
 *     threats, habitats, credits, …) are the regional assessment's.
 *   - What belongs to the species, not the assessment (its CoL link, GBIF and
 *     literature counts, Specialist Group), is its global row's. A species with
 *     no global assessment has no link, so it is 'unlinked' with zero counts,
 *     as an unlinked global species is.
 *   - The since-assessment counts are measured from the global assessment's
 *     date, so they are kept only when the regional assessment is that same
 *     assessment (a regional endemic's global assessment is also its regional
 *     one); otherwise null, as for an assessment with no date.
 *   - assessment_count: the years the species was assessed in that region.
 */
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

export async function buildRegionalAssessed(files: { regionalAssessments: string; assessed: string }, out: string): Promise<void> {
  const conn = await openDuckDB();
  const list = (c: string) => `CASE WHEN ${c} IS NULL OR len(${c}) = 0 THEN NULL ELSE array_to_string(${c}, ';') END`;
  const sameAssessment = (c: string) => `CASE WHEN g.assessment_id = r.assessment_id THEN g.${c} END AS ${c}`;
  await conn.run(`COPY (
    WITH history AS (
      SELECT region, sis_taxon_id, count(DISTINCT year_published) AS n
      FROM ${parquet(files.regionalAssessments)} GROUP BY ALL)
    SELECT r.region, r.sis_taxon_id AS id, r.scientific_name,
           coalesce(g.common_name, nullif(r.common_name, '')) AS common_name,
           r.taxon_group, r.class_name, r.order_name, r.family,
           r.category AS iucn_category, r.assessment_id,
           CAST(r.assessment_date AS VARCHAR) AS assessment_date, r.year_published,
           ${list("r.countries")} AS countries,
           g.gbif_species_key,
           CASE WHEN g.id IS NULL THEN 'unlinked' ELSE g.count_note END AS count_note,
           g.match_reason, g.match_counts, g.match_doubts, g.match_note, g.match_records, g.match_review,
           g.redlist_authority, g.redlist_synonyms, g.match_treatment,
           coalesce(g.match_other_names, 0)::INTEGER AS match_other_names,
           coalesce(g.gbif_georeferenced_records_count, 0) AS gbif_georeferenced_records_count,
           coalesce(g.gbif_all_records_count, 0) AS gbif_all_records_count,
           ${sameAssessment("gbif_georeferenced_records_since_assessment")},
           ${sameAssessment("gbif_all_records_since_assessment")},
           coalesce(g.openalex_works, 0)::BIGINT AS openalex_works,
           ${sameAssessment("openalex_works_since_assessment")},
           coalesce(g.bhl_works, 0)::BIGINT AS bhl_works,
           ${sameAssessment("bhl_works_since_assessment")},
           r.population_trend, ${list("r.systems")} AS systems, ${list("r.growth_forms")} AS growth_forms,
           r.movement_pattern, r.possibly_extinct, r.possibly_extinct_in_the_wild, r.criteria,
           ${list("r.threat_codes")} AS threat_codes, ${list("r.habitat_codes")} AS habitat_codes,
           r.assessors AS latest_assessors, r.reviewers AS latest_reviewers, r.facilitators AS latest_facilitators,
           r.contributors AS latest_contributors, r.institutions AS latest_institutions,
           coalesce(h.n, 1)::BIGINT AS assessment_count,
           g.specialist_group
    FROM ${parquet(files.regionalAssessments)} r
    LEFT JOIN ${parquet(files.assessed)} g ON g.id = r.sis_taxon_id
    LEFT JOIN history h ON h.region = r.region AND h.sis_taxon_id = r.sis_taxon_id
    WHERE r.is_latest
    ORDER BY r.region, r.sis_taxon_id
  ) TO ${lit(output(out))} (FORMAT parquet, COMPRESSION zstd)`);

  // Same columns as assessed.parquet, in its order, or the app's queries break under a region.
  const cols = async (f: string) => (await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${parquet(f)}`)).getRowObjects()
    .map((r) => `${r.column_name} ${r.column_type}`);
  const want = await cols(files.assessed);
  const got = (await cols(out)).slice(1);
  if (want.join(",") !== got.join(",")) {
    throw new Error(`regional-assessed: columns differ from assessed.parquet:\n  want ${want.join(", ")}\n  got  ${got.join(", ")}`);
  }
  const summary = (await conn.runAndReadAll(`SELECT region, count(*)::INT AS n FROM ${parquet(out)} GROUP BY 1 ORDER BY 2 DESC`)).getRowObjects();
  console.log(`   ${summary.reduce((s, r) => s + Number(r.n), 0).toLocaleString()} regional species rows in ${summary.length} regions ` +
    `(${summary.slice(0, 3).map((r) => `${r.region} ${Number(r.n).toLocaleString()}`).join(", ")}, …)`);
}
