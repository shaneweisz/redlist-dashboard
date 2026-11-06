/**
 * build-prebuilt's cache key: the sync name plus every source file the three
 * builders import. A file the key misses would let a deploy reuse files built
 * by older code.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { cacheKey, sourceClosure } from "../build/build-prebuilt";

const APP = path.join(__dirname, "..", "..");
const rel = (fs: string[]) => fs.map((f) => path.relative(APP, f));
const entries = ["build-species-lists", "build-search-shards", "build-tree-children"]
  .map((b) => path.join(APP, "scripts", "build", `${b}.ts`));

describe("build-prebuilt cache key", () => {
  it("follows the builders' imports, relative and @/, into the code that shapes the files", () => {
    const files = rel(sourceClosure(entries));
    for (const f of [
      "src/lib/data/species-duckdb.ts",          // the rows
      "src/lib/species-lists/format.ts",         // their encoding
      "src/lib/search-shards/rank.ts",           // search ranking
      "src/lib/data/tree-children-build.ts",     // tree expands
      "src/config/taxonomy-tree.ts",             // nodes and display names
      "src/lib/data/sync-layout.ts",             // where the inputs are
    ]) expect(files).toContain(f);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("changes with the sync", () => {
    expect(cacheKey("2026-11-05T19-58-01Z").key).not.toBe(cacheKey("2026-11-06T09-13-55Z").key);
    expect(cacheKey("2026-11-05T19-58-01Z").key).toBe(cacheKey("2026-11-05T19-58-01Z").key);
  });
});
