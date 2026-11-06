/**
 * The sync comparison harness (scripts/sync/checks/compare): the diff engine finds
 * every field-level difference and nothing else, reasons claim only what their
 * predicate covers (first rule wins), the facts reproduce the app's NE
 * universe rules, and a newer GBIF snapshot explains counts that grew.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { diffFacts, applyReasons } from "../sync/checks/compare/diff";
import { compare } from "../sync/checks/compare";
import { syncPath } from "../../src/lib/data/sync-layout";

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

describe("compare over a sync", () => {
  let tmp: string;

  /** A minimal sync, in the published layout. */
  async function writeSync(dir: string, opts: { count: number; neName: string; snapshot: string }): Promise<void> {
    const at = (name: string) => { const p = path.join(dir, syncPath(name)); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
    const c = await conn();
    const copy = (sql: string, file: string) => c.run(`COPY (${sql}) TO '${file}' (FORMAT parquet)`);
    await copy(`SELECT * FROM (VALUES (1::BIGINT, 'Panthera leo', 'VU', 'mammals', 'C1', ${opts.count}::BIGINT))
      t(id, scientific_name, iucn_category, taxon_group, gbif_species_key, gbif_georeferenced_records_count)`, at("assessed.parquet"));
    await copy(`SELECT * FROM (VALUES (1::BIGINT, 'primary', 'C1', 'accepted'))
      t(sis_taxon_id, role, col_id, method)`, at("assessment_link.parquet"));
    await copy(`SELECT * FROM (VALUES ('C2', 42::BIGINT, 50::BIGINT, 'BR;PE', 'BR;PE;CO', NULL::VARCHAR, 'C2'))
      t(col_id, gbif_georeferenced_records_count, gbif_all_records_count, countries, gbif_all_records_countries, common_name, gbif_species_key)`,
      at("ne.parquet"));
    // C1 is assessed, C3 is domestic, C4 is extinct and not IUCN EX/EW, C5 is outside the base:
    // only C2 is a Not Evaluated species the app lists.
    const part = path.join(dir, syncPath("species"), "taxon_group=mammals", "part.parquet");
    fs.mkdirSync(path.dirname(part), { recursive: true });
    // described as the sync sets it: in Base, extant, not excluded (C3 is domestic).
    await copy(`SELECT *, in_base AND NOT extinct AND col_id <> 'C3' AS described FROM (VALUES
        ('C1', 'Panthera leo', 'Mammalia', 'Carnivora', 'Felidae', 1758, false, true),
        ('C2', '${opts.neName}', 'Mammalia', 'Carnivora', 'Felidae', 1758, false, true),
        ('C3', 'Felis catus', 'Mammalia', 'Carnivora', 'Felidae', 1758, false, true),
        ('C4', 'Smilodon fatalis', 'Mammalia', 'Carnivora', 'Felidae', 1869, true, true),
        ('C5', 'Panthera spelaea', 'Mammalia', 'Carnivora', 'Felidae', 1810, false, false))
      t(col_id, scientific_name, class_name, order_name, family, described_year, extinct, in_base)`, part);
    fs.writeFileSync(at("taxa-summary.json"), JSON.stringify([{ table1a_taxon_group: "mammals", total_assessed: 1, by_category: { VU: 1 } }]));
    fs.writeFileSync(at("sync.json"), JSON.stringify({ gbif: { snapshot: opts.snapshot } }));
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-compare-"));
    await writeSync(path.join(tmp, "base"), { count: 100, neName: "Panthera onca", snapshot: "2026-11-01" });
    await writeSync(path.join(tmp, "same"), { count: 100, neName: "Panthera onca", snapshot: "2026-11-01" });
    await writeSync(path.join(tmp, "moved"), { count: 130, neName: "Panthera onka", snapshot: "2026-11-01" });
    await writeSync(path.join(tmp, "grew"), { count: 130, neName: "Panthera onca", snapshot: "2026-12-01" });
    await writeSync(path.join(tmp, "shrank"), { count: 80, neName: "Panthera onca", snapshot: "2026-12-01" });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("finds no differences between identical syncs", async () => {
    const s = await compare({ baseline: path.join(tmp, "base"), candidate: path.join(tmp, "same"), out: path.join(tmp, "o1") });
    expect(s.total).toBe(0);
    expect(s.byKind.ne).toEqual({ baseline: 1, candidate: 1, diffs: 0, unexplained: 0 });
    expect(s.byKind.groups.baseline).toBe(1);
  });

  it("reports each moved field and writes the report", async () => {
    const out = path.join(tmp, "o2");
    const s = await compare({ baseline: path.join(tmp, "base"), candidate: path.join(tmp, "moved"), out });
    // Same snapshot, so the count moving is unexplained, and so is the NE name.
    expect(s.byKind.assessed.diffs).toBe(1);
    expect(s.byKind.ne.diffs).toBe(1);
    expect(s.unexplained).toBe(2);
    const report = fs.readFileSync(path.join(out, "report.md"), "utf-8");
    expect(report).toContain("### `gbif_georeferenced_records_count`");
    expect(report).toContain("Panthera onka");
    expect(fs.existsSync(path.join(out, "diffs.parquet"))).toBe(true);
  });

  it("explains a count that grew with a newer snapshot, not one that fell by more than 5%", async () => {
    const grew = await compare({ baseline: path.join(tmp, "base"), candidate: path.join(tmp, "grew"), out: path.join(tmp, "o3") });
    expect(grew).toMatchObject({ total: 1, unexplained: 0 });
    const shrank = await compare({ baseline: path.join(tmp, "base"), candidate: path.join(tmp, "shrank"), out: path.join(tmp, "o4") });
    expect(shrank).toMatchObject({ total: 1, unexplained: 1 });
  });
});
