/**
 * What the judge's answers would count, worked out as the sync would: an answer
 * becomes a decision, select() applies it, speciesRows() turns it into the
 * species' assessment_link rows, oneOwnerPerUsage() settles clashes with the
 * other species' rows, and count/owners.ts (usage_owner.sql's rule, checked
 * equal by checks/owners-check.ts) says who owns each record. Nothing here is
 * a second copy of a rule.
 *
 * It is local to each species: the CoL records under the species its facts
 * name, and what lies under its records, with every other species' rows on
 * them from the current build. Ownership of those records depends on nothing
 * else, as counting goes by CoL species and part-of roots.
 */

import { parquet, type tables } from "../paths";
import { openDuckDB, rows, writeTable } from "../sql";
import type { Selection, SpeciesInput } from "../link/select";
import { partOfRoots, speciesRows } from "../link/assessment-link";
import { oneOwnerPerUsage, type LinkRow } from "../link/rules";
import { PART, WHOLE, usageOwners, type OwnerClaim, type OwnerTaxon } from "../count/owners";

export interface Counted {
  /** What it counts: "own:<usage>" for each record it owns that has GBIF records, "whole:<species>" for each CoL species it counts whole. */
  key: string;
  /** Other assessed species that own records now and would own none. */
  emptied: number[];
}

export interface JudgeWorld { count(sp: SpeciesInput, s: Selection): Counted }

type BuiltRow = Pick<LinkRow, "sis_taxon_id" | "role" | "relation" | "col_species_id" | "col_taxon_id" | "basis" | "counted" | "doubts">;

const claimOf = (l: Pick<LinkRow, "sis_taxon_id" | "relation" | "counted" | "col_taxon_id" | "col_species_id">): OwnerClaim => ({
  sis_taxon_id: l.sis_taxon_id, relation: l.relation, col_taxon_id: l.col_taxon_id, col_species_id: l.col_species_id,
  counts: !l.counted ? "nothing" : l.relation === "is" || l.relation === "split into" ? WHOLE : l.relation === "part of" ? PART : "nothing",
});

/**
 * Loads the slices for these species: `of` gives each one's CoL record ids (its
 * facts' col_records) and the CoL species they lead to.
 */
