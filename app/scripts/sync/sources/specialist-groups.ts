/**
 * specialist_group_remits, rank_aliases: the SSC Specialist Groups' remits, as
 * tables the SQL stages can read. The groups themselves stay in
 * src/config/specialist-groups.ts (the "By SSC Specialist Group" layout's
 * sections and their groups), where the app renders them.
 *
 * Only Specialist Groups have rules. Every other row of the app's tree is an
 * IUCN group, or a named list of them (Invertebrates, Plants, Fungi), and a
 * species' IUCN group is its taxon_group.
 *
 * specialist_group_remits: one row per Specialist Group.
 *
 * Columns:
 *   group_id, section_id   the group, and its section (Mammal Specialist Groups, …)
 *   taxon_groups           the IUCN groups its species come from
 *   class_in, class_out, order_in, order_out, family_in, family_out,
 *   genus_in, genus_out, name_in, name_out
 *                          its remit's include and exclude lists, lowercased
 *                          (taxonomy-tree.ts's SpeciesFilter); empty means no rule
 *   extra_names            species it holds whatever the rules above say
 *   override_names         CoL names only it holds (col-described-overrides.ts:
 *                          CoL lumps Bison into Bos, so the Bison SG names them)
 *   catch_all              its section's "Other" group: it excludes classes, and
 *                          leaves out what its class- or order-scoped siblings hold
 *   claims                 a group the catch-all leaves out (it names classes or orders)
 *
 * rank_aliases: one row per class or order name IUCN and CoL spell differently
 * (taxonomy-sql.ts says why each is there).
 *
 * Columns:
 *   rank                   'class' or 'order'
 *   name, alias            a remit naming `name` also holds species filed under `alias`
 */
import { NODE_INDEX, PARENT_INDEX, SPECIALIST_GROUP_SECTIONS, isSpecialistGroup } from "../../../src/lib/taxonomy-utils";
import { COL_CLASS_ALIASES, COL_ORDER_ALIASES } from "../../../src/lib/taxonomy-sql";
import { COL_SPECIES_NAME_OVERRIDES } from "../../../src/config/col-described-overrides";
import { lit, openDuckDB } from "../sql";
import { output } from "../paths";

const list = (xs: string[] | undefined) => `[${(xs ?? []).map((x) => lit(x.toLowerCase())).join(", ")}]::VARCHAR[]`;

export async function buildSpecialistGroups(out: { remits: string; rankAliases: string }): Promise<void> {
  const conn = await openDuckDB();
  const rows: string[] = [];
  for (const [id, node] of NODE_INDEX) {
    if (!isSpecialistGroup(id)) continue;
    const f = node.filter;
    rows.push(`(${lit(id)}, ${lit(PARENT_INDEX.get(id)!)}, ${list(f.taxonGroups)},
      ${list(f.classNames)}, ${list(f.excludeClasses)}, ${list(f.orderNames)}, ${list(f.excludeOrders)},
      ${list(f.families)}, ${list(f.excludeFamilies)}, ${list(f.genera)}, ${list(f.excludeGenera)},
      ${list(f.speciesNames)}, ${list(f.excludeSpeciesNames)}, ${list(f.extraSpeciesNames)}, ${list(COL_SPECIES_NAME_OVERRIDES[id])},
      ${Boolean(f.excludeClasses?.length)}, ${Boolean(f.classNames?.length || f.orderNames?.length)})`);
  }
  await conn.run(`COPY (SELECT * FROM (VALUES ${rows.join(",\n")}) t(group_id, section_id, taxon_groups,
      class_in, class_out, order_in, order_out, family_in, family_out, genus_in, genus_out, name_in, name_out,
      extra_names, override_names, catch_all, claims) ORDER BY group_id)
    TO ${lit(output(out.remits))} (FORMAT parquet)`);

  const aliases = [
    ...Object.entries(COL_CLASS_ALIASES).flatMap(([name, as]) => as.map((a) => ["class", name, a])),
    ...Object.entries(COL_ORDER_ALIASES).flatMap(([name, as]) => as.map((a) => ["order", name, a])),
  ];
  await conn.run(`COPY (SELECT * FROM (VALUES ${aliases.map((r) => `(${r.map((x) => lit(x.toLowerCase())).join(", ")})`).join(", ")})
      t(rank, name, alias) ORDER BY ALL)
    TO ${lit(output(out.rankAliases))} (FORMAT parquet)`);
  console.log(`   ${rows.length} Specialist Groups in ${SPECIALIST_GROUP_SECTIONS.length} sections, ${aliases.length} rank aliases`);
}
