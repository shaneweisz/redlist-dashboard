/**
 * Who each CoL record's GBIF records count for: count/usage_owner.sql's rule
 * (docs/specs/matching.md, "Counting and the NE list"), in TypeScript, so the
 * rebuild check's counting can be compared without a sync. The two are kept
 * the same by checks/owners-check.ts, which compares them on a whole build.
 *
 * The first that applies:
 *   1. Part of: a part-of row's record (its col_taxon_id) owns itself and what
 *      lies under it, three levels down; a usage two roots reach goes to the
 *      nearest, then the lower SIS id, then the lower root id.
 *   2. Whole species: else the assessed species whose is or split-into row
 *      counts its species (taxa.species_id) whole.
 *   3. Unassessed: else its species itself, unless an is or split-into row
 *      names that species (then it counts for no one).
 */

export interface OwnerClaim {
  sis_taxon_id: number;
  relation: string;
  /** "the whole CoL species", "only records under its own name" or "nothing" (assessment_link.counts). */
  counts: string;
  col_taxon_id: string | null;
  col_species_id: string | null;
}

export interface OwnerTaxon { col_id: string; parent_id: string | null; species_id: string | null }

export type Owner = { sis: number; via: string; col_id?: undefined } | { col_id: string; sis?: undefined };

export const WHOLE = "the whole CoL species";
export const PART = "only records under its own name";

/** Children of each usage, for walking down from a part-of root. */
export function childrenOf(taxa: Iterable<OwnerTaxon>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of taxa) if (t.parent_id) (out.get(t.parent_id) ?? out.set(t.parent_id, []).get(t.parent_id)!).push(t.col_id);
  return out;
}

export function usageOwners(claims: OwnerClaim[], taxa: Iterable<OwnerTaxon>, children: Map<string, string[]> = childrenOf(taxa)): Map<string, Owner> {
  // 1. What each part-of root reaches, three levels down; the nearest root wins, then the lower SIS id, then the lower root id.
  const lumped = new Map<string, { depth: number; sis: number; root: string }>();
  for (const c of claims) {
    if (c.counts !== PART || !c.col_taxon_id) continue;
    let level = [c.col_taxon_id];
    for (let depth = 0; depth <= 3 && level.length; depth++) {
      const next: string[] = [];
      for (const u of level) {
        const cur = lumped.get(u);
        const better = !cur || depth < cur.depth || (depth === cur.depth && (c.sis_taxon_id < cur.sis || (c.sis_taxon_id === cur.sis && c.col_taxon_id < cur.root)));
        if (better) lumped.set(u, { depth, sis: c.sis_taxon_id, root: c.col_taxon_id });
        if (depth < 3) next.push(...(children.get(u) ?? []));
      }
      level = next;
    }
  }
  // 2 and 3. The species counted whole, by whom; the species an is or split-into row names.
  const whole = new Map<string, number>();
  for (const c of claims) if (c.counts === WHOLE && c.col_taxon_id) {
    const cur = whole.get(c.col_taxon_id);
    if (cur === undefined || c.sis_taxon_id < cur) whole.set(c.col_taxon_id, c.sis_taxon_id);
  }
  const named = new Set(claims.filter((c) => (c.relation === "is" || c.relation === "split into") && c.col_species_id).map((c) => c.col_species_id!));
  const out = new Map<string, Owner>();
  for (const t of taxa) {
    const l = lumped.get(t.col_id);
    if (l) { out.set(t.col_id, { sis: l.sis, via: l.root }); continue; }
    if (!t.species_id) continue;
    const w = whole.get(t.species_id);
    if (w !== undefined) out.set(t.col_id, { sis: w, via: t.species_id });
    else if (!named.has(t.species_id)) out.set(t.col_id, { col_id: t.species_id });
  }
  return out;
}
