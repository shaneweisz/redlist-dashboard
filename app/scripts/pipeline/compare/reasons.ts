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
    kinds: ["assessed", "ne"], fields: [...COUNTS],
    where: `d.before IS NOT NULL AND d.after IS NOT NULL AND ${NOISE("d.before::DOUBLE", "d.after::DOUBLE")}`,
  },

  // ── The Not Evaluated list ─────────────────────────────────────────────────
  {
    code: "empty_string_now_null",
    description: "The old overlay wrote '' for no common name or no countries; the new one leaves it NULL.",
    kinds: ["ne"], fields: ["common_name", "countries"],
    where: `d.before = '' AND d.after IS NULL`,
  },
  {
    code: "col_id_is_the_gbif_key",
    description: "GBIF keys are CoL ids; the old overlay picked one of several GBIF keys a col_id had.",
    kinds: ["ne"], fields: ["gbif_species_key"],
    where: `d.before IS NOT NULL AND d.after = d.key`,
  },
  {
    code: "key_for_ungeoreferenced_records",
    description: "A species whose records all lack coordinates now has a key (and a count of 0) for the all-records view.",
    kinds: ["ne"], fields: ["gbif_species_key", "gbif_occurrence_count", "countries"],
    where: `d.before IS NULL AND d.key IN (SELECT key FROM a.ne WHERE gbif_occurrence_count = 0)`,
  },
  {
    code: "outside_the_28_groups",
    description: "Bacteria, diatoms and the rest of 'other': the dashboard never shows them; the old pipeline never fetched them.",
    kinds: ["ne"],
    where: `d.key IN (SELECT key FROM a.ne WHERE taxon_group = 'other') OR d.key IN (SELECT key FROM b.ne WHERE taxon_group = 'other')`,
  },
  {
    code: "records_outside_old_facet_roots",
    description: "The old pipeline fetched GBIF species per group root key (17 taxa for other invertebrates); the snapshot covers every species.",
    kinds: ["ne"], fields: ["gbif_species_key", "gbif_occurrence_count", "countries", "common_name"],
    where: `d.before IS NULL AND d.after IS NOT NULL`,
  },
  {
    code: "common_name_from_inaturalist_or_col",
    description: "iNaturalist's preferred name, else CoL's display name; the old overlay kept a GBIF-phase name unless it scored worse against its genus.",
    kinds: ["ne"], fields: ["common_name"],
    where: `d.before IS NOT NULL AND d.after IS NOT NULL`,
  },
  {
    code: "now_linked_to_an_assessed_species",
    description: "An assessed species now links to this CoL species (see the link reasons), so it leaves the NE list.",
    kinds: ["ne"], changes: ["removed"],
    where: `d.key IN (SELECT col_id FROM ctx_link WHERE col_id IS NOT NULL)`,
  },
  {
    code: "no_longer_linked",
    description: "No assessed species links to this CoL species any more (see the link reasons), so it joins the NE list.",
    kinds: ["ne"], changes: ["added"],
    where: `d.key NOT IN (SELECT col_id FROM ctx_link WHERE col_id IS NOT NULL)`,
  },

  // ── Summaries ──────────────────────────────────────────────────────────────
  {
    code: "outdated_as_of_a_later_sync_date",
    description: "'Outdated' is as of the sync date, and this sync is later than the baseline's, so more species have crossed the 10-year line.",
    kinds: ["groups", "nodes", "countries", "realms"], fields: ["outdated"],
    where: `d.delta > 0`,
  },
  {
    code: "duplicate_concepts_no_longer_not_evaluated",
    description: "CoL species now linked as covered duplicates of an assessed species leave the NE count (see duplicate_concept_summed).",
    kinds: ["groups", "nodes"], fields: ["col_ne", "colNe"],
    where: `d.delta < 0`,
  },
  {
    code: "gbif_stats_from_the_ne_list",
    description: "Per-group GBIF figures count each species once, NE ones by the NE list's own rules, instead of from per-group API facet files that counted a species in every group whose root reached it.",
    kinds: ["groups", "nodes"], fields: ["gbif_species_count", "gbif_ne_species_count", "total_gbif_observations", "median_gbif_obs", "gbifNeSpeciesCount"],
    where: `TRUE`,
  },
  {
    code: "follows_the_new_links",
    description: "CoL-differences breakdowns and revision flags are derived from the links, which changed (see the link reasons).",
    kinds: ["nodes", "col_revisions"], fields: ["col_breakdown", "revision", "*"],
    where: `TRUE`,
  },
];
