import { describe, it, expect } from "vitest";
import { plainText } from "../../../../scripts/build-narratives";
import { indexPostings, phrasePattern, queryTerms, queryTokens } from "../narrative-terms";

/**
 * The corpus and the query must be tokenised the same way.
 *
 * They are read in two places — a build script and a request — and if the two
 * ever disagree the search simply returns nothing, with no error to notice.
 * These pin them together.
 */
describe("indexing and querying agree", () => {
  const cases = [
    "Limestone quarrying",
    "slash-and-burn agriculture",
    "1080 poison",
    "Guano-mining, in caves",
    "sub-populations",
  ];

  it("every word a query asks for is a word the index would hold", () => {
    for (const phrase of cases) {
      const indexed = indexPostings([phrase]);
      for (const word of queryTerms(phrase)) {
        expect(indexed.has(word), `"${word}" from "${phrase}" is not indexed`).toBe(true);
      }
    }
  });

  it("keeps hyphenated compounds whole", () => {
    expect([...indexPostings(["slash-and-burn agriculture"]).keys()]).toContain("slash-and-burn");
    expect(queryTerms("slash-and-burn")).toEqual(["slash-and-burn"]);
  });

  it("drops the words that would match everything", () => {
    expect([...indexPostings(["the forest and the river"]).keys()].sort()).toEqual([
      "forest",
      "river",
    ]);
  });

  it("keeps numbers, which assessors use as names", () => {
    expect([...indexPostings(["1080 poison"]).keys()]).toContain("1080");
  });

  it("takes at most six words from a query", () => {
    expect(queryTerms("one two three four five six seven eight")).toHaveLength(6);
  });
});

/**
 * Phrase search, as the SQL does it.
 *
 * `phraseSql` in narratives-duckdb.ts shifts each word's stored positions back
 * by where that word sits in the query and intersects the lists; a shared
 * number means the words are the right distance apart in the text. This is
 * that, in twelve lines, so the rule can be tested without a database — and so
 * the parquet's positions and the query's offsets are held to agreeing.
 */
function phraseMatches(fields: string[], query: string): boolean {
  const postings = indexPostings(fields);
  const tokens = queryTokens(query);
  let shared: number[] | null = null;
  for (const { word, pos } of tokens) {
    const anchors = (postings.get(word) ?? []).map((p) => p - pos);
    shared = shared === null ? anchors : shared.filter((a) => anchors.includes(a));
  }
  return (shared?.length ?? 0) > 0;
}

describe("phrase search", () => {
  it("wants the words in the order they were typed", () => {
    const text = ["Threatened by limestone quarrying at the cave mouth."];
    expect(phraseMatches(text, "limestone quarrying")).toBe(true);
    expect(phraseMatches(text, "quarrying limestone")).toBe(false);
  });

  it("holds dropped stop words to their place", () => {
    // "in" is never indexed, but it still took up a word of the sentence — so
    // the query has to spend it too. This is what stops "mining caves" from
    // matching text that only ever says "mining in caves".
    const text = ["Disturbance from guano mining in caves."];
    expect(phraseMatches(text, "guano mining in caves")).toBe(true);
    expect(phraseMatches(text, "mining in caves")).toBe(true);
    expect(phraseMatches(text, "mining caves")).toBe(false);
  });

  it("does not run a phrase across two narrative fields", () => {
    // The rationale ends with one word and the range begins with the next.
    // Read as one stream they are adjacent; read as an assessment they are not
    // a phrase anybody wrote.
    expect(phraseMatches(["Found in limestone", "Quarrying is widespread"], "limestone quarrying"))
      .toBe(false);
    expect(phraseMatches(["Found in limestone quarrying areas", ""], "limestone quarrying"))
      .toBe(true);
  });

  it("handles a word that repeats inside the phrase", () => {
    expect(phraseMatches(["It moves from cave to cave in one season."], "cave to cave")).toBe(true);
    expect(phraseMatches(["A single cave, and a roost."], "cave to cave")).toBe(false);
  });

  it("keeps a phrase inside one sentence", () => {
    // What the corpus actually served up: the only assessment matching "guano
    // mining in caves" matched it across a full stop, because the hole left by
    // the dropped "in" will take any word at all — "If", here.
    expect(phraseMatches(["Threats include guano mining. If caves are left undisturbed…"],
      "guano mining in caves")).toBe(false);
    expect(phraseMatches(["Disturbance from guano mining of caves"],
      "guano mining in caves")).toBe(true);
  });

  it("counts a whole word, not a fragment of one", () => {
    expect(phraseMatches(["Karst limestones of the region"], "limestone")).toBe(false);
  });
});

/**
 * A matched assessment has to be quotable.
 *
 * The index says the words are together; the snippet is found by pattern in
 * the prose. If those two rules ever disagree, a search returns rows with no
 * quote under them — so every phrase the index would match must also be a
 * phrase the pattern can find.
 */
describe("the snippet pattern agrees with the index", () => {
  const cases: [string, string][] = [
    ["Threatened by limestone quarrying at the cave mouth.", "limestone quarrying"],
    ["Disturbance from guano mining in caves.", "mining in caves"],
    ["Limestone, quarrying and fire are the main threats.", "limestone quarrying"],
    ["It moves from cave to cave in one season.", "cave to cave"],
    ["Widespread slash-and-burn agriculture.", "slash-and-burn agriculture"],
  ];

  it("finds, in the text, every phrase the positions would match", () => {
    for (const [text, query] of cases) {
      expect(phraseMatches([text], query), `index missed "${query}"`).toBe(true);
      expect(phrasePattern(queryTokens(query)).test(text), `pattern missed "${query}"`).toBe(true);
    }
  });

  it("does not find a phrase the positions would reject", () => {
    expect(phrasePattern(queryTokens("mining caves")).test("guano mining in caves")).toBe(false);
    expect(phrasePattern(queryTokens("limestone")).test("Karst limestones")).toBe(false);
    expect(
      phrasePattern(queryTokens("guano mining in caves")).test("guano mining. If caves are left")
    ).toBe(false);
  });
});

describe("plainText", () => {
  it("strips tags and decodes what assessors paste in", () => {
    expect(plainText("<p>Affected by&#160;quarrying &amp; fire</p>")).toBe(
      "Affected by quarrying & fire"
    );
    expect(plainText("caves&#x2019; entrances")).toBe("caves’ entrances");
  });

  it("leaves nothing that would show up in a snippet", () => {
    expect(plainText("<i>Karst</i>&nbsp;limestone<br/>outcrops")).toBe("Karst limestone outcrops");
  });
});
