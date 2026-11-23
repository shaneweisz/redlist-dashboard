/**
 * The counting rule (scripts/sync/dbt/models/count/): a species counts its own, its
 * synonyms' and its infraspecifics' records, not usages a lumped assessed
 * species owns, and every usage counts for one species at most.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { tables, output } from "../sync/paths";
import { runDbt, exportDbtTables } from "../sync/dbt";

type Link = { sis: number; usage: string; verdict: string; counted?: boolean };

async function counts(links: Link[] = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-owners-"));
  const T = tables(tmp);
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  const copy = (sql: string, file: string) => c.run(`COPY (${sql}) TO '${output(file)}' (FORMAT parquet)`);
  // LEO with a synonym, a subspecies, a BIN and a synonym LUMP; OAK with a synonym; a genus G.
  await copy(`SELECT * FROM (VALUES
      ('LEO', 'LEO', 'G'), ('SYN', 'LEO', 'LEO'), ('SSP', 'LEO', 'LEO'), ('BIN', 'LEO', 'SSP'),
      ('LUMP', 'LEO', 'LEO'), ('OAK', 'OAK', NULL), ('OAKSYN', 'OAK', 'OAK'), ('G', NULL, NULL))
      t(col_id, species_id, parent_id)`, T.taxa);
  await copy(`SELECT * FROM (VALUES
      ('LEO', 2020::SMALLINT, true, 140::BIGINT), ('LEO', 2020::SMALLINT, false, 5::BIGINT), ('SYN', 2001::SMALLINT, true, 7::BIGINT),
      ('SSP', NULL::SMALLINT, true, 3::BIGINT), ('BIN', 2019::SMALLINT, true, 2::BIGINT), ('LUMP', 2010::SMALLINT, true, 11::BIGINT),
      ('LEO', 2020::SMALLINT, true, 9::BIGINT), ('OAKSYN', 1900::SMALLINT, true, 30::BIGINT), ('OAK', 2024::SMALLINT, true, 1::BIGINT),
      ('G', 2020::SMALLINT, true, 500::BIGINT))
      t(usage_key, year, georef, n)`.replace("SELECT * FROM", "SELECT usage_key, year, NULL::TINYINT AS month, NULL::DATE AS event_date, georef, n FROM"), T.occurrences);
  // What assessment-link.ts writes for each verdict: counts, from the verdict and whether the row counts.
  const countsOf = (l: Link) => !(l.counted ?? true) ? "nothing" : l.verdict === "own" ? "the whole CoL species" : "only records under its own name";
  const values = links.map((l) => `(${l.sis}::BIGINT, '${l.usage}', '${countsOf(l)}', ${l.counted ?? true}, '${l.usage}', 'accepted')`);
  await copy(links.length
    ? `SELECT * FROM (VALUES ${values.join(", ")}) t(sis_taxon_id, col_taxon_id, counts, counted, col_species_id, method)`
    : `SELECT NULL::BIGINT AS sis_taxon_id, NULL::VARCHAR AS col_taxon_id, NULL::VARCHAR AS counts, NULL::BOOLEAN AS counted, NULL::VARCHAR AS col_species_id, NULL::VARCHAR AS method WHERE false`, T.link);
  await copy(`SELECT sis::BIGINT AS sis_taxon_id, true AS is_latest, DATE '2015-01-01' AS assessment_date
    FROM (VALUES (1), (2)) t(sis)`, T.assessments);

  try {
    runDbt({ buildDir: tmp, today: "2026-11-06", select: "usage_owner record_counts", quiet: true });
    await exportDbtTables(T, tmp, ["usage_owner", "record_counts"]);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const rows = (await c.runAndReadAll(`SELECT coalesce(CAST(sis_taxon_id AS VARCHAR), col_id) AS who, georef, all_records
    FROM read_parquet('${T.recordCounts}')`)).getRowObjects();
  fs.rmSync(tmp, { recursive: true, force: true });
  return Object.fromEntries(rows.map((r) => [String(r.who), { georef: Number(r.georef), all: Number(r.all_records) }]));
}

// Each case runs dbt, which takes a few seconds to start.
describe("usage_owner and record_counts", { timeout: 60_000 }, () => {
  it("sums a species' own, synonym, infraspecific and BIN usages", async () => {
    const r = await counts();
    // 140 + 7 + 3 + 2 + 11 + 9 georeferenced; all adds the 5 ungeoreferenced.
    expect(r.LEO).toEqual({ georef: 172, all: 177 });
    expect(r.OAK).toEqual({ georef: 31, all: 31 });
  });
  it("gives a lumped species its own usage, and leaves it out of the species it is filed under", async () => {
    const r = await counts([{ sis: 1, usage: "LUMP", verdict: "lumped" }]);
    expect(r["1"]).toEqual({ georef: 11, all: 11 });
    expect(r.LEO).toEqual({ georef: 161, all: 166 });
  });
  it("counts an assessed species' own species for it, not as unassessed", async () => {
    const r = await counts([{ sis: 2, usage: "OAK", verdict: "own" }]);
    expect(r["2"]).toEqual({ georef: 31, all: 31 });
    expect(r.OAK).toBeUndefined();
  });
  it("counts a species linked only by a row that doesn't count for no one", async () => {
    const r = await counts([{ sis: 2, usage: "OAK", verdict: "refused", counted: false }]);
    expect(r["2"]).toBeUndefined();
    expect(r.OAK).toBeUndefined();
  });
  it("credits nothing above species rank", async () => {
    expect(Object.keys(await counts()).sort()).toEqual(["LEO", "OAK"]);
  });
  it("stops when a usage would count for two species", async () => {
    await expect(counts([{ sis: 1, usage: "OAK", verdict: "own" }, { sis: 2, usage: "OAK", verdict: "own" }])).rejects.toThrow(/unique_usage_owner_usage_key/);
  });
});
