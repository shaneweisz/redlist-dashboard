/**
 * Phase 4b rewrites the root keys; phase 5 must then use the rewritten ones.
 *
 * This is the wiring that makes the sync survive a Catalogue of Life release.
 * When CoL renumbers a group root — Rhodophyta moved between COL26.6 and 26.7,
 * and Rhodophyta is red_algae's ONLY root — phase 4b derives the new key and
 * writes it, and phase 5 validates the keys it holds against the freshly built
 * taxonomy.
 *
 * The keys used to be a static `import` of the JSON, so they were fixed when the
 * process started, which was before phase 4b rewrote the file. Phase 5 therefore
 * checked the OLD release's keys against the NEW taxonomy, found them dead, and
 * failed the very run that had just repaired them. On the weekly Action that
 * fails the job before the commit step, so the corrected config is thrown away
 * with the runner and the next run does the same thing — red every Sunday until
 * someone ran the derivation by hand.
 *
 * The existing root-key tests all pass taxon literals straight to the guard, so
 * they verify the guard and not the wiring. This one goes through getTaxa(),
 * which is what the pipeline actually calls.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { getTaxa, reloadTaxonKeys } from "../lib/taxa";

// A scratch copy, never the git-tracked file. Rewriting the real config to test
// a rewrite means an interrupted run leaves invented keys in a committed file.
const REAL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/config/gbif-taxon-keys.json"
);
const original = fs.readFileSync(REAL, "utf8");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taxonkeys-"));
const CONFIG = path.join(dir, "gbif-taxon-keys.json");

beforeAll(() => {
  fs.writeFileSync(CONFIG, original);
  process.env.GBIF_TAXON_KEYS_PATH = CONFIG;
  reloadTaxonKeys();
});

afterAll(() => {
  delete process.env.GBIF_TAXON_KEYS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
  reloadTaxonKeys();
});

afterEach(() => {
  fs.writeFileSync(CONFIG, original);
  reloadTaxonKeys();
});

/** Rewrite one group's first root key, as a CoL renumbering would. */
function renumberFirstKey(): { group: string; before: string; after: string } {
  const cfg = JSON.parse(original) as Record<string, Array<{ redlistName: string; taxonKey: string | null }>>;
  const group = Object.keys(cfg).find((g) => cfg[g].some((k) => k.taxonKey))!;
  const entry = cfg[group].find((k) => k.taxonKey)!;
  const before = entry.taxonKey!;
  const after = `RENUMBERED_${before}`;
  entry.taxonKey = after;
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  return { group, before, after };
}

const keysOf = (group: string) =>
  getTaxa([group])[0].gbif.map((g) => g.taxonKey);

describe("root keys are re-read after phase 4b rewrites them", () => {
  it("serves the keys currently on disk", () => {
    const cfg = JSON.parse(original) as Record<string, Array<{ taxonKey: string | null }>>;
    const group = Object.keys(cfg).find((g) => cfg[g].some((k) => k.taxonKey))!;
    const onDisk = cfg[group].filter((k) => k.taxonKey).map((k) => k.taxonKey);
    expect(keysOf(group)).toEqual(onDisk);
  });

  it("picks up a rewritten key after reloadTaxonKeys()", () => {
    const { group, before, after } = renumberFirstKey();
    reloadTaxonKeys();
    expect(keysOf(group)).toContain(after);
    expect(keysOf(group)).not.toContain(before);
  });

  it("caches until told otherwise, so sync.ts's reload call is load-bearing", () => {
    const cfg = JSON.parse(original) as Record<string, Array<{ taxonKey: string | null }>>;
    const group = Object.keys(cfg).find((g) => cfg[g].some((k) => k.taxonKey))!;

    reloadTaxonKeys();
    const startingKeys = keysOf(group); // populates the cache

    const { before, after } = renumberFirstKey(); // file now differs from cache
    expect(keysOf(group)).toEqual(startingKeys);
    expect(keysOf(group)).toContain(before);
    expect(keysOf(group)).not.toContain(after);

    reloadTaxonKeys();
    expect(keysOf(group)).toContain(after);
  });
});
