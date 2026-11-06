/**
 * build-read-models: the files the app reads, built from the core tables.
 *
 * Nothing here is a source of truth: each file is a query over core/ (taxa,
 * assessments, assessment_link and the occurrence tables).
 *
 *   assessed.parquet     one row per assessed species: its latest assessment,
 *                        its GBIF counts under the counting rule (counts.ts),
 *                        its latest credits and assessment count
 *   assessments.parquet  published assessment history, one row per year
 *   species/, ne.parquet, species_link.parquet  see notEvaluated
 *
 * GBIF counts per assessed species, from its link rows:
 *   own / covered   its species' records, minus usages another species owns
 *   lumped          its own usage and anything under it
 * The species' GBIF key is the counted usage with the most records (an "own"
 * row before a "lumped" one), which is how Hylatomus pileatus links to
 * Dryocopus pileatus' 5M records rather than its own 156: CoL holds that bird
 * twice, and both halves count. A species with no records of any kind has
 * no key, and counts of 0.
 *
 * Every count comes twice: georeferenced (coordinates and no geospatial issue,
 * GBIF's hasCoordinate=true&hasGeospatialIssue=false) and all records. The
 * since-assessment counts start the day after the assessment date: records in
 * later years from occurrence_counts, records later in the assessment's own
 * year from occurrence_dates (a later day, or a later month for a record dated
 * only to the month). A record dated only to the assessment's year, or only to
 * its month, can't be placed either side of it and is left out.
 *
 * Usage:  npx tsx scripts/sync/outputs/build-read-models.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles } from "../../lib/utils";
import { speciesCountsSql, usageCountsSql } from "../core/counts";
import { ensureInatNames, inatKingdomSql } from "../inputs/inat-names";
import { CORE_DIR, DUCKDB_TMP, OUT_DIR } from "../paths";
import { syncPath, SYNC_FOLDERS } from "../../../src/lib/data/sync-layout";
import { lit } from "../sql";

const semicolonList = (col: string) => `CASE WHEN ${col} IS NULL OR len(${col}) = 0 THEN NULL ELSE array_to_string(${col}, ';') END`;

export interface ReadModelInputs {
  coreDir: string;
  outDir: string;
  inatNames?: string;
  /** The day since-assessment windows end (YYYY-MM-DD); defaults to today. */
  today?: string;
}

async function loadCore(conn: DuckDBConnection, coreDir: string): Promise<void> {
  const f = (n: string) => lit(path.join(coreDir, n));
  await conn.run(`CREATE OR REPLACE VIEW taxa AS SELECT * FROM read_parquet(${f("taxa.parquet")})`);
  await conn.run(`CREATE OR REPLACE VIEW occurrences AS SELECT * FROM read_parquet(${f("occurrence_counts.parquet")})`);
  await conn.run(`CREATE OR REPLACE VIEW occ_dates AS SELECT * FROM read_parquet(${f("occurrence_dates.parquet")})`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE link AS SELECT * FROM read_parquet(${f("assessment_link.parquet")})`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE latest AS SELECT * FROM read_parquet(${f("assessments.parquet")}) WHERE is_latest`);
}

/**
 * Usages each lumped species owns: its roots and anything under them, each
 * usage once. Roots can nest: Zosterops simplex owns both the subspecies
 * Z. japonicus simplex and the synonym Z. simplex filed under it, and walking
 * down from both reached the synonym twice (its 571k records counted twice).
 * A usage goes to the nearest root claiming it, which also settles a usage
 * two lumped species reach: the one whose own name it is wins.
 */
