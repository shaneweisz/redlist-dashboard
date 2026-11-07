/**
 * src/config/col-taxon-ids.json: every taxon name the taxonomy tree mentions,
 * with its Catalogue of Life id, so the "# Described Species" tooltip can link
 * each name to its CoL page. src/config/col-taxon-aliases.json: the names the
 * tree spells differently from CoL, with CoL's name.
 *
 * Written into the repo, not published with the sync: the app's client code
 * imports them at build time, and CI type-checks with no sync data.
 *
 * Built from: taxonomy/taxa; the taxonomy tree and its CoL overrides.
 *
 * Decisions:
 *   - A name links only to an exact accepted match at its expected rank; one
 *     that doesn't resolve is left as plain text rather than linked to a guess.
 *   - Homonyms are settled by the other names in the same tree node, or by
 *     seeds/tree-homonyms.tsv where that doesn't, each with its reason.
 *   - A name CoL files under another name or rank follows CoL's synonym records,
 *     or seeds/tree-col-equivalents.tsv where they can't, each with its reason.
 */
import * as fs from "fs";
import * as path from "path";
import { TAXONOMY_TREE, type TaxonomyNode, type SpeciesFilter } from "../../../src/config/taxonomy-tree";
import { COL_SPECIES_NAME_OVERRIDES } from "../../../src/config/col-described-overrides";
import { openDuckDB } from "../sql";
import { readSeed } from "../seeds/seeds";

type Rank = "class" | "order" | "family" | "genus" | "species";

/**
 * Names the tree mentions, and for each the other names mentioned in the SAME
 * node — which is what disambiguates a homonym. The node that asks for the genus
 * Posidonia also asks for Posidoniaceae, Cymodoceaceae and Zosteraceae, so the
 * seagrass is the candidate sitting under one of those; the sponge is not.
 */
const siblings = new Map<string, Set<string>>();

/**
 * Homonyms the data cannot disambiguate on its own (seeds/tree-homonyms.tsv).
 *
 * Nomenclature codes are independent, so the same genus name can be validly used
 * in animals, plants and fungi at once: four accepted genera are called
 * Posidonia. Where the taxonomy tree's own context settles it (Posidonia sits in
 * the eponymous Posidoniaceae, which the same tree node names) the rules below
 * find it. Where it does not, guessing is worse than stating the answer: a
 * guess once linked genus:posidonia to a sponge, and differently on each run.
 */
const HOMONYM_OVERRIDES: Record<string, { id: string; why: string }> = Object.fromEntries(
  readSeed("tree-homonyms.tsv").map((r) => [r.tree_name, { id: r.col_id, why: r.why }]));

/**
 * Names the tree uses that CoL files under a different name or rank, where
 * following CoL's own synonym records (done automatically below) can't find the
 * match: CoL either has no record of the tree's name, or several candidates
 * (seeds/tree-col-equivalents.tsv). Each is shown in the tooltip as "Name (CoL
 * name on CoL)" and links to that CoL taxon, which must be accepted at its rank.
 */
const COL_EQUIVALENTS: Record<string, { name: string; rank: string; why: string }> = Object.fromEntries(
  readSeed("tree-col-equivalents.tsv").map((r) => [r.tree_name, { name: r.col_name, rank: r.col_rank, why: r.why }]));

function collectNames(): Map<string, Rank> {
  const names = new Map<string, Rank>();
  const add = (rank: Rank, list: string[] | undefined) => {
    for (const n of list ?? []) names.set(n.toLowerCase(), rank);
  };
  const walk = (node: TaxonomyNode) => {
    const f: SpeciesFilter = node.filter;
    const here = [
      ...(f.classNames ?? []), ...(f.orderNames ?? []), ...(f.families ?? []),
      ...(f.genera ?? []),
    ].map((n) => n.toLowerCase());
    for (const n of here) {
      if (!siblings.has(n)) siblings.set(n, new Set());
      for (const o of here) if (o !== n) siblings.get(n)!.add(o);
    }
    add("class", f.classNames);
    add("class", f.excludeClasses);
    add("order", f.orderNames);
    add("order", f.excludeOrders);
    add("family", f.families);
    add("family", f.excludeFamilies);
    add("genus", f.genera);
    add("genus", f.excludeGenera);
    add("species", f.speciesNames);
    add("species", f.excludeSpeciesNames);
    for (const c of node.children ?? []) walk(c);
  };
  walk(TAXONOMY_TREE);
  for (const arr of Object.values(COL_SPECIES_NAME_OVERRIDES)) add("species", arr);
  return names;
}

