// Shared shape of a species row as returned by /api/redlist/species and rendered
// by RedListView. (The data is fetched inline in RedListView; this module is the
// canonical type definition imported across the app.)

import type { ColRevision } from "@/lib/col-revision";

export interface RedListSpecies {
  /**
   * This row's identity everywhere in the UI — selection, pinning, React keys,
   * per-species caches, the `species=` URL param. `sis-<sis_taxon_id>` for an
   * assessed species, `col-<col_id>` for a Not Evaluated one. See
   * lib/species-row-key for why it's namespaced rather than a bare number.
   */
  species_key: string;
  sis_taxon_id: number | null;
  col_id?: string | null; // CoL id (on NE rows); used for the detail panel's synonyms/CoL tab
  assessment_id: number | null;
  scientific_name: string;
  common_name: string | null;
  family: string | null;
  category: string;
  assessment_date: string | null;
  year_published: string | null;
  population_trend: string | null;
  countries: string[];
  class_name: string | null;
  order_name: string | null;
  taxon_group: string;
  taxon_id: string;
  // CoL species description year — populated for Not Evaluated (NE) rows only;
  // null for assessed species and for NE names with no datable CoL source.
  described_year: number | null;
  gbif_species_key: string | null;
  gbif_occurrence_count: number | null;
  gbif_observations_after_assessment_year: number | null;
  // The same two counts over every record, georeferenced or not — null on a sync
  // from before the GBIF snapshot, and on Not Evaluated rows for the since-assessment
  // one. The table swaps these in when its records toggle is on "All records".
  gbif_occurrence_count_all?: number | null;
  gbif_observations_after_assessment_year_all?: number | null;
  // Latest assessment's credits, inline in the species list (drives the credit
  // filters). The full history array is fetched lazily into previous_assessments
  // when a detail panel opens — empty in the list response.
  latest_assessors: string | null;
  latest_reviewers: string | null;
  /**
   * RedListFacilitators — who actually ran the assessment when the credited
   * assessor is an organisation rather than a person. BirdLife International is
   * the assessor on every bird assessment, so this is the only field naming the
   * individuals who did the work. null on the ~62% of latest assessments that
   * credit no facilitator at all.
   */
  latest_facilitators: string | null;
  /**
   * RedListContributors — credited for supplying data or expertise without being
   * assessor or reviewer. The longest of the credit lines (~8.5 names per
   * assessment), null on the ~67% that credit no contributor.
   */
  latest_contributors: string | null;
  /**
   * Institutions — the organisation(s) behind the assessment. Organisation names,
   * not "Lastname, Initials", so they are split on " & " alone rather than by
   * parseAssessors. null on the ~81% that credit no institution.
   */
  latest_institutions: string | null;
  previous_assessments: { id: number; year: string; category: string; date: string | null; criteria: string | null; assessors: string | null; reviewers: string | null; facilitators: string | null; contributors: string | null; institutions: string | null }[];
  systems: string[];
  growth_forms: string[];
  movement_pattern: string | null;
  possibly_extinct: boolean;
  possibly_extinct_in_the_wild: boolean;
  criteria: string | null;
  threat_codes: string[];
  habitat_codes: string[];
  /**
   * A possible sign that this species' taxonomy has moved since it was assessed:
   * either Catalogue of Life has no clean 1:1 match for it (lumped it, demoted it
   * to a subspecies, doesn't list it yet…), or CoL now recognises species likely
   * split out of it. null for the ~94% with neither, and for NE rows.
   * See lib/col-revision.
   */
  col_revision?: ColRevision | null;
  // Count of distinct assessment years on record (>=2 means reassessed at
  // least once). null for NE rows, which have no assessment history.
  assessment_count: number | null;
}
