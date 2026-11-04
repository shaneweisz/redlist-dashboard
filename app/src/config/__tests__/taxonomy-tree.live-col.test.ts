// Cross-checks every SSC Specialist Group filter against the LIVE Catalogue of Life
// backbone (data/species/**/*.parquet) — a larger, more current species universe than
// our own redlist/unassessed data, which is all taxonomy-tree.test.ts's zero-double-
// count checks verify against. CoL and IUCN don't always agree on family/genus
// boundaries (e.g. CoL splits ~34 genera IUCN still lumps under "Geotrupidae" into a
// separate family, "Bolboceratidae") — a filter fully verified against our own data
// can still silently miss or double-count species once evaluated against CoL's
// classification, which is what actually powers the "# Described Species (CoL)" counts
// and the Not Evaluated species list shown in the UI. Found and fixed two real bugs
// this way (a missing genus in what was then Sea Snake SG, a Dung Beetle SG double-count) that 3
// rounds of review checking only our own data never caught — see taxonomy-tree.ts's
// ssc-dung-beetle comment.
//
// Local-only: data/species/**/*.parquet is gitignored (only present after `npm run
// fetch-data-from-r2`) and CI never runs that sync, so this suite skips itself when
// the data isn't there rather than failing. Re-run locally after any CoL data refresh
// to catch newly-introduced drift between the two taxonomies.
import fs from "fs";
import path from "path";
import { describe, it, expect, beforeAll } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { NODE_INDEX, speciesMatchesNode } from "@/lib/taxonomy-utils";
import { COL_DOMESTIC_EXCLUDE_NAMES } from "../col-described-overrides";
import { DATA_DIR } from "../../../scripts/utils";

// Domestic/feral forms (Bos taurus, Felis catus, etc.) are deliberately unmatched by
// every node — speciesMatchesNode excludes them unconditionally (see
// COL_EXCLUDE_ALL_NODES's usage in matchesFilter) since each has a wild sibling
// species already counted separately. Expected, not a gap — excluded from this
// check rather than asserted on, so the real signal (a genuinely missed genus, a
// real double-count) doesn't get lost in 10 permanently-expected "failures".
const EXPECTED_UNMATCHED = new Set(COL_DOMESTIC_EXCLUDE_NAMES.map((n) => n.toLowerCase()));

const SPECIES_GLOB = path.join(DATA_DIR, "species", "**", "*.parquet");
const LINK = path.join(DATA_DIR, "species_link.parquet");
const ASSESSED = path.join(DATA_DIR, "assessed.parquet");

const DATA_AVAILABLE =
  fs.existsSync(path.join(DATA_DIR, "species")) && fs.existsSync(LINK) && fs.existsSync(ASSESSED);

// All 6 "ssc-*-groups" wrapper nodes, found generically rather than hardcoded — stays
// in sync automatically if a taxon's SSC pilot is ever added or removed.
const SSC_WRAPPER_IDS = [...NODE_INDEX.keys()].filter(
  (id) => id.startsWith("ssc-") && id.endsWith("-groups") && (NODE_INDEX.get(id)?.children?.length ?? 0) > 0,
);

type ColRow = { scientific_name: string; class_name: string | null; order_name: string | null; family: string | null; taxon_group: string };

// Same "extant, or CoL-extinct but IUCN-confirmed EX/EW" + Homo sapiens exclusion
// scripts/build-taxa-summary.ts uses for every other CoL-derived count in this app —
// mirrored here (not imported) since that logic lives inside non-exported functions.
async function fetchColUniverse(taxonGroups: string[]): Promise<ColRow[]> {
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(`
    CREATE TABLE ex_ew_assessed AS
    SELECT DISTINCT l.col_id
    FROM read_parquet('${LINK}') l
    JOIN read_parquet('${ASSESSED}') a ON a.id = l.id
    WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND a.iucn_category IN ('EX', 'EW')
  `);
  const groupList = taxonGroups.map((g) => `'${g}'`).join(", ");
  const result = await conn.run(`
    SELECT scientific_name, class_name, order_name, family, taxon_group
    FROM read_parquet('${SPECIES_GLOB}', hive_partitioning=true)
    WHERE taxon_group IN (${groupList})
      AND in_base
      AND (extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ex_ew_assessed))
      AND col_id NOT IN ('6MB3T')
  `);
  return (await result.getRowObjects()) as unknown as ColRow[];
}

describe.skipIf(!DATA_AVAILABLE)("SSC Specialist Group filters vs. the live Catalogue of Life backbone", () => {
  const universeByWrapper = new Map<string, ColRow[]>();

  beforeAll(async () => {
    for (const wrapperId of SSC_WRAPPER_IDS) {
      const wrapper = NODE_INDEX.get(wrapperId)!;
      universeByWrapper.set(wrapperId, await fetchColUniverse(wrapper.filter.taxonGroups));
    }
  }, 180_000);

  it.each(SSC_WRAPPER_IDS)(
    "%s: every live-CoL species matches exactly one child node",
    (wrapperId) => {
      const wrapper = NODE_INDEX.get(wrapperId)!;
      const children = wrapper.children!;
      const universe = universeByWrapper.get(wrapperId)!;
      expect(universe.length).toBeGreaterThan(0);

      const unmatched: string[] = [];
      const doubleMatched: string[] = [];
      for (const row of universe) {
        const species = { ...row, order_name: row.order_name ?? "" };
        const matches = children.filter((c) => speciesMatchesNode(species, c.id));
        if (matches.length === 0) {
          if (EXPECTED_UNMATCHED.has(row.scientific_name.toLowerCase())) continue;
          if (unmatched.length < 20) unmatched.push(`${row.scientific_name} (${row.class_name}/${row.order_name}/${row.family})`);
        } else if (matches.length > 1) {
          if (doubleMatched.length < 20) doubleMatched.push(`${row.scientific_name} -> ${matches.map((m) => m.id).join(", ")}`);
        }
      }

      expect(unmatched, `${unmatched.length} unmatched species (showing up to 20):\n${unmatched.join("\n")}`).toHaveLength(0);
      expect(doubleMatched, `${doubleMatched.length} double-matched species (showing up to 20):\n${doubleMatched.join("\n")}`).toHaveLength(0);
    },
    180_000,
  );
});
