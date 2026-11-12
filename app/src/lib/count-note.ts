/**
 * Why an assessed species' GBIF count needs a caveat (assessed.parquet's
 * count_note): "unlinked", linked to no CoL species, so none of its records are
 * counted (the table shows a dash rather than a 0 that would read as "no records
 * exist"); or "unconfirmed", counted through the matcher's answer the sync's rule
 * doubts (flagged ⚑ beside the number).
 */
import type { DataVersions } from "@/lib/data/data-versions";

export type CountNote = "unlinked" | "unconfirmed";

export function isCountNote(v: unknown): v is CountNote {
  return v === "unlinked" || v === "unconfirmed";
}

/** The table's text for a note; an unconfirmed count's sentence comes from gbif-match.ts unconfirmedText. */
export function countNoteText(note: CountNote, versions: DataVersions): string {
  const col = versions.col ?? "Catalogue of Life";
  if (note === "unconfirmed") return `Unconfirmed match to ${col}: the count follows GBIF's matcher, which our rules doubt here, so it may include another organism's records.`;
  return `Not yet linked to a species in ${col}, so none of its GBIF records are counted. ` +
    "Its name may be missing there, or need a person to decide which species it is.";
}
