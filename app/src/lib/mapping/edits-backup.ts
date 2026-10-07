import type { PinnedPlace } from "./geocode";
import { withDuplicateLinks, type AssessorDate, type Exclusion, type Georeference, type LocalityNote } from "./georeferences";
import type { PointFileImport } from "./iucn-point-file";

/**
 * The assessor's work for one species, as a file they can keep.
 *
 * Everything this dashboard holds for a species lives in the browser's local
 * storage: it is one person's reading of the evidence, not a correction anyone
 * has vouched for, and it has never been sent anywhere. That is the right
 * default and a bad single point of failure — "clear browsing data" takes a
 * fortnight of georeferencing with it, and no undo reaches across a reload.
 *
 * So: a file. One JSON document holding every store, written by hand from a
 * button, read back by another. Not a sync, not a format anyone else has to
 * understand — the thing you can put in a Dropbox folder and stop worrying.
 */
export const EDITS_BACKUP_VERSION = 1;

export interface EditsBackup {
  kind: "redlist-dashboard-edits";
  version: number;
  /** Which species this is the work for — a restore checks it. */
  speciesKey: string;
  scientificName?: string;
  savedAt: string;
  georeferences: Record<number, Georeference>;
  exclusions: Record<number, Exclusion>;
  dates: Record<number, AssessorDate>;
  /** How each locality was read, whether or not it ended up with a position. */
  notes?: Record<number, LocalityNote>;
  /** The imported point file, if one is loaded — it is part of the work. */
  pointFile?: PointFileImport | null;
  /**
   * The places pinned on the map.
   *
   * A pin dropped by hand names something no gazetteer knows — "the ridge the
   * 1987 collections came from" — so it can't be searched for again, which
   * makes it work rather than a view setting.
   */
  pins?: PinnedPlace[];
}

export function buildEditsBackup(backup: Omit<EditsBackup, "kind" | "version">): EditsBackup {
  return { kind: "redlist-dashboard-edits", version: EDITS_BACKUP_VERSION, ...backup };
}

/** What a backup holds, for the dialog that asks whether to restore it. */
export function summariseBackup(backup: EditsBackup): string {
  const parts = [
    `${Object.keys(backup.georeferences ?? {}).length} georeference`,
    `${Object.keys(backup.exclusions ?? {}).length} exclusion`,
    `${Object.keys(backup.dates ?? {}).length} date`,
  ].map((part) => {
    const [count] = part.split(" ");
    return count === "1" ? part : `${part}s`;
  });
  // Only where there are some: the three above are the shape of the work and
  // worth stating at zero, the rest are extras and read as noise at zero.
  const notes = Object.keys(backup.notes ?? {}).length;
  if (notes) parts.push(`${notes} locality note${notes === 1 ? "" : "s"}`);
  if (backup.pointFile) parts.push(`${backup.pointFile.points.length} imported point${backup.pointFile.points.length === 1 ? "" : "s"}`);
  if (backup.pins?.length) parts.push(`${backup.pins.length} pin${backup.pins.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * Reads a file back, and says why not rather than throwing.
 *
 * A restore replaces a species' work, so everything about it is checked before
 * it is offered: that the file is one of ours, that the version is one we
 * understand, and that it is the species you are looking at — restoring one
 * species' georeferences onto another would be a quiet disaster.
 */
export function readEditsBackup(
  text: string,
  speciesKey: string
): { backup: EditsBackup } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "That file isn't JSON — pick the file the save button produced." };
  }
  const backup = parsed as EditsBackup;
  if (!backup || backup.kind !== "redlist-dashboard-edits") {
    return { error: "That isn't a saved-work file from this dashboard." };
  }
  if (backup.version > EDITS_BACKUP_VERSION) {
    return { error: "That file was saved by a newer version of the dashboard than this one." };
  }
  if (backup.speciesKey !== speciesKey) {
    return {
      error: `That file holds the work for ${backup.scientificName ?? backup.speciesKey}, not this species.`,
    };
  }
  return {
    backup: {
      ...backup,
      georeferences: backup.georeferences ?? {},
      // A file from an older build carries its duplicates only in the wording.
      exclusions: withDuplicateLinks(backup.exclusions ?? {}),
      dates: backup.dates ?? {},
      notes: backup.notes ?? {},
      // Written by a build that had no pins in it, or by one that had none
      // placed: either way there is nothing to put back.
      pins: backup.pins ?? [],
    },
  };
}

/**
 * What to call the file: the species, and the moment it was saved.
 *
 * To the second, not the day. Saving twice in one sitting is the normal case —
 * it is the habit the button is there to encourage — and a name carrying only
 * the date made every save after the first collide, leaving the browser to
 * disambiguate them as "(1)", "(2)". Those sort by neither time nor content,
 * so picking the right one to restore from meant opening them.
 *
 * Colons are punctuation a filename can't portably carry, so the time is
 * hyphenated: the same shape this repo already stamps its data syncs with
 * (2026-08-25T15-40-40Z), which sorts lexicographically into chronological
 * order.
 */
export function backupFileName(scientificName: string | undefined, savedAt: string): string {
  const name = (scientificName || "species").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  const stamp = savedAt.slice(0, 19).replace(/:/g, "-");
  return `${name}_dashboard_work_${stamp}Z.json`;
}
