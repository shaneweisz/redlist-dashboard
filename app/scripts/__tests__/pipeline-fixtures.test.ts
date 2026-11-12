/**
 * Matching fixtures (scripts/sync/checks/fixtures/matching.ts) and the check that
 * holds a sync to them: each expectation is checked only when stated, and the
 * case list itself stays well-formed.
 */
import { describe, it, expect } from "vitest";
import { mismatches, failureKind, buildVersions, uncoveredRules, ruleLabel, type Observed } from "../sync/checks/check-fixtures";
import { MATCHING_CASES, type MatchCase } from "../sync/checks/fixtures/matching";

const seen: Observed = {
  assessed: true, category: "VU", linkedTo: "Malus domestica", linkedAuthorship: "Borkh.", gbifKey: "9Y3S3", gbifKeyName: "Malus sieversii",
  records: 8_413, neListed: { "Malus domestica": false }, rules: ["exact, unique"],
};
const confirmed = { redlist: "2026-1", col: "COL26.6 XR", snapshot: "2026-11-01" };
const c = (expect: MatchCase["expect"]): MatchCase => ({ name: "Malus sieversii", why: "", source: "", confirmed, expect });

describe("rules", () => {
  it("labels a waiting row by why it waits", () => {
    expect(ruleLabel("waiting", "provisional name")).toBe("waiting: provisional name");
    expect(ruleLabel("CoL duplicate", null)).toBe("CoL duplicate");
  });
  it("fails a case whose rows don't show its rule", () => {
    expect(mismatches(c({ rules: ["exact, unique"] }), seen)).toEqual([]);
    expect(mismatches(c({ rules: ["CoL duplicate"] }), seen)).toEqual(['rule: expected "CoL duplicate", its rows show ["exact, unique"]']);
  });
  it("names every rule a build applies that no case shows", () => {
    expect(uncoveredRules([c({ rules: ["exact, unique"] })], ["exact, unique", "waiting: lower confidence"])).toEqual(["waiting: lower confidence"]);
  });
});

describe("failureKind", () => {
  it("calls a failure on the releases a case last passed on a regression", () => {
    expect(failureKind(c({ linkedTo: "X" }), confirmed)).toBe("a regression: it passed on these same releases");
  });
  it("names the releases that moved since, the snapshot only for a case about records", () => {
    const newer = { redlist: "2026-1", col: "COL26.10 XR", snapshot: "2026-12-01" };
    expect(failureKind(c({ linkedTo: "X" }), newer)).toMatch(/^confirmed on older releases \(col COL26.6 XR → COL26.10 XR\)/);
    expect(failureKind(c({ minRecords: 5 }), newer)).toMatch(/col COL26.6 XR → COL26.10 XR, snapshot 2026-11-01 → 2026-12-01/);
    expect(failureKind(c({ linkedTo: "X" }), { ...confirmed, snapshot: "2026-12-01" })).toBe("a regression: it passed on these same releases");
  });
  it("reads a build's releases from its sync.json", () => {
    expect(buildVersions({ redlist: { database: "redlist_2026_1" }, col: { xr: { alias: "COL26.6 XR" } }, gbif: { snapshot: "2026-11-01" } })).toEqual(confirmed);
  });
});

describe("the cases", () => {
  it("an update to a why says when and against which release it was checked", () => {
    for (const m of MATCHING_CASES) for (const u of m.why.match(/Update \([^)]*\)/g) ?? []) {
      expect(u, m.name).toMatch(/^Update \(\d{4}-\d{2}, (Red List \d|COL\d|snapshot \d)[^)]*\)$/);
    }
  });

  it("every case says which releases it last passed on", () => {
    for (const m of MATCHING_CASES) expect(m.confirmed, m.name).toMatchObject({ redlist: expect.any(String), col: expect.any(String), snapshot: expect.any(String) });
  });
});

describe("mismatches", () => {
  it("passes when every stated expectation holds and ignores unstated ones", () => {
    expect(mismatches(c({ linkedTo: "Malus domestica", hasRecords: true, maxRecords: 30_000 }), seen)).toEqual([]);
    expect(mismatches(c({}), seen)).toEqual([]);
  });

  it("names each expectation that fails", () => {
    expect(mismatches(c({ gbifKeyName: "Malus domestica", minRecords: 10_000, maxRecords: 1_000 }), seen)).toEqual([
      'GBIF key name: expected "Malus domestica", got "Malus sieversii"',
      "records: expected at least 10000, got 8413",
      "records: expected at most 1000, got 8413",
    ]);
  });

  it("treats no records as zero and null as an expectation of no key", () => {
    const none: Observed = { ...seen, gbifKeyName: null, records: null };
    expect(mismatches(c({ gbifKeyName: null, hasRecords: false, maxRecords: 0 }), none)).toEqual([]);
    expect(mismatches(c({ hasRecords: true }), none)).toEqual(["has records: expected true, got false"]);
  });

  it("tells homonyms apart by the linked species' citation (Centropogon australis, a fish and a plant)", () => {
    const fish = { ...seen, linkedTo: "Centropogon australis", linkedAuthorship: "(White, 1790)" };
    const want = c({ linkedTo: "Centropogon australis", linkedAuthorship: "(White, 1790)" });
    expect(mismatches(want, fish)).toEqual([]);
    expect(mismatches(want, { ...fish, linkedAuthorship: "(J. White, 1790)" })).toEqual([]);
    expect(mismatches(want, { ...fish, linkedAuthorship: "(E.Wimm.) Gleason" })).toEqual([
      "linked to: expected Centropogon australis (White, 1790), got Centropogon australis (E.Wimm.) Gleason",
    ]);
  });

  it("flags a case whose Red List authority now names clearly other authors, when the build gives it", () => {
    const m = { ...c({}), authority: "(Shaw, 1790)" };
    expect(mismatches(m, { ...seen, authority: "(Shaw, 1790)" })).toEqual([]);
    expect(mismatches(m, { ...seen })).toEqual([]);
    expect(mismatches(m, { ...seen, authority: "Smith, 1950" })[0]).toMatch(/^Red List authority: the case is about/);
  });

  it("checks NE-list visibility per name", () => {
    expect(mismatches(c({ neListed: { "Malus domestica": true } }), seen)).toEqual([
      'Malus domestica in NE list: expected true, got false',
    ]);
  });
});

describe("MATCHING_CASES", () => {
  it("has one case per name, each saying why it exists and where", () => {
    const names = MATCHING_CASES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of MATCHING_CASES) {
      expect(m.why.length, m.name).toBeGreaterThan(10);
      expect(m.source.length, m.name).toBeGreaterThan(3);
      expect(Object.keys(m.expect).length, m.name).toBeGreaterThan(0);
    }
  });
});
