/**
 * build-read-models: the files the app reads, built from the core tables.
 *
 * Nothing here is a source of truth. Each file is a query over core/ (taxa,
 * assessments, assessment_link, occurrence_counts), kept in the shape the app
 * already reads so the app changes only where the shape itself was the problem.
 *
 *   assessed.parquet     one row per assessed species: its latest assessment,
 *                        its GBIF counts under the counting rule (counts.ts),
 *                        its latest credits and assessment count
 *   assessments.parquet  published assessment history, one row per year
 *   species/, ne.parquet, species_link.parquet, backbone.parquet  see notEvaluated
 *
 * GBIF counts per assessed species, from its link rows:
 *   own / covered   its species' records, minus usages another species owns
 *   lumped          its own usage and anything under it
 * The species' GBIF key is the counted usage with the most records (an "own"
 * row before a "lumped" one), which is how Hylatomus pileatus links to
 * Dryocopus pileatus' 5M records rather than its own 156: CoL holds that bird
 * twice, and both halves now count. A species with no records of any kind has
 * no key.
 *
 * Usage:  npx tsx scripts/pipeline/build-read-models.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles } from "../utils";
import { inatKingdomSql } from "../fetch-inat-vernaculars";
import { usageCountsSql, countedBasisSql } from "./counts";
import { ensureInatNames } from "./inputs/inat";
import { CORE_DIR, OUT_DIR } from "./paths";

let CORE_DIR_FOR_COUNTRIES = CORE_DIR;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const joined = (col: string) => `CASE WHEN ${col} IS NULL OR len(${col}) = 0 THEN NULL ELSE array_to_string(${col}, ';') END`;

export interface ReadModelInputs {
  coreDir: string;
  outDir: string;
  inatNames?: string;
  /** The year since-assessment windows end; defaults to this year. */
  currentYear?: number;
}

async function loadCore(conn: DuckDBConnection, coreDir: string): Promise<void> {
  const f = (n: string) => lit(path.join(coreDir, n));
  await conn.run(`CREATE OR REPLACE VIEW taxa AS SELECT * FROM read_parquet(${f("taxa.parquet")})`);
  await conn.run(`CREATE OR REPLACE VIEW occ AS SELECT * FROM read_parquet(${f("occurrence_counts.parquet")})`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE link AS SELECT * FROM read_parquet(${f("assessment_link.parquet")})`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE latest AS SELECT * FROM read_parquet(${f("assessments.parquet")}) WHERE is_latest`);
}

