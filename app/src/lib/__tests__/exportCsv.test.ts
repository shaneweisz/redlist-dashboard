import { describe, expect, it } from "vitest";
import { rowsToCsv } from "../exportCsv";

describe("rowsToCsv", () => {
  it("joins rows and escapes fields with commas, quotes or newlines", () => {
    expect(
      rowsToCsv(
        ["Country", "# Assessed"],
        [
          ["Bonaire, Sint Eustatius and Saba", 1234],
          ['Côte d"Ivoire', 5],
          ["Plain", 0],
        ]
      )
    ).toBe('Country,# Assessed\n"Bonaire, Sint Eustatius and Saba",1234\n"Côte d""Ivoire",5\nPlain,0');
  });
});
