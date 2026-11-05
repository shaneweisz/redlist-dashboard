/**
 * Catalogue of Life inputs, cached by dataset key.
 *
 * Three things come from ChecklistBank:
 *   - the XR release GBIF indexes (NameUsage, Reference, VernacularName). GBIF
 *     keys are XR ids, so the taxonomy has to be the release GBIF uses, not the
 *     newest one.
 *   - the curated checklist (3LR), used to demote XR over-splits and to say
 *     whether a usage is visible on catalogueoflife.org.
 *   - the list of Base GSD sources, to tell curated species from the XR's tail
 *     of single fossil papers.
 *
 * Each lands in ~/.cache/redlist-dashboard/col/<kind>-<key>/ and is reused
 * until the key moves. A directory counts only once its .complete marker
 * exists, so an interrupted download is redone, never half-used.
 *
 * Usage (fetch only):  npx tsx scripts/sync/inputs/col.ts
 */

import * as fs from "fs";
import * as path from "path";
import { loadEnvFiles } from "../../lib/utils";
import { CACHE_ROOT } from "../paths";
import { resolveXrDataset, run as fetchXr, type XrDatasetInfo } from "./fetch-col-xr";
import { resolveChecklistDataset, run as fetchChecklist, type ChecklistInfo } from "./fetch-col-checklist";

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
const BASE_DATASET = process.env.COL_BASE_DATASET || "3LR";

async function cached(dir: string, fill: (dir: string) => Promise<unknown>): Promise<string> {
  const marker = path.join(dir, ".complete");
  if (fs.existsSync(marker)) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await fill(dir);
  fs.writeFileSync(marker, new Date().toISOString() + "\n");
  return dir;
}

async function baseSources(checklistKey: string): Promise<string[]> {
  const dir = await cached(path.join(COL_CACHE, `base-sources-${checklistKey}`), async (d) => {
    const res = await fetch(`https://api.checklistbank.org/dataset/${BASE_DATASET}/source`);
    if (!res.ok) throw new Error(`Base source list fetch failed (${BASE_DATASET}): ${res.status}`);
    const ids = ((await res.json()) as { key: number }[]).map((s) => String(s.key)).filter(Boolean);
    if (ids.length === 0) throw new Error(`Base ${BASE_DATASET} returned no sources`);
    fs.writeFileSync(path.join(d, "sources.json"), JSON.stringify(ids) + "\n");
  });
  return JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf-8")) as string[];
}

export async function ensureColInputs(): Promise<ColInputs> {
  const xr = await resolveXrDataset();
  const checklist = await resolveChecklistDataset();
  const xrDir = await cached(path.join(COL_CACHE, `xr-${xr.key}`), (d) => fetchXr({ destDir: d }));
  const clDir = await cached(path.join(COL_CACHE, `checklist-${checklist.key}`),
    (d) => fetchChecklist({ destDir: d, dataset: checklist }));
  return {
    xr,
    checklist,
    nameUsage: path.join(xrDir, "NameUsage.tsv"),
    reference: path.join(xrDir, "Reference.tsv"),
    vernacularNames: path.join(xrDir, "VernacularName.tsv"),
    checklistNameUsage: path.join(clDir, "NameUsage.tsv"),
    baseSourceIds: await baseSources(checklist.key),
  };
}

const isDirectRun = process.argv[1]?.endsWith("inputs/col.ts") || process.argv[1]?.endsWith("inputs/col.js");
if (isDirectRun) {
  loadEnvFiles();
  ensureColInputs()
    .then((c) => console.log(JSON.stringify({ ...c, baseSourceIds: c.baseSourceIds.length }, null, 2)))
    .catch((e) => { console.error(e); process.exit(1); });
}
