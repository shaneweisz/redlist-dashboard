/**
 * The Catalogue of Life eXtended Release (XR): every name usage the taxa table
 * is built from.
 *
 * Not the newest XR, but the one GBIF's occurrence index runs on. GBIF adopts
 * each release about three weeks after CoL publishes it, and CoL renumbers about
 * 2% of usage ids per release, so the newest is normally one ahead and a slice
 * of GBIF's keys would resolve to nothing (measured once: 504 assessed and 9,092
 * unassessed keys against the newest, none against the indexed one).
 *
 * The release is resolved in this order: COL_XR_DATASET, then the release GBIF
 * reports, then the one the last sync used (src/config/col-release.json) when
 * GBIF can't be reached, and only with nothing pinned the newest, which is a guess and says so.
 *
 * Three tables are taken from the ColDP export: NameUsage (the usages),
 * Reference (the publication year of botanical and fungal names, whose author
 * citations carry none) and VernacularName (common names for higher ranks).
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export interface XrDatasetInfo {
  key: string;
  alias: string;
  doi: string | null;
  issued: string | null;
}

export const XR_TABLES = ["NameUsage.tsv", "Reference.tsv", "VernacularName.tsv"] as const;

/**
 * The release GBIF's occurrence index is built on. The dataset record's `doi`
 * tracks the newest crawl and is misleading; `/v2/species/match/metadata`
 * reports the live index. Retried, because giving up means guessing.
 */
async function gbifIndexedRelease(): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.gbif.org/v2/species/match/metadata?checklistKey=xcol");
      if (res.ok) {
        const body = (await res.json()) as { mainIndex?: { clbDatasetKey?: string; datasetAlias?: string } };
        const key = body.mainIndex?.clbDatasetKey;
        if (key) {
          console.log(`   GBIF's occurrence index runs ${body.mainIndex?.datasetAlias ?? "?"} (${key})`);
          return key;
        }
      }
    } catch {
      // retry
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
  }
  return null;
}

/** @param pinned the XR the last sync used, to stand on if GBIF can't be asked */
export async function resolveXrDataset(pinned: string | null): Promise<XrDatasetInfo> {
  const indexed = process.env.COL_XR_DATASET ?? (await gbifIndexedRelease());
  const key = indexed ?? pinned;
  if (!indexed) {
    console.warn(key
      ? `   could not reach GBIF to confirm its indexed release; keeping the pinned ${key}`
      : "   could not reach GBIF and nothing is pinned; using the newest XR, so some GBIF keys may not resolve");
  }
  const res = key
    ? await fetch(`https://api.checklistbank.org/dataset/${key}`)
    : await fetch("https://api.checklistbank.org/dataset?origin=xrelease&limit=1&sortBy=created");
  if (!res.ok) throw new Error(`col-xr: ChecklistBank lookup failed: ${res.status}`);
  const body = await res.json();
  const ds = key ? body : body.result?.[0];
  if (!ds) throw new Error("col-xr: no xrelease datasets returned");
  return { key: String(ds.key), alias: ds.alias, doi: ds.doi ?? null, issued: ds.issued ?? null };
}

/** Download `xr`'s ColDP export into `destDir` and keep the three tables. */
export function fetchXr(xr: XrDatasetInfo, destDir: string): void {
  const zip = path.join(destDir, "coldp_xr.zip");
  const url = `https://api.checklistbank.org/dataset/${xr.key}/export.zip?format=ColDP&extended=true`;
  console.log(`   downloading ${xr.alias} (${xr.key})`);
  // Resumable and retried: a 1.4 GB download, the largest in the sync.
  execFileSync("curl", ["-fsSL", "--retry", "5", "--retry-all-errors", "--retry-delay", "10",
    "-C", "-", url, "-o", zip], { stdio: ["ignore", "inherit", "inherit"] });
  execFileSync("unzip", ["-o", zip, ...XR_TABLES, "-d", destDir], { stdio: ["ignore", "inherit", "inherit"] });
  fs.rmSync(zip, { force: true });
  for (const t of XR_TABLES) {
    if (!fs.existsSync(path.join(destDir, t))) throw new Error(`col-xr: ${t} missing after extraction`);
  }
}
