/**
 * The curated Catalogue of Life checklist: what catalogueoflife.org shows.
 *
 * The XR is a curated release plus the sources CoL merges in around it. The sync
 * uses the curated release the XR was built from (COL26.6 XR → COL26.6), never a
 * newer one: sources/taxa.ts reads it for which species are curated (in_base),
 * which usages it holds (in_checklist), and to demote an XR species the
 * curated release treats as a synonym. Against its own release that demotes
 * nothing; against a newer one it did (8,738 species on COL26.6 XR with
 * COL26.10), which brought CoL's later taxonomy into links and counts that
 * otherwise follow the XR GBIF filed its records under.
 *
 * COL_CHECKLIST_DATASET (a key or an alias) overrides the choice, for measuring.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

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

/** The curated releases, newest first. origin=release leaves out the XRs. */
async function curatedReleases(): Promise<ChecklistInfo[]> {
  const res = await fetch("https://api.checklistbank.org/dataset?releasedFrom=3&origin=release&limit=100");
  if (!res.ok) throw new Error(`col-checklist: release listing failed: ${res.status}`);
  const body = (await res.json()) as { result?: { key?: number | string; alias?: string; issued?: string }[] };
  return (body.result ?? [])
    .filter((d): d is { key: number | string; alias?: string; issued: string } => Boolean(d.key && d.issued))
    .map((d) => ({ key: String(d.key), alias: d.alias ?? String(d.key), issued: d.issued }))
    .sort((a, b) => b.issued.localeCompare(a.issued));
}

/** The curated release `xr` was built from, the one its alias names, checked to be downloadable. */
export async function resolveChecklistDataset(xr: { alias: string }): Promise<ChecklistInfo> {
  const pinned = process.env.COL_CHECKLIST_DATASET;
  const want = pinned || xr.alias.replace(/\s*XR$/, "");
  const release = (await curatedReleases()).find((r) => r.key === want || r.alias === want);
  if (!release) throw new Error(`col-checklist: no curated release ${want} on ChecklistBank` +
    (pinned ? " (COL_CHECKLIST_DATASET)" : ` for ${xr.alias}`));
  if (!(await hasArchive(release.key))) throw new Error(`col-checklist: ${release.alias} (${release.key}) has no archive to download`);
  return release;
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
