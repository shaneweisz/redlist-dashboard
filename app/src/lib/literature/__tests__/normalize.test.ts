import { describe, it, expect } from "vitest";
import {
  cleanAbstract,
  cleanText,
  formatAuthors,
  mapWorkType,
  mentionsAnyVariant,
  normalizeDoi,
  normalizeTitle,
  parseDate,
  toSortStamp,
} from "../normalize";

describe("normalizeDoi", () => {
  it("strips resolver prefixes and lowercases", () => {
    expect(normalizeDoi("https://doi.org/10.1038/S41586-020-2649-2")).toBe("10.1038/s41586-020-2649-2");
    expect(normalizeDoi("http://dx.doi.org/10.1234/AbC")).toBe("10.1234/abc");
    expect(normalizeDoi("doi: 10.1234/abc")).toBe("10.1234/abc");
  });

  it("drops trailing sentence punctuation", () => {
    expect(normalizeDoi("10.1234/abc.")).toBe("10.1234/abc");
    expect(normalizeDoi("10.1234/abc);")).toBe("10.1234/abc");
  });

  it("rejects anything that isn't a DOI", () => {
    expect(normalizeDoi(null)).toBeNull();
    expect(normalizeDoi("")).toBeNull();
    expect(normalizeDoi("n/a")).toBeNull();
    expect(normalizeDoi("https://europepmc.org/article/MED/1234")).toBeNull();
    expect(normalizeDoi("10.123/tooshortprefix")).toBeNull();
  });
});

describe("normalizeTitle", () => {
  it("ignores case, punctuation and whitespace differences", () => {
    expect(normalizeTitle("Ecology of Panthera leo.")).toBe(
      normalizeTitle("ECOLOGY  OF   Panthera   leo"),
    );
  });

  it("strips diacritics and inline markup", () => {
    expect(normalizeTitle("Étude de <i>Aloe</i> spp.")).toBe("etude de aloe spp");
    expect(normalizeTitle("Conservation &amp; trade")).toBe("conservation trade");
  });

  it("returns an empty string for nothing usable", () => {
    expect(normalizeTitle(null)).toBe("");
    expect(normalizeTitle("   ")).toBe("");
    expect(normalizeTitle("!!!")).toBe("");
  });
});

describe("parseDate", () => {
  it("reads full ISO dates, with or without a time part", () => {
    expect(parseDate("2023-03-14")).toEqual({ date: "2023-03-14", precision: "day", year: 2023 });
    expect(parseDate("2023-03-14T00:00:00Z")).toEqual({
      date: "2023-03-14",
      precision: "day",
      year: 2023,
    });
  });

  it("keeps month and year precision rather than inventing a day", () => {
    expect(parseDate("2023-03")).toEqual({ date: "2023-03", precision: "month", year: 2023 });
    expect(parseDate("1911")).toEqual({ date: "1911", precision: "year", year: 1911 });
    expect(parseDate(1996)).toEqual({ date: "1996", precision: "year", year: 1996 });
  });

  it("reads the prose dates Google Books and BHL emit", () => {
    expect(parseDate("March 2023")).toEqual({ date: "2023-03", precision: "month", year: 2023 });
    expect(parseDate("14 Mar 2023")).toEqual({ date: "2023-03-14", precision: "day", year: 2023 });
    // A BHL date range degrades to its first year.
    expect(parseDate("1911-1913")).toEqual({ date: "1911", precision: "year", year: 1911 });
  });

  it("degrades an out-of-range month to year precision", () => {
    expect(parseDate("2023-13")).toEqual({ date: "2023", precision: "year", year: 2023 });
  });

  it("rejects unusable and implausible values", () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate("no date")).toBeNull();
    expect(parseDate("0001-01-01")).toBeNull();
    expect(parseDate(3500)).toBeNull();
  });
});