async function ownedUsages(conn: DuckDBConnection): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE owned AS
    WITH RECURSIVE down(sis, root, usage_key, depth) AS (
      SELECT sis_taxon_id, usage_id, usage_id, 0 FROM link WHERE verdict = 'lumped' AND counted
      UNION ALL
      SELECT d.sis, d.root, t.col_id, d.depth + 1 FROM down d JOIN taxa t ON t.parent_id = d.usage_key WHERE d.depth < 3)
    SELECT sis, root, usage_key FROM down
    QUALIFY row_number() OVER (PARTITION BY usage_key ORDER BY depth, sis, root) = 1`);
}

async function gbifCounts(conn: DuckDBConnection, today: string): Promise<void> {
  const d = lit(today);
  await conn.run(`CREATE OR REPLACE TEMP TABLE usage_counts AS ${usageCountsSql({ taxa: "taxa", counts: "occurrences" })}`);
  // A view, not a table: of its 300M+ rows only the assessed species' own
  // assessment year is read (counted_records_in_assessment_year).
  await conn.run(`CREATE OR REPLACE VIEW usage_counts_dated AS ${usageCountsSql({ taxa: "taxa", counts: "occ_dates", dated: true })}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE link_rows AS
    SELECT l.sis_taxon_id AS sis, l.usage_id, l.verdict, l.role, CAST(latest.assessment_date AS DATE) AS assessed_on
    FROM link l JOIN latest USING (sis_taxon_id) WHERE l.counted`);
  // Every counted usage-year (or usage-date), with the species and link row it counts for.
  const countedFrom = (u: string, cols: string) => `
    -- own / covered: the species' records, minus usages someone else owns
    SELECT r.sis, r.usage_id, r.verdict, r.role, r.assessed_on, u.usage_key, ${cols}, u.georef, u.n
    FROM link_rows r JOIN ${u} u ON u.species_id = r.usage_id
    WHERE r.verdict = 'own'
      AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.usage_key = u.usage_key)
    UNION ALL
    -- lumped: its own usage and what is under it
    SELECT r.sis, r.usage_id, r.verdict, r.role, r.assessed_on, u.usage_key, ${cols}, u.georef, u.n
    FROM link_rows r JOIN owned o ON o.sis = r.sis AND o.root = r.usage_id JOIN ${u} u ON u.usage_key = o.usage_key
    WHERE r.verdict = 'lumped'`;
  await conn.run(`CREATE OR REPLACE TEMP TABLE counted_records AS ${countedFrom("usage_counts", "u.year")}`);
  // Only the assessment's own year is read by date; later years come from counted_records.
  // In it, a record counts on a later day, or (dated only to the month) in a
  // later month.
  await conn.run(`CREATE OR REPLACE TEMP TABLE counted_records_in_assessment_year AS
    SELECT * FROM (${countedFrom("usage_counts_dated", "u.year, u.month, u.event_date")})
    WHERE year = year(assessed_on)
      AND (CASE WHEN event_date IS NOT NULL THEN event_date > assessed_on AND event_date <= ${d}
                ELSE month > month(assessed_on) AND make_date(year, month, 1) <= ${d}::DATE END)`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE row_counts AS
    WITH by_year AS (
      SELECT sis, usage_id, any_value(verdict) AS verdict, any_value(role) AS role, any_value(assessed_on) AS assessed_on,
             coalesce(sum(n) FILTER (georef), 0)::BIGINT AS georef,
             coalesce(sum(n), 0)::BIGINT AS all_records,
             coalesce(sum(n) FILTER (georef AND year > year(assessed_on) AND year <= year(${d}::DATE)), 0)::BIGINT AS georef_since,
             coalesce(sum(n) FILTER (year > year(assessed_on) AND year <= year(${d}::DATE)), 0)::BIGINT AS all_since
      FROM counted_records GROUP BY sis, usage_id),
    by_day AS (
      SELECT sis, usage_id, coalesce(sum(n) FILTER (georef), 0)::BIGINT AS georef_since, sum(n)::BIGINT AS all_since
      FROM counted_records_in_assessment_year GROUP BY sis, usage_id)
    SELECT y.sis, y.usage_id, y.verdict, y.role, y.assessed_on, y.georef, y.all_records,
           (y.georef_since + coalesce(day_counts.georef_since, 0))::BIGINT AS georef_since,
           (y.all_since + coalesce(day_counts.all_since, 0))::BIGINT AS all_since
    FROM by_year y LEFT JOIN by_day day_counts USING (sis, usage_id)`);
  // What each species' count is made of, so a change in it can be explained:
  // records left out because another assessed species owns the usage, and
  // records added from a covered duplicate or a lumped species' own usage.
  await conn.run(`CREATE OR REPLACE TEMP TABLE count_components AS
    WITH excluded AS (
      SELECT r.sis_taxon_id AS sis, sum(u.n) FILTER (u.georef)::BIGINT AS georef, sum(u.n)::BIGINT AS all_records
      FROM link r JOIN usage_counts u ON u.species_id = r.usage_id
      JOIN (SELECT DISTINCT sis, usage_key FROM owned) o ON o.usage_key = u.usage_key AND o.sis <> r.sis_taxon_id
      WHERE r.counted AND r.verdict = 'own' GROUP BY 1)
    SELECT rc.sis,
           sum(rc.georef) FILTER (rc.role = 'primary' AND rc.verdict = 'own')::BIGINT AS own_georef,
           sum(rc.georef) FILTER (rc.role = 'covered')::BIGINT AS covered_georef,
           sum(rc.georef) FILTER (rc.verdict = 'lumped')::BIGINT AS lumped_georef,
           any_value(e.georef) AS owned_by_others_georef
    FROM row_counts rc LEFT JOIN excluded e ON e.sis = rc.sis GROUP BY rc.sis`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE species_gbif AS
    SELECT sis,
           -- usage_id last: two usages with the same counts would otherwise swap between runs.
           arg_min(usage_id, (CASE verdict WHEN 'own' THEN 0 ELSE 1 END, -georef, -all_records, usage_id)) AS gbif_species_key,
           sum(georef)::BIGINT AS georef, sum(all_records)::BIGINT AS all_records,
           -- No window for an undated assessment, or one dated today or later: nothing can postdate it yet.
           CASE WHEN any_value(assessed_on) IS NULL OR any_value(assessed_on) >= ${d}::DATE THEN NULL ELSE sum(georef_since)::BIGINT END AS georef_since,
           CASE WHEN any_value(assessed_on) IS NULL OR any_value(assessed_on) >= ${d}::DATE THEN NULL ELSE sum(all_since)::BIGINT END AS all_since
    FROM row_counts GROUP BY sis HAVING sum(all_records) > 0`);
}

/** Published history: one assessment per year, unpublished drafts left out, the latest on top. */
async function history(conn: DuckDBConnection, coreDir: string): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE hist AS
    SELECT sis_taxon_id, (row_number() OVER (PARTITION BY sis_taxon_id ORDER BY year_published DESC, is_latest DESC, assessment_date DESC NULLS LAST, assessment_id DESC) - 1)::INTEGER AS seq,
           assessment_id AS id, year_published AS "year", category, CAST(assessment_date AS VARCHAR) AS "date", criteria,
           assessors, reviewers, facilitators, contributors, institutions
    FROM read_parquet(${lit(path.join(coreDir, "assessments.parquet"))})
    WHERE year_published IS NOT NULL AND sis_taxon_id IN (SELECT sis_taxon_id FROM latest)
    -- One per year: the species' latest assessment if it is in that year (an old
    -- assessment republished the same year has a higher id but isn't the one the
    -- category comes from), else the most recently dated.
    QUALIFY row_number() OVER (PARTITION BY sis_taxon_id, year_published ORDER BY is_latest DESC, assessment_date DESC NULLS LAST, assessment_id DESC) = 1`);
}

