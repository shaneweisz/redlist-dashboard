/**
 * The AI taxonomic reviews file (scripts/sync/link/ai-reviews.ts): read and
 * written one row per species and reviewer, and applied by selectEvery only
 * while the rules give the answer and basis they were given, never changing
 * the records (docs/specs/matching.md, "AI taxonomic review").
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { readReviews, writeReviews, parseRecord, formatRecord, reviewBasis, answerKey, REVIEWS_FILE, REVIEW_DOUBT, type Review } from "../sync/link/ai-reviews";
import { selectEvery, answerRecords, type ColRecord, type ColSpecies, type SpeciesInput } from "../sync/link/select";

const review = (over: Partial<Review> = {}): Review => ({
  sis: 1, redlistName: "Panthera leo", reviewer: 1, finding: "agrees", records: [], reason: "r", sources: ["https://example.org/a"],
  rulesAnswer: "", basis: "", model: "claude-opus-5-5", date: "2026-11-26", transcript: "abc", context: "xr 1; snapshot 2026-11-01; matcher v1; prompt 12345678", ...over,
});

describe("readReviews / writeReviews", () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reviews-")), "ai-reviews.tsv");

  it("round-trips, one row per reviewer, suggested records included", () => {
    const f = tmp();
    const other = review({ reviewer: 2, finding: "other records", records: [
      { id: "S", relation: "is", label: "Panthera leo", status: "accepted", species: "Panthera leo", records: 100 },
      { id: "P", relation: "part of", label: "Leo pardus (L.; 1758)", status: "synonym", species: "Panthera pardus", records: 7 }] });
    writeReviews([other, review()], f);
    const back = readReviews(f).get(1)!;
    expect(back.map((r) => r.reviewer)).toEqual([1, 2]);
    // A ";" in an authorship would split the list: it is written as ",".
    expect(back[1].records).toEqual([other.records[0], { ...other.records[1], label: "Leo pardus (L., 1758)" }]);
    expect(back[0]).toEqual(review());
  });

  it("refuses an unknown finding or a bad id", () => {
    const f = tmp();
    writeReviews([review()], f);
    fs.writeFileSync(f, fs.readFileSync(f, "utf-8").replace("\tagrees\t", "\tconfirmed\t"));
    expect(() => readReviews(f)).toThrow(/finding/);
    expect(() => parseRecord("not a record")).toThrow(/can't read/);
  });

  it("the repo's file reads, two reviewers a species", () => {
    const all = readReviews(REVIEWS_FILE);
    expect(all.size).toBeGreaterThan(0);
    for (const rs of all.values()) expect(rs.map((r) => r.reviewer)).toEqual([1, 2]);
  });

  it("writes a record so it reads back", () => {
    const r = { id: "3YNKJ", relation: "split into" as const, label: "Medicago falcata", status: "accepted", species: "Medicago falcata", records: 120640 };
    expect(parseRecord(formatRecord(r))).toEqual(r);
  });
});

describe("applied by selectEvery", () => {
  const spc: ColSpecies = { id: "S", name: "Panthera leo", authorship: "(Linnaeus, 1758)", class: null, kingdom: "Animalia", phylum: "Chordata" };
  const rec: ColRecord = { id: "S", name: "Panthera leo", authorship: "(Linnaeus, 1758)", rank: "SPECIES", status: "ACCEPTED", species: spc };
  // Accepted, but the matcher isn't sure of the spelling: the doubt "other spelling" lists it for review.
  const sp: SpeciesInput = { sis: 1, name: "Panthera leo", authority: "(Linnaeus, 1758)", kingdom: "Animalia", phylum: "Chordata", synonyms: [],
    match: { matchType: "FUZZY", answerName: "Panthera leo", answer: { ...rec, name: "Panthera lio" }, alternatives: [] } };
  const release = { assessedNames: new Set(["panthera leo"]), recordsNamed: () => [], occurrencesUnder: () => 10, byId: () => undefined };
  const rules = selectEvery([sp], release)[0];
  const given = { rulesAnswer: answerKey(answerRecords(rules)), basis: reviewBasis(sp, rules) };
  const reviewed = (findings: Review["finding"][], over: Partial<Review> = {}) =>
    selectEvery([sp], release, new Map([[1, findings.map((finding, i) => review({ reviewer: i + 1, finding, ...given, ...over }))]]))[0];

  it("lists the species for review before any review", () => {
    expect(rules.toReview).not.toBeNull();
    expect(rules.reviews).toBeUndefined();
  });
  it("both agree: off the review list, its doubts kept, its records unchanged", () => {
    const s = reviewed(["agrees", "agrees"]);
    expect(s.toReview).toBeNull();
    expect(s.doubts).toEqual(rules.doubts);
    expect(s.selected).toEqual(rules.selected);
  });
  it("one suggests other records: the doubt, still listed, its records unchanged", () => {
    const s = reviewed(["agrees", "other records"]);
    expect(s.doubts).toEqual([...rules.doubts, REVIEW_DOUBT]);
    expect(s.toReview).toMatch(new RegExp(`^${REVIEW_DOUBT}`));
    expect(s.selected).toEqual(rules.selected);
  });
  it("can't tell: shown, listed as it was", () => {
    const s = reviewed(["agrees", "can't tell"]);
    expect(s.reviews).toHaveLength(2);
    expect(s.toReview).toBe(rules.toReview);
  });
  it("applies only while the rules' answer and basis are unchanged", () => {
    expect(reviewed(["agrees", "agrees"], { rulesAnswer: "something else" }).reviews).toBeUndefined();
    expect(reviewed(["agrees", "agrees"], { basis: "000000000000" }).toReview).toBe(rules.toReview);
  });
});
