/**
 * Reasons: the explanations a difference against the baseline may have.
 *
 * Every difference between a new sync and the one production serves must be
 * explained. A rule names the explanation and states, as SQL, which
 * differences it covers. The predicate sees the diff row as `d` (kind, key,
 * field, change, before, after, delta) and may join the fact tables of either
 * side (`b.<kind>`, `a.<kind>`) or any table the pipeline left in the session.
 *
 * Rules run in order and the first match wins, so put narrow, specific rules
 * (a named bug fix) before broad ones (snapshot age). A rule must be narrow
 * enough that it can't hide a regression: "count changed" is not a reason,
 * "count moved by less than the records GBIF added since the baseline" is.
 *
 * Each commit of the rewrite that is expected to move numbers adds its rules
 * here, with the evidence for them in its commit message.
 */

import type { FactKind } from "./facts";

export interface ReasonRule {
  code: string;
  description: string;
  kinds?: FactKind[];
  fields?: string[];
  changes?: ("changed" | "added" | "removed")[];
  /** SQL predicate over `d`. */
  where: string;
}

const CREDITS = ["latest_assessors", "latest_reviewers", "latest_facilitators", "latest_contributors", "latest_institutions"];
const COUNTS = ["gbif_occurrence_count", "gbif_observations_after_assessment_year"];
const GBIF = ["gbif_species_key", ...COUNTS];
/** Within the noise between a monthly snapshot and the live API two days later. */
const NOISE = (before: string, after: string) => `abs(${after} - ${before}) <= greatest(5, 0.05 * ${before})`;
const sis = "d.key::BIGINT";

/**
 * The rewrite's expected changes against the old pipeline. Context views
 * (ctx_link, ctx_taxa, ctx_assessments, ctx_components) are the candidate's
 * core tables; `pair` holds both sides' link, key and count per assessed
 * species. Write rules as semi-joins (d.key IN (SELECT ...)): a correlated
 * subquery per difference against an 8M-row table spilled 88 GB once.
 */
export const REASONS: ReasonRule[] = [
  // ── Assessments ────────────────────────────────────────────────────────────
  {
    code: "date_no_longer_a_day_early",
    description: "The old fetcher shifted British Summer Time dates back a day (toISOString on Europe/London).",
    kinds: ["assessed"], fields: ["assessment_date"],
    where: `try_cast(d.before AS DATE) + 1 = try_cast(d.after AS DATE)`,
  },
  {
    code: "unpublished_draft_left_out",
    description: "An unpublished, undated draft sat at the top of the old history and supplied the 'latest' credits.",
    kinds: ["assessed"], fields: [...CREDITS, "assessment_count"],
    where: `${sis} IN (SELECT sis_taxon_id FROM ctx_assessments WHERE year_published IS NULL)`,
  },
  {
    code: "credits_from_the_assessment_shown",
    description: "Old 'latest' credits came from the highest assessment id in the latest year, not the assessment whose category is shown.",
    kinds: ["assessed"], fields: [...CREDITS, "assessment_count"],
    where: `${sis} IN (
      SELECT x.sis FROM (
        SELECT sis_taxon_id AS sis, arg_max(assessment_id, year_published || lpad(assessment_id::VARCHAR, 12, '0')) AS top
        FROM ctx_assessments WHERE year_published IS NOT NULL GROUP BY 1) x
      JOIN ctx_assessments l ON l.sis_taxon_id = x.sis AND l.is_latest WHERE l.assessment_id <> x.top)`,
  },

  // ── Links ──────────────────────────────────────────────────────────────────
  {
    code: "linked_to_the_species_not_its_subspecies",
    description: "A link now names the species; the old one could name the subspecies or variety CoL files a synonym under.",
    kinds: ["assessed"], fields: ["link_col_id", "link_method"],
    where: `d.key IN (SELECT p.key FROM pair p JOIN ctx_taxa t ON t.col_id = p.b_col WHERE t.rank <> 'species' AND t.species_id = p.a_col)`,
  },
  {
    code: "checklist_demotion_followed",
    description: "The old variant pass linked to an XR species the curated checklist demotes (suspected bug 3).",
    kinds: ["assessed"], fields: ["link_col_id", "link_method"],
    where: `d.key IN (SELECT p.key FROM pair p JOIN ctx_taxa t ON t.col_id = p.b_col WHERE t.demoted)`,
  },
  {
    code: "match_method_renamed",
    description: "Same CoL species, reached by a pass with a new name or order (variants before IUCN synonyms, ambiguous synonyms).",
    kinds: ["assessed"], fields: ["link_method"],
    where: `d.key IN (SELECT key FROM pair WHERE b_col IS NOT DISTINCT FROM a_col)`,
  },

  // ── GBIF counts ────────────────────────────────────────────────────────────
  {
    code: "key_for_ungeoreferenced_records",
    description: "A species whose records all lack coordinates now has a key (and a count of 0) for the all-records view.",
    kinds: ["assessed"], fields: GBIF,
    where: `d.key IN (SELECT key FROM pair WHERE b_key IS NULL AND a_n = 0)`,
  },
  {
    code: "lumped_counts_from_its_infraspecific",
    description: "A lumped species' records start at the subspecies or variety CoL files its synonym under, not the synonym alone.",
    kinds: ["assessed"], fields: GBIF,
    where: `d.key IN (SELECT p.key FROM pair p JOIN ctx_taxa t ON t.col_id = p.b_key WHERE t.parent_id = p.a_key)`,
  },
  {
    code: "separately_assessed_split_not_double_counted",
    description: "Records of a usage another assessed species owns (a split IUCN assesses, CoL files as a subspecies) are no longer counted for both.",
    kinds: ["assessed"], fields: COUNTS,
    where: `(d.field = 'gbif_occurrence_count' AND d.key IN (SELECT p.key FROM pair p JOIN ctx_components c ON c.sis = p.key::BIGINT
              WHERE c.owned_by_others_georef > 0
                AND ${NOISE("p.b_n::DOUBLE", "(c.key_georef + CASE WHEN c.key_is_own_species THEN c.owned_by_others_georef ELSE 0 END)")}))
            OR (d.field = 'gbif_observations_after_assessment_year' AND d.delta < 0
                AND ${sis} IN (SELECT sis FROM ctx_components WHERE owned_by_others_georef > 0))`,
  },
  {
    code: "duplicate_concept_summed",
    description: "CoL holds the organism twice (Hylatomus / Dryocopus pileatus); both halves now count.",
    kinds: ["assessed"], fields: COUNTS,
    where: `(d.field = 'gbif_occurrence_count' AND d.key IN (SELECT p.key FROM pair p JOIN ctx_components c ON c.sis = p.key::BIGINT
              WHERE c.covered_georef > 0 AND ${NOISE("p.b_n::DOUBLE", "c.key_georef")}))
            OR (d.field = 'gbif_observations_after_assessment_year' AND d.delta > 0
                AND ${sis} IN (SELECT sis FROM ctx_components WHERE covered_georef > 0))`,
  },
  {
    code: "snapshot_vs_api",
    description: "The 1 November snapshot against the API two days later: within 5% or 5 records.",
    kinds: ["assessed"], fields: COUNTS,
    where: `d.before IS NOT NULL AND d.after IS NOT NULL AND ${NOISE("d.before::DOUBLE", "d.after::DOUBLE")}`,
  },
];
