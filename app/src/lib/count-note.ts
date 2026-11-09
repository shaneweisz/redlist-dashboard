/**
 * The note beside a GBIF count the snapshot can't give in full: the species'
 * taxonomy follows CoL's newest release, but GBIF filed the snapshot's records
 * under an older one (scripts/sync/sources/release-map.ts). Lumps and renames
 * map across cleanly; a split or a species new since then can't, and says so.
 */
import type { DataVersions } from "@/lib/data/data-versions";

export type CountNote = "split" | "new";

export function isCountNote(v: unknown): v is CountNote {
  return v === "split" || v === "new";
}

export function countNoteText(note: CountNote, versions: DataVersions): string {
  const older = versions.snapshotCol ?? "an earlier Catalogue of Life release";
  const newer = versions.col ?? "the newest release";
  return note === "split"
    ? `GBIF's snapshot files its records under ${older}, which holds this species together with another that ${newer} separates, so its count may be high or low until GBIF re-indexes.`
    : `GBIF's snapshot files its records under ${older}, which doesn't have this species yet, so its count may be low until GBIF re-indexes.`;
}
