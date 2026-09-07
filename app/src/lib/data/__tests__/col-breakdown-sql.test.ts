/**
 * computeNoMatchDetails end-to-end over fixture parquet.
 *
 * classifyNoMatch is a pure function and is tested as one, which left the query
 * that FEEDS it untested — and that query is a template string assembled from
 * three optional fragments. Removing one column from its SELECT list left a
 * double comma, and the whole suite stayed green while the build could not parse
 * its own SQL; only running a sync surfaced it. So this drives the real query
 * against a tiny synthetic universe and asserts the reasons that come back.
 *
 * The point is coverage of the SQL, not of the branching: one row per shape the
 * query has to carry a field for, so a projection that stops being selected, or
 * a join that stops resolving, fails here rather than in a data sync.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { computeNoMatchDetails, COL_TO_ASSESSED_SQL, SYNONYM_ASSESSED_SQL, backboneHasChecklistColumns, type BreakdownQueryContext } from "../col-breakdown";

let tmp: string;
let conn: DuckDBConnection;
let ctx: BreakdownQueryContext;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "col-breakdown-sql-"));
  fs.mkdirSync(path.join(tmp, "species"), { recursive: true });
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  const copy = (sql: string, file: string) =>
    conn.run(`COPY (${sql}) TO '${path.join(tmp, file)}' (FORMAT PARQUET);`);

  // CoL's displayable universe. IN1 is in Base; XR1 is the extended release only.
  // The lineage columns are what the classified_elsewhere wording names — CoL's
  // own placement for the record — and CLSEW carries no family, to exercise the
  // fallback down the rank chain (CoL's family/order coverage is genuinely patchy).
  await copy(`SELECT * FROM (VALUES
      ('IN1','Clean species', true, false, 'Felidae', 'Carnivora', 'Mammalia'),
      ('XR1','Xr onlyus', false, false, 'Felidae', 'Carnivora', 'Mammalia'),
      ('LUMP','Lump winner', true, false, 'Felidae', 'Carnivora', 'Mammalia'),
      ('ANS','Anselli test', false, false, 'Felidae', 'Carnivora', 'Mammalia'),
      ('AMBX','Ambiguous target', false, false, 'Felidae', 'Carnivora', 'Mammalia'),
      ('CLSEW','Elsewhere species', true, false, 'valloniidae', 'stylommatophora', 'gastropoda'),
      ('CLSEW2','Elsewhere unranked', true, false, NULL, NULL, 'gastropoda')
    ) v(col_id, scientific_name, in_base, extinct, family, order_name, class_name)`, "species/data_0.parquet");

  // Backbone: a synonym of an in-Base accepted species (the synonym_of route),
  // and a subspecies record (the infraspecific route).
  // in_checklist / checklist_parent_id = what CoL's CURRENT RELEASE says, as
  // distinct from the extended release the rest of the backbone comes from.
  await copy(`SELECT * FROM (VALUES
      ('IN1', NULL, 'accepted', 'species', 'Clean species', true, NULL, NULL),
      ('XR1', NULL, 'accepted', 'species', 'Xr onlyus', false, NULL, NULL),
      ('LUMP', NULL, 'accepted', 'species', 'Lump winner', true, NULL, 'Lump winnerus'),
      ('SYN1', 'IN1', 'synonym', 'species', 'Renamed away', true, 'IN1', NULL),
      ('SUB1', 'IN1', 'accepted', 'subspecies', 'Clean species demoted', true, NULL, NULL),
      -- The Hylomyscus anselli shape: the XR accepts the name AND separately holds
      -- it as a synonym of something else, and the release contains neither record.
      ('ANS', NULL, 'accepted', 'species', 'Anselli test', false, NULL, NULL),
      ('ANSSYN', 'IN1', 'synonym', 'species', 'Anselli test', false, NULL, NULL),
      -- One name the release files as a synonym of TWO different accepted species.
      ('AMBX', NULL, 'accepted', 'species', 'Ambiguous target', false, NULL, NULL),
      ('AMB1', 'IN1', 'synonym', 'species', 'Ambiguous target', true, 'IN1', NULL),
      ('AMB2', 'LUMP', 'synonym', 'species', 'Ambiguous target', true, 'LUMP', NULL),
      ('SPELL', 'LUMP', 'synonym', 'species', 'Spelling case', true, 'LUMP', NULL),
      -- An UNASSESSED accepted species under which CoL files an assessed name:
      -- IUCN has assessed this taxon, as 'Clean species'. SYNONYM_ASSESSED_SQL.
      ('NEACC', NULL, 'accepted', 'species', 'Ne accepta', true, NULL, NULL),
      ('NESYN', 'NEACC', 'synonym', 'species', 'Clean species', true, NULL, NULL),
      -- Two names IUCN assesses separately, both synonyms of one unassessed
      -- species: naming either would present a coin toss as a finding.
      ('NEAMB', NULL, 'accepted', 'species', 'Ne ambigua', true, NULL, NULL),
      ('NEAMB1', 'NEAMB', 'synonym', 'species', 'Lump winner', true, NULL, NULL),
      ('NEAMB2', 'NEAMB', 'synonym', 'species', 'Demoted one', true, NULL, NULL)
    ) v(col_id, parent_id, status, rank, scientific_name, in_checklist, checklist_parent_id, checklist_name)`, "backbone.parquet");

  // family/order_name are the assessment's own placement, which the
  // classified_elsewhere wording compares CoL's against — naming a family the
  // two already agree on tells a reader nothing (every Sorbus row did).
  await copy(`SELECT * FROM (VALUES
      (1::BIGINT, 'Clean species', 'LC', 'Felidae', 'Carnivora'),
      (2::BIGINT, 'Xr onlyus', 'LC', 'Felidae', 'Carnivora'),
      (3::BIGINT, 'Renamed away', 'LC', 'Felidae', 'Carnivora'),
      (4::BIGINT, 'Demoted one', 'LC', 'Felidae', 'Carnivora'),
      (5::BIGINT, 'Lump winner', 'LC', 'Felidae', 'Carnivora'),
      (6::BIGINT, 'Lump loser', 'LC', 'Felidae', 'Carnivora'),
      (7::BIGINT, 'Nothing at all', 'LC', 'Felidae', 'Carnivora'),
      (8::BIGINT, 'Anselli test', 'LC', 'Felidae', 'Carnivora'),
      (9::BIGINT, 'Ambiguous target', 'LC', 'Felidae', 'Carnivora'),
      (10::BIGINT, 'Spelling case', 'LC', 'Felidae', 'Carnivora')
    ) v(id, scientific_name, iucn_category, family, order_name)`, "assessed.parquet");

  await copy(`SELECT * FROM (VALUES
      ('redlist', 1::BIGINT, 'Clean species', 'IN1', 'accepted'),
      ('redlist', 2::BIGINT, 'Xr onlyus', 'XR1', 'accepted'),
      ('redlist', 3::BIGINT, 'Renamed away', 'XR1', 'accepted'),
      ('redlist', 4::BIGINT, 'Demoted one', 'SUB1', 'accepted'),
      ('redlist', 5::BIGINT, 'Lump winner', 'LUMP', 'accepted'),
      ('redlist', 6::BIGINT, 'Lump loser', 'LUMP', 'synonym'),
      ('redlist', 7::BIGINT, 'Nothing at all', NULL, 'unmatched'),
      ('redlist', 8::BIGINT, 'Anselli test', 'ANS', 'accepted'),
      ('redlist', 9::BIGINT, 'Ambiguous target', 'AMBX', 'accepted'),
      ('redlist', 10::BIGINT, 'Spelling case', 'XR1', 'accepted')
    ) v(src, id, scientific_name, col_id, match_method)`, "species_link.parquet");

  // The same temp tables the real caller builds before running the diagnostic.
  await conn.run(COL_TO_ASSESSED_SQL(path.join(tmp, "species_link.parquet"), path.join(tmp, "assessed.parquet")));
  await conn.run(`CREATE TEMP TABLE assessed_cids AS
    SELECT DISTINCT col_id FROM read_parquet('${path.join(tmp, "species_link.parquet")}')
    WHERE col_id IS NOT NULL`);

  ctx = {
    conn,
    speciesGlob: path.join(tmp, "species", "**", "*.parquet"),
    assessedPath: path.join(tmp, "assessed.parquet"),
    linkPath: path.join(tmp, "species_link.parquet"),
    backbonePath: path.join(tmp, "backbone.parquet"),
    hasBackbone: true,
    hasChecklistColumns: true,
    universeSql: "extinct IS NOT TRUE",
    assessedCidsTable: "assessed_cids",
    excludedColIdsSql: "('__none__')",
  } as unknown as BreakdownQueryContext;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("computeNoMatchDetails — the query, not just the classifier", () => {
  it("runs, and every field classifyNoMatch reads survives the SELECT list", async () => {
    const details = await computeNoMatchDetails(ctx, "true", "true");
    const byId = new Map(details.map((d) => [d.id, d]));

    // A clean 1:1 match must not be diagnosed at all.
    expect(byId.has(1)).toBe(false);

    // linked_in_base reaching the classifier: XR-only, no backbone synonymy.
    expect(byId.get(2)?.reason).toBe("not_in_base");

    // syn_name/syn_col_id reaching the classifier via the backbone route.
    expect(byId.get(3)?.reason).toBe("synonym_of");
    expect(byId.get(3)?.detail).toBe("Clean species");

    // bk_rank + parent fields reaching the classifier.
    expect(byId.get(4)?.reason).toBe("infraspecific");
    expect(byId.get(4)?.rank).toBe("subspecies");

    // winner_name/winner_id reaching the classifier.
    expect(byId.get(6)?.reason).toBe("lumped");
    expect(byId.get(6)?.detail).toBe("Lump winner");

    // No link at all.
    expect(byId.get(7)?.reason).toBe("unmatched");

    // An XR-only synonym must NOT carry a rename claim: the release holds no such
    // synonymy, so a reader following the link would find nothing. What is true of
    // this species is that its record is extended-release only.
    expect(byId.get(8)?.reason).toBe("not_in_base");
    expect(byId.get(8)?.detail).toBeUndefined();

    // The release files this name under TWO accepted species. Picking one would
    // be a coin toss presented as a finding (Andropogon virginicus was reported
    // as Anatherum leucostachyum when the release says Anatherum virginicum), so
    // no rename is claimed at all.
    expect(byId.get(9)?.reason).toBe("not_in_base");
    expect(byId.get(9)?.detail).toBeUndefined();

    // The name shown beside a link to the release must be the RELEASE's spelling
    // ("Lump winnerus"), not the XR's ("Lump winner") — the text and the page it
    // sends you to have to agree.
    expect(byId.get(10)?.reason).toBe("synonym_of");
    expect(byId.get(10)?.detail).toBe("Lump winnerus");
  });

  // A backbone built before build-backbone stamped the checklist columns is a
  // perfectly usable backbone that simply lacks three columns. Referencing one
  // anyway is a Binder Error that fails the whole query — which is how every
  // live-drilldown breakdown started returning a 500 while the data sync,
  // gated only on the CoL release pins, kept declining to rebuild the file.
  // With the columns gone the rename claim goes with them; nothing else does.
  it("degrades instead of throwing when the backbone predates the checklist columns", async () => {
    const legacyBackbone = path.join(tmp, "backbone-legacy.parquet");
    await conn.run(`COPY (
      SELECT col_id, parent_id, status, rank, scientific_name
      FROM read_parquet('${path.join(tmp, "backbone.parquet")}')
    ) TO '${legacyBackbone}' (FORMAT PARQUET);`);

    expect(await backboneHasChecklistColumns(conn, legacyBackbone)).toBe(false);
    expect(await backboneHasChecklistColumns(conn, path.join(tmp, "backbone.parquet"))).toBe(true);

    const details = await computeNoMatchDetails(
      { ...ctx, backbonePath: legacyBackbone, hasChecklistColumns: false },
      "true",
      "true",
    );
    const byId = new Map(details.map((d) => [d.id, d]));

    // Every reason that doesn't come from those columns is unaffected.
    expect(byId.has(1)).toBe(false);
    expect(byId.get(4)?.reason).toBe("infraspecific");
    expect(byId.get(6)?.reason).toBe("lumped");
    expect(byId.get(7)?.reason).toBe("unmatched");

    // The rename claim is the one thing lost: species 3 falls back to what the
    // rest of the row still supports rather than disappearing or erroring.
    expect(byId.get(3)?.reason).toBe("not_in_base");
    expect(byId.get(3)?.detail).toBeUndefined();
  });
});

describe("SYNONYM_ASSESSED_SQL — why a Not Evaluated species may already be assessed", () => {
  it("names the assessed species CoL files as a synonym, and refuses when there are two", async () => {
    await conn.run(SYNONYM_ASSESSED_SQL(path.join(tmp, "backbone.parquet"), path.join(tmp, "assessed.parquet"), "assessed_cids"));
    const rows = await (await conn.run("SELECT * FROM synonym_assessed ORDER BY ne_col_id")).getRowObjects();
    const by = new Map(rows.map((r) => [String(r.ne_col_id), r]));

    // CoL files the assessed 'Clean species' as a synonym of the unassessed
    // 'Ne accepta' — the assessment exists, under a name CoL doesn't accept.
    expect(by.get("NEACC")?.assessed_name).toBe("Clean species");
    expect(Number(by.get("NEACC")?.assessed_id)).toBe(1);

    // Two separately-assessed names under one unassessed species: no claim.
    expect(by.has("NEAMB")).toBe(false);

    // A synonym under an ASSESSED accepted record explains no gap — there is
    // none. ('Renamed away' is a synonym of IN1, which IUCN has assessed.)
    expect(by.has("IN1")).toBe(false);
  });
});
