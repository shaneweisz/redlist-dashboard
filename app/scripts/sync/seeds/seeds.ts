/**
 * Seeds: every decision a person made that the sync applies, one file per kind,
 * one row per decision, each with its reason. Kept as data rather than code so
 * that "what did a person decide, and why" is a list you can read in one place.
 *
 *   decisions.tsv            which CoL name each hard-to-match Red List species
 *                            is (link/decisions.ts reads and writes it)
 *   ne-excluded.tsv          species never listed as Not Evaluated: domestic
 *                            forms, whose wild relatives are what IUCN assesses,
 *                            and humans (sources/taxa.ts). The domestic pigeon
 *                            is deliberately absent: IUCN's "Columba domestica"
 *                            is a synonym of the assessed Rock Dove in CoL.
 *   forced-latest.tsv        assessments counted as a species' latest although
 *                            the database doesn't flag them so (sources/assessments.ts)
 *   tree-homonyms.tsv        which CoL taxon a taxonomy-tree name means where
 *                            several share it and the tree can't tell
 *                            (precomputed/col-taxon-ids.ts)
 *   tree-col-equivalents.tsv the CoL name for a taxonomy-tree name CoL files
 *                            under another name or rank (precomputed/col-taxon-ids.ts)
 *
 * Tab-separated, a header row first, no quoting.
 */
import * as fs from "fs";
import * as path from "path";

export const SEEDS_DIR = __dirname;

/** A seed's rows, keyed by its header. */
export function readSeed(name: string): Record<string, string>[] {
  const [head, ...lines] = fs.readFileSync(path.join(SEEDS_DIR, name), "utf-8").split("\n").filter((l) => l.trim() !== "");
  const cols = head.split("\t");
  return lines.map((line) => {
    const cells = line.split("\t");
    if (cells.length !== cols.length) throw new Error(`seeds/${name}: expected ${cols.length} columns, got ${cells.length}: ${line}`);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}
