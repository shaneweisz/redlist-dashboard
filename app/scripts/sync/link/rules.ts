/**
 * assessment_link's row, and the one rule applied across species once every
 * species' rows exist: each CoL record counts for one assessed species at most
 * (docs/specs/matching.md, "Counting and the NE list"). What each species'
 * rows are is select.ts.
 */

export type LinkRelation = "is" | "part of" | "split into" | "refused" | "none" | "duplicate";

export interface LinkRow {
  sis_taxon_id: number;
  role: "primary" | "covered";
  /** The CoL species the record leads to (s). */
  col_species_id: string | null;
  /** The CoL taxon its records are counted from: s for is and split into, the record (or its infraspecific) for part of. */
  col_taxon_id: string | null;
  relation: LinkRelation;
  method: string;
  basis: "matcher" | "citation" | "synonym" | null;
  /** The primary row's step (1-6); covered rows' is null. */
  step: number | null;
  /** The species' doubts, ;-joined, on its primary row; NULL when none. */
  doubts: string | null;
  match_reason: string | null;
  col_treatment: string | null;
  match_description: string | null;
  to_review: string | null;
  counted: boolean;
}

/** A primary row in doubt: the app flags it (⚑). */
export const isFlaggedLink = (l: Pick<LinkRow, "doubts">) => !!l.doubts;

const RELATION_ORDER: Record<string, number> = { "is": 0, "split into": 1, "part of": 2 };

/**
 * Each record counts for one assessed species at most. Where two claim one
 * record, the first by: primary before covered; no doubts before doubts; is,
 * then split into, then part of; the species
 * whose CoL name is its Red List name as written; the lower SIS id. The
 * loser's row becomes a duplicate and counts nothing.
 *
 * `flagged`: the species with doubts. `exactName`: the species whose primary
 * row's CoL name is their Red List name, as written.
 */
export function oneOwnerPerUsage(links: LinkRow[], flagged: Set<number>, exactName: Set<number>): Set<number> {
  const rank = (l: LinkRow) => [l.role === "primary" ? 0 : 1, flagged.has(l.sis_taxon_id) ? 1 : 0, RELATION_ORDER[l.relation] ?? 3,
    exactName.has(l.sis_taxon_id) ? 0 : 1, l.sis_taxon_id];
  const claimants = links.filter((l) => l.counted && l.col_taxon_id).sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const owner = new Map<string, number>();
  const touched = new Set<number>();
  for (const l of claimants) {
    if (!owner.has(l.col_taxon_id!)) { owner.set(l.col_taxon_id!, l.sis_taxon_id); continue; }
    l.counted = false;
    l.relation = "duplicate";
    touched.add(l.sis_taxon_id);
  }
  return touched;
}
