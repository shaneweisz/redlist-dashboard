/**
 * The decisions file (scripts/sync/link/match-overrides.ts): read, written, and
 * resolved against a release by names, since CoL ids move.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { readOverrides, writeOverrides, resolveOverride, COLUMNS, OVERRIDES_FILE, type MatchOverride } from "../sync/link/match-overrides";

const decision = (over: Partial<MatchOverride> = {}): MatchOverride => ({
  sis: 1, redlistName: "Ochotona pallasi", redlistAuthority: "(Gray, 1867)", colName: "Ochotona pallasii", colAuthorship: "(Gray, 1867)", colId: "OLD",
  colStatus: "accepted", colSpecies: "Ochotona pallasii", redlistVersion: "2026-1", colVersion: "COL26.6 XR",
  by: "someone", reviewed: true, date: "2026-11-05", note: "a Latin ending", ...over,
});
const usage = (col_id: string, scientific_name = "Ochotona pallasii", authorship: string | null = "(Gray, 1867)", status = "accepted",
  species_name: string | null = scientific_name) => ({ col_id, scientific_name, authorship, status, species_name });

describe("readOverrides / writeOverrides", () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "decisions-")), "match-overrides.tsv");

  it("round-trips", () => {
    const f = tmp();
    writeOverrides([decision({ sis: 2, colName: null, colAuthorship: null, colId: null, reviewed: false }), decision()], f);
    const back = readOverrides(f);
    expect([...back.keys()]).toEqual([1, 2]);
    expect(back.get(1)).toEqual(decision());
    expect(back.get(2)).toMatchObject({ colName: null, reviewed: false });
  });

  it("refuses a species decided twice", () => {
    const f = tmp();
    fs.writeFileSync(f, [COLUMNS.join("\t"), "1\ta\t\tb\t\t\t\t\t\t\tx\tyes\t\t", "1\ta\t\tc\t\t\t\t\t\t\tx\tyes\t\t"].join("\n"));
    expect(() => readOverrides(f)).toThrow(/decided twice/);
  });

  it("refuses a decision without an author", () => {
    const f = tmp();
    fs.writeFileSync(f, [COLUMNS.join("\t"), "1\ta\t\tb\t\t\t\t\t\t\t\tyes\t\t"].join("\n"));
    expect(() => readOverrides(f)).toThrow(/no "by"/);
  });

  it("the checked-in file reads", () => {
    expect(() => readOverrides(OVERRIDES_FILE)).not.toThrow();
  });
});

describe("resolveOverride", () => {
  it("is stale when the Red List now cites clearly other authors, not for a reformatting", () => {
    expect(resolveOverride(decision(), "Ochotona pallasi", [usage("OLD")], "Smith, 1950").kind).toBe("stale");
    expect(resolveOverride(decision(), "Ochotona pallasi", [usage("OLD")], "(J. E. Gray, 1867)")).toEqual({ kind: "usage", colId: "OLD" });
  });

  it("carries a decision to a newer release while what it rested on still holds", () => {
    expect(resolveOverride(decision({ colVersion: "COL26.6 XR" }), "Ochotona pallasi", [usage("NEW")])).toEqual({ kind: "usage", colId: "NEW" });
  });

  it("is stale when CoL now holds the name with another status", () => {
    const r = resolveOverride(decision(), "Ochotona pallasi", [usage("OLD", "Ochotona pallasii", "(Gray, 1867)", "synonym", "Ochotona other")]);
    expect(r).toEqual({ kind: "stale", why: "CoL now holds Ochotona pallasii as synonym, not accepted (decided against COL26.6 XR)" });
  });

  it("is stale when the name now leads to another species", () => {
    const d = decision({ colStatus: "synonym", colSpecies: "Ochotona one" });
    const r = resolveOverride(d, "Ochotona pallasi", [usage("OLD", "Ochotona pallasii", "(Gray, 1867)", "synonym", "Ochotona two")]);
    expect(r).toEqual({ kind: "stale", why: "CoL now files Ochotona pallasii under Ochotona two, not Ochotona one (decided against COL26.6 XR)" });
  });

  it("uses the recorded id while it carries the name", () => {
    expect(resolveOverride(decision(), "Ochotona pallasi", [usage("OLD"), usage("NEW")])).toEqual({ kind: "usage", colId: "OLD" });
  });

  it("finds the name again when CoL renumbers it", () => {
    expect(resolveOverride(decision(), "Ochotona pallasi", [usage("NEW")])).toEqual({ kind: "usage", colId: "NEW" });
  });

  it("tells homonyms apart by authorship", () => {
    const r = resolveOverride(decision({ colId: null }), "Ochotona pallasi",
      [usage("A", "Ochotona pallasii", "Someone, 1900"), usage("B")]);
    expect(r).toEqual({ kind: "usage", colId: "B" });
  });

  it("prefers the accepted usage of a name CoL holds twice", () => {
    const r = resolveOverride(decision({ colId: null }), "Ochotona pallasi", [usage("A", undefined, undefined, "synonym"), usage("B")]);
    expect(r).toEqual({ kind: "usage", colId: "B" });
  });

  it("is stale when the name is gone from CoL", () => {
    expect(resolveOverride(decision(), "Ochotona pallasi", [])).toMatchObject({ kind: "stale" });
  });

  it("is stale when the Red List renames the species", () => {
    expect(resolveOverride(decision(), "Ochotona argentata", [usage("OLD")])).toMatchObject({ kind: "stale" });
  });

  it("records a species CoL doesn't hold", () => {
    expect(resolveOverride(decision({ colName: null }), "Ochotona pallasi", [])).toEqual({ kind: "not in CoL" });
  });
});
