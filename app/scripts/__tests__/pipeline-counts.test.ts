/**
 * The counting rule (scripts/sync/core/counts.ts): a species counts its own,
 * its synonyms' and its infraspecifics' records, not usages another assessed
 * species owns. All records counts every record type; georeferenced keeps the
 * types that place the species where it lives wild (preserved specimens
 * included, for every kingdom; fossils, living specimens and citations not).
 */
import { describe, it, expect } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { speciesCountsSql } from "../sync/core/counts";

async function counts(owned: string[] = []) {
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run(`
    CREATE TABLE taxa AS SELECT * FROM (VALUES
      ('LEO', 'LEO', 'animalia'), ('SYN', 'LEO', NULL), ('SSP', 'LEO', 'animalia'), ('BIN', 'LEO', 'animalia'),
      ('LUMP', 'LEO', NULL), ('OAK', 'OAK', 'plantae'), ('OAKSYN', 'OAK', NULL), ('G', NULL, 'animalia'))
      t(col_id, species_id, kingdom);
    CREATE TABLE occ AS SELECT * FROM (VALUES
      ('LEO', 2020, true, 'HUMAN_OBSERVATION', 100), ('LEO', 2020, false, 'HUMAN_OBSERVATION', 5),
      ('LEO', 2020, true, 'PRESERVED_SPECIMEN', 40), ('SYN', 2001, true, 'OCCURRENCE', 7),
      ('SSP', NULL, true, 'MACHINE_OBSERVATION', 3), ('BIN', 2019, true, 'MATERIAL_SAMPLE', 2),
      ('LUMP', 2010, true, 'HUMAN_OBSERVATION', 11), ('LEO', 2020, true, 'FOSSIL_SPECIMEN', 9),
      ('OAKSYN', 1900, true, 'PRESERVED_SPECIMEN', 30), ('OAK', 2024, true, 'HUMAN_OBSERVATION', 1),
      ('G', 2020, true, 'HUMAN_OBSERVATION', 500))
      t(usage_key, year, georef, basis, n);
    CREATE TABLE owned AS SELECT unnest([${owned.map((o) => `'${o}'`).join(",")}]::VARCHAR[]) AS usage_key;`);
  const rows = (await c.runAndReadAll(`${speciesCountsSql({ taxa: "taxa", counts: "occ", owned: "owned" })} ORDER BY 1`)).getRowObjects();
  return Object.fromEntries(rows.map((r) => [String(r.species_id), { georef: Number(r.georef), all: Number(r.all_records) }]));
}

describe("speciesCountsSql", () => {
  it("sums a species' own, synonym, infraspecific and BIN usages", async () => {
    const r = await counts();
    // 100 + 40 (museum) + 7 + 3 + 2 + 11 georeferenced; all adds the 5
    // ungeoreferenced and the 9 fossils.
    expect(r.LEO).toEqual({ georef: 163, all: 177 });
  });
  it("leaves out a usage another assessed species owns", async () => {
    expect((await counts(["LUMP"])).LEO).toEqual({ georef: 152, all: 166 });
  });
  it("counts preserved specimens for every kingdom, and fossils only in all records", async () => {
    const r = await counts();
    expect(r.OAK).toEqual({ georef: 31, all: 31 });
    expect(r.LEO.all - r.LEO.georef).toBe(5 + 9);
  });
  it("credits nothing above species rank", async () => {
    expect(Object.keys(await counts())).toEqual(["LEO", "OAK"]);
  });
});
