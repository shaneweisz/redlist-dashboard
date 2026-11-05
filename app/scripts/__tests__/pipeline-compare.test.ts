/**
 * The sync comparison harness (scripts/sync/checks/compare): the diff engine finds
 * every field-level difference and nothing else, reasons claim only what their
 * predicate covers (first rule wins), and the old-layout facts reproduce the
 * app's NE universe rules.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { diffFacts, applyReasons } from "../sync/checks/compare/diff";
import { compare } from "../sync/checks/compare";

async function conn(): Promise<DuckDBConnection> {
  return (await DuckDBInstance.create(":memory:")).connect();
}

async function diffRows(c: DuckDBConnection) {
  return (await c.runAndReadAll(
    `SELECT kind, key, field, change, before, after, delta, reason FROM diffs ORDER BY kind, key, field`
  )).getRowObjects();
}

describe("diffFacts", () => {
  it("reports changed fields, added and removed rows, and schema-only columns", async () => {
    const c = await conn();
    await c.run(`CREATE SCHEMA b; CREATE SCHEMA a;
      CREATE TABLE b.assessed AS SELECT * FROM (VALUES ('1', 10::BIGINT, 'x', 'gone'), ('2', 5, 'y', 'gone'), ('3', 1, 'z', 'gone'))
        t(key, n, name, old_col);
      CREATE TABLE a.assessed AS SELECT * FROM (VALUES ('1', 12.0::DOUBLE, 'x', 'new'), ('2', 5.0, 'Y', 'new'), ('4', 1.0, 'w', 'new'))
        t(key, n, name, new_col);`);
    const notes = await diffFacts(c);
    const rows = await diffRows(c);

    expect(rows).toEqual([
      { kind: "assessed", key: "1", field: "n", change: "changed", before: "10", after: "12.0", delta: 2, reason: null },
      { kind: "assessed", key: "2", field: "name", change: "changed", before: "y", after: "Y", delta: null, reason: null },
      { kind: "assessed", key: "3", field: "*", change: "removed", before: null, after: null, delta: null, reason: null },
      { kind: "assessed", key: "4", field: "*", change: "added", before: null, after: null, delta: null, reason: null },
    ]);
    // 5 (BIGINT) vs 5.0 (DOUBLE) is no difference: numbers compare as numbers.
    expect(notes).toEqual([
      { kind: "assessed", field: "old_col", side: "baseline only" },
      { kind: "assessed", field: "new_col", side: "candidate only" },
    ]);
  });

  it("treats NULL on one side as a difference and NULL on both as none", async () => {
    const c = await conn();
    await c.run(`CREATE SCHEMA b; CREATE SCHEMA a;
      CREATE TABLE b.ne AS SELECT * FROM (VALUES ('A', NULL::BIGINT), ('B', NULL), ('C', 3)) t(key, n);
      CREATE TABLE a.ne AS SELECT * FROM (VALUES ('A', NULL::BIGINT), ('B', 7), ('C', NULL)) t(key, n);`);
    await diffFacts(c);
    expect((await diffRows(c)).map((r) => [r.key, r.before, r.after])).toEqual([["B", null, "7"], ["C", "3", null]]);
  });

  it("notes a kind only one side has", async () => {
    const c = await conn();
    await c.run(`CREATE SCHEMA b; CREATE SCHEMA a;
      CREATE TABLE b.realms AS SELECT 'Marine' AS key, 1 AS species;`);
    expect(await diffFacts(c)).toEqual([{ kind: "realms", field: "*", side: "baseline only" }]);
  });
});

describe("applyReasons", () => {
  it("gives each difference the first rule that covers it, and leaves the rest unexplained", async () => {
    const c = await conn();
    await c.run(`CREATE SCHEMA b; CREATE SCHEMA a;
      CREATE TABLE b.assessed AS SELECT * FROM (VALUES ('1', 100), ('2', 100), ('3', 100)) t(key, n);
      CREATE TABLE a.assessed AS SELECT * FROM (VALUES ('1', 101), ('2', 150), ('3', 40)) t(key, n);`);
    await diffFacts(c);
    await applyReasons(c, [
      { code: "small_move", description: "", fields: ["n"], where: "abs(d.delta) <= 5" },
      { code: "any_rise", description: "", fields: ["n"], where: "d.delta > 0" },
      { code: "wrong_kind", description: "", kinds: ["ne"], where: "TRUE" },
    ]);
    expect((await diffRows(c)).map((r) => [r.key, r.reason])).toEqual([
      ["1", "small_move"], // also a rise, but the earlier rule wins
      ["2", "any_rise"],
      ["3", null],
    ]);
  });
});

describe("compare over the old layout", () => {
  let tmp: string;

  /** A minimal v1 data directory. */
  async function writeV1(dir: string, opts: { count: number; neName: string }): Promise<void> {
    fs.mkdirSync(path.join(dir, "species", "taxon_group=mammals"), { recursive: true });
    const c = await conn();
    const copy = (sql: string, file: string) => c.run(`COPY (${sql}) TO '${path.join(dir, file)}' (FORMAT parquet)`);
    await copy(`SELECT * FROM (VALUES (1::BIGINT, 'Panthera leo', 'VU', 'mammals', '4QHKG', ${opts.count}::BIGINT))
      t(id, scientific_name, iucn_category, taxon_group, gbif_species_key, gbif_occurrence_count)`, "assessed.parquet");
    await copy(`SELECT * FROM (VALUES
        ('redlist', 1::BIGINT, 1::BIGINT, '4QHKG', 'Panthera leo', 'C1', 'accepted'),
        ('gbif', 900::BIGINT, NULL::BIGINT, 'K2', 'Panthera onca', 'C2', 'accepted'))
      t(src, id, sis_taxon_id, gbif_species_key, scientific_name, col_id, match_method)`, "species_link.parquet");
    await copy(`SELECT * FROM (VALUES (900::BIGINT, 'Panthera onca', NULL::VARCHAR, 'mammals', 'K2', 42::BIGINT, 'BR;PE'))
      t(id, scientific_name, common_name, taxon_group, gbif_species_key, gbif_occurrence_count, countries)`, "unassessed.parquet");
    // C1 is assessed, C3 is domestic, C4 is extinct and not IUCN EX/EW, C5 is outside the base:
    // only C2 is a Not Evaluated species the app lists.
    await copy(`SELECT * FROM (VALUES
        ('C1', 'Panthera leo', 'Mammalia', 'Carnivora', 'Felidae', 1758, false, true),
        ('C2', '${opts.neName}', 'Mammalia', 'Carnivora', 'Felidae', 1758, false, true),
        ('C3', 'Felis catus', 'Mammalia', 'Carnivora', 'Felidae', 1758, false, true),
        ('C4', 'Smilodon fatalis', 'Mammalia', 'Carnivora', 'Felidae', 1869, true, true),
        ('C5', 'Panthera spelaea', 'Mammalia', 'Carnivora', 'Felidae', 1810, false, false))
      t(col_id, scientific_name, class_name, order_name, family, described_year, extinct, in_base)`,
      path.join("species", "taxon_group=mammals", "part.parquet"));
    fs.writeFileSync(path.join(dir, "taxa-summary.json"), JSON.stringify([
      { table1a_taxon_group: "mammals", total_assessed: 1, by_category: { VU: 1 }, mean_gbif_obs: opts.count },
    ]));
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-compare-"));
    await writeV1(path.join(tmp, "base"), { count: 100, neName: "Panthera onca" });
    await writeV1(path.join(tmp, "same"), { count: 100, neName: "Panthera onca" });
    await writeV1(path.join(tmp, "moved"), { count: 130, neName: "Panthera onka" });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("finds no differences between identical syncs", async () => {
    const s = await compare({ baseline: path.join(tmp, "base"), candidate: path.join(tmp, "same"), out: path.join(tmp, "o1"), rules: [] });
    expect(s.total).toBe(0);
    expect(s.byKind.ne).toEqual({ baseline: 1, candidate: 1, diffs: 0, unexplained: 0 });
    expect(s.byKind.groups.baseline).toBe(1);
  });

  it("reports each moved field, ignores the unused mean, and writes the report", async () => {
    const out = path.join(tmp, "o2");
    const s = await compare({ baseline: path.join(tmp, "base"), candidate: path.join(tmp, "moved"), out, rules: [] });
    // assessed count and NE name moved; mean_gbif_obs moved too, but no reader uses it.
    expect(s.byKind.assessed.diffs).toBe(1);
    expect(s.byKind.ne.diffs).toBe(1);
    expect(s.byKind.groups.diffs).toBe(0);
    expect(s.unexplained).toBe(2);
    const report = fs.readFileSync(path.join(out, "report.md"), "utf-8");
    expect(report).toContain("### `gbif_occurrence_count`");
    expect(report).toContain("Panthera onka");
    expect(fs.existsSync(path.join(out, "diffs.parquet"))).toBe(true);
  });
});
