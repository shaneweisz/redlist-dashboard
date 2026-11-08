/**
 * tree_nodes, tree_aliases: the taxonomy tree's rules, as tables the SQL stages
 * can read. The tree itself stays in src/config/taxonomy-tree.ts, where the app
 * renders it; this writes out what decides which species each node holds.
 *
 * tree_nodes: one row per static tree node.
 *
 * Columns:
 *   node_id, parent_id     the node, and the node whose children it is among
 *   taxon_groups           the Table 1a groups its species come from
 *   class_in, class_out, order_in, order_out, family_in, family_out,
 *   genus_in, genus_out, name_in, name_out
 *                          its filter's include and exclude lists, lowercased
 *                          (taxonomy-tree.ts's SpeciesFilter); empty means no rule
 *   extra_names            species it holds whatever the rules above say
 *   override_names         CoL names it holds besides (col-described-overrides.ts:
 *                          CoL lumps Bison into Bos, so the Bison SG names them)
 *   catch_all              a catch-all ("Other Mammals": it excludes classes), which
 *                          leaves out what its class- or order-scoped siblings hold
 *   claims                 a sibling a catch-all leaves out (it names classes or orders)
 *
 * tree_aliases: one row per name IUCN and CoL spell differently at class or
 * order rank (taxonomy-sql.ts says why each is there).
 *
 * Columns:
 *   rank                   'class', 'order', or 'excluded' (a name every node but
 *                          the one overriding it leaves out: Bison's CoL names)
 *   name, alias            a filter naming `name` also matches rows naming `alias`
 */
import { NODE_INDEX, PARENT_INDEX } from "../../../src/lib/taxonomy-utils";
import { COL_CLASS_ALIASES, COL_ORDER_ALIASES } from "../../../src/lib/taxonomy-sql";
import { COL_SPECIES_NAME_OVERRIDES, COL_EXCLUDE_ALL_NODES } from "../../../src/config/col-described-overrides";
import { lit, openDuckDB } from "../sql";
import { output } from "../paths";

const list = (xs: string[] | undefined) => `[${(xs ?? []).map((x) => lit(x.toLowerCase())).join(", ")}]::VARCHAR[]`;

export async function buildTree(out: { treeNodes: string; treeAliases: string }): Promise<void> {
  const conn = await openDuckDB();
  const rows: string[] = [];
  for (const [id, node] of NODE_INDEX) {
    const f = node.filter;
    rows.push(`(${lit(id)}, ${PARENT_INDEX.has(id) ? lit(PARENT_INDEX.get(id)!) : "NULL"}, ${list(f.taxonGroups)},
      ${list(f.classNames)}, ${list(f.excludeClasses)}, ${list(f.orderNames)}, ${list(f.excludeOrders)},
      ${list(f.families)}, ${list(f.excludeFamilies)}, ${list(f.genera)}, ${list(f.excludeGenera)},
      ${list(f.speciesNames)}, ${list(f.excludeSpeciesNames)}, ${list(f.extraSpeciesNames)}, ${list(COL_SPECIES_NAME_OVERRIDES[id])},
      ${Boolean(f.excludeClasses?.length)}, ${Boolean(f.classNames?.length || f.orderNames?.length)})`);
  }
  await conn.run(`COPY (SELECT * FROM (VALUES ${rows.join(",\n")}) t(node_id, parent_id, taxon_groups,
      class_in, class_out, order_in, order_out, family_in, family_out, genus_in, genus_out, name_in, name_out,
      extra_names, override_names, catch_all, claims) ORDER BY node_id)
    TO ${lit(output(out.treeNodes))} (FORMAT parquet)`);

  const aliases = [
    ...Object.entries(COL_CLASS_ALIASES).flatMap(([name, as]) => as.map((a) => ["class", name, a])),
    ...Object.entries(COL_ORDER_ALIASES).flatMap(([name, as]) => as.map((a) => ["order", name, a])),
    ...COL_EXCLUDE_ALL_NODES.map((n) => ["excluded", n, n]),
  ];
  await conn.run(`COPY (SELECT * FROM (VALUES ${aliases.map((r) => `(${r.map((x) => lit(x.toLowerCase())).join(", ")})`).join(", ")})
      t(rank, name, alias) ORDER BY ALL)
    TO ${lit(output(out.treeAliases))} (FORMAT parquet)`);
  console.log(`   tree: ${rows.length} nodes, ${aliases.length} aliases`);
}
