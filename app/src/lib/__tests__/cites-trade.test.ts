import { describe, expect, it } from "vitest";
import { aggregate, commodities, normalizeUnit, type CompactRecord } from "../cites-trade";

const row = (o: Partial<CompactRecord>): CompactRecord => ({ y: 2020, s: "W", p: "H", t: "trophies", u: "", e: "ZA", i: "US", o: "", ...o });

describe("cites-trade", () => {
  // One trade both countries reported, plus one the two described differently,
  // which the comparative tabulation splits into an exporter-only and an
  // importer-only row (guide, FAQ "Why do importer- and exporter-reported data
  // not always match?").
  const rows = [
    row({ qe: 10, qi: 8 }),
    row({ qe: 5, p: "H" }),
    row({ qi: 5, p: "P" }),
  ];

  it("reads one reporter's figures and never fills in from the other", () => {
    expect(aggregate(rows, "exporter").quantity).toBe(15);
    expect(aggregate(rows, "importer").quantity).toBe(13);
    // "Exporter's figure, else the importer's" would give 20: that trade twice.
  });

  it("sums by year, country, flow, purpose and re-export origin", () => {
    const agg = aggregate([
      row({ y: 2019, qe: 2, e: "ZA", i: "US" }),
      row({ y: 2020, qe: 3, e: "ZA", i: "DE", o: "NA" }),
      row({ y: 2020, qe: 4, e: "ZW", i: "US", p: "T" }),
    ], "exporter");
    expect(agg.byYear).toEqual([{ year: 2019, quantity: 2 }, { year: 2020, quantity: 7 }]);
    expect(agg.exporters).toEqual([{ code: "ZA", quantity: 5 }, { code: "ZW", quantity: 4 }]);
    expect(agg.importers).toEqual([{ code: "US", quantity: 6 }, { code: "DE", quantity: 3 }]);
    expect(agg.flows[0]).toEqual({ from: "ZW", to: "US", quantity: 4 });
    expect(agg.byPurpose).toEqual([{ code: "H", quantity: 5 }, { code: "T", quantity: 4 }]);
    expect(agg.reExports).toEqual([{ from: "NA", to: "ZA", quantity: 3 }]);
  });

  it("lists commodities per term and unit, only those the reporter reported", () => {
    const list = commodities([
      row({ t: "tusks", u: "kg", qe: 100 }),
      row({ t: "tusks", u: "", qe: 4 }),
      row({ t: "tusks", u: "", qe: 2 }),
      row({ t: "skins", u: "", qi: 9 }),
    ], "exporter");
    expect(list.map((c) => [c.key, c.quantity])).toEqual([["tusks|", 6], ["tusks|kg", 100]]);
  });

  it("reads a blank unit and 'Number of specimens' as the same unit", () => {
    expect(["", null, "Number of specimens", "NAR", "no."].map(normalizeUnit)).toEqual(["", "", "", "", ""]);
    expect(normalizeUnit("kg")).toBe("kg");
  });
});
