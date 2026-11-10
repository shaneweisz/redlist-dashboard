/**
 * The Catalogue of Life eXtended Release (XR): every name usage the taxa table
 * is built from.
 *
 * One XR serves the whole sync: the one the GBIF snapshot is filed under
 * (inputs/snapshot-xr.ts finds it), so every count, link and list uses the ids
 * GBIF filed its records with. Not CoL's newest: GBIF re-indexes a few times a
 * year, CoL releases monthly, and CoL renumbers about 2% of usage ids per
 * release, so ids from one XR can't be read as another's.
 *
 * GBIF's live index can run a newer XR than the snapshot (it re-indexes between
 * snapshots). resolveLiveXr names it, for the app's live GBIF queries only
 * (link/live-keys.ts).
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

/**
 * The XR GBIF's live occurrence index uses: the app's live GBIF queries (maps,
 * breakdowns, photos, gbif.org links) go to that index, so they need ids from
 * it. Null when GBIF can't be asked.
 */
export async function resolveLiveXr(): Promise<XrDatasetInfo | null> {
  const key = await gbifIndexedRelease();
  return key ? datasetInfo(key) : null;
}

export async function datasetInfo(key: string): Promise<XrDatasetInfo> {
  const res = await fetch(`https://api.checklistbank.org/dataset/${key}`);
  if (!res.ok) throw new Error(`col-xr: ChecklistBank lookup failed for ${key}: ${res.status}`);
  const ds = await res.json();
  return { key: String(ds.key), alias: ds.alias, doi: ds.doi ?? null, issued: ds.issued ?? null };
}

/** CoL's XRs, newest first. */
export async function xreleases(limit = 12): Promise<XrDatasetInfo[]> {
  const res = await fetch(`https://api.checklistbank.org/dataset?releasedFrom=3&origin=xrelease&limit=${limit}&sortBy=created`);
  if (!res.ok) throw new Error(`col-xr: XR listing failed: ${res.status}`);
  const body = (await res.json()) as { result?: { key: number | string; alias: string; doi?: string; issued?: string }[] };
  return (body.result ?? [])
    .map((d) => ({ key: String(d.key), alias: d.alias, doi: d.doi ?? null, issued: d.issued ?? null }))
    .sort((a, b) => (b.issued ?? "").localeCompare(a.issued ?? ""));
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
