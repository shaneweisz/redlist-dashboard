/**
 * Author agreement for the orthographic pass (scripts/sync/core/build-link.ts):
 * IUCN and CoL format one author citation many ways, so equality is too strict,
 * but a different author or year must still refuse.
 */
import { describe, it, expect } from "vitest";
import { sameAuthors } from "../sync/core/build-link";

describe("sameAuthors", () => {
  it.each([
    ["Hook.f.", "Hook.fil."],
    ["Pitard", "Pit."],
    ["A.Shaw", "Airy Shaw"],
    ["Silhavy, 1937", "Šilhavý, 1937"],
    ["Klokov & Des.-Shost.", "Klokov & Desj.-Shost."],
    ["(Wu, 1934)", "(HW Wu, 1934)"],
    ["(Stertz, 1902)", "(Stertz, 1902)"],
  ])("accepts %s / %s", (a, b) => expect(sameAuthors(a, b)).toBe(true));

  it.each([
    ["(Férussac, 1921)", "(A. Férussac, 1821)"],
    ["Klutter, 1950", "Kutter, 1950"],
    ["Macfarlane", "Hemsl."],
    ["Hillebr.", "A.Gray"],
  ])("refuses %s / %s", (a, b) => expect(sameAuthors(a, b)).toBe(false));

  it("refuses when either side has no authorship", () => {
    expect(sameAuthors(null, "L.")).toBe(false);
    expect(sameAuthors("L.", undefined)).toBe(false);
  });
});
