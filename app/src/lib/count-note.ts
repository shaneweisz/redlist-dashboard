/**
 * Why an assessed species' GBIF count isn't a count (assessed.parquet's
 * count_note): it is linked to no CoL species yet (the sync's match queue), so
 * none of its records are counted. The table shows a dash rather than a 0 that
 * would read as "no records exist".
 */
import type { DataVersions } from "@/lib/data/data-versions";

export type CountNote = "unlinked";

export function isCountNote(v: unknown): v is CountNote {
  return v === "unlinked";
}

export function countNoteText(_note: CountNote, versions: DataVersions): string {
  const col = versions.col ?? "Catalogue of Life";
  return `Not yet linked to a species in ${col}, so none of its GBIF records are counted. ` +
    "Its name may be missing there, or need a person to decide which species it is.";
}
