/**
 * build-backbone transform test (#271, Phase 3): drives the real run() over a
 * tiny synthetic ColDP NameUsage TSV in a temp dir, then inspects the parquet it
 * writes. Focus: the two flags that define the displayable extant universe —
 *  - col:extinct → tri-state boolean (true=fossil / false=extant / empty=null);
 *  - in_base = (col:sourceID is one of the Base GSD source keys), which catches
 *    the unflagged-fossil tail (paleo papers that never set col:extinct).
 * The read layer's universe predicate is `in_base AND extinct IS NOT TRUE`. Also
 * pins the universe to status='accepted' (provisionally accepted excluded), and
 * verifies the curated-checklist demotion overlay (opts.demotedColIds) drops an
 * XR-accepted species the curated checklist demotes to a synonym. The Base source
 * list + demotion set are injected so the test never hits the network. Self-contained
 * (local fixture + DuckDB) — no R2 data needed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { run, backboneHasCurrentColumns } from "../build-backbone";

// Minimal ColDP NameUsage: only the columns build-backbone reads by name. The last
// three feed described_year: the current-combination author year, the basionym
// author year, and the cited-reference id (resolved to a year via Reference.tsv).
const COLS = [
  "col:ID", "col:parentID", "col:status", "col:rank", "col:scientificName",
  "col:authorship", "col:kingdom", "col:phylum", "col:class", "col:order",
  "col:family", "col:genus", "col:sourceID", "col:extinct",
  "col:combinationAuthorshipYear", "col:basionymAuthorshipYear", "col:nameReferenceID",
];
// Base GSD source keys (injected). 100/200 are GSDs; 999 is a non-Base source
// (stand-in for the paleo-paper tail).
const BASE_SOURCE_IDS = ["100", "200"];
// id, parent, status, rank, name, auth, kingdom, phylum, class, order, family, genus, sourceID, extinct, combYear, basYear, refID
const ROWS: string[][] = [
  ["1", "F", "accepted", "species", "Panthera leo", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Panthera", "100", "false", "1758", "", ""],
  ["2", "F", "accepted", "species", "Smilodon fatalis", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Smilodon", "100", "true", "", "", ""],
  // Combination year empty → falls back to the basionym author year (1834).
  ["3", "F", "accepted", "species", "Felis incognita", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Felis", "200", "", "", "1834", ""],
  // Subgenus parenthetical: must be normalized to the binomial "Peropteryx leucoptera".
  // No author years → described_year falls back to the cited reference's year. R1 has a
  // structured col:issued (1867) AND a col:citation year (1850); issued must win → 1867.
  ["7", "F", "accepted", "species", "Peropteryx (Peronymus) leucoptera", "L.", "Animalia", "Chordata", "Mammalia", "Chiroptera", "Emballonuridae", "Peropteryx", "200", "false", "", "", "R1"],
  // No author years, and its reference (R2) has an EMPTY col:issued — the year is only in
  // the free-text col:citation → described_year must parse it out (citation fallback → 1888).
  ["8", "F", "accepted", "species", "Testus citatius", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Testus", "200", "false", "", "", "R2"],
  // Regression (Bulbophyllum concinnum bug): its citation has a 4-digit PLATE number
  // ("t. 2038a") before the real year (1890). Must yield 1890, not 2038.
  ["9", "F", "accepted", "species", "Testus platius", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Testus", "200", "false", "", "", "R3"],
  // Regression (#295, Calandrinia villaroelii): its citation ends in a DOI whose suffix
  // holds an in-range 4-digit run ("…/phytotaxa.1543…") trailing the real year (2021).
  // The DOI must be stripped → 2021, not 1543.
  ["11", "F", "accepted", "species", "Testus doicitatius", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Testus", "200", "false", "", "", "R4"],
  // Pre-Linnaean floor: a citation year of 1600 predates valid nomenclature (1753), so it's
  // necessarily a mis-parse — described_year must be null, not 1600.
  ["12", "F", "accepted", "species", "Testus antiquus", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Testus", "200", "false", "", "", "R5"],
  // The curated release files this one as an AMBIGUOUS synonym (see the checklist
  // fixture): it is demoted out of the universe like any synonym, but must not
  // yield an accepted name for a rename claim to be built on.
  ["13", "F", "accepted", "species", "Felis ambigua", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Felis", "200", "false", "", "", ""],
  // Unflagged fossil from a non-Base paleo source: extinct is null, so only in_base drops it.
  ["6", "F", "accepted", "species", "Cimexomys testus", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Cimexomys", "999", "", "", "", ""],
  ["4", "F", "provisionally accepted", "species", "Felis dubia", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Felis", "100", "false", "", "", ""],
  ["5", "1", "synonym", "species", "Felis leo", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Felis", "100", "", "", "", ""],
  ["F", "R", "accepted", "family", "Felidae", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "", "100", "", "", "", ""],
  // Genus-rank row for the vernacular-names.json tests below.
  ["G1", "F", "accepted", "genus", "Panthera", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Panthera", "100", "", "", "", ""],
  // An XR over-split: accepted species + in_base + extant, but the curated checklist
  // demotes col_id "10" to a synonym (injected via demotedColIds) → dropped from species/.
  ["10", "F", "accepted", "species", "Felis splitta", "L.", "Animalia", "Chordata", "Mammalia", "Carnivora", "Felidae", "Felis", "100", "false", "", "", ""],
];

// Minimal ColDP Reference. R1: structured col:issued (full CSL date, exercises the
// 4-digit extraction) plus a *different* citation year to prove issued wins. R2: empty
// col:issued, year only in the free-text citation (exercises the citation fallback).
// R3: plate number 2038 precedes the real year 1890 (Bulbophyllum regression).
// R4: a trailing DOI whose suffix holds an in-range 4-digit run (1543) after the real
// year 2021 — must be stripped before year extraction (#295 regression).
const REF_COLS = ["col:ID", "col:issued", "col:citation"];
const REF_ROWS: string[][] = [
  ["R1", "1867-05-01", "Trans. Imag. Soc. 1: 5 (1850)"],
  ["R2", "", "Fl. Imag. 3: 77. 1888."],
  ["R3", "", "Hooker's Icon. Pl. 21: t. 2038a (1890)"],
  ["R4", "", "Phytotaxa 211: 1-10. 2021. https://doi.org/10.11646/phytotaxa.1543.1.1"],
  // R5: a pre-Linnaean year (1600) — below the 1753 floor, must be dropped to null.
  ["R5", "", "Antiqua Fl. 1: 1. 1600."],
];
// Curated-checklist demotion set (injected, no network): "10" = Felis splitta.

// Minimal ColDP VernacularName. Exercises: (1) preferred=true wins over other
// candidates regardless of length ("Cats" is shorter than "Felids" but Felidae's
// preferred name is "Felids"); (2) with no preferred flag set, the shortest name
// wins (Panthera: "Panther", 7 chars, beats "Big Cats", 8 chars, and
// "Pantherines", 11 chars); (3) non-English names are dropped (Felidae's French
// "Chats" never competes); (4) species-rank vernacular names (Panthera leo,
// col_id "1") are excluded from the output entirely — species get their common
// name from our own Red List/GBIF data.
const VERN_COLS = ["col:taxonID", "col:name", "col:language", "col:preferred"];
const VERN_ROWS: string[][] = [
  ["F", "Cats", "eng", ""],
  ["F", "Felids", "eng", "true"],
  ["F", "Chats", "fra", "true"],
  ["G1", "Big Cats", "eng", ""],
  ["G1", "Panther", "eng", ""],
  ["G1", "Pantherines", "eng", ""],
  ["1", "Lion", "eng", "true"],
];

let tmp: string;
let speciesGlob: string;
let backbone: string;
let vernacularNames: Record<string, string>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backbone-test-"));
  const tsv = path.join(tmp, "NameUsage.tsv");
  fs.writeFileSync(tsv, [COLS.join("\t"), ...ROWS.map((r) => r.join("\t"))].join("\n") + "\n");
  const referenceTsv = path.join(tmp, "Reference.tsv");
  fs.writeFileSync(referenceTsv, [REF_COLS.join("\t"), ...REF_ROWS.map((r) => r.join("\t"))].join("\n") + "\n");
  const vernacularTsv = path.join(tmp, "VernacularName.tsv");
  fs.writeFileSync(vernacularTsv, [VERN_COLS.join("\t"), ...VERN_ROWS.map((r) => r.join("\t"))].join("\n") + "\n");
  // A stand-in for CoL's CURRENT RELEASE, which build-backbone reads to stamp
  // in_checklist / checklist_parent_id. It deliberately does NOT contain col_id
  // "2": the XR carries that usage and the release does not, which is the
  // Hylomyscus anselli shape a claim must never be sourced from.
  const checklistTsv = path.join(tmp, "ChecklistNameUsage.tsv");
  fs.writeFileSync(checklistTsv, [
    ["col:ID", "col:parentID", "col:status", "col:rank", "col:scientificName"].join("\t"),
    ["1", "G1", "accepted", "species", "Panthera leo"].join("\t"),
    // The release spells this one differently from the XR ("Testus citatius"),
    // exactly as Witheringia stramonifolia / stramoniifolia differ by a letter.
    ["8", "G1", "accepted", "species", "Testus citatus"].join("\t"),
    // Identical once the XR's subgenus parenthetical is stripped, so no override.
    ["7", "G1", "accepted", "species", "Peropteryx leucoptera"].join("\t"),
    ["10", "1", "synonym", "species", "Felis splitta"].join("\t"),
    // CoL saying the name's application is UNCERTAIN. It still demotes, but it
    // must not yield an accepted name for anyone to claim.
    ["13", "1", "ambiguous synonym", "species", "Felis ambigua"].join("\t"),
  ].join("\n") + "\n");
  await run({ tsv, referenceTsv, vernacularTsv, outDir: tmp, baseSourceIds: BASE_SOURCE_IDS, demotionsTsv: checklistTsv });
  speciesGlob = path.join(tmp, "species", "**", "*.parquet");
  backbone = path.join(tmp, "backbone.parquet");
  vernacularNames = JSON.parse(fs.readFileSync(path.join(tmp, "vernacular-names.json"), "utf-8"));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function query(sql: string): Promise<Record<string, unknown>[]> {
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  return (await (await conn.run(sql)).getRowObjects());
}

describe("build-backbone species universe", () => {
  it("keeps every status='accepted' species (drops provisionally accepted, synonyms, higher ranks, demoted)", async () => {
    const rows = await query(`SELECT scientific_name FROM read_parquet('${speciesGlob}', hive_partitioning=true) ORDER BY scientific_name`);
    // Felis dubia (provisionally accepted) and Felis splitta (curated-checklist-demoted)
    // excluded. The fossil + non-Base species are KEPT in the parquet (carried with
    // flags) and filtered at query time.
    expect(rows.map((r) => r.scientific_name)).toEqual([
      "Cimexomys testus", "Felis incognita", "Panthera leo", "Peropteryx leucoptera", "Smilodon fatalis", "Testus antiquus", "Testus citatius", "Testus doicitatius", "Testus platius",
    ]);
  });

  it("drops XR over-splits the curated checklist demotes (col_id in the demotion set)", async () => {
    // Felis splitta (col_id "10") is an accepted, in_base, extant species in the XR
    // fixture — but the curated checklist demotes it, so it must NOT reach species/.
    const rows = await query(`SELECT scientific_name FROM read_parquet('${speciesGlob}', hive_partitioning=true) WHERE col_id = '10'`);
    expect(rows).toEqual([]);
    // …yet it's still carried in backbone.parquet (the demotion only prunes the universe,
    // never the tree — the name stays resolvable).
    const bb = await query(`SELECT scientific_name FROM read_parquet('${backbone}') WHERE col_id = '10'`);
    expect(bb.map((r) => r.scientific_name)).toEqual(["Felis splitta"]);
  });

  it("normalizes a subgenus parenthetical to the canonical binomial (dedup + display)", async () => {
    const rows = await query(`SELECT scientific_name FROM read_parquet('${speciesGlob}', hive_partitioning=true) WHERE scientific_name LIKE 'Peropteryx%'`);
    // "Peropteryx (Peronymus) leucoptera" → "Peropteryx leucoptera" so it matches
    // the plain binomial in our assessed/GBIF data and doesn't reappear as "new".
    expect(rows.map((r) => r.scientific_name)).toEqual(["Peropteryx leucoptera"]);
  });

  it("derives col:extinct as a tri-state boolean: true→TRUE, false→FALSE, empty→NULL", async () => {
    const rows = await query(`SELECT scientific_name, extinct FROM read_parquet('${speciesGlob}', hive_partitioning=true)`);
    const byName = new Map(rows.map((r) => [r.scientific_name, r.extinct]));
    expect(byName.get("Panthera leo")).toBe(false);      // col:extinct='false'
    expect(byName.get("Smilodon fatalis")).toBe(true);   // col:extinct='true'  (flagged fossil)
    expect(byName.get("Felis incognita")).toBeNull();    // col:extinct=''      (unflagged)
    expect(byName.get("Cimexomys testus")).toBeNull();   // unflagged fossil
  });

  it("tags in_checklist from CoL's current release, not the extended release", async () => {
    const rows = await query(`SELECT col_id, in_checklist, checklist_parent_id
                              FROM read_parquet('${backbone}') WHERE col_id IN ('1','2','10')`);
    const by = new Map(rows.map((r: Record<string, unknown>) => [String(r.col_id), r]));
    // In the release, accepted.
    expect(by.get("1")?.in_checklist).toBe(true);
    expect(by.get("1")?.checklist_parent_id).toBeNull();
    // XR carries it, the release does not — so nothing may be claimed from it.
    expect(by.get("2")?.in_checklist).toBe(false);
    // The release files it as a synonym: carry the RELEASE's accepted parent,
    // which is what a rename claim has to be sourced from.
    expect(by.get("10")?.in_checklist).toBe(true);
    expect(by.get("10")?.checklist_parent_id).toBe("1");
  });

  it("records the release's own spelling, and only when it differs", async () => {
    const rows = await query(`SELECT col_id, scientific_name, checklist_name
                              FROM read_parquet('${backbone}') WHERE col_id IN ('1','7','8')`);
    const by = new Map(rows.map((r: Record<string, unknown>) => [String(r.col_id), r]));
    // Differs by a letter → carry the release's, since that is what its page says.
    expect(by.get("8")?.scientific_name).toBe("Testus citatius");
    expect(by.get("8")?.checklist_name).toBe("Testus citatus");
    // Same spelling → null, so the column stays empty for all but a handful.
    expect(by.get("1")?.checklist_name).toBeNull();
    // Same once the XR's subgenus parenthetical is stripped → also null, i.e. the
    // comparison runs on normalised names, not raw ColDP strings.
    expect(by.get("7")?.scientific_name).toBe("Peropteryx leucoptera");
    expect(by.get("7")?.checklist_name).toBeNull();
  });

  // The sync decides whether to rebuild the backbone from the CoL release pins,
  // and those say which release the data came from, never which version of this
  // script wrote it. Adding a column here while both pins hold steady leaves a
  // file that is current by every check the sync makes and missing a column the
  // read layer queries — so the sync asks the file itself (see sync.ts).
  it("reports a backbone written by an earlier version of this script as not current", async () => {
    expect(await backboneHasCurrentColumns(backbone)).toBe(true);

    // backbone.parquet exactly as it looked before the checklist columns existed.
    const legacy = path.join(tmp, "backbone-legacy.parquet");
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    await conn.run(`COPY (
      SELECT col_id, parent_id, status, rank, scientific_name, authorship
      FROM read_parquet('${backbone}')
    ) TO '${legacy}' (FORMAT PARQUET)`);
    expect(await backboneHasCurrentColumns(legacy)).toBe(false);

    // Unreadable is not "current" either — a rebuild is the right answer.
    expect(await backboneHasCurrentColumns(path.join(tmp, "no-such-file.parquet"))).toBe(false);
  });

  it("refuses to name an accepted species from an AMBIGUOUS synonym", async () => {
    // 'ambiguous synonym' is CoL declaring the name's application uncertain, so a
    // parent taken from one would assert exactly what the status disclaims.
    // in_checklist is still true — the usage IS in the release.
    const rows = await query(`SELECT col_id, in_checklist, checklist_parent_id
                              FROM read_parquet('${backbone}') WHERE col_id = '13'`);
    expect(rows[0]?.in_checklist).toBe(true);
    expect(rows[0]?.checklist_parent_id).toBeNull();
  });

  it("tags in_base from col:sourceID against the Base GSD allowlist", async () => {
    const rows = await query(`SELECT scientific_name, in_base FROM read_parquet('${speciesGlob}', hive_partitioning=true)`);
    const byName = new Map(rows.map((r) => [r.scientific_name, r.in_base]));
    expect(byName.get("Panthera leo")).toBe(true);       // source 100 (GSD)
    expect(byName.get("Felis incognita")).toBe(true);    // source 200 (GSD)
    expect(byName.get("Cimexomys testus")).toBe(false);  // source 999 (paleo-paper tail)
  });

  it("the universe predicate `in_base AND extinct IS NOT TRUE` drops flagged AND unflagged fossils", async () => {
    const rows = await query(`SELECT scientific_name FROM read_parquet('${speciesGlob}', hive_partitioning=true) WHERE in_base AND extinct IS NOT TRUE ORDER BY scientific_name`);
    // Smilodon (flagged fossil) and Cimexomys (unflagged, non-Base) both excluded.
    expect(rows.map((r) => r.scientific_name)).toEqual([
      "Felis incognita", "Panthera leo", "Peropteryx leucoptera", "Testus antiquus", "Testus citatius", "Testus doicitatius", "Testus platius",
    ]);
  });

  it("derives described_year: combination year, then basionym year, then reference year", async () => {
    const rows = await query(`SELECT scientific_name, described_year FROM read_parquet('${speciesGlob}', hive_partitioning=true)`);
    const byName = new Map(rows.map((r) => [r.scientific_name, r.described_year]));
    expect(Number(byName.get("Panthera leo"))).toBe(1758);          // combination author year
    expect(Number(byName.get("Felis incognita"))).toBe(1834);       // basionym fallback
    expect(Number(byName.get("Peropteryx leucoptera"))).toBe(1867); // reference col:issued (1867) beats its citation year (1850)
    expect(Number(byName.get("Testus citatius"))).toBe(1888);       // reference citation fallback (col:issued empty → parsed from citation)
    expect(Number(byName.get("Testus platius"))).toBe(1890);        // citation has plate "t. 2038a" before year — must pick 1890, not 2038
    expect(Number(byName.get("Testus doicitatius"))).toBe(2021);    // #295: trailing DOI "…/phytotaxa.1543…" stripped — must pick 2021, not 1543
    expect(byName.get("Testus antiquus")).toBeNull();               // citation year 1600 is pre-Linnaean (< 1753 floor) → null, not 1600
    expect(byName.get("Cimexomys testus")).toBeNull();              // no year anywhere
  });

  it("lowercases the denormalized lineage and partitions by taxon_group (Table 1a group)", async () => {
    const rows = await query(`SELECT DISTINCT class_name, taxon_group FROM read_parquet('${speciesGlob}', hive_partitioning=true)`);
    // All fixture species are class Mammalia → taxon_group 'mammals' (TAXON_GROUP_CASE).
    expect(rows).toEqual([{ class_name: "mammalia", taxon_group: "mammals" }]);
  });
});

describe("build-backbone backbone.parquet", () => {
  it("carries every usage (all ranks + synonyms) for tree + synonym resolution", async () => {
    const rows = await query(`SELECT count(*) n, count(*) FILTER (status LIKE '%synonym%') syn FROM read_parquet('${backbone}')`);
    expect(Number(rows[0].n)).toBe(15);  // all rows: family, genus, synonym, demoted species + the rest
    expect(Number(rows[0].syn)).toBe(1);
  });
});

describe("build-backbone vernacular-names.json", () => {
  it("picks the preferred=true name over a shorter, unpreferred one", () => {
    // "Cats" (4 chars, no preferred flag) loses to "Felids" (6 chars,
    // preferred=true) — preferred always wins regardless of length.
    expect(vernacularNames["felidae"]).toBe("Felids");
  });

  it("picks the shortest name when no candidate is marked preferred", () => {
    // Panthera: "Panther" (7) beats "Big Cats" (8) and "Pantherines" (11).
    expect(vernacularNames["panthera"]).toBe("Panther");
  });

  it("drops non-English names (Felidae's French 'Chats' never competes)", () => {
    expect(Object.values(vernacularNames)).not.toContain("Chats");
  });

  it("excludes species-rank vernacular names (they get a common name from our own Red List/GBIF data instead)", () => {
    expect(vernacularNames["panthera leo"]).toBeUndefined();
    expect(Object.values(vernacularNames)).not.toContain("Lion");
  });

  it("keys names by lowercased scientific name", () => {
    expect(Object.keys(vernacularNames)).toContain("felidae");
    expect(Object.keys(vernacularNames)).not.toContain("Felidae");
  });
});
