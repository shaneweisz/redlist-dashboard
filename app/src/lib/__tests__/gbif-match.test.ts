import { describe, it, expect } from "vitest";
import { matchKey, countsKeys, matchesMatchFilter, newMatchTally, tallyMatch, isFlagged } from "../gbif-match";

describe("matchKey", () => {
  it("groups the sync's labels", () => {
    expect(matchKey({ match_reason: "exact, unique" })).toBe("plain");
    expect(matchKey({ match_reason: "exact, homonym, author decides" })).toBe("author");
    expect(matchKey({ match_reason: "spelling variant, duplicate in CoL" })).toBe("duplicate");
    expect(matchKey({ match_reason: "spelling variant" })).toBe("variant");
    expect(matchKey({ match_reason: "flagged: homonym the authors don't decide", count_note: "flagged" })).toBe("f_homonym");
    expect(matchKey({ match_reason: "flagged: accepted and a synonym in CoL", count_note: "flagged" })).toBe("f_ambiguous");
    expect(matchKey({ match_reason: "waiting", count_note: "flagged" })).toBe("f_synonyms_only");
    expect(matchKey({ match_reason: "waiting", count_note: "unlinked" })).toBe("none");
  });
  it("tells a person's decision from an AI proposal", () => {
    expect(matchKey({ match_reason: "override", match_decided_by: "fixture" })).toBe("decided");
    expect(matchKey({ match_reason: "override", match_decided_by: "agent audit" })).toBe("decided");
    expect(matchKey({ match_reason: "override", match_decided_by: "agent:haiku" })).toBe("agent");
  });
});

describe("the filter and tally", () => {
  const exact = { match: "plain" as const, match_counts_keys: [] };
  const lumped = { match: "plain" as const, match_counts_keys: countsKeys({ match_counts: "only records under its own name" }) };
  const guess = { match: "f_confidence" as const, match_counts_keys: countsKeys({ match_other_names: 2 }) };
  const resolved = { match: "author" as const, match_counts_keys: [] };
  const ne = { may_be_assessed: ["Coenonympha gardetta"] };
  it("selects by bar, or by Flagged / Exact", () => {
    expect(matchesMatchFilter(exact, new Set())).toBe(true);
    expect(matchesMatchFilter(lumped, new Set(["own_name"]))).toBe(true);
    expect(matchesMatchFilter(exact, new Set(["own_name"]))).toBe(false);
    expect(matchesMatchFilter(guess, new Set(["flagged"]))).toBe(true);
    expect(matchesMatchFilter(ne, new Set(["flagged"]))).toBe(true);
    expect(matchesMatchFilter(resolved, new Set(["flagged"]))).toBe(false);
    expect(matchesMatchFilter(lumped, new Set(["exact"]))).toBe(true);
    expect(matchesMatchFilter(resolved, new Set(["exact"]))).toBe(false);
  });
  it("counts Exact and Flagged, and each bar a species belongs to", () => {
    const t = newMatchTally();
    for (const s of [exact, lumped, guess, resolved, ne]) tallyMatch(t, s);
    expect(t).toEqual({ exact: 2, flagged: 2, counts: { own_name: 1, f_confidence: 1, other_names: 1, author: 1, ne_candidate: 1 } });
    expect(isFlagged(resolved)).toBe(false);
  });
});
