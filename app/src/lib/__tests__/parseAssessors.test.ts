import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseAssessors, parseInstitutions, COMMA_BEARING_INSTITUTIONS } from "../parseAssessors";

describe("parseAssessors", () => {
  it("returns empty array for null/undefined/empty", () => {
    expect(parseAssessors(null)).toEqual([]);
    expect(parseAssessors(undefined)).toEqual([]);
    expect(parseAssessors("")).toEqual([]);
    expect(parseAssessors("  ")).toEqual([]);
  });

  it("parses a single name", () => {
    expect(parseAssessors("Bernal, N.")).toEqual(["Bernal, N."]);
  });

  it("parses names separated by &", () => {
    expect(parseAssessors("Tsang, S.M. & Sheherazade")).toEqual([
      "Tsang, S.M.",
      "Sheherazade",
    ]);
  });

  it("parses names separated by commas and &", () => {
    expect(
      parseAssessors("Dunnum, J., Vargas, J. & Bernal, N.")
    ).toEqual(["Dunnum, J.", "Vargas, J.", "Bernal, N."]);
  });

  it("parses multiple names separated only by commas", () => {
    expect(
      parseAssessors("Hutson, A.M., Kingston, T., Helgen, K. & Sinaga, U.")
    ).toEqual(["Hutson, A.M.", "Kingston, T.", "Helgen, K.", "Sinaga, U."]);
  });

  it("handles names without initials (group names)", () => {
    expect(parseAssessors("Chiroptera Specialist Group")).toEqual([
      "Chiroptera Specialist Group",
    ]);
  });

  it("handles mixed group names and individual names with &", () => {
    expect(
      parseAssessors("Sheherazade, Tsang, S.M. & Matorang, Z.")
    ).toEqual(["Sheherazade", "Tsang, S.M.", "Matorang, Z."]);
  });

  it("handles parenthetical affiliations in reviewer strings", () => {
    expect(
      parseAssessors(
        "Amori, G. (Small Nonvolant Mammal Red List Authority) & Schipper, J. (Global Mammal Assessment Team)"
      )
    ).toEqual([
      "Amori, G. (Small Nonvolant Mammal Red List Authority)",
      "Schipper, J. (Global Mammal Assessment Team)",
    ]);
  });

  it("handles complex reviewer string with parens and commas", () => {
    expect(
      parseAssessors(
        "Hutson, A.M., Racey, P.A. (Chiroptera Red List Authority), Chanson, J. & Chiozza, F. (Global Mammal Assessment Team)"
      )
    ).toEqual([
      "Hutson, A.M.",
      "Racey, P.A. (Chiroptera Red List Authority)",
      "Chanson, J.",
      "Chiozza, F. (Global Mammal Assessment Team)",
    ]);
  });

  it("handles long list of names", () => {
    const result = parseAssessors(
      "Mildenstein, T., Cariño,A., Paul, S., Heaney, L., Alviola, P., Duya, A., Stier, S., Pedregosa, S., Lorica, R., Ingle, N., Balete, D., Garcia, J.J., Gonzalez, J.C., Ong, P., Rosell-Ambal, G. & Tabaranza, B."
    );
    expect(result).toContain("Mildenstein, T.");
    expect(result).toContain("Cariño,A."); // no space after comma in source data
    expect(result).toContain("Paul, S.");
    expect(result).toContain("Tabaranza, B.");
    expect(result.length).toBe(16);
  });

  it("handles IUCN SSC group name as assessor", () => {
    expect(
      parseAssessors("IUCN SSC Amphibian Specialist Group")
    ).toEqual(["IUCN SSC Amphibian Specialist Group"]);
  });

  it("normalizes 'Cox, N.' to 'Cox, N.A.' (same person)", () => {
    expect(parseAssessors("Cox, N.")).toEqual(["Cox, N.A."]);
    // Already canonical form is unchanged
    expect(parseAssessors("Cox, N.A.")).toEqual(["Cox, N.A."]);
    // Works within a list of names
    expect(
      parseAssessors("Bowles, P., Cox, N. & Stuart, S.N.")
    ).toEqual(["Bowles, P.", "Cox, N.A.", "Stuart, S.N."]);
  });

  it("handles name with complex initials and paren after comma-separated list", () => {
    expect(
      parseAssessors(
        "Hutson, A.M., Racey, P.A. (Chiroptera Red List Authority) & Stuart, S.N. (Global Mammal Assessment Team)"
      )
    ).toEqual([
      "Hutson, A.M.",
      "Racey, P.A. (Chiroptera Red List Authority)",
      "Stuart, S.N. (Global Mammal Assessment Team)",
    ]);
  });
});

