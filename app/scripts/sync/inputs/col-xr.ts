/**
 * The Catalogue of Life eXtended Releases (XR) the sync reads, and which is which.
 *
 * Up to three can be in play, and most months they are one:
 *   - the taxonomy's: CoL's newest XR whose archive ChecklistBank serves
 *     (resolveXrDataset). Taxa, the link and every list follow it.
 *   - the snapshot's: the XR GBIF indexed when it made the snapshot, which the
 *     snapshot's keys are ids of (inputs/snapshot-xr.ts). Its usages are mapped
 *     onto the taxonomy's (sources/release-map.ts) before anything is counted.
 *   - the live index's: the XR GBIF's occurrence API runs now (resolveLiveXr),
 *     whose ids the app's live GBIF queries need.
 * GBIF re-indexes a few times a year (July and November 2026), so CoL is
 * normally a release or more ahead of both, and CoL renumbers about 2% of usage
 * ids per release: ids from one XR can't be read as another's.
 *
 * COL_XR_DATASET pins the taxonomy's XR.
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

async function datasetInfo(key: string): Promise<XrDatasetInfo> {
  const res = await fetch(`https://api.checklistbank.org/dataset/${key}`);
  if (!res.ok) throw new Error(`col-xr: ChecklistBank lookup failed for ${key}: ${res.status}`);
  const ds = await res.json();
  return { key: String(ds.key), alias: ds.alias, doi: ds.doi ?? null, issued: ds.issued ?? null };
}

const exportUrl = (key: string) => `https://api.checklistbank.org/dataset/${key}/export.zip?format=ColDP&extended=true`;

/** Whether ChecklistBank will serve this dataset's archive yet (HEAD, following its redirect to the file). */
export async function hasArchive(key: string): Promise<boolean> {
  try {
    return (await fetch(exportUrl(key), { method: "HEAD", redirect: "follow" })).ok;
  } catch {
    return false;
  }
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

/**
 * The taxonomy's XR: COL_XR_DATASET, else the newest XR `usable` accepts (its
 * archive, and its curated release's, can be downloaded). CoL names a release
 * days before its archive is built, so a newer one without an archive is
 * stepped past, and said so.
 */
export async function resolveXrDataset(usable: (xr: XrDatasetInfo) => Promise<boolean>): Promise<XrDatasetInfo> {
  if (process.env.COL_XR_DATASET) return datasetInfo(process.env.COL_XR_DATASET);
  for (const xr of await xreleases(4)) {
    if (await usable(xr)) return xr;
    console.warn(`   ${xr.alias} (${xr.key}) can't be downloaded yet; trying the release before it`);
  }
  throw new Error("col-xr: none of CoL's four newest XRs can be downloaded");
}

/** Download `xr`'s ColDP export into `destDir` and keep the three tables. */
export function fetchXr(xr: XrDatasetInfo, destDir: string): void {
  const zip = path.join(destDir, "coldp_xr.zip");
  const url = exportUrl(xr.key);
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
