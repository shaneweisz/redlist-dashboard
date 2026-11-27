import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { creditToOwners } from "@/lib/data/occurrence-taxa";

/**
 * A route asking GBIF for one species' records asks for every taxon its count
 * claims (countedGbifKeys in occurrence-taxa.ts), not its one key: asked by the
 * key alone, a species CoL splits showed part of what it counts (Butorides
 * striata: 287k of 3.4M). So calling liveGbifKeys directly is a decision, and
 * each file that makes it is listed here with why.
 */
const DIRECT = new Map<string, string>([
  ["src/lib/gbif-live-keys.ts", "defines it"],
  ["src/lib/data/occurrence-taxa.ts", "countedGbifKeys, the one way in"],
  ["src/app/api/occurrences/route.ts", "the context scope, and each counted taxon's own total"],
  ["src/app/api/gbif-link/route.ts", "the species page shows one taxon; the occurrence search uses countedGbifKeys"],
  ["src/app/api/country/stats/route.ts", "taxonomic groups, not species"],
  ["src/app/api/species/[key]/inat-photos/route.ts", "photos of the species itself, not a count: a split's other species would show another bird"],
]);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe("species GBIF queries", () => {
  it("call liveGbifKeys directly only where listed", () => {
    const root = path.resolve(__dirname, "../../../..");
    const callers = files(path.join(root, "src"))
      .filter((f) => fs.readFileSync(f, "utf-8").includes("liveGbifKeys("))
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .sort();
    expect(callers).toEqual([...DIRECT.keys()].sort());
  });
});

describe("creditToOwners", () => {
  it("credits a split's other species to the Red List species that counts it", () => {
    const byKey = new Map([["NZ6J", 3], ["NZ6M", 40], ["OTHER", 5]]);
    const owners = new Map([["NZ6J", "NZ6J"], ["NZ6M", "NZ6J"]]);
    expect(creditToOwners(byKey, owners)).toEqual(new Map([["NZ6J", 43], ["OTHER", 5]]));
  });
});
