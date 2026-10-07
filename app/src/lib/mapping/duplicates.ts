import { duplicateOf, duplicateOfReason, resolvePrimary, type DuplicateLink, type Exclusion } from "./georeferences";

/**
 * Duplicate groups, as operations on the exclusions.
 *
 * A duplicate is an excluded record linked to the record kept, so
 * there is no second store — but the arithmetic of keeping one record of a
 * group, re-pointing its siblings and flattening what was a chain is worth
 * having on its own, where it can be read and tested without a map around it.
 */

/** The records set aside as duplicates, by the record each was kept for. */
export function duplicatesByPrimary<T>(
  records: T[],
  gbifIdOf: (record: T) => number,
  exclusions: Record<number, DuplicateLink>
): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const record of records) {
    const id = gbifIdOf(record);
    if (duplicateOf(exclusions[id]) == null) continue;
    const primary = resolvePrimary(id, exclusions);
    if (primary === id) continue;
    const kept = groups.get(primary);
    if (kept) kept.push(record);
    else groups.set(primary, [record]);
  }
  return groups;
}

/**
 * Keeps one record of a group and sets the others aside as duplicates of it.
 *
 * The one operation behind all three ways of saying it: dragging a row onto
 * another, "keep this one of N" on a point with records stacked under it, and
 * handing primacy to a record that was itself a duplicate.
 *
 * Three things it guarantees, each of which was a bug before it did:
 *
 * - The record kept is counted afterwards, whatever it was before. "Keep this
 *   one" on a record that was itself a duplicate used to leave every record in
 *   the group excluded, and the whole locality vanished from the list.
 * - Where the record kept was a duplicate, its old group comes with it, so a
 *   group is never left pointing at a record that is now a duplicate itself.
 * - Everything already set aside for a record now being set aside comes too,
 *   pointed at the record kept rather than at a copy of it. One specimen, one
 *   group, however many times you change your mind about which sheet to keep.
 *
 * Returns the exclusions as they should be — the caller commits them, so the
 * whole rearrangement is one edit and one undo.
 */
export function keepRecord({
  exclusions,
  gbifIDs,
  primaryGbifID,
  alsoDuplicates = [],
  stamp,
}: {
  exclusions: Record<number, Exclusion>;
  /** Every record in play — the group can only be gathered from what's loaded. */
  gbifIDs: number[];
  primaryGbifID: number;
  alsoDuplicates?: number[];
  stamp: { excludedAt: string; excludedBy?: string };
}): Record<number, Exclusion> {
  const setAside = new Set(alsoDuplicates);

  // The group the record kept is leaving, if it was in one.
  const oldPrimary = resolvePrimary(primaryGbifID, exclusions);
  if (oldPrimary !== primaryGbifID) {
    setAside.add(oldPrimary);
    for (const id of gbifIDs) {
      if (resolvePrimary(id, exclusions) === oldPrimary) setAside.add(id);
    }
  }

  // And the groups being folded in, repeated until nothing more joins: a group
  // can have been built up a record at a time.
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of gbifIDs) {
      if (id === primaryGbifID || setAside.has(id)) continue;
      const parent = duplicateOf(exclusions[id]);
      if (parent != null && setAside.has(parent)) {
        setAside.add(id);
        grew = true;
      }
    }
  }

  setAside.delete(primaryGbifID);
  const next = { ...exclusions };
  delete next[primaryGbifID];
  const justification = duplicateOfReason(primaryGbifID);
  for (const id of setAside) next[id] = { gbifID: id, justification, duplicateOf: primaryGbifID, ...stamp };
  return next;
}