describe("toSortStamp", () => {
  it("places imprecise dates mid-interval so they interleave", () => {
    expect(toSortStamp("2023-03-14", "day")).toBe("2023-03-14");
    expect(toSortStamp("2023-03", "month")).toBe("2023-03-15");
    expect(toSortStamp("1996", "year")).toBe("1996-07-01");
  });

  it("returns null when there is no date", () => {
    expect(toSortStamp(null, null)).toBeNull();
    expect(toSortStamp("2020", null)).toBeNull();
  });

  it("orders correctly as plain strings", () => {
    const stamps = [
      toSortStamp("1996", "year"),
      toSortStamp("1996-01-04", "day"),
      toSortStamp("1996-12", "month"),
    ] as string[];
    expect([...stamps].sort()).toEqual(["1996-01-04", "1996-07-01", "1996-12-15"]);
  });
});

describe("cleanAbstract", () => {
  it("removes markup and collapses whitespace", () => {
    expect(cleanAbstract("<p>Hello   <b>world</b></p>")).toBe("Hello world");
  });

  it("truncates with an ellipsis", () => {
    const long = "a ".repeat(1000);
    const result = cleanAbstract(long, 20)!;
    expect(result.length).toBeLessThanOrEqual(21);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns null when nothing survives", () => {
    expect(cleanAbstract("<p>  </p>")).toBeNull();
    expect(cleanAbstract(null)).toBeNull();
  });
});

describe("cleanText", () => {
  it("collapses whitespace and nulls out empties", () => {
    expect(cleanText("  Journal  of   Conchology ")).toBe("Journal of Conchology");
    expect(cleanText("   ")).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });
});

describe("formatAuthors", () => {
  it("joins up to the cap and counts the rest", () => {
    expect(formatAuthors(["A One", "B Two"])).toBe("A One, B Two");
    expect(formatAuthors(["A", "B", "C", "D", "E"])).toBe("A, B, C +2");
  });

  it("skips blanks and returns null when there are no names", () => {
    expect(formatAuthors([null, "  ", undefined])).toBeNull();
    expect(formatAuthors([])).toBeNull();
  });
});

describe("mapWorkType", () => {
  it("maps each source's vocabulary onto the shared one", () => {
    expect(mapWorkType("journal-article")).toBe("article");
    expect(mapWorkType("Journal Article")).toBe("article");
    expect(mapWorkType("posted-content")).toBe("preprint");
    expect(mapWorkType("book-chapter")).toBe("chapter");
    expect(mapWorkType("monograph")).toBe("book");
    expect(mapWorkType("doctoral thesis")).toBe("report");
  });

  it("prefers the more specific reading of overlapping words", () => {
    // "book-chapter" contains "book"; the chapter reading must win.
    expect(mapWorkType("book-chapter")).toBe("chapter");
  });

  it("falls back to other rather than guessing", () => {
    expect(mapWorkType(null)).toBe("other");
    expect(mapWorkType("peer-review")).toBe("other");
  });
});

describe("mentionsAnyVariant", () => {
  const variants = ["Stenocephalemys albocaudata", "Stenocephalemys albocaudatus"];

  it("matches a whole-phrase mention in any of the supplied texts", () => {
    expect(mentionsAnyVariant(variants, "Diet of Stenocephalemys albocaudata in Bale")).toBe(true);
    expect(mentionsAnyVariant(variants, null, "…the type series of Stenocephalemys albocaudatus.")).toBe(
      true,
    );
  });

  it("matches at either end of the text", () => {
    expect(mentionsAnyVariant(variants, "Stenocephalemys albocaudata")).toBe(true);
    expect(mentionsAnyVariant(variants, "A revision of Stenocephalemys albocaudata")).toBe(true);
    expect(mentionsAnyVariant(variants, "Stenocephalemys albocaudata revisited")).toBe(true);
  });

  it("rejects a congener or a partial-word collision", () => {
    expect(mentionsAnyVariant(variants, "Diet of Stenocephalemys griseicauda")).toBe(false);
    expect(mentionsAnyVariant(variants, "Notes on albocaudata")).toBe(false);
  });

  it("is false when there is nothing to search", () => {
    expect(mentionsAnyVariant(variants, null, undefined)).toBe(false);
    expect(mentionsAnyVariant([], "anything at all")).toBe(false);
  });
});
