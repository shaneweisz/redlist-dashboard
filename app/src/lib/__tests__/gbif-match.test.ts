import { describe, it, expect } from "vitest";
import { matchKey, countsKeys, matchesMatchFilter, newMatchTally, tallyMatch } from "../gbif-match";

describe("matchKey", () => {
  it("groups the sync's labels", () => {
    expect(matchKey({ match_reason: "exact, unique" })).toBe("plain");
    expect(matchKey({ match_reason: "exact, homonym, author decides" })).toBe("author");
    expect(matchKey({ match_reason: "spelling variant, duplicate in CoL" })).toBe("duplicate");
    expect(matchKey({ match_reason: "spelling variant" })).toBe("variant");
    expect(matchKey({ match_reason: "unconfirmed: homonym the authors don't decide", count_note: "unconfirmed" })).toBe("u_homonym");
    expect(matchKey({ match_reason: "unconfirmed: accepted and a synonym in CoL", count_note: "unconfirmed" })).toBe("u_ambiguous");
    expect(matchKey({ match_reason: "waiting", count_note: "unconfirmed" })).toBe("u_waiting");
    expect(matchKey({ match_reason: "waiting", count_note: "unlinked" })).toBe("none");
  });
  it("tells a person's decision from an agent's proposal", () => {
    expect(matchKey({ match_reason: "override", match_decided_by: "fixture" })).toBe("decided");
    expect(matchKey({ match_reason: "override", match_decided_by: "agent audit" })).toBe("decided");
    expect(matchKey({ match_reason: "override", match_decided_by: "agent:haiku" })).toBe("agent");
  });
});

describe("the filter and tally", () => {
  const plain = { match: "plain" as const, match_counts_keys: [] };
  const lumped = { match: "plain" as const, match_counts_keys: countsKeys({ match_counts: "only records under its own name" }) };
  const guess = { match: "u_confidence" as const, match_counts_keys: countsKeys({ match_other_names: 2 }) };
  const ne = { may_be_assessed: ["Coenonympha gardetta"] };
  it("selects by bar, or a whole side", () => {
    expect(matchesMatchFilter(plain, new Set())).toBe(true);
    expect(matchesMatchFilter(lumped, new Set(["own_name"]))).toBe(true);
    expect(matchesMatchFilter(plain, new Set(["own_name"]))).toBe(false);
    expect(matchesMatchFilter(guess, new Set(["unconfirmed"]))).toBe(true);
    expect(matchesMatchFilter(ne, new Set(["unconfirmed"]))).toBe(true);
    expect(matchesMatchFilter(guess, new Set(["confirmed"]))).toBe(false);
    expect(matchesMatchFilter(lumped, new Set(["confirmed"]))).toBe(true);
  });
  it("counts each species once per side, and in each bar it belongs to", () => {
    const t = newMatchTally();
    for (const s of [plain, lumped, guess, ne]) tallyMatch(t, s);
    expect(t).toEqual({ confirmed: 2, unconfirmed: 2, counts: { own_name: 1, u_confidence: 1, other_names: 1, ne_candidate: 1 } });
  });
});
