/**
 * Validates taxa-summary.json against IUCN Table 1a (2026-1).
 *
 * Requires data files from sync.ts to be present.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = process.env.PIPELINE_DATA_DIR ?? path.join(__dirname, "../../data");

// Assessed-species counts per taxon group, from the official 2026-1 Table 1a
// (https://nc.iucnredlist.org/redlist/content/attachment_files/2026-1_RL_Table1a.pdf,
// "last updated 09 July 2026") cross-checked against our own synced totals.
// Originally every group matched exactly except crustaceans, off by 2 — not
// live-database drift as first assumed (both missing species are 1996 DD
// assessments, not recent ones), but a real bug: IUCN's SIS DB had already
// split 2 barnacle species out of the legacy "MAXILLOPODA" class into its
// own "THEOCOSTRACA" class (their misspelling of Thecostraca), which
// taxa.ts's crustaceans filterValues didn't list. Fixed in taxa.ts; see its
// crustaceans comment. The IUCN Table 1a "Insects" row (14,531) is split
// across the 8 order-based groups; they sum back to 14,531.
const TABLE_1A_2026_1: Record<string, number> = {
  mammals: 6054,
  birds: 11185,
  reptiles: 10371,
  amphibians: 8095,
  fishes: 29371,
  // Insects (Table 1a row = 14,531), split by order:
  beetles: 2639,
  butterflies_and_moths: 2396,
  flies_and_mosquitoes: 431,
  bees_wasps_and_ants: 934,
  true_bugs: 93,
  grasshoppers_crickets_locusts: 1501,
  dragonflies_and_damselflies: 6229,
  other_insects: 308,
  molluscs: 9957,
  crustaceans: 3410,
  corals: 916,
  arachnids: 1057,
  velvet_worms: 11,
  horseshoe_crabs: 4,
  other_invertebrates: 1153,
  mosses: 327,
  ferns_and_allies: 839,
  gymnosperms: 1061,
  flowering_plants: 76102,
  green_algae: 18,
  red_algae: 78,
  mushrooms: 1351,
  brown_algae: 18,
};

const TOTAL_EXPECTED = 175909;

// Checks a sync's output, so it needs the data: npm test with app/data fetched,
// or the sync's own checks (PIPELINE_DATA_DIR = its build). CI skips it.
const summaryPath = path.join(DATA_DIR, "taxa-summary.json");

describe.skipIf(!fs.existsSync(summaryPath))("taxa_summary vs Table 1a (2026-1)", () => {
  it("total_assessed per table1a_taxon_group matches Table 1a expected values", () => {

    const data = JSON.parse(fs.readFileSync(summaryPath, "utf-8")) as Array<{
      table1a_taxon_group: string;
      total_assessed: number;
    }>;

    expect(data.length).toBeGreaterThan(0);

    const actual = new Map<string, number>();
    for (const row of data) {
      actual.set(row.table1a_taxon_group, row.total_assessed);
    }

    let totalActual = 0;
    for (const [taxon, expected] of Object.entries(TABLE_1A_2026_1)) {
      const assessed = actual.get(taxon);
      expect(assessed, `${taxon}: expected ${expected}, got ${assessed}`).toBe(expected);
      totalActual += assessed ?? 0;
    }

    expect(totalActual).toBe(TOTAL_EXPECTED);
  });
});
