/**
 * The Catalogue of Life inputs for one XR, cached by dataset key:
 *   - the XR (col-xr.ts): the usages the taxa table is built from. The sync's
 *     is the one the GBIF snapshot is filed under (snapshot-xr.ts); GBIF's live
 *     index's, when newer, is fetched the same way for live ids
 *   - the curated release that XR was built from (col-checklist.ts): which
 *     species are curated, and which usages it holds
 *   - the checklist's Base sources: tell curated species from the XR's tail of
 *     single fossil papers
 *
 * Each lands in ~/.cache/redlist-dashboard/col/<kind>-<key>/ and is reused
 * until the key moves.
 *
 * Once a sync is built, writeColReleasePin records both releases in
 * src/config/col-release.json, which the app cites as its CoL source.
 *
 * Usage (fetch only):  npx tsx scripts/sync/inputs/col.ts
 */

import * as fs from "fs";
import * as path from "path";
import { loadEnvFiles } from "../../lib/utils";
import { CACHE_ROOT, cachedDir } from "../paths";
import { fetchXr, resolveLiveXr, type XrDatasetInfo } from "./col-xr";
import { resolveChecklistDataset, fetchChecklist, type ChecklistInfo } from "./col-checklist";

export interface ColInputs {
  xr: XrDatasetInfo;
  checklist: ChecklistInfo;
  nameUsage: string;
  reference: string;
  vernacularNames: string;
  checklistNameUsage: string;
  baseSourceIds: string[];
}

const COL_CACHE = path.join(CACHE_ROOT, "col");
const PIN = path.join(__dirname, "..", "..", "..", "src", "config", "col-release.json");

async function baseSources(checklist: ChecklistInfo): Promise<string[]> {
  const dir = await cachedDir(path.join(COL_CACHE, `base-sources-${checklist.key}`), async (d) => {
    const res = await fetch(`https://api.checklistbank.org/dataset/${checklist.key}/source`);
    if (!res.ok) throw new Error(`col: Base source list fetch failed (${checklist.key}): ${res.status}`);
    const ids = ((await res.json()) as { key: number }[]).map((s) => String(s.key)).filter(Boolean);
    if (ids.length === 0) throw new Error(`col: ${checklist.alias} lists no Base sources`);
    fs.writeFileSync(path.join(d, "sources.json"), JSON.stringify(ids) + "\n");
  });
  return JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf-8")) as string[];
}

/** The XR's own tables only (no curated release): enough to test a snapshot's keys against. */
export async function ensureXr(xr: XrDatasetInfo): Promise<string> {
  const dir = await cachedDir(path.join(COL_CACHE, `xr-${xr.key}`), (d) => fetchXr(xr, d));
  return path.join(dir, "NameUsage.tsv");
}

export async function ensureColInputs(xr: XrDatasetInfo): Promise<ColInputs> {
  const checklist = await resolveChecklistDataset(xr);
  const xrDir = await cachedDir(path.join(COL_CACHE, `xr-${xr.key}`), (d) => fetchXr(xr, d));
  const clDir = await cachedDir(path.join(COL_CACHE, `checklist-${checklist.key}`), (d) => fetchChecklist(checklist, d));
  return {
    xr,
    checklist,
    nameUsage: path.join(xrDir, "NameUsage.tsv"),
    reference: path.join(xrDir, "Reference.tsv"),
    vernacularNames: path.join(xrDir, "VernacularName.tsv"),
    checklistNameUsage: path.join(clDir, "NameUsage.tsv"),
    baseSourceIds: await baseSources(checklist),
  };
}

/** Record the releases a sync was built from, for the app's "Source" link. */
export function writeColReleasePin(xr: XrDatasetInfo, checklist: ChecklistInfo, file = PIN): void {
  fs.writeFileSync(file, JSON.stringify({ ...xr, checklist }, null, 2) + "\n");
  console.log(`   wrote ${path.relative(process.cwd(), file)} (${xr.alias}; checklist ${checklist.alias})`);
}

/** The XR the last sync was built from, if any: the first to test a snapshot against. */
export function lastXr(): XrDatasetInfo | null {
  try {
    const pin = JSON.parse(fs.readFileSync(PIN, "utf-8")) as XrDatasetInfo;
    return pin.key ? { key: pin.key, alias: pin.alias, doi: pin.doi, issued: pin.issued } : null;
  } catch {
    return null;
  }
}

const isDirectRun = process.argv[1]?.endsWith("inputs/col.ts");
if (isDirectRun) {
  loadEnvFiles();
  resolveLiveXr()
    .then((xr) => { if (!xr) throw new Error("col: GBIF's live XR could not be resolved"); return ensureColInputs(xr); })
    .then((c) => console.log(JSON.stringify({ ...c, baseSourceIds: c.baseSourceIds.length }, null, 2)))
    .catch((e) => { console.error(e); process.exit(1); });
}
