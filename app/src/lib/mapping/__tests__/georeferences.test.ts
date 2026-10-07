import { describe, it, expect } from "vitest";
import {
  validateGeoreference,
  parseCoordinatePair,
  uncertaintyCircle,
  duplicateOf,
  duplicateOfReason,
  withDuplicateLinks,
  resolvePrimary,
  parseAssessorDate,
  parseCoordinateEntry,
} from "../georeferences";

describe("validateGeoreference", () => {
  it("accepts a point with a radius", () => {
    expect(
      validateGeoreference({
        decimalLatitude: 1.1958,
        decimalLongitude: -76.9256,
        coordinateUncertaintyInMeters: 1500,
      }).ok
    ).toBe(true);
  });

  it("requires an uncertainty radius", () => {
    const result = validateGeoreference({
      decimalLatitude: 1.1958,
      decimalLongitude: -76.9256,
      coordinateUncertaintyInMeters: null,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/uncertainty/i);
  });

  it("rejects out-of-range coordinates", () => {
    const result = validateGeoreference({
      decimalLatitude: 91,
      decimalLongitude: -200,
      coordinateUncertaintyInMeters: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it("rejects null island, the error the cleaning checks exist to catch", () => {
    const result = validateGeoreference({
      decimalLatitude: 0,
      decimalLongitude: 0,
      coordinateUncertaintyInMeters: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/0, 0/);
  });
});

describe("parseCoordinatePair", () => {
  it.each([
    ["1.1958, -76.9256", 1.1958, -76.9256],
    ["1.1958,-76.9256", 1.1958, -76.9256],
    ["1.1958 -76.9256", 1.1958, -76.9256],
    ["-0.6667; -77.6667", -0.6667, -77.6667],
  ])("parses %s", (text, lat, lon) => {
    expect(parseCoordinatePair(text)).toEqual({ lat, lon });
  });

  it.each(["", "1.1958", "not a coordinate", "95, 10", "10, 200"])(
    "returns null for %s",
    (text) => {
      expect(parseCoordinatePair(text)).toBeNull();
    }
  );
});

describe("uncertaintyCircle", () => {
  it("closes the ring", () => {
    const ring = uncertaintyCircle(1.1958, -76.9256, 1500).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("is a circle on the ground, not in degrees — wider in longitude away from the equator", () => {
    const spanAt = (lat: number) => {
      const ring = uncertaintyCircle(lat, 0, 10_000).coordinates[0];
      const lons = ring.map(([lon]) => lon);
      return Math.max(...lons) - Math.min(...lons);
    };
    // At 60°N a degree of longitude is half a degree at the equator, so the same
    // ground radius has to span about twice the degrees.
    expect(spanAt(60) / spanAt(0)).toBeCloseTo(2, 1);
  });

  it("spans roughly twice the radius across", () => {
    const ring = uncertaintyCircle(0, 0, 111_320).coordinates[0];
    const lats = ring.map(([, lat]) => lat);
    expect(Math.max(...lats) - Math.min(...lats)).toBeCloseTo(2, 1);
  });
});

describe("duplicate exclusions", () => {
  const excluded = (justification: string, duplicateOf?: number) => ({
    gbifID: 1,
    justification,
    excludedAt: "2026-08-27T00:00:00.000Z",
    ...(duplicateOf != null ? { duplicateOf } : {}),
  });
  /** The link as read after loading, the only way exclusions arrive. */
  const linkOf = (justification: string, link?: number) =>
    duplicateOf(withDuplicateLinks({ 1: excluded(justification, link) })[1]);

  it("names the record kept in the reason", () => {
    expect(duplicateOfReason(2013787280)).toBe("Duplicate of GBIF 2013787280");
  });

  it("reads the link from the field, not the wording", () => {
    expect(duplicateOf(excluded("Same sheet as the one at K", 42))).toBe(42);
    // Typing the sentence by hand no longer makes a duplicate.
    expect(duplicateOf(excluded(duplicateOfReason(42)))).toBeNull();
    expect(duplicateOf(undefined)).toBeNull();
  });

  it("links what older builds saved only as wording", () => {
    expect(linkOf(duplicateOfReason(2013787280))).toBe(2013787280);
    expect(linkOf("Duplicate of GBIF record 12345")).toBe(12345);
  });

  it("lets a link already there win over the wording", () => {
    expect(linkOf(duplicateOfReason(1), 2)).toBe(2);
  });

  it("is not fooled by a reason that merely mentions duplication", () => {
    expect(linkOf("Looks like a duplicate of something")).toBeNull();
    expect(linkOf("Cultivated")).toBeNull();
    expect(linkOf("")).toBeNull();
  });

  it("leaves an exclusion with nothing to link untouched", () => {
    const plain = excluded("Cultivated");
    expect(withDuplicateLinks({ 1: plain })[1]).toBe(plain);
  });
});

describe("resolvePrimary", () => {
  const asDuplicate = (of: number) => ({ justification: duplicateOfReason(of), duplicateOf: of });

  it("gives back a record that isn't a duplicate of anything", () => {
    expect(resolvePrimary(1, {})).toBe(1);
    expect(resolvePrimary(1, { 1: { justification: "Cultivated" } })).toBe(1);
  });

  it("follows a chain to the record actually being kept", () => {
    const exclusions = { 1: asDuplicate(2), 2: asDuplicate(3) };
    expect(resolvePrimary(1, exclusions)).toBe(3);
    expect(resolvePrimary(2, exclusions)).toBe(3);
    expect(resolvePrimary(3, exclusions)).toBe(3);
  });

  it("stops on a cycle rather than spinning", () => {
    const exclusions = { 1: asDuplicate(2), 2: asDuplicate(1) };
    expect([1, 2]).toContain(resolvePrimary(1, exclusions));
  });
});

describe("parseAssessorDate", () => {
  it("takes a date as precise as the label is", () => {
    expect(parseAssessorDate("1987")).toEqual({ eventDate: "1987" });
    expect(parseAssessorDate("1987-3")).toEqual({ eventDate: "1987-03" });
    expect(parseAssessorDate(" 1987-12-09 ")).toEqual({ eventDate: "1987-12-09" });
  });

  it("refuses a date that isn't one", () => {
    expect(parseAssessorDate("")).toHaveProperty("error");
    expect(parseAssessorDate("December 1987")).toHaveProperty("error");
    expect(parseAssessorDate("1987-13")).toHaveProperty("error");
    expect(parseAssessorDate("1987-02-30")).toHaveProperty("error");
  });

  it("refuses a year no specimen can carry", () => {
    expect(parseAssessorDate("1600")).toHaveProperty("error");
    expect(parseAssessorDate(String(new Date().getFullYear() + 1))).toHaveProperty("error");
  });

  it("keeps the last day of a month that has one", () => {
    expect(parseAssessorDate("2024-02-29")).toEqual({ eventDate: "2024-02-29" });
    expect(parseAssessorDate("2023-02-29")).toHaveProperty("error");
  });
});

describe("parseCoordinateEntry", () => {
  it("reads the pair people paste", () => {
    expect(parseCoordinateEntry("1.1958, -76.9256")).toEqual({ lat: 1.1958, lon: -76.9256 });
  });

  it("reads a third number as the radius", () => {
    expect(parseCoordinateEntry("1.1958, -76.9256, 2000")).toEqual({
      lat: 1.1958,
      lon: -76.9256,
      uncertainty: 2000,
    });
  });

  it("takes a space or a semicolon between them, as a label might", () => {
    expect(parseCoordinateEntry("4.55 -75.5")).toEqual({ lat: 4.55, lon: -75.5 });
    expect(parseCoordinateEntry("4.55; -75.5")).toEqual({ lat: 4.55, lon: -75.5 });
  });

  it("refuses a position off the globe", () => {
    expect(parseCoordinateEntry("95, -75.5")).toBeNull();
    expect(parseCoordinateEntry("4.55, -200")).toBeNull();
  });

  it("refuses a radius of nothing", () => {
    expect(parseCoordinateEntry("4.55, -75.5, 0")).toBeNull();
  });

  it("says nothing rather than half a position while it's still being typed", () => {
    expect(parseCoordinateEntry("4.55,")).toBeNull();
    expect(parseCoordinateEntry("")).toBeNull();
    expect(parseCoordinateEntry("north of the river")).toBeNull();
  });
});
