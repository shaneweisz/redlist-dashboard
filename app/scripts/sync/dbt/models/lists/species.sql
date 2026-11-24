/**
 * lists/species/: one row per accepted CoL species the curated checklist keeps,
 * with its lineage, partitioned by taxon_group. The universe every "described"
 * and Not Evaluated count, list and search tier is drawn from.
 *
 * Built from: taxa, assessment_link, assessments (latest categories), paper_counts.
 *
 * Columns:
 *   col_id, scientific_name, authorship, described_year,
 *   kingdom, phylum, class_name, order_name, family, genus, extinct, in_base,
 *   described      the dashboard's universe (below)
 *   specialist_group  the SSC Specialist Group whose remit holds it, if any
 *                  (specialist_group_species)
 *   may_be_assessed  the assessed species with a doubt it may be (a candidate
 *                  not taken), ';'-joined; NULL when none
 *   assessed_here  assessed species whose part-of records lie under it, or whose
 *                  name it holds though their citation points elsewhere:
 *                  "<name> (part of | same name)", ';'-joined; NULL when none
 *   openalex_works, bhl_works
 *                  literature works mentioning it, for a species no assessment
 *                  links (paper_counts; 0 otherwise: an assessed species' counts
 *                  are on assessed)
 *   taxon_group    the partition
 *
 * Decisions:
 *   - described: in a curated Base source, extant (or extinct and assessed EX
 *     or EW, which IUCN agrees with), and not excluded (seeds/domesticated-and-humans.tsv).
 *     This is the one definition: every reader filters on it, so no two counts
 *     can disagree about which species exist.
 *   - Accepted in the XR and not demoted by the curated release (none are, against the XR's own release).
 */

WITH ex_ew_linked AS (
  SELECT DISTINCT l.col_species_id AS col_id FROM {{ source('link', 'assessment_link') }} l
  JOIN {{ source('sources', 'assessments') }} a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
  WHERE l.relation IN ('is', 'split into') AND a.category IN ('EX', 'EW')
),
-- The NE list's notes (docs/specs/matching.md): a flag for a species with a
-- doubt whose untaken candidate this is; a note for an assessed species whose
-- part-of records lie under it, or whose name it holds though the citation
-- settled elsewhere.
notes AS (
  SELECT l.col_species_id AS col_id,
         string_agg(DISTINCT a.scientific_name, ';' ORDER BY a.scientific_name) FILTER (l.method = 'undecided_candidate') AS may_be_assessed,
         string_agg(DISTINCT a.scientific_name || CASE WHEN l.relation = 'part of' THEN ' (part of)' ELSE ' (same name)' END, ';'
                    ORDER BY a.scientific_name || CASE WHEN l.relation = 'part of' THEN ' (part of)' ELSE ' (same name)' END)
           FILTER ((l.relation = 'part of' AND l.counted) OR l.method = 'other_group') AS assessed_here
  FROM {{ source('link', 'assessment_link') }} l
  JOIN {{ source('sources', 'assessments') }} a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
  WHERE l.col_species_id IS NOT NULL GROUP BY 1
)
SELECT col_id, scientific_name, authorship, described_year, kingdom, phylum, class_name, order_name, family, genus,
       extinct, in_base,
       in_base AND (extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ex_ew_linked)) AND ne_excluded IS NULL AS described,
       g.group_id AS specialist_group,
       n.may_be_assessed, n.assessed_here,
       coalesce(papers.openalex_works, 0)::BIGINT AS openalex_works, coalesce(papers.bhl_works, 0)::BIGINT AS bhl_works,
       taxon_group
FROM {{ source('sources', 'taxa') }} t
LEFT JOIN {{ ref('specialist_group_species') }} g USING (col_id)
LEFT JOIN notes n USING (col_id)
LEFT JOIN (
  SELECT col_id AS paper_col_id, sum(works) FILTER (source = 'openalex') AS openalex_works, sum(works) FILTER (source = 'bhl') AS bhl_works
  FROM {{ ref('paper_counts') }} WHERE col_id IS NOT NULL GROUP BY 1
) papers ON papers.paper_col_id = t.col_id
WHERE {{ col_species() }}
