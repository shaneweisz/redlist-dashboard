/**
 * lists/assessments: one row per assessed species per year it was published
 * in, latest first. The species page's assessment history.
 *
 * Built from: assessments.
 *
 * Columns:
 *   sis_taxon_id
 *   seq          0 for the latest, then 1, 2, … going back
 *   id           the assessment id
 *   year         year published
 *   category, date, criteria, assessors, reviewers, facilitators, contributors,
 *   institutions
 *
 * Decisions:
 *   - Published assessments only: an unpublished draft has no year_published.
 *   - One per year: the species' latest assessment if it is in that year (an old
 *     assessment republished the same year has a higher id but isn't the one the
 *     category comes from), else the most recently dated.
 */
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

export async function buildAssessmentHistory(inputs: { assessments: string }, historyFile: string): Promise<void> {
  const conn = await openDuckDB();
  await conn.run(`COPY (
    SELECT sis_taxon_id, (row_number() OVER (PARTITION BY sis_taxon_id ORDER BY year_published DESC, is_latest DESC, assessment_date DESC NULLS LAST, assessment_id DESC) - 1)::INTEGER AS seq,
           assessment_id AS id, year_published AS "year", category, CAST(assessment_date AS VARCHAR) AS "date", criteria,
           assessors, reviewers, facilitators, contributors, institutions
    FROM ${parquet(inputs.assessments)}
    WHERE year_published IS NOT NULL
      AND sis_taxon_id IN (SELECT sis_taxon_id FROM ${parquet(inputs.assessments)} WHERE is_latest)
    QUALIFY row_number() OVER (PARTITION BY sis_taxon_id, year_published ORDER BY is_latest DESC, assessment_date DESC NULLS LAST, assessment_id DESC) = 1
    ORDER BY sis_taxon_id, seq
  ) TO ${lit(output(historyFile))} (FORMAT parquet, COMPRESSION zstd)`);
}
