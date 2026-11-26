/**
 * Checks count/owners.ts (the TypeScript copy of the counting rule) against
 * count/usage_owner.sql on a whole build: every CoL usage must have the same
 * owner, or no owner, in both. Run after a change to either, or to the spec's
 * "Counting and the NE list":
 *
 *   npm run sync:owners-check
 */

import { parquet, tables } from "../paths";
import { openDuckDB, rows } from "../sql";
import { usageOwners, type OwnerClaim, type OwnerTaxon } from "../count/owners";

export async function ownersCheck(): Promise<{ usages: number; differ: { usage: string; sql: string; ts: string }[] }> {
  const T = tables();
  const conn = await openDuckDB();
  const claims = await rows<OwnerClaim>(conn, `SELECT sis_taxon_id::INTEGER AS sis_taxon_id, relation, counts, col_taxon_id, col_species_id FROM ${parquet(T.link)}`);
  const taxa = await rows<OwnerTaxon>(conn, `SELECT col_id, parent_id, species_id FROM ${parquet(T.taxa)}`);
  const ts = usageOwners(claims.map((c) => ({ ...c, sis_taxon_id: Number(c.sis_taxon_id) })), taxa);
  const sql = new Map((await rows<{ usage_key: string; sis: number | null; via: string | null; col_id: string | null }>(conn,
    `SELECT usage_key, sis_taxon_id::INTEGER AS sis, link_usage_id AS via, col_id FROM ${parquet(T.usageOwner)}`))
    .map((r) => [r.usage_key, r.sis != null ? `sis ${Number(r.sis)} via ${r.via}` : `col ${r.col_id}`]));
  const say = (o: ReturnType<typeof ts.get>) => (!o ? "none" : o.sis !== undefined ? `sis ${o.sis} via ${o.via}` : `col ${o.col_id}`);
  const differ: { usage: string; sql: string; ts: string }[] = [];
  for (const k of new Set([...sql.keys(), ...ts.keys()])) {
    const a = sql.get(k) ?? "none", b = say(ts.get(k));
    if (a !== b) differ.push({ usage: k, sql: a, ts: b });
  }
  return { usages: taxa.length, differ };
}

if (require.main === module) {
  ownersCheck().then(({ usages, differ }) => {
    console.log(`owners-check: ${usages.toLocaleString()} usages; ${differ.length.toLocaleString()} differ between usage_owner.sql and count/owners.ts`);
    for (const d of differ.slice(0, 20)) console.log(`  ${d.usage}: sql ${d.sql}; ts ${d.ts}`);
    process.exit(differ.length ? 1 : 0);
  });
}
