/**
 * GBIF counts, from the count stage to the lists (scripts/sync/dbt/models/count/,
 * lists/): both record modes, and since-assessment windows that
 * start the day after the assessment date rather than the year after it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { tables } from "../sync/paths";
import { runDbt, exportDbtTables } from "../sync/dbt";
import { buildSpecialistGroups } from "../sync/sources/specialist-groups";

let tmp: string;
let conn: DuckDBConnection;
const rows: Record<string, Record<string, unknown>> = {};
const ne: Record<string, Record<string, unknown>> = {};

beforeAll(async () => {
  // Fixture rows for every table count and lists read, then dbt over them.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-models-gbif-"));
  const core = path.join(tmp, "core");
  fs.mkdirSync(core, { recursive: true });
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  const copy = (sql: string, file: string) => conn.run(`COPY (${sql}) TO '${path.join(core, file)}' (FORMAT parquet)`);

  // Two assessed birds and one Not Evaluated one.
  await copy(`SELECT col_id, NULL::VARCHAR AS parent_id, col_id AS species_id, 'animalia' AS kingdom, 'species' AS rank,
      'accepted' AS status, false AS demoted, true AS in_base, false AS extinct, NULL::VARCHAR AS ne_excluded,
      'birds' AS taxon_group, name AS scientific_name, NULL::VARCHAR AS authorship, NULL::INTEGER AS described_year,
      'Chordata' AS phylum, 'AVES' AS class_name, 'ACCIPITRIFORMES' AS order_name, 'ACCIPITRIDAE' AS family, 'Accipiter' AS genus,
      true AS in_checklist, NULL::VARCHAR AS checklist_parent_id, NULL::VARCHAR AS checklist_name
    FROM (VALUES ('A1', 'Accipiter one'), ('A2', 'Accipiter two'), ('N1', 'Accipiter three')) t(col_id, name)`, "taxa.parquet");
  await copy(`SELECT sis::BIGINT AS sis_taxon_id, usage_id, 'own' AS verdict, 'primary' AS role, true AS counted,
      usage_id AS col_id, 'exact' AS method, 'matcher' AS basis, NULL::VARCHAR AS decided_by
    FROM (VALUES (1, 'A1'), (2, 'A2')) t(sis, usage_id)`, "assessment_link.parquet");
  await copy(`SELECT sis::BIGINT AS sis_taxon_id, sis::BIGINT * 10 AS assessment_id, true AS is_latest, '2025' AS year_published,
      d::DATE AS assessment_date, 'VU' AS category, NULL::VARCHAR AS criteria, false AS possibly_extinct,
      false AS possibly_extinct_in_the_wild, NULL::VARCHAR AS population_trend, ['CU']::VARCHAR[] AS countries,
      []::VARCHAR[] AS systems, []::VARCHAR[] AS growth_forms, NULL::VARCHAR AS movement_pattern, []::VARCHAR[] AS threat_codes,
      []::VARCHAR[] AS habitat_codes, NULL::VARCHAR AS assessors, NULL::VARCHAR AS reviewers, NULL::VARCHAR AS facilitators,
      NULL::VARCHAR AS contributors, NULL::VARCHAR AS institutions, name AS scientific_name, NULL::VARCHAR AS authority,
      NULL::VARCHAR AS common_name, 'ANIMALIA' AS kingdom_name, 'CHORDATA' AS phylum_name, 'AVES' AS class_name,
      'ACCIPITRIFORMES' AS order_name, 'ACCIPITRIDAE' AS family, 'birds' AS taxon_group,
      []::STRUCT(name VARCHAR, status VARCHAR)[] AS synonyms
    FROM (VALUES (1, '2025-04-15', 'Accipiter one'), (2, '2026-12-02', 'Accipiter two')) t(sis, d, name)`, "assessments.parquet");

  // A1, assessed 15 April 2025:
  //   2024: 50 georeferenced                          → before
  //   2025: 3 georeferenced on 1 March, 4 on 1 May,
  //         2 ungeoreferenced on 1 June, 6 dated only to the year,
  //         5 dated only to April (its month: can't be placed), 7 only to July
  //   2026: 10 georeferenced, 1 ungeoreferenced       → after
  // One row per usage, georef and date, at the precision each record has.
  await copy(`SELECT usage_key, year(d::DATE)::SMALLINT AS year, month(d::DATE)::TINYINT AS month, d::DATE AS event_date, georef, n FROM (VALUES
      ('A1', '2024-06-01', true, 50::BIGINT),
      ('A1', '2025-03-01', true, 3::BIGINT),
      ('A1', '2025-05-01', true, 4::BIGINT),
      ('A1', '2025-06-01', false, 2::BIGINT),
      ('A1', '2026-02-01', true, 10::BIGINT),
      ('A1', '2026-02-01', false, 1::BIGINT),
      ('A2', '2026-11-01', true, 8::BIGINT),
      ('N1', '2020-01-01', false, 5::BIGINT)) t(usage_key, d, georef, n)
    UNION ALL
    SELECT 'A1', 2025::SMALLINT, m::TINYINT, NULL::DATE, true, n::BIGINT FROM (VALUES (4, 5), (7, 7)) t(m, n)
    UNION ALL
    SELECT 'A1', 2025::SMALLINT, NULL::TINYINT, NULL::DATE, true, 6::BIGINT`, "occurrences.parquet");
  await copy(`SELECT * FROM (VALUES ('N1', 'MX', false, 5::BIGINT)) t(usage_key, countrycode, georef, n)`, "occurrence_countries.parquet");
  await copy(`SELECT 'col' AS source, 'display' AS kind, 'N1' AS col_id, 'species' AS rank, 'Accipiter three' AS scientific_name,
      NULL::VARCHAR AS kingdom, 'Some name' AS name`, "common_names.parquet");

  const T = tables(tmp);
  const today = "2026-11-06";
  // The real Specialist Groups' remits; dbt's unit test (dbt/models/lists/_lists.yml)
  // checks specialist_group_species's rules on its own rows once the models are built.
  await buildSpecialistGroups({ remits: T.specialistGroupRemits, rankAliases: T.rankAliases });
  runDbt({ buildDir: tmp, today, quiet: true });
  await exportDbtTables(T, tmp);
  for (const r of (await conn.runAndReadAll(`SELECT * FROM read_parquet('${tables(tmp).assessed}')`)).getRowObjects()) {
    rows[String(r.id)] = r;
  }
  for (const r of (await conn.runAndReadAll(`SELECT * FROM read_parquet('${tables(tmp).ne}')`)).getRowObjects()) {
    ne[String(r.col_id)] = r;
  }
}, 120_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("GBIF counts in the lists", () => {
  it("counts georeferenced and all records", () => {
    expect(Number(rows["1"].gbif_georeferenced_records_count)).toBe(85);
    expect(Number(rows["1"].gbif_all_records_count)).toBe(88);
  });

  it("starts the since-assessment window the day after the assessment date", () => {
    // 4 on 1 May and 7 in July 2025, 10 in 2026. Left out: the 3 before
    // 15 April, the 5 dated only to April, and the 6 dated only to 2025.
    expect(Number(rows["1"].gbif_georeferenced_records_since_assessment)).toBe(21);
    // Plus the 2 ungeoreferenced in June 2025 and 1 in 2026.
    expect(Number(rows["1"].gbif_all_records_since_assessment)).toBe(24);
  });

  it("has no window for an assessment dated after today", () => {
    expect(rows["2"].gbif_georeferenced_records_since_assessment).toBeNull();
    expect(rows["2"].gbif_all_records_since_assessment).toBeNull();
  });

  it("puts a species in no Specialist Group when none covers its IUCN group", async () => {
    // These are birds, and no Specialist Group's remit covers birds.
    const [r] = (await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${tables(tmp).specialistGroupSpecies}')`)).getRowObjects();
    expect(Number(r.n)).toBe(0);
  });

  it("writes 0, not NULL, for a Not Evaluated species with no georeferenced records", () => {
    expect(Number(ne.N1.gbif_georeferenced_records_count)).toBe(0);
    expect(Number(ne.N1.gbif_all_records_count)).toBe(5);
    expect(ne.N1.countries).toBeNull();
    expect(ne.N1.gbif_all_records_countries).toBe("MX");
  });
});