const CONFIG = path.join(__dirname, "..", "..", "..", "src", "config");

export async function buildColTaxonIds(
  inputs: { appTaxa: string },
  out: { colTaxonIds?: string; colTaxonAliases?: string } = {},
): Promise<Record<string, string>> {
  const taxaPath = inputs.appTaxa;
  const outPath = out.colTaxonIds ?? path.join(CONFIG, "col-taxon-ids.json");

  const names = collectNames();
  const conn = await openDuckDB();
  await conn.run(`CREATE TEMP TABLE names(rank VARCHAR, name VARCHAR);`);
  const values = [...names.entries()].map(([n, r]) => `('${r}', '${n.replace(/'/g, "''")}')`).join(",");
  await conn.run(`INSERT INTO names VALUES ${values};`);

  // Homonyms are real and this join finds all of them: four accepted genera are
  // named Posidonia — the seagrass, a bivalve, a grass, and a sponge. Taking rows
  // in whatever order the scan returns made the result a lottery, and it lost:
  // genus:posidonia shipped pointing at the sponge (Halisarcidae) instead of the
  // seagrass, and re-running produced different answers for two entries.
  //
  // Preference order, most specific first:
  //   1. the taxon whose lineage the taxonomy tree actually asks for, i.e. one
  //      whose ancestors include another id the tree already resolves;
  //   2. a taxon with authorship, which a bare unattributed name usually is not;
  //   3. lowest col_id, purely so the output is stable rather than arbitrary.
  // Ancestors, not just the immediate parent. The tree names families, but a
  // genus often hangs off a tribe or subfamily below one — Caccobius sits in
  // Onthophagini, inside the Scarabaeidae the tree actually asks for, so matching
  // on the parent alone found nothing and fell through to a fungus.
  const rows = await (await conn.run(`
    WITH RECURSIVE b AS (SELECT col_id, parent_id, rank, scientific_name, authorship, status
               FROM read_parquet('${taxaPath}')),
    lineage AS (
      SELECT col_id AS root, parent_id, 0 AS depth FROM b
      UNION ALL
      SELECT l.root, p.parent_id, l.depth + 1
      FROM lineage l JOIN b p ON p.col_id = l.parent_id
      WHERE l.depth < 8
    )
    SELECT n.rank, n.name, b.col_id, b.authorship,
           (SELECT p.scientific_name FROM b p WHERE p.col_id = b.parent_id) AS parent_name,
           list(DISTINCT lower(a.scientific_name)) AS ancestors
    FROM names n
    JOIN b ON b.rank = n.rank AND lower(b.scientific_name) = n.name AND b.status = 'accepted'
    LEFT JOIN lineage l ON l.root = b.col_id
    LEFT JOIN b a ON a.col_id = l.parent_id
    GROUP BY n.rank, n.name, b.col_id, b.authorship, b.parent_id
    ORDER BY n.rank, n.name, b.col_id
  `)).getRowObjects();

  const wanted = new Set([...names.keys()]);
  const byKey = new Map<string, Array<{ id: string; authorship: string; parent: string; ancestors: Set<string> }>>();
  for (const r of rows) {
    const k = `${r.rank}:${r.name}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push({
      id: String(r.col_id),
      authorship: r.authorship == null ? "" : String(r.authorship),
      parent: r.parent_name == null ? "" : String(r.parent_name).toLowerCase(),
      // DuckDB's list type arrives as a wrapper object, not a JS array.
      ancestors: new Set(
        (Array.isArray(r.ancestors) ? r.ancestors : (r.ancestors as { items?: unknown[] })?.items ?? [])
          .map((a) => String(a))
      ),
    });
  }

  const map: Record<string, string> = {};
  const ambiguous: string[] = [];
  for (const [k, cands] of byKey) {
    if (cands.length === 1) {
      map[k] = cands[0].id;
      continue;
    }
    const name = k.split(":").slice(1).join(":");
    const sibs = siblings.get(name) ?? new Set<string>();
    // Most specific first: the type genus of an eponymous family (Posidonia sits
    // in Posidoniaceae), then a parent the same tree node also names, then any
    // parent the tree knows, then a name that carries authorship at all.
    const tiers = [
      cands.filter((c) => c.parent.startsWith(name.split(" ")[0])),
      cands.filter((c) => [...sibs].some((sb) => c.ancestors.has(sb))),
      cands.filter((c) => [...c.ancestors].some((a) => wanted.has(a))),
      cands.filter((c) => c.authorship !== ""),
    ];
    const override = HOMONYM_OVERRIDES[k];
    const overridden = override && cands.find((c) => c.id === override.id);
    const pool = tiers.find((t) => t.length > 0) ?? cands;
    const chosen = overridden ?? pool.sort((a, b) => a.id.localeCompare(b.id))[0];
    if (override && !overridden) {
      throw new Error(
        `col-taxon-ids: ${k} is pinned to ${override.id} (${override.why}), but that id is no ` +
        `longer an accepted ${k.split(":")[0]} in this Catalogue of Life release. It was probably ` +
        `renumbered — re-pick it from the candidates and update seeds/tree-homonyms.tsv.`
      );
    }
    map[k] = chosen.id;
    ambiguous.push(`${k} (${cands.length} accepted homonyms → ${chosen.id}${chosen.parent ? ` under ${chosen.parent}` : ""})`);
  }

  // Names CoL files under another name: a hand-written COL_EQUIVALENTS entry, or
  // else CoL's own synonym record at the same rank (Palaemonetes antrorum ->
  // Palaemon antrorum, Ziphiidae -> Hyperoodontidae). These link to the CoL
  // taxon, and aliasesOutPath records its name so the tooltip can say so.
  const aliases: Record<string, { name: string; rank: string }> = {};
  const pending = [...names.entries()].filter(([n, r]) => !map[`${r}:${n}`]);
  for (const k of Object.keys(COL_EQUIVALENTS)) {
    if (!names.has(k.split(":").slice(1).join(":"))) {
      throw new Error(`col-taxon-ids: seeds/tree-col-equivalents.tsv has ${k}, which the taxonomy tree no longer uses — remove it.`);
    }
  }
  if (pending.length) {
    const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;
    await conn.run(`CREATE TEMP TABLE pending(k VARCHAR, rank VARCHAR, name VARCHAR, target VARCHAR, target_rank VARCHAR);`);
    await conn.run(`INSERT INTO pending VALUES ${pending.map(([n, r]) => {
      const eq = COL_EQUIVALENTS[`${r}:${n}`];
      return `(${esc(`${r}:${n}`)}, ${esc(r)}, ${esc(n)}, ${eq ? esc(eq.name.toLowerCase()) : "NULL"}, ${eq ? esc(eq.rank) : "NULL"})`;
    }).join(",")};`);
    const aliasRows = await (await conn.run(`
      WITH RECURSIVE b AS (SELECT col_id, parent_id, rank, scientific_name, authorship, status
                 FROM read_parquet('${taxaPath}')),
      cand AS (
        SELECT p.k, t.col_id FROM pending p
        JOIN b t ON p.target IS NOT NULL AND lower(t.scientific_name) = p.target
                AND t.rank = p.target_rank AND t.status = 'accepted'
        UNION
        SELECT p.k, t.col_id FROM pending p
        JOIN b s ON p.target IS NULL AND lower(s.scientific_name) = p.name AND s.rank = p.rank
                AND s.status NOT IN ('accepted', 'provisionally accepted')
        JOIN b t ON t.col_id = s.parent_id AND t.status = 'accepted'
      ),
      lineage AS (
        SELECT DISTINCT c.col_id AS root, t.parent_id, 0 AS depth FROM cand c JOIN b t ON t.col_id = c.col_id
        UNION ALL
        SELECT l.root, p.parent_id, l.depth + 1 FROM lineage l JOIN b p ON p.col_id = l.parent_id WHERE l.depth < 8
      )
      SELECT c.k, t.col_id, t.scientific_name, t.rank, t.authorship,
             list(DISTINCT lower(a.scientific_name)) AS ancestors
      FROM cand c JOIN b t ON t.col_id = c.col_id
      LEFT JOIN lineage l ON l.root = c.col_id
      LEFT JOIN b a ON a.col_id = l.parent_id
      GROUP BY c.k, t.col_id, t.scientific_name, t.rank, t.authorship
      ORDER BY c.k, t.col_id
    `)).getRowObjects();
    const byAlias = new Map<string, Array<{ id: string; name: string; rank: string; authorship: string; ancestors: Set<string> }>>();
    for (const r of aliasRows) {
      const k = String(r.k);
      if (!byAlias.has(k)) byAlias.set(k, []);
      byAlias.get(k)!.push({
        id: String(r.col_id), name: String(r.scientific_name), rank: String(r.rank),
        authorship: r.authorship == null ? "" : String(r.authorship),
        ancestors: new Set((Array.isArray(r.ancestors) ? r.ancestors : (r.ancestors as { items?: unknown[] })?.items ?? []).map((a) => String(a))),
      });
    }
    for (const k of Object.keys(COL_EQUIVALENTS)) {
      if (pending.some(([n, r]) => `${r}:${n}` === k) && !byAlias.has(k)) {
        const eq = COL_EQUIVALENTS[k];
        throw new Error(`col-taxon-ids: seeds/tree-col-equivalents.tsv maps ${k} to ${eq.name} (${eq.rank}), which is not an accepted ${eq.rank} in this Catalogue of Life release.`);
      }
    }
    for (const [k, cands] of byAlias) {
      const name = k.split(":").slice(1).join(":");
      const sibs = siblings.get(name) ?? new Set<string>();
      // Same tie-break as the homonyms above, led by a species keeping its own
      // epithet (Palaemonetes sinensis -> Palaemon sinensis, not P. tonkinensis).
      const epithet = name.split(" ")[1];
      const tiers = [
        epithet ? cands.filter((c) => c.name.toLowerCase().split(" ")[1] === epithet) : [],
        cands.filter((c) => [...sibs].some((sb) => c.ancestors.has(sb))),
        cands.filter((c) => [...c.ancestors].some((a) => wanted.has(a))),
        cands.filter((c) => c.authorship !== ""),
      ];
      const chosen = (tiers.find((t) => t.length > 0) ?? cands).sort((a, b) => a.id.localeCompare(b.id))[0];
      if (cands.length > 1) ambiguous.push(`${k} (${cands.length} CoL candidates → ${chosen.name})`);
      map[k] = chosen.id;
      aliases[k] = { name: chosen.name, rank: chosen.rank };
    }
  }
  const aliasesOutPath = out.colTaxonAliases ?? path.join(CONFIG, "col-taxon-aliases.json");
  fs.writeFileSync(aliasesOutPath, JSON.stringify(Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");

  const sortedMap = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(outPath, JSON.stringify(sortedMap, null, 2) + "\n");

  const unresolved = [...names.entries()].filter(([n, r]) => !map[`${r}:${n}`]);
  console.log(`   col-taxon-ids: resolved ${Object.keys(map).length}/${names.size} names → ${outPath}`);
  const aliasList = Object.entries(aliases);
  if (aliasList.length) {
    console.log(`  linked under their CoL name (${aliasList.length}):`, aliasList.map(([k, a]) => `${k} → ${a.name}`).join(", "));
  }
  if (ambiguous.length) {
    console.log(`  several CoL candidates, resolved by lineage/authorship/id (${ambiguous.length}):`);
    for (const a of ambiguous) console.log(`    ${a}`);
  }
  if (unresolved.length) {
    console.log(`  unresolved (${unresolved.length}, left as plain text):`, unresolved.map(([n, r]) => `${r}:${n}`).join(", "));
  }
  return map;
}
