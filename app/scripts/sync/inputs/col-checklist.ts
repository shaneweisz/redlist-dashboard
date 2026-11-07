/**
 * The curated Catalogue of Life checklist: what catalogueoflife.org shows.
 *
 * The XR maximises coverage but doesn't reconcile its sources, so it over-splits:
 * Pycnonotus tricolor is an accepted species in the XR and a synonym of the
 * assessed P. barbatus in the checklist. sources/taxa.ts uses the checklist only to
 * demote such species, never to add or delete any: groups the checklist lacks
 * (macroalgae) are kept. col_ids are shared, so the join is exact where both
 * datasets carry a usage, though about 95k checklist usages have no XR row.
 *
 * `3LR` (COL_CHECKLIST_DATASET) names the newest release the day CoL publishes
 * it, but ChecklistBank builds its export days later (one day for COL26.8, three
 * for COL26.7, more than four for COL26.9). So the release is probed, and when
 * its archive isn't built yet the newest one that is gets used, up to three
 * releases back. Only the extended archive is asked for: the simple one would do
 * but lags further, and ChecklistBank won't build either on request.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const CHECKLIST_DATASET = process.env.COL_CHECKLIST_DATASET || "3LR";
const MAX_FALLBACK_RELEASES = 3;

export interface ChecklistInfo {
  key: string;
  alias: string;
  issued: string;
}

const exportUrl = (key: string) =>
  `https://api.checklistbank.org/dataset/${key}/export.zip?format=ColDP&extended=true`;

/** Whether ChecklistBank will serve this release's archive (HEAD, following its redirect to the file). */
async function hasArchive(key: string): Promise<boolean> {
  try {
    return (await fetch(exportUrl(key), { method: "HEAD", redirect: "follow" })).ok;
  } catch {
    return false;
  }
}

/** The curated releases, newest first. origin=release leaves out the XRs, which this exists to correct. */
async function curatedReleases(): Promise<ChecklistInfo[]> {
  const res = await fetch("https://api.checklistbank.org/dataset?releasedFrom=3&origin=release&limit=100");
  if (!res.ok) throw new Error(`col-checklist: release listing failed: ${res.status}`);
  const body = (await res.json()) as { result?: { key?: number | string; alias?: string; issued?: string }[] };
  return (body.result ?? [])
    .filter((d): d is { key: number | string; alias?: string; issued: string } => Boolean(d.key && d.issued))
    .map((d) => ({ key: String(d.key), alias: d.alias ?? String(d.key), issued: d.issued }))
    .sort((a, b) => b.issued.localeCompare(a.issued));
}

/** The newest curated release whose archive can be downloaded. */
export async function resolveChecklistDataset(): Promise<ChecklistInfo> {
  const res = await fetch(`https://api.checklistbank.org/dataset/${CHECKLIST_DATASET}`);
  if (!res.ok) throw new Error(`col-checklist: metadata fetch failed (${CHECKLIST_DATASET}): ${res.status}`);
  const d = (await res.json()) as { key?: number | string; alias?: string; issued?: string; version?: string };
  const issued = d.issued ?? d.version ?? "";
  if (!d.key || !issued) throw new Error(`col-checklist: metadata missing key/issued for ${CHECKLIST_DATASET}`);
  const latest: ChecklistInfo = { key: String(d.key), alias: d.alias ?? CHECKLIST_DATASET, issued };
  if (await hasArchive(latest.key)) return latest;

  console.warn(`   ${latest.alias} (${latest.key}) has no archive built yet; looking for the newest release that does`);
  // Older by issue date, not key: keys are allocation order.
  const older = (await curatedReleases()).filter((r) => r.issued < latest.issued).slice(0, MAX_FALLBACK_RELEASES);
  for (const candidate of older) {
    if (await hasArchive(candidate.key)) {
      console.warn(`   using ${candidate.alias} (${candidate.key}) until ${latest.alias}'s archive is built`);
      return candidate;
    }
  }
  throw new Error(
    `col-checklist: no archive for ${latest.alias} (${latest.key}) or the ${older.length} release(s) before it ` +
      `(${older.map((r) => r.alias).join(", ") || "none found"}); that's longer than the gap has ever been, so check CoL.`
  );
}

/** Download `checklist`'s archive into `destDir` and keep NameUsage.tsv. */
export function fetchChecklist(checklist: ChecklistInfo, destDir: string): void {
  const zip = path.join(destDir, "checklist.zip");
  console.log(`   downloading ${checklist.alias} (${checklist.key})`);
  execFileSync("curl", ["-fsSL", exportUrl(checklist.key), "-o", zip], { stdio: ["ignore", "inherit", "inherit"] });
  execFileSync("unzip", ["-o", zip, "NameUsage.tsv", "-d", destDir], { stdio: ["ignore", "inherit", "inherit"] });
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(path.join(destDir, "NameUsage.tsv"))) throw new Error("col-checklist: NameUsage.tsv missing after extraction");
}
