/**
 * build-taxa (scripts/pipeline/build-taxa.ts): species_id resolution, checklist
 * demotion, one group per usage, and the Not Evaluated exclusion list, over a
 * tiny synthetic ColDP.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildTaxa } from "../pipeline/build-taxa";

const HEAD = ["col:ID", "col:parentID", "col:status", "col:rank", "col:scientificName", "col:authorship",
  "col:combinationAuthorshipYear", "col:basionymAuthorshipYear", "col:nameReferenceID",
  "col:kingdom", "col:phylum", "col:class", "col:order", "col:family", "col:genus", "col:sourceID", "col:extinct"];

type Row = Partial<Record<(typeof HEAD)[number], string>>;
const lineage = { "col:kingdom": "Animalia", "col:phylum": "Chordata", "col:class": "Mammalia", "col:order": "Carnivora", "col:family": "Felidae", "col:sourceID": "1000" };

function writeTsv(file: string, rows: Row[], head = HEAD): void {
  fs.writeFileSync(file, [head.join("\t"), ...rows.map((r) => head.map((h) => r[h as keyof Row] ?? "").join("\t"))].join("\n") + "\n");
}

let tmp: string;
let rows: Record<string, Record<string, unknown>>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-taxa-"));
  const nu = path.join(tmp, "NameUsage.tsv");
  writeTsv(nu, [
    { "col:ID": "G", "col:status": "accepted", "col:rank": "genus", "col:scientificName": "Panthera", ...lineage },
    { "col:ID": "LEO", "col:parentID": "G", "col:status": "accepted", "col:rank": "species", "col:scientificName": "Panthera leo",
      "col:combinationAuthorshipYear": "1758", ...lineage },
    { "col:ID": "SYN", "col:parentID": "LEO", "col:status": "synonym", "col:rank": "species", "col:scientificName": "Felis leo", ...lineage },
    { "col:ID": "AMB", "col:parentID": "LEO", "col:status": "ambiguous synonym", "col:rank": "species", "col:scientificName": "Leo leo", ...lineage },
    { "col:ID": "MIS", "col:parentID": "LEO", "col:status": "misapplied", "col:rank": "species", "col:scientificName": "Panthera spelaea", ...lineage },
    { "col:ID": "SSP", "col:parentID": "LEO", "col:status": "accepted", "col:rank": "subspecies", "col:scientificName": "Panthera leo persica", ...lineage },
    { "col:ID": "VAR", "col:parentID": "SSP", "col:status": "accepted", "col:rank": "variety", "col:scientificName": "Panthera leo persica alba", ...lineage },
    { "col:ID": "SSPSYN", "col:parentID": "SSP", "col:status": "synonym", "col:rank": "subspecies", "col:scientificName": "Felis leo persicus", ...lineage },
    { "col:ID": "SUBG", "col:parentID": "G", "col:status": "accepted", "col:rank": "species", "col:scientificName": "Panthera (Tigris) tigris", ...lineage },
    { "col:ID": "SPLIT", "col:parentID": "G", "col:status": "accepted", "col:rank": "species", "col:scientificName": "Panthera melanochaita", ...lineage },
    { "col:ID": "CAT", "col:parentID": "G", "col:status": "accepted", "col:rank": "species", "col:scientificName": "Felis catus", ...lineage },
    { "col:ID": "FOSSIL", "col:parentID": "G", "col:status": "accepted", "col:rank": "species", "col:scientificName": "Panthera atrox",
      "col:extinct": "true", ...lineage, "col:sourceID": "9999" },
    { "col:ID": "OAK", "col:status": "accepted", "col:rank": "species", "col:scientificName": "Quercus robur",
      "col:kingdom": "Plantae", "col:phylum": "Tracheophyta", "col:class": "Magnoliopsida", "col:order": "Fagales", "col:family": "Fagaceae", "col:sourceID": "1000" },
  ]);
  const cl = path.join(tmp, "Checklist.tsv");
  writeTsv(cl, [
    { "col:ID": "LEO", "col:status": "accepted", "col:rank": "species", "col:scientificName": "Panthera leo" },
    { "col:ID": "SPLIT", "col:parentID": "LEO", "col:status": "synonym", "col:rank": "species", "col:scientificName": "Panthera melanochaita" },
    { "col:ID": "SUBG", "col:status": "accepted", "col:rank": "species", "col:scientificName": "Panthera tygris" },
  ], ["col:ID", "col:parentID", "col:status", "col:rank", "col:scientificName"]);

  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const out = await buildTaxa(conn, {
    nameUsage: nu, checklistNameUsage: cl, baseSourceIds: ["1000"], neExcluded: { "felis catus": "domesticated" },
  }, path.join(tmp, "out"));
  const all = (await conn.runAndReadAll(`SELECT * FROM read_parquet('${out}')`)).getRowObjects();
  rows = Object.fromEntries(all.map((r) => [String(r.col_id), r]));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("species_id", () => {
  it("is the species itself, a synonym's accepted species, or an infraspecific's species", () => {
    expect(rows.LEO.species_id).toBe("LEO");
    expect(rows.SYN.species_id).toBe("LEO");
    expect(rows.AMB.species_id).toBe("LEO");
    expect(rows.SSP.species_id).toBe("LEO");
    expect(rows.VAR.species_id).toBe("LEO");
    expect(rows.SSPSYN.species_id).toBe("LEO");
  });
  it("is NULL for misapplied names and above species rank", () => {
    expect(rows.MIS.species_id).toBeNull();
    expect(rows.G.species_id).toBeNull();
  });
});

describe("checklist overlay", () => {
  it("demotes an XR species the release treats as a synonym, and records the release's parent", () => {
    expect(rows.SPLIT.demoted).toBe(true);
    expect(rows.SPLIT.checklist_parent_id).toBe("LEO");
    expect(rows.LEO.demoted).toBe(false);
    // Curated silence is not contradiction: a species the release lacks stays.
    expect(rows.CAT.demoted).toBe(false);
  });
  it("keeps the release's spelling only where it differs, and drops a subgenus parenthetical", () => {
    expect(rows.SUBG.scientific_name).toBe("Panthera tigris");
    expect(rows.SUBG.checklist_name).toBe("Panthera tygris");
    expect(rows.LEO.checklist_name).toBeNull();
  });
  it("marks usages the release doesn't have", () => {
    expect(rows.LEO.in_checklist).toBe(true);
    expect(rows.CAT.in_checklist).toBe(false);
  });
});

describe("groups, base and exclusions", () => {
  it("gives a usage its species' group", () => {
    expect(rows.SYN.taxon_group).toBe("mammals");
    expect(rows.OAK.taxon_group).toBe("flowering_plants");
  });
  it("tags non-Base sources, fossils and excluded names", () => {
    expect(rows.FOSSIL.in_base).toBe(false);
    expect(rows.FOSSIL.extinct).toBe(true);
    expect(rows.CAT.ne_excluded).toBe("domesticated");
    expect(rows.LEO.ne_excluded).toBeNull();
    expect(rows.LEO.described_year).toBe(1758);
  });
  it("fails when an excluded name is not an accepted species", async () => {
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    await expect(buildTaxa(conn, {
      nameUsage: path.join(tmp, "NameUsage.tsv"), baseSourceIds: ["1000"], neExcluded: { "canis familiaris": "domesticated" },
    }, path.join(tmp, "out2"))).rejects.toThrow(/canis familiaris/);
  });
});
