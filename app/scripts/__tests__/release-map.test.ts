/**
 * Reading a snapshot keyed by an older CoL XR as the taxonomy's newest
 * (sources/release-map.ts, sources/occurrences.ts), and the keys GBIF's live
 * index needs (link/live-keys.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildReleaseMap, buildSnapshotMap } from "../sync/sources/release-map";
import { buildOccurrences } from "../sync/sources/occurrences";
import { writeGbifLiveKeys } from "../sync/link/live-keys";

let tmp: string;
let conn: DuckDBConnection;
const f = (name: string) => path.join(tmp, name);
const copy = (sql: string, file: string) => conn.run(`COPY (${sql}) TO '${f(file)}' (FORMAT parquet)`);
const read = async (file: string) => (await conn.runAndReadAll(`SELECT * FROM read_parquet('${f(file)}')`)).getRowObjects();
const taxa = (rows: string) => `SELECT col_id, scientific_name, rank, status, nullif(authorship, '') AS authorship, nullif(species_id, '') AS species_id
  FROM (VALUES ${rows}) t(col_id, scientific_name, rank, status, authorship, species_id)`;

let usages: Record<string, { to_key: string | null; how: string }>;
let notes: Record<string, { note: string; snapshot_name: string | null }>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-map-"));
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  // The snapshot's XR.
  await copy(taxa(`
    ('S1', 'Aus bus', 'species', 'accepted', 'L.', 'S1'),
    ('S2', 'Aus cus', 'species', 'accepted', 'L.', 'S2'),
    ('S3', 'Aus dus', 'species', 'accepted', 'Gmelin, 1789', 'S3'),
    ('S4', 'Aus bus minor', 'subspecies', 'accepted', 'L.', 'S1'),
    ('S5', 'Xus', 'genus', 'accepted', '', ''),
    ('S6', 'Cus eus', 'species', 'accepted', 'L.', 'S6'),
    ('S7', 'Cus fus', 'species', 'synonym', 'L.', 'S6'),
    ('S9', 'Eus a', 'species', 'accepted', 'L.', 'S9'),
    ('S10', 'Eus b', 'species', 'accepted', 'L.', 'S10'),
    ('S11', 'Gus a', 'species', 'accepted', 'L.', 'S11'),
    ('S12', 'Hus a', 'species', 'accepted', 'L.', 'S12'),
    ('S14', 'Hus minor', 'species', 'synonym', 'L.', 'S11')`), "snapshot_taxa.parquet");
  // The taxonomy's, a few releases on.
  await copy(taxa(`
    ('S1', 'Aus bus', 'species', 'accepted', 'L.', 'S1'),
    ('N2', 'Aus cus', 'species', 'accepted', 'L.', 'N2'),
    ('N3', 'Aus dus', 'species', 'accepted', 'J. F. Gmelin, 1789', 'N3'),
    ('S6', 'Cus eus', 'species', 'accepted', 'L.', 'S6'),
    ('S7', 'Cus fus', 'species', 'accepted', 'L.', 'S7'),
    ('N8', 'Dus novus', 'species', 'accepted', 'Sp., 2026', 'N8'),
    ('S9', 'Eus a', 'species', 'accepted', 'L.', 'S9'),
    ('S10', 'Eus b', 'species', 'synonym', 'L.', 'S9'),
    ('S11', 'Gus a', 'species', 'synonym', 'L.', 'S12'),
    ('S12', 'Hus a', 'species', 'accepted', 'L.', 'S12'),
    ('S14', 'Hus minor', 'species', 'accepted', 'L.', 'S14')`), "taxa.parquet");
  const mapped = await buildSnapshotMap({ snapshotTaxa: f("snapshot_taxa.parquet"), taxa: f("taxa.parquet") },
    { usages: f("snapshot_usages.parquet"), notes: f("snapshot_notes.parquet") });
  expect(mapped).toMatchObject({ unmapped: 1, split: 4, new: 1 });
  usages = Object.fromEntries((await read("snapshot_usages.parquet")).map((r) => [r.from_key, r])) as typeof usages;
  notes = Object.fromEntries((await read("snapshot_notes.parquet")).map((r) => [r.col_id, r])) as typeof notes;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the snapshot's usages, as the taxonomy's", () => {
  it("keeps only the usages whose id changes", () => {
    expect(usages.S1).toBeUndefined();
    expect(usages.S10).toBeUndefined(); // the same id: a lump needs nothing
  });

  it("follows a renumbered usage by name, rank and authorship", () => {
    expect(usages.S2).toMatchObject({ to_key: "N2", how: "name" });
  });

  it("follows a dropped duplicate to the usage with its name, when they lead to one species", () => {
    expect(usages.S3).toMatchObject({ to_key: "N3", how: "name only" });
  });

  it("keeps a vanished infraspecific's records with its species", () => {
    expect(usages.S4).toMatchObject({ to_key: "S1", how: "species" });
  });

  it("has nowhere for a usage with no counterpart", () => {
    expect(usages.S5).toMatchObject({ to_key: null, how: null });
  });
});

describe("snapshot_notes", () => {
  it("notes both halves of a split, naming the snapshot's species", () => {
    expect(notes.S6).toMatchObject({ note: "split", snapshot_name: "Cus eus" });
    expect(notes.S7).toMatchObject({ note: "split", snapshot_name: "Cus eus" });
  });

  // Cathormion umbellatum: COL26.10 makes it a synonym of Albizia umbellata and
  // raises its subspecies moniliforme to Albizia moniliforme.
  it("notes a split where the old species became a synonym of another", () => {
    expect(notes.S12).toMatchObject({ note: "split", snapshot_name: "Gus a" });
    expect(notes.S14).toMatchObject({ note: "split", snapshot_name: "Gus a" });
  });

  it("notes a species the snapshot's XR doesn't have", () => {
    expect(notes.N8).toMatchObject({ note: "new" });
  });

  it("leaves renames, duplicates and lumps alone", () => {
    expect(Object.keys(notes).sort()).toEqual(["N8", "S12", "S14", "S6", "S7"]);
  });
});

describe("occurrences through the map", () => {
  it("counts each record under the taxonomy's id, and drops those with no counterpart", async () => {
    const snap = f("snapshot");
    fs.mkdirSync(snap);
    const rec = `VALUES ('S1', 2020, true, 10::BIGINT), ('S2', 2020, true, 3::BIGINT), ('S4', 2020, false, 2::BIGINT), ('S5', 2020, true, 1::BIGINT)`;
    await conn.run(`COPY (SELECT usage_key, year::SMALLINT AS year, georef, n FROM (${rec}) t(usage_key, year, georef, n))
      TO '${path.join(snap, "counts-0.parquet")}' (FORMAT parquet)`);
    await conn.run(`COPY (SELECT usage_key, year::SMALLINT AS year, NULL::TINYINT AS month, NULL::DATE AS event_date, georef, n
      FROM (${rec}) t(usage_key, year, georef, n) WHERE false) TO '${path.join(snap, "dates-0.parquet")}' (FORMAT parquet)`);
    await conn.run(`COPY (SELECT usage_key, 'FR' AS countrycode, georef, n FROM (${rec}) t(usage_key, year, georef, n))
      TO '${path.join(snap, "countries-0.parquet")}' (FORMAT parquet)`);
    // One record in 16 has no counterpart: past the 0.5% limit, so it stops, after writing the table.
    await expect(buildOccurrences({ snapshotCounts: snap, sourceRows: 16, snapshotUsages: f("snapshot_usages.parquet"), taxa: f("taxa.parquet") },
      { occurrences: f("occ.parquet"), occurrenceCountries: f("occ_c.parquet") })).rejects.toThrow(/1 records \(6.25%\) are on usages/);
    const occ = (await conn.runAndReadAll(`SELECT usage_key, sum(n)::INT AS n FROM read_parquet('${f("occ.parquet")}') GROUP BY 1 ORDER BY 1`))
      .getRowObjects();
    expect(occ).toEqual([{ usage_key: "N2", n: 3 }, { usage_key: "S1", n: 12 }]);
  });
});

describe("gbif-live-keys.json", () => {
  it("maps the keys the lists use onto the live XR's, where they differ", async () => {
    await copy(taxa(`('S1', 'Aus bus', 'species', 'accepted', 'L.', 'S1'), ('L2', 'Aus cus', 'species', 'accepted', 'L.', 'L2')`), "live_taxa.parquet");
    expect(await buildReleaseMap({ from: f("taxa.parquet"), to: f("live_taxa.parquet") }, f("live_usages.parquet"))).toBeGreaterThan(0);
    await copy(`SELECT * FROM (VALUES ('S1'), ('N2')) t(gbif_species_key)`, "assessed.parquet");
    await copy(`SELECT * FROM (VALUES ('N8')) t(gbif_species_key)`, "ne.parquet");
    const out = f("gbif-live-keys.json");
    await writeGbifLiveKeys({ assessed: f("assessed.parquet"), ne: f("ne.parquet"), liveUsages: f("live_usages.parquet"),
      snapshotUsages: f("snapshot_usages.parquet"), taxa: f("taxa.parquet") }, out);
    // S1 is the same id live; N8 has no live counterpart, so the app asks with its own key.
    expect(JSON.parse(fs.readFileSync(out, "utf-8"))).toEqual({ N2: "L2" });
  });

  it("is empty when GBIF runs the taxonomy's XR", async () => {
    await buildReleaseMap(null, f("live_none.parquet"));
    const out = f("gbif-live-keys-none.json");
    await writeGbifLiveKeys({ assessed: f("assessed.parquet"), ne: f("ne.parquet"), liveUsages: f("live_none.parquet"),
      snapshotUsages: f("snapshot_usages.parquet"), taxa: f("taxa.parquet") }, out);
    expect(JSON.parse(fs.readFileSync(out, "utf-8"))).toEqual({});
  });
});
