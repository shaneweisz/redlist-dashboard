/**
 * The note beside a GBIF count the snapshot can't give yet: the species'
 * taxonomy follows CoL's newest release, but GBIF filed the snapshot's records
 * under an older one that has no name for this species, so records carrying
 * its name were matched to something else until GBIF re-indexes
 * (scripts/sync/sources/release-map.ts). Lumps, renames and splits map across
 * as GBIF's re-index will file them, and carry no note.
 */
import type { DataVersions } from "@/lib/data/data-versions";

export type CountNote = "new";

export function isCountNote(v: unknown): v is CountNote {
  return v === "new";
}

export function countNoteText(_note: CountNote, versions: DataVersions): string {
  const older = versions.snapshotCol ?? "an earlier Catalogue of Life release";
  return `GBIF's snapshot files its records under ${older}, which doesn't have this species yet, so its count may be low until GBIF re-indexes.`;
}
