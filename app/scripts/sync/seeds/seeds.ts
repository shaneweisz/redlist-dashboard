/**
 * Seeds: what the sync reads besides its sources, one file per kind, each row
 * with its reason. Kept as data rather than code so that "what was decided, and
 * why" is a list you can read in one place.
 *
 *   ai-reviews.tsv           the AI taxonomic reviewers' answers on the species
 *                            listed for review, one row per reviewer (link/ai-reviews.ts,
 *                            docs/specs/matching.md); shown, never counted
 *   domesticated-and-humans.tsv
 *                            species never listed as Not Evaluated: domestic
 *                            forms, whose wild relatives are what IUCN assesses,
 *                            and humans (sources/taxa.ts). The domestic pigeon
 *                            is deliberately absent: IUCN's "Columba domestica"
 *                            is a synonym of the assessed Rock Dove in CoL.
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
