/**
 * regional_assessments: one row per species' latest regional assessment, per
 * region (Europe, Mediterranean, Pan-Africa, …), read from the Red List
 * Postgres database. Published as-is for the Regional view (/regional).
 *
 * Built from: the Red List database named by DB_NAME, opened read-only.
 *
 * Columns:
 *   region              the assessment's scope, as IUCN names it ("Europe")
 *   sis_taxon_id        the species (IUCN's SIS taxon id)
 *   assessment_id       the regional assessment
 *   year_published, assessment_date, category, criteria
 *                       of the regional assessment; category may be RE
 *                       (Regionally Extinct) or NA (Not Applicable), which
 *                       exist only regionally
 *   countries           native, extant, country-level ISO codes the assessment
 *                       lists. These are the species' range as recorded, not
 *                       clipped to the region.
 *   scientific_name, common_name, taxon_group, class_name
 *                       the species' current taxon record
 *   global_category, global_year
 *                       its latest global assessment, or null when it has none
 *
 * Decisions:
 *   - Every scope but Global (scope 15); not suppressed; the species' current
 *     taxon record (not a subspecies or subpopulation), as for global ones.
 *   - One row per species and region: the latest flag, the most recently dated
 *     when the database flags two.
 *   - taxon_group is null for a species outside every Table 1a group, rather
 *     than an error: the global stage owns that check.
 *
 * Self-contained: the app reads it only in the Regional view, so dropping the
 * feature is deleting this file, its line in sync.ts and the view.
 */
import { lit, openDuckDB } from "../sql";
import { output } from "../paths";
import { attachRedList, CURRENT_TAXON, GLOBAL_ASSESSMENT, groupSql } from "./assessments";

const pg = (sql: string) => `postgres_query('pg', ${lit(sql)})`;

export async function buildRegionalAssessments(outFile: string): Promise<void> {
  const conn = await openDuckDB();
  await attachRedList(conn);
  const out = output(outFile);
  const { caseSql } = groupSql();

  await conn.run(`CREATE OR REPLACE TEMP TABLE regional AS SELECT * FROM ${pg(`
    SELECT sl.description->>'en' AS region, t.sis_id AS sis_taxon_id, a.id AS assessment_id,
           a.year_published, a.assessment_date::date AS assessment_date, rlc.code AS category, a.criteria,
           t.scientific_name, lower(t.class_name) AS class_name,
           upper(t.kingdom_name) AS k, upper(t.phylum_name) AS p, upper(t.class_name) AS c, upper(t.order_name) AS o,
           (SELECT n.name FROM taxon_common_names n WHERE n.taxon_id = t.id AND n.language_id = 609 AND n.main
            ORDER BY n.id LIMIT 1) AS common_name,
           (SELECT array_agg(DISTINCT ll.code ORDER BY ll.code)
            FROM assessment_locations al JOIN location_lookup ll ON ll.id = al.location_id
            JOIN legend_lookup leg ON leg.id = al.legend_id
            WHERE al.assessment_id = a.id AND leg.origin = 'Native' AND leg.presence = 'Extant' AND length(ll.code) = 2) AS countries
    FROM taxons t
    JOIN assessments a ON a.taxon_id = t.id
    JOIN assessment_scopes s ON s.assessment_id = a.id AND s.scope_lookup_id <> 15
    JOIN scope_lookup sl ON sl.id = s.scope_lookup_id
    JOIN red_list_category_lookup rlc ON rlc.id = a.red_list_category_id
    WHERE ${CURRENT_TAXON} AND a.latest AND a.suppress = false`)}`);

  await conn.run(`CREATE OR REPLACE TEMP TABLE global AS SELECT * FROM ${pg(`
    SELECT DISTINCT ON (t.sis_id) t.sis_id AS sis_taxon_id, rlc.code AS global_category, a.year_published AS global_year
    FROM taxons t JOIN assessments a ON a.taxon_id = t.id
    JOIN red_list_category_lookup rlc ON rlc.id = a.red_list_category_id
    WHERE ${CURRENT_TAXON} AND a.latest AND ${GLOBAL_ASSESSMENT}
    ORDER BY t.sis_id, a.assessment_date DESC, a.id DESC`)}`);

  await conn.run(`COPY (
    SELECT r.region, r.sis_taxon_id, r.assessment_id, r.year_published, r.assessment_date, r.category,
           nullif(r.criteria, '') AS criteria, coalesce(r.countries, []) AS countries,
           r.scientific_name, r.common_name, ${caseSql} AS taxon_group, r.class_name,
           g.global_category, g.global_year
    FROM regional r LEFT JOIN global g USING (sis_taxon_id)
    QUALIFY row_number() OVER (PARTITION BY r.region, r.sis_taxon_id ORDER BY r.assessment_date DESC, r.assessment_id DESC) = 1
    ORDER BY r.region, r.scientific_name
  ) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);

  const summary = (await conn.runAndReadAll(`SELECT region, count(*)::INT AS n, count(*) FILTER (global_category IS NULL)::INT AS no_global
    FROM read_parquet(${lit(out)}) GROUP BY 1 ORDER BY 2 DESC`)).getRowObjects();
  const total = summary.reduce((s, r) => s + Number(r.n), 0);
  console.log(`   ${total.toLocaleString()} regional assessments in ${summary.length} regions ` +
    `(${summary.slice(0, 3).map((r) => `${r.region} ${Number(r.n).toLocaleString()}`).join(", ")}, …)`);
}
