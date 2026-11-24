/**
 * The decisions file (scripts/sync/link/decisions.ts): read and written one row
 * per record, and held against a release by names, since CoL ids move. One
 * case per hold condition (docs/specs/matching.md, "Decisions").
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { readDecisions, writeDecisions, decisionHolds, isOverride, answerKey, readConfirmations, writeConfirmations, readNotes,
  COLUMNS, DECISIONS_FILE, CONFIRMED_FILE, NOTES_FILE, type Decision, type DecidableRecord } from "../sync/link/decisions";

const decision = (over: Partial<Decision> = {}): Decision => ({
  sis: 1, redlistName: "Ochotona pallasi", redlistAuthority: "(Gray, 1867)", candidates: ["Ochotona pallasii"], by: "someone", reviewed: true,
  date: "2026-11-05", evidence: "a Latin ending", sources: ["https://example.org/a"], transcripts: ["abc"],
  rows: [{ id: "OLD", name: "Ochotona pallasii", authorship: "(Gray, 1867)", status: "accepted", species: "Ochotona pallasii", relation: "is" }], ...over,
});
const record = (id: string, over: Partial<DecidableRecord> = {}): DecidableRecord => ({
  id, name: "Ochotona pallasii", authorship: "(Gray, 1867)", status: "accepted", speciesId: id, speciesName: "Ochotona pallasii", ...over });
const release = (records: DecidableRecord[], assessed: string[] = []) => ({
  byId: (id: string) => records.find((r) => r.id === id),
  byName: (n: string) => records.filter((r) => r.name.toLowerCase() === n.toLowerCase()),
  isAnotherAssessedName: (n: string) => assessed.includes(n),
});
const own = { name: "Ochotona pallasi", citation: "(Gray, 1867)" };

describe("readDecisions / writeDecisions", () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "decisions-")), "decisions.tsv");

  it("round-trips, one row per record, and 'not in CoL' as a species' only row", () => {
    const f = tmp();
    const two = decision({ sis: 3, rows: [decision().rows[0], { ...decision().rows[0], id: "SECOND", relation: "split into" }] });
    writeDecisions([decision({ sis: 2, rows: [], reviewed: false }), decision(), two], f);
    const back = readDecisions(f);
    expect([...back.keys()]).toEqual([1, 2, 3]);
    expect(back.get(1)).toEqual(decision());
    expect(back.get(2)).toMatchObject({ rows: [], reviewed: false });
    expect(back.get(3)!.rows.map((r) => r.relation)).toEqual(["is", "split into"]);
  });

  it("refuses rows that disagree on the species, a bad relation, or a missing by", () => {
    const f = tmp();
    const line = (sis: number, by: string, relation = "is", evidence = "x") =>
      [sis, "N", "", "ID", "N", "", "accepted", "N", relation, "", by, "yes", "2026-11-05", evidence, "", ""].join("\t");
    fs.writeFileSync(f, [COLUMNS.join("\t"), line(1, "a"), line(1, "a", "is", "other")].join("\n"));
    expect(() => readDecisions(f)).toThrow(/disagree/);
    fs.writeFileSync(f, [COLUMNS.join("\t"), line(1, "a", "refused")].join("\n"));
    expect(() => readDecisions(f)).toThrow(/relation/);
    fs.writeFileSync(f, [COLUMNS.join("\t"), line(1, "")].join("\n"));
    expect(() => readDecisions(f)).toThrow(/no "by"/);
  });

  it("the repo's files read", () => {
    expect(() => readDecisions(DECISIONS_FILE)).not.toThrow();
    expect(() => readConfirmations(CONFIRMED_FILE)).not.toThrow();
    expect(() => readNotes(NOTES_FILE)).not.toThrow();
  });

  it("a person's decision is an override, the judge's, an agent's or a fixture's isn't", () => {
    expect(isOverride({ by: "someone" })).toBe(true);
    for (const by of ["judge:claude-opus-5-5", "agent:unrecorded", "fixture"]) expect(isOverride({ by })).toBe(false);
  });

  it("confirmations round-trip, keyed by the answer without refused records", () => {
    const f = tmp();
    const answer = answerKey([{ id: "B", relation: "part of" }, { id: "A", relation: "is" }, { id: "C", relation: "refused" }]);
    expect(answer).toBe("A:is,B:part of");
    writeConfirmations([{ sis: 5, redlistName: "N", answer, by: "judge:m", date: "2026-11-24", transcripts: ["t1", "t2"] }], f);
    expect(readConfirmations(f).get(5)).toMatchObject({ answer: "A:is,B:part of", transcripts: ["t1", "t2"] });
  });
});

describe("decisionHolds", () => {
  it("holds, finding a moved record by its name, status, species and equal authorship", () => {
    const res = decisionHolds(decision(), own, release([record("NEW")]));
    expect(res).toMatchObject({ holds: true, records: [{ record: { id: "NEW" }, relation: "is" }] });
  });
  it("lapses: the Red List renamed the species", () => {
    expect(decisionHolds(decision(), { ...own, name: "Ochotona other" }, release([record("OLD")]))).toEqual({ holds: false, lapse: "name" });
  });
  it("lapses: the Red List now cites other authors (a reformatting doesn't)", () => {
    expect(decisionHolds(decision(), { ...own, citation: "(Smith, 1900)" }, release([record("OLD")]))).toEqual({ holds: false, lapse: "citation" });
    expect(decisionHolds(decision(), { ...own, citation: "(Gray 1867)" }, release([record("OLD")])).holds).toBe(true);
  });
  it("lapses: a record's name or species is another assessed name", () => {
    expect(decisionHolds(decision(), own, release([record("OLD")], ["Ochotona pallasii"]))).toEqual({ holds: false, lapse: "assessed name" });
  });
  it("lapses: the record is gone, moved species, or changed status", () => {
    expect(decisionHolds(decision(), own, release([]))).toEqual({ holds: false, lapse: "record not found" });
    expect(decisionHolds(decision(), own, release([record("OLD", { speciesName: "Ochotona other" })]))).toEqual({ holds: false, lapse: "record not found" });
    expect(decisionHolds(decision(), own, release([record("OLD", { status: "synonym" })]))).toEqual({ holds: false, lapse: "record not found" });
  });
  it("lapses when two records could be the one meant", () => {
    expect(decisionHolds(decision(), own, release([record("A"), record("B")]))).toEqual({ holds: false, lapse: "record not found" });
  });
  it("'not in CoL' holds with no records", () => {
    expect(decisionHolds(decision({ rows: [] }), own, release([]))).toEqual({ holds: true, records: [] });
  });
});