describe("parseInstitutions", () => {
  it("returns [] for empty input", () => {
    expect(parseInstitutions(null)).toEqual([]);
    expect(parseInstitutions(undefined)).toEqual([]);
    expect(parseInstitutions("  ")).toEqual([]);
  });

  it("keeps a comma that belongs to the organisation's own name", () => {
    // parseAssessors would split this into "Royal Botanic Gardens" + "Kew",
    // inventing an institution that does not exist. This is the whole reason
    // institutions get their own parser.
    expect(parseInstitutions("Royal Botanic Gardens, Kew")).toEqual(["Royal Botanic Gardens, Kew"]);
    expect(parseAssessors("Royal Botanic Gardens, Kew")).toHaveLength(2);
  });

  it("splits on the ampersand", () => {
    expect(parseInstitutions("Centro Nacional de Conservação da Flora (CNCFlora) & Botanic Gardens Conservation International"))
      .toEqual(["Centro Nacional de Conservação da Flora (CNCFlora)", "Botanic Gardens Conservation International"]);
  });

  // The line is an ordinary English list, so a comma separates too. Missing this
  // left every line of 3+ institutions as one pseudo-institution — and since the
  // CNCFlora + Brazil RLA pair ALSO appears " & "-joined on its own, the same two
  // organisations were counted both as a pair and separately.
  it("splits a comma-joined list, ampersand before the last item", () => {
    expect(parseInstitutions("Centro Nacional de Conservação da Flora (CNCFlora), IUCN SSC Brazil Plant Red List Authority & Botanic Gardens Conservation International"))
      .toEqual([
        "Centro Nacional de Conservação da Flora (CNCFlora)",
        "IUCN SSC Brazil Plant Red List Authority",
        "Botanic Gardens Conservation International",
      ]);
  });

  it("splits a list whose first item carries its own comma", () => {
    expect(parseInstitutions("Royal Botanic Gardens, Kew, Botanic Gardens Conservation International"))
      .toEqual(["Royal Botanic Gardens, Kew", "Botanic Gardens Conservation International"]);
  });

  // A real credit line: one university, whose parenthetical department name
  // contains both a comma and an ampersand.
  it("ignores separators inside brackets", () => {
    const uni = "Addis Ababa University (National Herbarium of Ethiopia, Department of Plant Biology & Biodiversity Management)";
    expect(parseInstitutions(uni)).toEqual([uni]);
    expect(parseInstitutions(`Royal Botanic Gardens, Kew, ${uni}, Ethiopian Biodiversity Institute & Gullele Botanic Garden`))
      .toEqual([
        "Royal Botanic Gardens, Kew",
        uni,
        "Ethiopian Biodiversity Institute",
        "Gullele Botanic Garden",
      ]);
  });

  // The protected list is derived from the corpus, so it has to stay true to it:
  // a name belongs there if it appears as a COMPLETE institution (a whole credit
  // line, or the piece after the final " & ") while containing ", ". If a sync
  // introduces a seventh such name, splitting it would invent institutions —
  // this fails rather than letting that ship silently.
  const ASSESSED = path.join(process.cwd(), "data", "sync", "lists", "assessed.parquet");
  const dataIt = fs.existsSync(ASSESSED) ? it : it.skip;
  dataIt("COMMA_BEARING_INSTITUTIONS still matches what the data contains", async () => {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    const rows = (await conn.runAndReadAll(
      `SELECT DISTINCT latest_institutions AS s FROM '${ASSESSED}' WHERE latest_institutions IS NOT NULL`,
    )).getRowObjects();

    const complete = new Set<string>();
    for (const r of rows) {
      const parts = String(r.s).split(" & ");
      complete.add(parts[parts.length - 1].trim());
      if (parts.length === 1) complete.add(String(r.s).trim());
    }
    const derived = [...complete].filter((x) => x.includes(", ")).sort();
    expect(derived).toEqual([...COMMA_BEARING_INSTITUTIONS].sort());
  }, 60_000);

  // Whatever the line, no parsed institution may still hold a top-level
  // separator — that would mean two organisations counted as one.
  dataIt("leaves no unsplit separator in any real credit line", async () => {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    const rows = (await conn.runAndReadAll(
      `SELECT DISTINCT latest_institutions AS s FROM '${ASSESSED}' WHERE latest_institutions IS NOT NULL`,
    )).getRowObjects();

    const leftovers = new Set<string>();
    for (const r of rows) {
      for (const inst of parseInstitutions(String(r.s))) {
        const bracketless = inst.replace(/\([^)]*\)/g, "");
        if (/,\s|\s&\s/.test(bracketless) && !COMMA_BEARING_INSTITUTIONS.includes(inst)) {
          leftovers.add(inst);
        }
      }
    }
    expect([...leftovers]).toEqual([]);
  }, 60_000);
});
