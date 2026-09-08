import { describe, it, expect } from "vitest";
import { linkCitations, findReference, type AssessmentReference } from "../nearby-citations";

/** Real entries, in the shape and spelling the IUCN API returns them. */
const REFS: AssessmentReference[] = [
  {
    citation: "Ferguson-Lees, J. and Christie, D.A. 2001. <i>Raptors of the world</i>. Christopher Helm, London.",
    year: "2001",
    author: "Ferguson-Lees, J. and Christie, D.A.",
  },
  { citation: "Global Forest Watch. 2023. Global Forest Watch.", year: "2023", author: "Global Forest Watch" },
  { citation: "Márquez, C. and Delgado, J. 2010. …", year: "2010", author: "Márquez, C. and Delgado, J." },
  { citation: "Rivas-Fuenzalida, T. et al. 2022. …", year: "2022", author: "Rivas-Fuenzalida, T." },
  { citation: "Renjifo, L.M. 2014. …", year: "2014", author: "Renjifo, L.M." },
];

const linked = (t: string) => linkCitations(t, REFS).filter((s) => s.reference);

describe("finding the reference a citation names", () => {
  it("matches two authors written as 'X and Y'", () => {
    expect(findReference("Ferguson-Lees and Christie ", "2001", REFS)?.year).toBe("2001");
  });

  it("matches a corporate author with no comma in it", () => {
    expect(findReference("Global Forest Watch ", "2023", REFS)?.author).toBe("Global Forest Watch");
  });

  it("matches through 'et al.'", () => {
    expect(findReference("Rivas-Fuenzalida et al. ", "2022", REFS)?.author).toBe("Rivas-Fuenzalida, T.");
  });

  // "C. Márquez in litt. 2014" — the bibliography is ordered by surname, so the
  // leading initial is not part of what identifies the reference.
  it("ignores a leading initial and an 'in litt.'", () => {
    expect(findReference("C. Márquez in litt. ", "2010", REFS)?.author).toBe("Márquez, C. and Delgado, J.");
  });

  // The year is what makes a citation a citation; a name alone must not match.
  it("refuses a name whose year disagrees", () => {
    expect(findReference("Ferguson-Lees and Christie ", "1999", REFS)).toBeUndefined();
  });

  it("refuses a name that is in no reference", () => {
    expect(findReference("Darwin ", "2001", REFS)).toBeUndefined();
  });

  it("matches a year carrying a disambiguating letter", () => {
    expect(findReference("Renjifo ", "2014a", REFS)?.author).toBe("Renjifo, L.M.");
  });
});

describe("splitting a narrative", () => {
  const text =
    "Forest has been lost to agriculture (Ferguson-Lees and Christie 2001, Global Forest Watch 2023). " +
    "Persecution is recorded (Márquez and Delgado 2010).";

  it("marks every citation it can resolve", () => {
    expect(linked(text).map((s) => s.text.trim())).toEqual([
      "Ferguson-Lees and Christie 2001",
      "Global Forest Watch 2023",
      "Márquez and Delgado 2010",
    ]);
  });

  // The prose has to survive intact: a reader loses nothing by the linking.
  it("puts the text back together exactly as it came in", () => {
    expect(linkCitations(text, REFS).map((s) => s.text).join("")).toBe(text);
  });

  // A citation pointing at nothing is worse than one that isn't clickable.
  it("leaves an unresolvable citation as plain prose", () => {
    const out = linkCitations("Something happened (Darwin 1859).", REFS);
    expect(out.some((s) => s.reference)).toBe(false);
    expect(out.map((s) => s.text).join("")).toBe("Something happened (Darwin 1859).");
  });

  it("returns the text whole when the assessment has no bibliography", () => {
    expect(linkCitations("No refs here (Darwin 1859).", [])).toEqual([{ text: "No refs here (Darwin 1859)." }]);
  });

  it("has nothing to say about empty text", () => {
    expect(linkCitations("", REFS)).toEqual([]);
  });
});
