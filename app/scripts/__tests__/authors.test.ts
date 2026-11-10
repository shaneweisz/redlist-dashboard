/**
 * Author citations compared (scripts/sync/link/authors.ts): IUCN and CoL format
 * one citation many ways, so equality is too strict, but a different author or
 * year must still refuse, and only clear evidence says "other authors".
 */
import { describe, it, expect } from "vitest";
import { compareAuthors } from "../sync/link/authors";

describe("compareAuthors", () => {
  it.each([
    ["Hook.f.", "Hook.fil."],
    ["Pitard", "Pit."],
    ["A.Shaw", "Airy Shaw"],
    ["Silhavy, 1937", "Šilhavý, 1937"],
    ["Klokov & Des.-Shost.", "Klokov & Desj.-Shost."],
    ["(Wu, 1934)", "(HW Wu, 1934)"],
    ["(Stertz, 1902)", "(Stertz, 1902)"],
    ["Fabricius, 1775", "(Fabr., 1775)"],
    ["Düben", "Dueben"],
    ["Lægaard", "Laegaard"],
  ])("same: %s / %s", (a, b) => expect(compareAuthors(a, b)).toBe("same"));

  it.each([
    // Tritoma bipustulata: the beetle CoL dropped, and the synonym it left.
    ["Fabricius, 1775", "Schilsky, 1888"],
    ["Macfarlane", "Hemsl."],
    ["Hillebr.", "A.Gray"],
    ["(Lesson, 1831)", "(Vieillot, 1817)"],
    // Real homonyms the queue caught on COL26.6 XR.
    ["Boisduval, 1833", "Herrich-Schäffer, 1844"],
    ["(Draparnaud, 1801)", "(O. F. Müller, 1774)"],
  ])("other: %s / %s", (a, b) => expect(compareAuthors(a, b)).toBe("other"));

  it.each([
    // One author, a different year: not the same citation, not clearly another author.
    ["(Férussac, 1921)", "(A. Férussac, 1821)"],
    ["(Forster, 1781)", "(Forster, 1780)"],
    // A misspelling with the same year.
    ["Klutter, 1950", "Kutter, 1950"],
    ["Milen-Edwards & Haime, 1948", "(Milne Edwards & Haime, 1848)"],
    // Nothing beyond an initial.
    ["L.", "L."],
    ["L.", "Jacq."],
    // An abbreviation as short as two letters.
    ["Bl.", "Blume"],
    // Spelt differently: a swap, a typo (both one author).
    ["Kujit", "Kuijt"],
    ["Tamaka & Limada", "Yu.Tanaka & Shimada"],
  ])("unclear: %s / %s", (a, b) => expect(compareAuthors(a, b)).toBe("unclear"));

  it("is unclear when either side has no authorship", () => {
    expect(compareAuthors(null, "L.")).toBe("unclear");
    expect(compareAuthors("Fabricius", undefined)).toBe("unclear");
    expect(compareAuthors("", "Fabricius")).toBe("unclear");
  });

  it("is symmetric", () => {
    for (const [a, b] of [["Fabricius, 1775", "Schilsky, 1888"], ["Pitard", "Pit."], ["(Forster, 1781)", "(Forster, 1780)"]]) {
      expect(compareAuthors(a, b)).toBe(compareAuthors(b, a));
    }
  });
});
