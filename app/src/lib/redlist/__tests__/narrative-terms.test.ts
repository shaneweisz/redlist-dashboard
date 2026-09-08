import { describe, it, expect } from "vitest";
import { plainText } from "../../../../scripts/build-narratives";
import { indexTerms, queryTerms } from "../narrative-terms";

/**
 * The corpus and the query must be tokenised the same way.
 *
 * They are two functions in two files — one runs at build time in a script,
 * one at request time in the app — and if they ever disagree the search simply
 * returns nothing, with no error to notice. These pin them together.
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
      const indexed = indexTerms(phrase);
      for (const word of queryTerms(phrase)) {
        expect(indexed.has(word), `"${word}" from "${phrase}" is not indexed`).toBe(true);
      }
    }
  });

  it("keeps hyphenated compounds whole", () => {
    expect([...indexTerms("slash-and-burn agriculture")]).toContain("slash-and-burn");
    expect(queryTerms("slash-and-burn")).toEqual(["slash-and-burn"]);
  });

  it("drops the words that would match everything", () => {
    expect([...indexTerms("the forest and the river")].sort()).toEqual(["forest", "river"]);
  });

  it("keeps numbers, which assessors use as names", () => {
    expect([...indexTerms("1080 poison")]).toContain("1080");
  });

  it("takes at most six words from a query", () => {
    expect(queryTerms("one two three four five six seven eight")).toHaveLength(6);
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
