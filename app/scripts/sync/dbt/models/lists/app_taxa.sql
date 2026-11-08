/**
 * taxonomy/taxa and taxonomy/assessment_link: the taxonomy and the links as the
 * app reads them.
 *
 * Built from: taxa, assessment_link.
 *
 * taxonomy/taxa: one row per CoL usage (the synonyms lookup needs them all),
 * with only the columns a reader uses (col_id, parent_id, status, rank,
 * scientific_name, authorship, in_checklist, checklist_parent_id,
 * checklist_name), sorted by col_id so a lookup by id skips row groups. Lineage,
 * the universe flags and groups are on species/.
 *
 * taxonomy/assessment_link: assessment_link as built (see link/assessment-link.ts).
 */

SELECT col_id, parent_id, status, rank, scientific_name, authorship, in_checklist, checklist_parent_id, checklist_name
FROM {{ source('core', 'taxa') }}
