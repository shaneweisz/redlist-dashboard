/**
 * The matcher's points (scripts/sync/link/matches.ts parseScore), read from the
 * verbose note matching-ws gives each candidate.
 */
import { describe, it, expect } from "vitest";
import { parseScore } from "../sync/link/matches";

describe("parseScore", () => {
  it("reads each component and the total (Cipangopaludina chinensis, the ambiguous synonym)", () => {
    expect(parseScore("Similarity: name=110; authorship=0; classification=50; rank=6; status=-1; score=165; nextMatch=2"))
      .toEqual({ name: 110, authorship: 0, classification: 50, rank: 6, status: -1, total: 165 });
  });
  it("leaves out what a note doesn't give (a higher-rank fallback has no authorship)", () => {
    expect(parseScore("Similarity: name=100; classification=50; rank=0; status=1; score=151"))
      .toEqual({ name: 100, authorship: null, classification: 50, rank: 0, status: 1, total: 151 });
  });
  it("is null for no note, or one without points", () => {
    expect(parseScore(undefined)).toBeNull();
    expect(parseScore("matched by id")).toBeNull();
  });
});
