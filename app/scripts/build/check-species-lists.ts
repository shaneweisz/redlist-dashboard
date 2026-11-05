/**
 * check-species-lists: prove the pre-built species-list files answer every view the way
 * the live /api/redlist/species route does.
 *
 * For each taxonomy node (plus "all" and a sample of dynamic drilldown ids), in both the
 * Assessed and Not Evaluated modes, takes
 *   - the route's rows (querySpecies — what the route returns), and
 *   - the files' rows (the groups lib/species-lists/loader picks, decoded),
 * narrows both with the client's own speciesMatchesNode (what RedListView shows), and
 * compares species keys and every field. Above the route's 400k NE cap (insects,
 * invertebrates) the route returns only a count, which the files' row total must match.
 * The one intended difference is ignored: NE
 * rows' taxon_id is the group's display taxon in the files, the requested taxon in the
 * route (RedListView matches NE rows by node membership instead).
 *
 * Usage: npx tsx scripts/build/check-species-lists.ts [--quick]   (after build-species-lists)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { querySpecies } from "../../src/lib/data/species-duckdb";
import { NODE_INDEX, speciesMatchesNode } from "../../src/lib/taxonomy-utils";
import { decodeColumns, speciesListFileName, type SpeciesListManifest } from "../../src/lib/species-lists/format";
import { groupsForTaxon } from "../../src/lib/species-lists/loader";

const APP_DIR = path.join(__dirname, "..", "..");
const sync = fs.readFileSync(path.join(APP_DIR, "latest-sync.txt"), "utf-8").trim();
const dir = path.join(APP_DIR, "public", "species-lists", sync);
const manifest: SpeciesListManifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));

type Row = Record<string, unknown>;
const fileCache = new Map<string, Row[]>();
function groupRows(group: string, kind: "assessed" | "ne"): Row[] {
  const key = `${group}.${kind}`;
  if (!fileCache.has(key)) {
    const buf = zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, speciesListFileName(group, kind))));
    fileCache.set(key, decodeColumns(JSON.parse(buf.toString("utf-8"))));
  }
  return fileCache.get(key)!;
}

const narrow = (rows: Row[], taxon: string) =>
  taxon === "all" ? rows : rows.filter((r) => speciesMatchesNode(r as Parameters<typeof speciesMatchesNode>[0], taxon));

function stable(r: Row, ne: boolean): string {
  const o: Row = {};
  for (const k of Object.keys(r).sort()) if (!(ne && k === "taxon_id")) o[k] = r[k];
  return JSON.stringify(o);
}

async function check(taxon: string, ne: boolean): Promise<string | null> {
  const groups = groupsForTaxon(taxon, manifest);
  if (!groups) return `${taxon}: files can't answer (would fall back to the route)`;
  const live = await querySpecies({ taxon, includeNE: ne });
  if (live.tooLarge) {
    // Over the route's 400k cap it returns no rows, only a count (neTotal) — the files load
    // them all. Check the files hold exactly that many for the same groups.
    const fileTotal = groups.reduce((s, g) => s + manifest.groups[g].ne.rows, 0);
    return fileTotal === live.neTotal ? null
      : `${taxon} NE: route counts ${live.neTotal} (too large to list), files hold ${fileTotal}`;
  }
  const liveRows = narrow((live.species as unknown as Row[]).filter((r) => (r.category === "NE") === ne), taxon);
  const fileRows = narrow(groups.flatMap((g) => groupRows(g, ne ? "ne" : "assessed")), taxon);
  const a = new Map(liveRows.map((r) => [String(r.species_key), stable(r, ne)]));
  const b = new Map(fileRows.map((r) => [String(r.species_key), stable(r, ne)]));
  const missing = [...a.keys()].filter((k) => !b.has(k));
  const extra = [...b.keys()].filter((k) => !a.has(k));
  const differ = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  if (!missing.length && !extra.length && !differ.length) return null;
  return `${taxon}${ne ? " NE" : ""}: route ${a.size} / files ${b.size} rows — missing ${missing.length} ${missing.slice(0, 3)}, extra ${extra.length} ${extra.slice(0, 3)}, differ ${differ.length}` +
    (differ.length ? `\n    route: ${a.get(differ[0])!.slice(0, 300)}\n    files: ${b.get(differ[0])!.slice(0, 300)}` : "");
}

async function main() {
  const quick = process.argv.includes("--quick");
  const dynamic = [
    "insects~order:coleoptera", "insects~order:lepidoptera~family:nymphalidae", "mammals~order:rodentia",
    "pl-flowering_plants~order:fabales", "pl-flowering_plants~order:asparagales~family:orchidaceae",
    "inv-molluscs~class:gastropoda", "birds~order:passeriformes~family:turdidae",
  ];
  const nodes = quick
    ? ["all", "mammals", "plantae", "fungi", "inv-corals", "ssc-orchid", "ssc-plant-groups", ...dynamic]
    : ["all", ...NODE_INDEX.keys(), ...dynamic];
  let failures = 0;
  let checked = 0;
  for (const taxon of nodes) {
    for (const ne of [false, true]) {
      if (ne && taxon === "all") continue; // the dashboard never requests NE for "all"
      const problem = await check(taxon, ne);
      checked++;
      if (problem) { failures++; console.log(`✗ ${problem}`); }
    }
  }
  console.log(`${checked - failures}/${checked} views match`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