/** Usages each lumped species owns: its root and anything under it. */
async function ownedUsages(conn: DuckDBConnection): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE owned AS
    WITH RECURSIVE down(sis, root, usage_key, depth) AS (
      SELECT sis_taxon_id, usage_id, usage_id, 0 FROM link WHERE verdict = 'lumped' AND counted
      UNION ALL
      SELECT d.sis, d.root, t.col_id, d.depth + 1 FROM down d JOIN taxa t ON t.parent_id = d.usage_key WHERE d.depth < 3)
    SELECT DISTINCT sis, root, usage_key FROM down`);
}

async function gbifCounts(conn: DuckDBConnection, currentYear: number): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE uc AS ${usageCountsSql({ taxa: "taxa", counts: "occ" })}`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE row_counts AS
    WITH rows AS (
      SELECT l.sis_taxon_id AS sis, l.usage_id, l.verdict, l.role,
             year(la.assessment_date) AS y
      FROM link l JOIN latest la USING (sis_taxon_id) WHERE l.counted),
    hits AS (
      -- own / covered: the species' records, minus usages someone else owns
      SELECT r.sis, r.usage_id, r.verdict, r.role, r.y, u.year, u.georef, u.n
      FROM rows r JOIN uc u ON u.species_id = r.usage_id
      WHERE r.verdict = 'own'
        AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.usage_key = u.usage_key AND o.sis <> r.sis)
        AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.usage_key = u.usage_key AND o.sis = r.sis)
      UNION ALL
      -- lumped: its own usage and what is under it
      SELECT r.sis, r.usage_id, r.verdict, r.role, r.y, u.year, u.georef, u.n
      FROM rows r JOIN owned o ON o.sis = r.sis AND o.root = r.usage_id JOIN uc u ON u.usage_key = o.usage_key
      WHERE r.verdict = 'lumped')
    SELECT sis, usage_id, any_value(verdict) AS verdict, any_value(role) AS role,
           coalesce(sum(n) FILTER (georef), 0)::BIGINT AS georef,
           coalesce(sum(n), 0)::BIGINT AS all_records,
           coalesce(sum(n) FILTER (georef AND year > y AND year <= ${currentYear}), 0)::BIGINT AS georef_since,
           any_value(y) AS y
    FROM hits GROUP BY sis, usage_id`);
  // What each species' count is made of, so a change in it can be explained:
  // records left out because another assessed species owns the usage, and
  // records added from a covered duplicate or a lumped species' own usage.
  await conn.run(`CREATE OR REPLACE TEMP TABLE count_components AS
    WITH excluded AS (
      SELECT r.sis_taxon_id AS sis, sum(u.n) FILTER (u.georef)::BIGINT AS georef, sum(u.n)::BIGINT AS all_records
      FROM link r JOIN uc u ON u.species_id = r.usage_id
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
           arg_min(usage_id, [CASE verdict WHEN 'own' THEN 0 ELSE 1 END, -georef, -all_records]) AS gbif_species_key,
           sum(georef)::BIGINT AS georef, sum(all_records)::BIGINT AS all_records,
           -- No window for a species assessed this year: nothing can postdate it yet.
           CASE WHEN any_value(y) + 1 > ${currentYear} THEN NULL ELSE sum(georef_since)::BIGINT END AS georef_since
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
 *                             with lineage, partitioned by group (as before)
 *   ne.parquet                one row per species in that universe that no
 *                             assessed species is linked to and GBIF has records
 *                             for: its counts, GBIF countries and common name.
 *                             Keyed by col_id, which is also its GBIF key; this
 *                             replaces unassessed.parquet and its synthetic ids.
 *   species_link.parquet      the assessed species' links, in the old shape
 *                             (src = 'redlist'; covered rows as
 *                             iucn_synonym_covered), for the CoL-differences code
 */
async function notEvaluated(conn: DuckDBConnection, outDir: string): Promise<void> {
  const speciesDir = path.join(outDir, "species");
  fs.rmSync(speciesDir, { recursive: true, force: true });
  await conn.run(`COPY (
    SELECT col_id, scientific_name, authorship, described_year, kingdom, phylum, class_name, order_name, family, genus,
           extinct, in_base, taxon_group
    FROM taxa WHERE rank = 'species' AND status = 'accepted' AND NOT demoted
    ORDER BY taxon_group, class_name, order_name, family, scientific_name
  ) TO ${lit(speciesDir)} (FORMAT parquet, PARTITION_BY (taxon_group), COMPRESSION zstd, ROW_GROUP_SIZE 20000)`);

  await conn.run(`COPY (
    SELECT sis_taxon_id AS id, sis_taxon_id, gbif_species_key, scientific_name, col_id, match_method, 'redlist' AS src FROM (
      SELECT l.sis_taxon_id, a.gbif_species_key, la.scientific_name, l.col_id,
             CASE WHEN l.role = 'covered' THEN 'iucn_synonym_covered' WHEN l.col_id IS NULL THEN 'unmatched' ELSE l.method END AS match_method,
             l.role
      FROM link l JOIN latest la USING (sis_taxon_id)
      LEFT JOIN species_gbif a ON a.sis = l.sis_taxon_id AND l.role = 'primary'
      WHERE l.role = 'primary' OR l.col_id IS NOT NULL
      QUALIFY row_number() OVER (PARTITION BY l.sis_taxon_id, l.col_id, l.role ORDER BY l.usage_id NULLS LAST) = 1)
    ORDER BY sis_taxon_id
  ) TO ${lit(path.join(outDir, "species_link.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);

  // Counted records and GBIF countries per NE species, under the counting rule:
  // its species' usages, minus any an assessed species owns.
  await conn.run(`CREATE OR REPLACE TEMP TABLE ne_counts AS
    SELECT species_id, sum(n) FILTER (georef)::BIGINT AS georef, sum(n)::BIGINT AS all_records
    FROM uc WHERE species_id IS NOT NULL AND usage_key NOT IN (SELECT usage_key FROM owned)
    GROUP BY 1`);
  await conn.run(`CREATE OR REPLACE VIEW occ_countries AS SELECT * FROM read_parquet(${lit(path.join(CORE_DIR_FOR_COUNTRIES, "occurrence_countries.parquet"))})`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE ne_countries AS
    SELECT u.species_id, string_agg(DISTINCT c.countrycode, ';' ORDER BY c.countrycode) AS countries
    FROM occ_countries c JOIN taxa u ON u.col_id = c.usage_key LEFT JOIN taxa sp ON sp.col_id = u.species_id
    WHERE c.georef AND ${countedBasisSql("c.basis", "coalesce(sp.kingdom, u.kingdom)")}
      AND u.species_id IS NOT NULL AND c.usage_key NOT IN (SELECT usage_key FROM owned)
    GROUP BY 1`);
  const vern = path.join(outDir, "species-vernaculars.parquet");
  await conn.run(fs.existsSync(vern)
    ? `CREATE OR REPLACE TEMP TABLE col_names AS SELECT col_id, vernacular_name FROM read_parquet(${lit(vern)})`
    : `CREATE OR REPLACE TEMP TABLE col_names (col_id VARCHAR, vernacular_name VARCHAR)`);
  await conn.run(`COPY (
    SELECT t.col_id AS id, t.col_id, t.scientific_name,
           -- iNaturalist's preferred name, else CoL's.
           coalesce(i.preferred_name, v.vernacular_name) AS common_name,
           t.taxon_group, t.class_name, t.order_name, t.family, 'NE' AS iucn_category,
           c.countries, t.col_id AS gbif_species_key, n.georef AS gbif_occurrence_count, n.all_records AS gbif_all_records_count
    FROM taxa t
    JOIN ne_counts n ON n.species_id = t.col_id AND n.all_records > 0
    LEFT JOIN ne_countries c ON c.species_id = t.col_id
    LEFT JOIN col_names v ON v.col_id = t.col_id
    LEFT JOIN inat i ON i.scientific_name = t.scientific_name AND i.kingdom = ${inatKingdomSql("t.taxon_group")}
    -- Only species the NE list can show: in the curated Base, extant, not excluded.
    WHERE t.rank = 'species' AND t.status = 'accepted' AND NOT t.demoted
      AND t.in_base AND t.extinct IS NOT TRUE AND t.ne_excluded IS NULL
      AND t.col_id NOT IN (SELECT col_id FROM link WHERE col_id IS NOT NULL)
    ORDER BY t.taxon_group, t.class_name, t.order_name, t.family, t.scientific_name
  ) TO ${lit(path.join(outDir, "ne.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);
}

export async function buildReadModels(conn: DuckDBConnection, o: ReadModelInputs): Promise<void> {
  fs.mkdirSync(o.outDir, { recursive: true });
  CORE_DIR_FOR_COUNTRIES = o.coreDir;
  const currentYear = o.currentYear ?? new Date().getUTCFullYear();
  await loadCore(conn, o.coreDir);
  await ownedUsages(conn);
  await gbifCounts(conn, currentYear);
  await history(conn, o.coreDir);

  await conn.run(o.inatNames && fs.existsSync(o.inatNames)
    ? `CREATE OR REPLACE TEMP TABLE inat AS SELECT scientific_name, kingdom, preferred_name FROM read_parquet(${lit(o.inatNames)})`
    : `CREATE OR REPLACE TEMP TABLE inat (scientific_name VARCHAR, kingdom VARCHAR, preferred_name VARCHAR)`);

  await conn.run(`COPY (SELECT * FROM hist ORDER BY sis_taxon_id, seq)
    TO ${lit(path.join(o.outDir, "assessments.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);

  await conn.run(`COPY (
    SELECT la.sis_taxon_id AS id, la.scientific_name,
           -- IUCN's name, else iNaturalist's preferred one.
           coalesce(nullif(la.common_name, ''), i.preferred_name, la.common_name) AS common_name,
           la.taxon_group, la.class_name, la.order_name, la.family,
           la.category AS iucn_category, la.assessment_id,
           CAST(la.assessment_date AS VARCHAR) AS assessment_date, la.year_published,
           ${joined("la.countries")} AS countries,
           g.gbif_species_key, g.georef AS gbif_occurrence_count, g.georef_since AS gbif_observations_after_assessment_year,
           g.all_records AS gbif_all_records_count,
           la.population_trend, ${joined("la.systems")} AS systems, ${joined("la.growth_forms")} AS growth_forms,
           la.movement_pattern, la.possibly_extinct, la.possibly_extinct_in_the_wild, la.criteria,
           ${joined("la.threat_codes")} AS threat_codes, ${joined("la.habitat_codes")} AS habitat_codes,
           la.assessors AS latest_assessors, la.reviewers AS latest_reviewers, la.facilitators AS latest_facilitators,
           la.contributors AS latest_contributors, la.institutions AS latest_institutions,
           coalesce(hc.n, 1)::BIGINT AS assessment_count
    FROM latest la
    LEFT JOIN species_gbif g ON g.sis = la.sis_taxon_id
    LEFT JOIN (SELECT sis_taxon_id, count(*) AS n FROM hist GROUP BY 1) hc ON hc.sis_taxon_id = la.sis_taxon_id
    LEFT JOIN inat i ON i.scientific_name = la.scientific_name AND i.kingdom = ${inatKingdomSql("la.taxon_group")}
    ORDER BY la.class_name, la.order_name, la.family, la.scientific_name
  ) TO ${lit(path.join(o.outDir, "assessed.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);

  await conn.run(`COPY (
    SELECT c.*, k.georef AS key_georef, k.role = 'primary' AND k.verdict = 'own' AS key_is_own_species
    FROM count_components c
    LEFT JOIN species_gbif g ON g.sis = c.sis
    LEFT JOIN row_counts k ON k.sis = c.sis AND k.usage_id = g.gbif_species_key
    ORDER BY c.sis) TO ${lit(path.join(o.coreDir, "count_components.parquet"))} (FORMAT parquet)`);

  await notEvaluated(conn, o.outDir);

  // The app reads the link and the taxonomy directly too. backbone.parquet is the
  // taxa table under the name the CoL-differences code reads.
  for (const f of ["assessment_link.parquet", "taxa.parquet"]) fs.copyFileSync(path.join(o.coreDir, f), path.join(o.outDir, f));
  fs.copyFileSync(path.join(o.coreDir, "taxa.parquet"), path.join(o.outDir, "backbone.parquet"));
  if (o.inatNames && fs.existsSync(o.inatNames)) fs.copyFileSync(o.inatNames, path.join(o.outDir, "inat-vernaculars.parquet"));
}

export async function run(): Promise<void> {
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "16", memory_limit: "64GB" })).connect();
  const inatNames = await ensureInatNames();
  await buildReadModels(conn, { coreDir: CORE_DIR, outDir: OUT_DIR, inatNames });
  const [s] = (await conn.runAndReadAll(`SELECT count(*) AS n, count(gbif_species_key) AS keyed, sum(gbif_occurrence_count) AS georef
    FROM read_parquet(${lit(path.join(OUT_DIR, "assessed.parquet"))})`)).getRowObjects();
  console.log(`Wrote ${OUT_DIR}/assessed.parquet: ${Number(s.n).toLocaleString()} species, ${Number(s.keyed).toLocaleString()} with GBIF records ` +
    `(${Number(s.georef).toLocaleString()} georeferenced)`);
}

const isDirectRun = process.argv[1]?.endsWith("pipeline/build-read-models.ts") || process.argv[1]?.endsWith("pipeline/build-read-models.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((e) => { console.error(e); process.exit(1); });
}