export async function loadJudgeWorld(conn: Awaited<ReturnType<typeof openDuckDB>>, T: ReturnType<typeof tables>,
  of: Map<number, { records: string[]; species: string[] }>): Promise<JudgeWorld> {
  const recIds = [...new Set([...of.values()].flatMap((x) => x.records))];
  const spIds = [...new Set([...of.values()].flatMap((x) => x.species))];
  const root = await partOfRoots(conn, T.taxa, recIds);
  await writeTable(conn, "world_rec", { id: "VARCHAR" }, recIds.map((id) => ({ id })));
  await writeTable(conn, "world_sp", { id: "VARCHAR" }, spIds.map((id) => ({ id })));
  const taxa = await rows<OwnerTaxon>(conn, `
    WITH RECURSIVE down(id, depth) AS (
      SELECT id, 0 FROM world_rec
      UNION ALL SELECT t.col_id, d.depth + 1 FROM down d JOIN ${parquet(T.taxa)} t ON t.parent_id = d.id WHERE d.depth < 3)
    SELECT col_id, parent_id, species_id FROM ${parquet(T.taxa)}
    WHERE species_id IN (SELECT id FROM world_sp) OR col_id IN (SELECT id FROM down)`);
  await writeTable(conn, "world_taxa", { id: "VARCHAR" }, taxa.map((t) => ({ id: t.col_id })));
  const occ = new Map((await rows<{ id: string; n: number }>(conn, `
    SELECT usage_key AS id, sum(n)::BIGINT AS n FROM ${parquet(T.occurrences)} WHERE usage_key IN (SELECT id FROM world_taxa) GROUP BY 1`))
    .map((r) => [r.id, Number(r.n)]));
  const built = (await rows<BuiltRow>(conn, `
    SELECT sis_taxon_id::INTEGER AS sis_taxon_id, role, relation, col_species_id, col_taxon_id, basis, counted, doubts FROM ${parquet(T.link)}
    WHERE col_species_id IN (SELECT id FROM world_sp) OR col_taxon_id IN (SELECT id FROM world_taxa)`))
    .map((l) => ({ ...l, sis_taxon_id: Number(l.sis_taxon_id) }));

  const bySpecies = new Map<string, OwnerTaxon[]>(), byId = new Map<string, OwnerTaxon>(), children = new Map<string, string[]>();
  for (const t of taxa) {
    byId.set(t.col_id, t);
    if (t.species_id) (bySpecies.get(t.species_id) ?? bySpecies.set(t.species_id, []).get(t.species_id)!).push(t);
    if (t.parent_id) (children.get(t.parent_id) ?? children.set(t.parent_id, []).get(t.parent_id)!).push(t.col_id);
  }

  /** The species' slice: the records of its CoL species, and those under its records (three levels). */
  const sliceOf = (sis: number) => {
    const x = of.get(sis) ?? { records: [], species: [] };
    const ids = new Set<string>();
    for (const sp of x.species) for (const t of bySpecies.get(sp) ?? []) ids.add(t.col_id);
    let level = x.records;
    for (let d = 0; d <= 3 && level.length; d++) { const next: string[] = []; for (const u of level) { ids.add(u); next.push(...(children.get(u) ?? [])); } level = next; }
    const local = [...ids].map((id) => byId.get(id)).filter((t): t is OwnerTaxon => !!t);
    const ch = new Map<string, string[]>();
    for (const t of local) if (t.parent_id && ids.has(t.parent_id)) (ch.get(t.parent_id) ?? ch.set(t.parent_id, []).get(t.parent_id)!).push(t.col_id);
    const spSet = new Set(x.species);
    const others = built.filter((l) => l.sis_taxon_id !== sis && ((l.col_species_id && spSet.has(l.col_species_id)) || (l.col_taxon_id && ids.has(l.col_taxon_id))));
    const mineBuilt = built.filter((l) => l.sis_taxon_id === sis);
    return { local, ch, others, mineBuilt };
  };
  const slices = new Map<number, ReturnType<typeof sliceOf>>();

  /** Owned records with GBIF records, per species, given these rows for `sis`. */
  const owned = (sis: number, mine: Pick<LinkRow, "sis_taxon_id" | "role" | "relation" | "col_species_id" | "col_taxon_id" | "basis" | "counted" | "doubts">[]) => {
    const sl = slices.get(sis) ?? slices.set(sis, sliceOf(sis)).get(sis)!;
    const all = [...sl.others, ...mine].map((l) => ({ ...l })) as LinkRow[];
    const flagged = new Set(all.filter((l) => l.doubts).map((l) => l.sis_taxon_id));
    oneOwnerPerUsage(all, flagged, new Set());
    const owners = usageOwners(all.map(claimOf), sl.local, sl.ch);
    const per = new Map<number, string[]>();
    for (const [u, o] of owners) if (o.sis !== undefined && (occ.get(u) ?? 0) > 0) (per.get(o.sis) ?? per.set(o.sis, []).get(o.sis)!).push(u);
    return { per, rows: all };
  };

  return {
    count(sp, s) {
      const mine = speciesRows(s, sp, root);
      const { per, rows: all } = owned(sp.sis, mine);
      const whole = all.filter((l) => l.sis_taxon_id === sp.sis && l.counted && (l.relation === "is" || l.relation === "split into") && l.col_species_id).map((l) => l.col_species_id!);
      const key = [...(per.get(sp.sis) ?? []).map((u) => `own:${u}`), ...[...new Set(whole)].map((w) => `whole:${w}`)].sort().join(",");
      const before = owned(sp.sis, (slices.get(sp.sis)!).mineBuilt).per;
      const emptied = [...before.keys()].filter((o) => o !== sp.sis && (before.get(o)?.length ?? 0) > 0 && !(per.get(o)?.length));
      return { key, emptied };
    },
  };
}
