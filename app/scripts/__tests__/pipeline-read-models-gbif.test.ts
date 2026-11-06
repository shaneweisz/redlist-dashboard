/**
 * GBIF counts in the read models (scripts/sync/outputs/build-read-models.ts):
 * both record modes, and since-assessment windows that start the day after the
 * assessment date rather than the year after it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildReadModels } from "../sync/outputs/build-read-models";
import { syncPath } from "../../src/lib/data/sync-layout";

let tmp: string;
let conn: DuckDBConnection;
const rows: Record<string, Record<string, unknown>> = {};
const ne: Record<string, Record<string, unknown>> = {};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-models-gbif-"));
  const core = path.join(tmp, "core");
  const out = path.join(tmp, "data");
  fs.mkdirSync(core, { recursive: true });
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  const copy = (sql: string, file: string) => conn.run(`COPY (${sql}) TO '${path.join(core, file)}' (FORMAT parquet)`);

  // Two assessed birds and one Not Evaluated one.
  await copy(`SELECT col_id, NULL::VARCHAR AS parent_id, col_id AS species_id, 'animalia' AS kingdom, 'species' AS rank,
      'accepted' AS status, false AS demoted, true AS in_base, false AS extinct, NULL::VARCHAR AS ne_excluded,
      'birds' AS taxon_group, name AS scientific_name, NULL::VARCHAR AS authorship, NULL::INTEGER AS described_year,
      'Chordata' AS phylum, 'AVES' AS class_name, 'ACCIPITRIFORMES' AS order_name, 'ACCIPITRIDAE' AS family, 'Accipiter' AS genus
    FROM (VALUES ('A1', 'Accipiter one'), ('A2', 'Accipiter two'), ('N1', 'Accipiter three')) t(col_id, name)`, "taxa.parquet");
  await copy(`SELECT sis::BIGINT AS sis_taxon_id, usage_id, 'own' AS verdict, 'primary' AS role, true AS counted,
      usage_id AS col_id, 'exact' AS method
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
  await copy(`SELECT * FROM (VALUES
      ('A1', 2024::SMALLINT, true, 'HUMAN_OBSERVATION', 50::BIGINT),
      ('A1', 2025::SMALLINT, true, 'HUMAN_OBSERVATION', 25::BIGINT),
      ('A1', 2025::SMALLINT, false, 'HUMAN_OBSERVATION', 2::BIGINT),
      ('A1', 2026::SMALLINT, true, 'HUMAN_OBSERVATION', 10::BIGINT),
      ('A1', 2026::SMALLINT, false, 'HUMAN_OBSERVATION', 1::BIGINT),
      ('A2', 2026::SMALLINT, true, 'HUMAN_OBSERVATION', 8::BIGINT),
      ('N1', 2020::SMALLINT, false, 'HUMAN_OBSERVATION', 5::BIGINT)) t(usage_key, year, georef, basis, n)`, "occurrence_counts.parquet");
  await copy(`SELECT usage_key, year(d::DATE)::SMALLINT AS year, month(d::DATE)::TINYINT AS month, d::DATE AS event_date, georef, basis, n FROM (VALUES
      ('A1', '2024-06-01', true, 'HUMAN_OBSERVATION', 50::BIGINT),
      ('A1', '2025-03-01', true, 'HUMAN_OBSERVATION', 3::BIGINT),
      ('A1', '2025-05-01', true, 'HUMAN_OBSERVATION', 4::BIGINT),
      ('A1', '2025-06-01', false, 'HUMAN_OBSERVATION', 2::BIGINT),
      ('A1', '2026-02-01', true, 'HUMAN_OBSERVATION', 10::BIGINT),
      ('A1', '2026-02-01', false, 'HUMAN_OBSERVATION', 1::BIGINT),
      ('A2', '2026-11-01', true, 'HUMAN_OBSERVATION', 8::BIGINT),
      ('N1', '2020-01-01', false, 'HUMAN_OBSERVATION', 5::BIGINT)) t(usage_key, d, georef, basis, n)
    UNION ALL
    SELECT 'A1', 2025::SMALLINT, m::TINYINT, NULL::DATE, true, 'HUMAN_OBSERVATION', n::BIGINT
    FROM (VALUES (4, 5), (7, 7)) t(m, n)`, "occurrence_dates.parquet");
  await copy(`SELECT * FROM (VALUES ('N1', 'MX', false, 'HUMAN_OBSERVATION', 5::BIGINT)) t(usage_key, countrycode, georef, basis, n)`,
    "occurrence_countries.parquet");

  await buildReadModels(conn, { coreDir: core, outDir: out, today: "2026-11-06" });
  for (const r of (await conn.runAndReadAll(`SELECT * FROM read_parquet('${path.join(out, syncPath("assessed.parquet"))}')`)).getRowObjects()) {
    rows[String(r.id)] = r;
  }
  for (const r of (await conn.runAndReadAll(`SELECT * FROM read_parquet('${path.join(out, syncPath("ne.parquet"))}')`)).getRowObjects()) {
    ne[String(r.col_id)] = r;
  }
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("GBIF counts in the read models", () => {
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

  it("writes 0, not NULL, for a Not Evaluated species with no georeferenced records", () => {
    expect(Number(ne.N1.gbif_georeferenced_records_count)).toBe(0);
    expect(Number(ne.N1.gbif_all_records_count)).toBe(5);
    expect(ne.N1.countries).toBeNull();
    expect(ne.N1.gbif_all_records_countries).toBe("MX");
  });
});