/**
 * The Not Evaluated side and the CoL universe it is drawn from:
 *
 *   species/taxon_group=*\/   every accepted species the curated checklist keeps,
 *                             with lineage, partitioned by group
 *   ne.parquet                one row per species in that universe that no
 *                             assessed species is linked to and GBIF has records
 *                             for: its counts, GBIF countries and common name.
 *                             Keyed by col_id, which is also its GBIF key.
 *   species_link.parquet      the assessed species' links as the CoL-differences
 *                             code reads them: one row per species and CoL id,
 *                             covered rows as match_method iucn_synonym_covered
 */
async function notEvaluated(conn: DuckDBConnection, outDir: string, coreDir: string): Promise<void> {
  const speciesDir = path.join(outDir, syncPath("species"));
  fs.rmSync(speciesDir, { recursive: true, force: true });
  await conn.run(`COPY (
    SELECT col_id, scientific_name, authorship, described_year, kingdom, phylum, class_name, order_name, family, genus,
           extinct, in_base, taxon_group
    FROM taxa WHERE rank = 'species' AND status = 'accepted' AND NOT demoted
    ORDER BY taxon_group, class_name, order_name, family, scientific_name
  ) TO ${lit(speciesDir)} (FORMAT parquet, PARTITION_BY (taxon_group), COMPRESSION zstd, ROW_GROUP_SIZE 20000)`);

  await conn.run(`COPY (
    SELECT sis_taxon_id AS id, sis_taxon_id, gbif_species_key, scientific_name, col_id, match_method, 'redlist' AS src FROM (
      SELECT l.sis_taxon_id, a.gbif_species_key, latest.scientific_name, l.col_id,
             CASE WHEN l.role = 'covered' THEN 'iucn_synonym_covered' WHEN l.col_id IS NULL THEN 'unmatched' ELSE l.method END AS match_method,
             l.role
      FROM link l JOIN latest USING (sis_taxon_id)
      LEFT JOIN species_gbif a ON a.sis = l.sis_taxon_id AND l.role = 'primary'
      WHERE l.role = 'primary' OR l.col_id IS NOT NULL
      QUALIFY row_number() OVER (PARTITION BY l.sis_taxon_id, l.col_id, l.role ORDER BY l.usage_id NULLS LAST) = 1)
    ORDER BY sis_taxon_id
  ) TO ${lit(path.join(outDir, syncPath("species_link.parquet")))} (FORMAT parquet, COMPRESSION zstd)`);

  // Counted records and GBIF countries per NE species, under the counting rule:
  // its species' usages, minus any an assessed species owns.
  await conn.run(`CREATE OR REPLACE TEMP TABLE ne_counts AS ${speciesCountsSql({ taxa: "taxa", counts: "occurrences", owned: "owned" })}`);
  await conn.run(`CREATE OR REPLACE VIEW occ_countries AS SELECT * FROM read_parquet(${lit(path.join(coreDir, "occurrence_countries.parquet"))})`);
  // A record's country is its countrycode, which GBIF fills from coordinates or
  // from what the publisher wrote, so an all-records country list is longer.
  await conn.run(`CREATE OR REPLACE TEMP TABLE ne_countries AS
    SELECT u.species_id,
           string_agg(DISTINCT c.countrycode, ';' ORDER BY c.countrycode) FILTER (c.georef) AS countries,
           string_agg(DISTINCT c.countrycode, ';' ORDER BY c.countrycode) AS all_records_countries
    FROM occ_countries c JOIN taxa u ON u.col_id = c.usage_key
    WHERE u.species_id IS NOT NULL AND c.usage_key NOT IN (SELECT usage_key FROM owned)
    GROUP BY 1`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE col_names AS
    SELECT col_id, common_name FROM read_parquet(${lit(path.join(coreDir, "species-fallback-display-name-col.parquet"))})`);
  await conn.run(`COPY (
    SELECT t.col_id AS id, t.col_id, t.scientific_name,
           -- iNaturalist's preferred name, else CoL's.
           coalesce(i.preferred_name, v.common_name) AS common_name,
           t.taxon_group, t.class_name, t.order_name, t.family, 'NE' AS iucn_category,
           c.countries, c.all_records_countries AS gbif_all_records_countries,
           t.col_id AS gbif_species_key,
           coalesce(ne_counts.georef, 0) AS gbif_georeferenced_records_count, ne_counts.all_records AS gbif_all_records_count
    FROM taxa t
    JOIN ne_counts ON ne_counts.species_id = t.col_id AND ne_counts.all_records > 0
    LEFT JOIN ne_countries c ON c.species_id = t.col_id
    LEFT JOIN col_names v ON v.col_id = t.col_id
    LEFT JOIN inat i ON i.scientific_name = t.scientific_name AND i.kingdom = ${inatKingdomSql("t.taxon_group")}
    -- Only species the NE list can show: in the curated Base, extant, not excluded.
    WHERE t.rank = 'species' AND t.status = 'accepted' AND NOT t.demoted
      AND t.in_base AND t.extinct IS NOT TRUE AND t.ne_excluded IS NULL
      AND t.col_id NOT IN (SELECT col_id FROM link WHERE col_id IS NOT NULL)
    ORDER BY t.taxon_group, t.class_name, t.order_name, t.family, t.scientific_name
  ) TO ${lit(path.join(outDir, syncPath("ne.parquet")))} (FORMAT parquet, COMPRESSION zstd)`);
}

/**
 * The counting rule's invariant: a usage's records count towards one species
 * on the dashboard at most, assessed or Not Evaluated, and only once. A
 * violation means a number somewhere is inflated, so the sync stops.
 */
async function checkEachUsageCountedOnce(conn: DuckDBConnection, outDir: string): Promise<void> {
  const bad = (await conn.runAndReadAll(`
    WITH claims AS (
      SELECT DISTINCT usage_key, 'sis ' || sis || ' via ' || usage_id AS claim FROM counted_records
      UNION ALL
      SELECT DISTINCT u.usage_key, 'NE ' || u.species_id FROM usage_counts u
      JOIN read_parquet(${lit(path.join(outDir, syncPath("ne.parquet")))}) ne ON ne.col_id = u.species_id
      WHERE u.usage_key NOT IN (SELECT usage_key FROM owned))
    SELECT usage_key, string_agg(claim, ', ' ORDER BY claim) AS claims
    FROM claims GROUP BY usage_key HAVING count(*) > 1 ORDER BY usage_key LIMIT 10`)).getRowObjects();
  if (bad.length > 0) {
    throw new Error(`build-read-models: usages counted more than once:\n${bad.map((b) => `  ${b.usage_key}: ${b.claims}`).join("\n")}`);
  }
}

export async function buildReadModels(conn: DuckDBConnection, o: ReadModelInputs): Promise<void> {
  for (const f of SYNC_FOLDERS) fs.mkdirSync(path.join(o.outDir, f), { recursive: true });
  fs.mkdirSync(o.outDir, { recursive: true });
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  await loadCore(conn, o.coreDir);
  await ownedUsages(conn);
  await gbifCounts(conn, today);
  await history(conn, o.coreDir);

  await conn.run(o.inatNames && fs.existsSync(o.inatNames)
    ? `CREATE OR REPLACE TEMP TABLE inat AS SELECT scientific_name, kingdom, preferred_name FROM read_parquet(${lit(o.inatNames)})`
    : `CREATE OR REPLACE TEMP TABLE inat (scientific_name VARCHAR, kingdom VARCHAR, preferred_name VARCHAR)`);

  await conn.run(`COPY (SELECT * FROM hist ORDER BY sis_taxon_id, seq)
    TO ${lit(path.join(o.outDir, syncPath("assessments.parquet")))} (FORMAT parquet, COMPRESSION zstd)`);

  await conn.run(`COPY (
    SELECT latest.sis_taxon_id AS id, latest.scientific_name,
           -- IUCN's name, else iNaturalist's preferred one.
           coalesce(nullif(latest.common_name, ''), i.preferred_name, latest.common_name) AS common_name,
           latest.taxon_group, latest.class_name, latest.order_name, latest.family,
           latest.category AS iucn_category, latest.assessment_id,
           CAST(latest.assessment_date AS VARCHAR) AS assessment_date, latest.year_published,
           ${semicolonList("latest.countries")} AS countries,
           gbif.gbif_species_key,
           coalesce(gbif.georef, 0) AS gbif_georeferenced_records_count,
           coalesce(gbif.all_records, 0) AS gbif_all_records_count,
           -- A species with no records still has a window, unless its assessment has none.
           CASE WHEN gbif.sis IS NOT NULL THEN gbif.georef_since
                WHEN latest.assessment_date IS NOT NULL AND CAST(latest.assessment_date AS DATE) < ${lit(today)}::DATE THEN 0 END
             AS gbif_georeferenced_records_since_assessment,
           CASE WHEN gbif.sis IS NOT NULL THEN gbif.all_since
                WHEN latest.assessment_date IS NOT NULL AND CAST(latest.assessment_date AS DATE) < ${lit(today)}::DATE THEN 0 END
             AS gbif_all_records_since_assessment,
           latest.population_trend, ${semicolonList("latest.systems")} AS systems, ${semicolonList("latest.growth_forms")} AS growth_forms,
           latest.movement_pattern, latest.possibly_extinct, latest.possibly_extinct_in_the_wild, latest.criteria,
           ${semicolonList("latest.threat_codes")} AS threat_codes, ${semicolonList("latest.habitat_codes")} AS habitat_codes,
           latest.assessors AS latest_assessors, latest.reviewers AS latest_reviewers, latest.facilitators AS latest_facilitators,
           latest.contributors AS latest_contributors, latest.institutions AS latest_institutions,
           coalesce(history_count.n, 1)::BIGINT AS assessment_count
    FROM latest
    LEFT JOIN species_gbif gbif ON gbif.sis = latest.sis_taxon_id
    LEFT JOIN (SELECT sis_taxon_id, count(*) AS n FROM hist GROUP BY 1) history_count ON history_count.sis_taxon_id = latest.sis_taxon_id
    LEFT JOIN inat i ON i.scientific_name = latest.scientific_name AND i.kingdom = ${inatKingdomSql("latest.taxon_group")}
    ORDER BY latest.class_name, latest.order_name, latest.family, latest.scientific_name
  ) TO ${lit(path.join(o.outDir, syncPath("assessed.parquet")))} (FORMAT parquet, COMPRESSION zstd)`);

  await conn.run(`COPY (
    SELECT c.*, key_counts.georef AS key_georef, key_counts.role = 'primary' AND key_counts.verdict = 'own' AS key_is_own_species
    FROM count_components c
    LEFT JOIN species_gbif gbif ON gbif.sis = c.sis
    LEFT JOIN row_counts key_counts ON key_counts.sis = c.sis AND key_counts.usage_id = gbif.gbif_species_key
    ORDER BY c.sis) TO ${lit(path.join(o.coreDir, "count_components.parquet"))} (FORMAT parquet)`);

  await notEvaluated(conn, o.outDir, o.coreDir);
  await checkEachUsageCountedOnce(conn, o.outDir);

  // The app reads the taxonomy directly, and the comparison reads the link.
  for (const f of ["assessment_link.parquet", "taxa.parquet"]) fs.copyFileSync(path.join(o.coreDir, f), path.join(o.outDir, syncPath(f)));
}

export async function run(): Promise<void> {
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "16", memory_limit: "64GB", temp_directory: DUCKDB_TMP })).connect();
  const inatNames = await ensureInatNames();
  await buildReadModels(conn, { coreDir: CORE_DIR, outDir: OUT_DIR, inatNames });
  const [s] = (await conn.runAndReadAll(`SELECT count(*) AS n, count(gbif_species_key) AS keyed, sum(gbif_georeferenced_records_count) AS georef
    FROM read_parquet(${lit(path.join(OUT_DIR, syncPath("assessed.parquet")))})`)).getRowObjects();
  console.log(`Wrote ${OUT_DIR}/assessed.parquet: ${Number(s.n).toLocaleString()} species, ${Number(s.keyed).toLocaleString()} with GBIF records ` +
    `(${Number(s.georef).toLocaleString()} georeferenced)`);
}

const isDirectRun = process.argv[1]?.endsWith("outputs/build-read-models.ts") || process.argv[1]?.endsWith("outputs/build-read-models.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((e) => { console.error(e); process.exit(1); });
}
