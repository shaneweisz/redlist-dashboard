/**
 * Why an assessed species' GBIF count needs a caveat (assessed.parquet's
 * count_note): "unlinked", linked to no CoL species, so none of its records are
 * counted (the table shows a dash rather than a 0 that would read as "no records
 * exist"); or "flagged", counted through the matcher's answer the sync's rule
 * doubts (flagged ⚑ beside the number).
 */
import type { DataVersions } from "@/lib/data/data-versions";

export type CountNote = "unlinked" | "flagged";

export function isCountNote(v: unknown): v is CountNote {
  return v === "unlinked" || v === "flagged";
}

/** The text for a note (the CSV export); the table's ⚑ explains a flagged count in full (gbif-match.ts). */
export function countNoteText(note: CountNote, versions: DataVersions): string {
  const col = versions.col ?? "Catalogue of Life";
  if (note === "flagged") return `Flagged: its match to ${col} is in doubt, so the count may include another species' records.`;
  return `Not yet linked to a species in ${col}, so none of its GBIF records are counted. ` +
    "Its name may be missing there, or need a person to decide which species it is.";
}
