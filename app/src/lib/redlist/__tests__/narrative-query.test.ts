import { describe, it, expect } from "vitest";
import { parseQuery, highlightsOf, MIN_PREFIX, MAX_ATOMS } from "../narrative-query";

/** A readable shape for what a clause asks for. */
const shape = (q: string) =>
  parseQuery(q).required.map((c) =>
    c.alternatives.map((a) => (a.kind === "phrase" ? `"${a.tokens.map((t) => t.word).join(" ")}"` : a.kind === "prefix" ? `${a.word}*` : a.word))
  );

describe("the query language", () => {
  it("makes every bare word a requirement of its own", () => {
    expect(shape("limestone quarrying")).toEqual([["limestone"], ["quarrying"]]);
  });

  it("keeps a quoted run together as a phrase", () => {
    expect(shape('"limestone quarrying"')).toEqual([['"limestone quarrying"']]);
  });

  it("treats a one-word quote as the word, not a phrase", () => {
    // The phrase machinery is a join per word; for one word it is the same
    // answer as the plain lookup and several times the work.
    expect(shape('"limestone"')).toEqual([["limestone"]]);
  });

  it("hangs an OR alternative off the clause before it", () => {
    expect(shape('guano OR "bat dung" mining')).toEqual([
      ["guano", '"bat dung"'],
      ["mining"],
    ]);
  });

  it("ignores an OR with nothing to attach to", () => {
    expect(shape("OR caves")).toEqual([["caves"]]);
  });

  it("takes a minus as an exclusion, quoted or not", () => {
    const parsed = parseQuery('caves -bats -"guano mining"');
    expect(shape("caves -bats")).toEqual([["caves"]]);
    expect(parsed.excluded.map((a) => a.kind)).toEqual(["term", "phrase"]);
  });

  it("takes a trailing star as a prefix, but not a short one", () => {
    expect(shape("quarr*")).toEqual([["quarr*"]]);
    // A prefix is a range scan, and a short range is most of the index: "s*"
    // is 35,774 words and 2.4M postings. Below the floor the star is dropped
    // and the word looked up as itself.
    expect(MIN_PREFIX).toBe(4);
    expect(shape("car*")).toEqual([["car"]]);
  });

  it("closes an unclosed quote at the end of the line", () => {
    // Someone typing a phrase has typed the opening quote long before the
    // closing one, and a parse error mid-sentence helps nobody.
    expect(shape('"limestone quarrying')).toEqual([['"limestone quarrying"']]);
  });

  it("says what it could not use, rather than dropping it in silence", () => {
    expect(parseQuery("in the caves").ignored).toEqual(["in", "the"]);
    expect(parseQuery("in the caves").required).toHaveLength(1);
  });

  it("stops at a sane number of lookups", () => {
    const parsed = parseQuery("one two three four five six seven eight nine ten");
    expect(parsed.required).toHaveLength(MAX_ATOMS);
    expect(parsed.ignored).toEqual(["nine", "ten"]);
  });

  it("collects what to mark in a snippet", () => {
    const { terms, prefixes } = highlightsOf(parseQuery('quarr* "bat dung" caves -bats'));
    expect(prefixes).toEqual(["quarr"]);
    expect(terms.sort()).toEqual(["bat", "caves", "dung"]);
  });
});
