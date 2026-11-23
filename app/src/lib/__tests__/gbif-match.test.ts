import { describe, it, expect } from "vitest";
import { matchKey, countsKeys, doubtKeys, matchesMatchFilter, newMatchTally, tallyMatch, isFlagged, isExact, assessedHere } from "../gbif-match";

describe("matchKey", () => {
  it("groups the sync's labels", () => {
    expect(matchKey({ match_reason: "exact, unique" })).toBe("plain");
    expect(matchKey({ match_reason: "exact, homonym, author decides" })).toBe("author");
    expect(matchKey({ match_reason: "spelling variant, duplicate in CoL" })).toBe("duplicate");
    expect(matchKey({ match_reason: "spelling variant" })).toBe("variant");
    expect(matchKey({ match_reason: "exact, duplicate in CoL", match_doubts: "homonym;ambiguous synonym", count_note: "flagged" })).toBe("f_homonym");
    expect(matchKey({ match_reason: "no candidate", count_note: "flagged" })).toBe("f_synonyms_only");
    expect(matchKey({ match_reason: "no candidate", count_note: "unlinked" })).toBe("none");
    expect(matchKey({ match_reason: "informal or qualified name", count_note: "unlinked" })).toBe("none");
  });
  it("reads every doubt as a bar of its own", () => {
    expect(doubtKeys({ match_doubts: "chosen by the citation;ambiguous synonym" })).toEqual(["f_author_pick", "f_ambiguous"]);
    expect(doubtKeys({ match_doubts: "counts nothing;split, authors unclear;synonym filed elsewhere;placed elsewhere" }))
      .toEqual(["f_counts_nothing", "f_split_unclear", "f_filed_elsewhere", "f_confidence"]);
    expect(doubtKeys({ match_doubts: null })).toEqual([]);
  });
  it("tells a person's decision from an AI proposal", () => {
    expect(matchKey({ match_reason: "decision", match_decided_by: "fixture" })).toBe("decided");
    expect(matchKey({ match_reason: "decision", match_decided_by: "agent:unrecorded" })).toBe("agent");
    expect(matchKey({ match_reason: "decision", match_decided_by: "agent:unrecorded", match_reviewed: true })).toBe("decided");
    expect(matchKey({ match_reason: "decision, not in CoL", match_decided_by: "someone", count_note: "unlinked" })).toBe("none");
  });
});

describe("the filter and tally", () => {
  const exact = { match: "plain" as const, match_counts_keys: [] };
  const lumped = { match: "plain" as const, match_counts_keys: countsKeys({ match_counts: "only records under its own name" }) };
  const guess = { match: "f_confidence" as const, match_doubt_keys: doubtKeys({ match_doubts: "placed elsewhere;other authors" }),
    match_counts_keys: countsKeys({ match_other_names: 2 }) };
  const resolved = { match: "author" as const, match_counts_keys: [] };
  const ne = { may_be_assessed: ["Coenonympha gardetta"] };
  // Sorbus greenii: found once, as a synonym CoL counts under Aria greenii.
  const renamed = { match: "renamed" as const, match_counts_keys: [] };
  it("selects by bar, or by Flagged / Exact", () => {
    expect(matchesMatchFilter(exact, new Set())).toBe(true);
    expect(matchesMatchFilter(lumped, new Set(["own_name"]))).toBe(true);
    expect(matchesMatchFilter(exact, new Set(["own_name"]))).toBe(false);
    expect(matchesMatchFilter(guess, new Set(["flagged"]))).toBe(true);
    expect(matchesMatchFilter(ne, new Set(["flagged"]))).toBe(true);
    expect(matchesMatchFilter(resolved, new Set(["flagged"]))).toBe(false);
    expect(matchesMatchFilter(lumped, new Set(["exact"]))).toBe(true);
    expect(matchesMatchFilter(resolved, new Set(["exact"]))).toBe(false);
    expect(matchesMatchFilter(renamed, new Set(["exact"]))).toBe(true);
  });
  it("counts Exact (a rename included, no bar of its own) and Flagged, and each bar a species belongs to", () => {
    const t = newMatchTally();
    for (const s of [exact, lumped, guess, resolved, ne, renamed]) tallyMatch(t, s);
    expect(t).toEqual({ exact: 3, flagged: 2, counts: { own_name: 1, f_confidence: 1, f_other_authors: 1, other_names: 1, author: 1, ne_candidate: 1 } });
    expect(isFlagged(resolved)).toBe(false);
  });
  it("filters by any of a species' doubts, and a doubted plain match isn't exact", () => {
    expect(matchesMatchFilter(guess, new Set(["f_other_authors"]))).toBe(true);
    expect(isExact({ match: "plain", match_doubt_keys: ["f_filed_elsewhere"] })).toBe(false);
    expect(isFlagged({ match: "plain", match_doubt_keys: ["f_filed_elsewhere"] })).toBe(true);
  });
  it("reads an NE species' notes", () => {
    expect(assessedHere("Pararge xiphioides (part of)")).toEqual({ name: "Pararge xiphioides", kind: "part of" });
    expect(assessedHere("Gymnosporia gracilis (same name)")).toEqual({ name: "Gymnosporia gracilis", kind: "same name" });
    // A note isn't a flag.
    expect(isFlagged({ assessed_here: ["Pararge xiphioides (part of)"] })).toBe(false);
    expect(matchesMatchFilter({ assessed_here: ["Pararge xiphioides (part of)"] }, new Set(["ne_assessed_here"]))).toBe(true);
  });
});
