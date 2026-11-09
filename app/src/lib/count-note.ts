/**
 * The note beside a GBIF count the snapshot can't give yet: the species'
 * taxonomy follows CoL's newest release, but GBIF filed the snapshot's records
 * under an older one that has no name for this species, so records carrying
 * its name were matched to something else until GBIF re-indexes
 * (scripts/sync/sources/release-map.ts). Lumps, renames and splits map across
 * as GBIF's re-index will file them, and carry no note.
 *
 * Or no count at all: an assessed species linked to no CoL species yet (the
 * sync's match queue) counts nothing, shown as a dash rather than 0.
 */
import type { DataVersions } from "@/lib/data/data-versions";

export type CountNote = "new" | "unlinked";

export function isCountNote(v: unknown): v is CountNote {
  return v === "new" || v === "unlinked";
}

export function countNoteText(note: CountNote, versions: DataVersions): string {
  if (note === "unlinked") {
    const col = versions.col ?? "Catalogue of Life";
    return `Not yet linked to a species in ${col}, so none of its GBIF records are counted. ` +
      "Its name may be missing there, or need a person to decide which species it is.";
  }
  const older = versions.snapshotCol ?? "an earlier Catalogue of Life release";
  return `GBIF's snapshot files its records under ${older}, which doesn't have this species yet, so its count may be low until GBIF re-indexes.`;
}

