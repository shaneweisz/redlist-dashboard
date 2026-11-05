/**
 * col-revisions.json, as a sync published it, against the code that reads it.
 *
 * The file is short-keyed (species-store's getColRevisions decodes it) and
 * carries reason codes the CoL-differences card matches on (col-revision.ts).
 * It is built by the sync and shipped with it, so a code change that renames a
 * key or a code would leave the card reading a vocabulary it no longer knows,
 * and it would quietly empty. This fails instead: locally on npm test with the
 * sync fetched, and in the sync's own checks. CI has no data and skips it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { REVISION_REASONS, UNFLAGGED_REASONS } from "@/lib/col-revision";
import { syncPath } from "@/lib/data/sync-layout";

const DIR = process.env.PIPELINE_DATA_DIR ?? path.join(process.cwd(), "data", "sync");
const FILE = path.join(DIR, syncPath("col-revisions.json"));
/** Every short key getColRevisions decodes. */
const KEYS = new Set(["r", "d", "i", "dc", "k", "c", "n", "s", "lw", "ln", "an", "ac", "gd"]);

describe.skipIf(!fs.existsSync(FILE))("col-revisions.json against col-revision.ts", () => {
  const species = fs.existsSync(FILE)
    ? (JSON.parse(fs.readFileSync(FILE, "utf-8")).species as Record<string, Record<string, unknown>>)
    : {};

  it("uses only keys the reader decodes", () => {
    const unknown = new Set(Object.values(species).flatMap((e) => Object.keys(e)).filter((k) => !KEYS.has(k)));
    expect([...unknown]).toEqual([]);
  });

  it("uses only reason codes the card knows", () => {
    const known = new Set<string>([...REVISION_REASONS, ...UNFLAGGED_REASONS]);
    const unknown = new Set(Object.values(species).map((e) => e.r as string | undefined).filter((r) => r != null && !known.has(r)));
    expect([...unknown]).toEqual([]);
  });
});
