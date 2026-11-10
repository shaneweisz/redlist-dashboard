/**
 * The releases the sources stage built its tables from: the CoL XR and curated
 * checklist, and the GBIF snapshot. Written beside the tables, so a run that
 * starts later (`--from link`) can tell whether the tables it reuses came from
 * the releases it is about to use.
 *
 * Decisions:
 *   - A mismatch stops the run. Linking against one CoL release while the taxa
 *     come from another gives ids that don't join, and nothing downstream
 *     notices: a `--from link` run once matched against COL26.10 XR on
 *     COL26.6 XR taxa. The fix is to run from sources, or to pin the XR.
 *   - No record (a build from before this file, or an interrupted sources run)
 *     also stops it: the tables' releases can't be vouched for.
 */
import * as fs from "fs";

export interface SourcesReleases {
  xr: string;
  checklist: string;
  snapshot: string;
}

export function writeSourcesReleases(file: string, r: SourcesReleases): void {
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
}

/** Why the tables in the build can't be reused with these releases, or null when they can. */
export function sourcesMismatch(recorded: SourcesReleases | null, now: SourcesReleases): string | null {
  if (!recorded) return "the build has no record of the releases its sources were built from";
  const diffs = (["xr", "checklist", "snapshot"] as const)
    .filter((k) => recorded[k] !== now[k])
    .map((k) => `${k} ${recorded[k]} in the build, ${now[k]} now`);
  return diffs.length ? diffs.join("; ") : null;
}

export function readSourcesReleases(file: string): SourcesReleases | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SourcesReleases;
  } catch {
    return null;
  }
}
