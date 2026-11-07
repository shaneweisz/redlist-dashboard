/**
 * usage_owner: one row per CoL usage whose GBIF records count for a species,
 * naming that species. This table is the counting rule: every GBIF number on
 * the dashboard is a sum of occurrences joined to it.
 *
 * Built from: taxa, assessment_link.
 *
 * Columns:
 *   usage_key       a taxa.col_id; the occurrences' usage_key
 *   sis_taxon_id    the assessed species its records count for, else NULL
 *   link_usage_id   the assessment_link row it counts through (that row's
 *                   usage_id), for an assessed species
 *   col_id          the unassessed CoL species its records count for, else NULL
 *
 * Decisions, in order (the first that applies decides):
 *   1. A lumped species owns its own usage and everything under it (three levels
 *      down: the deepest case in the current release is three). Roots can nest:
 *      Zosterops simplex owns both the subspecies Z. japonicus simplex and the
 *      synonym Z. simplex filed under it, so a usage goes to the nearest root
 *      claiming it, and of two lumped species reaching it, the one whose own
 *      name it is.
 *   2. Otherwise a usage counts for its species (taxa.species_id): its own name,
 *      its synonyms, its subspecies, their BINs. If an assessed species' counted
 *      "own" link row is that species, for the assessed species.
 *   3. Otherwise, if no link row names that species at all, for the species
 *      itself, unassessed. A species linked only by rows that don't count
 *      (refused, duplicate) counts for no one.
 *
 * Checks: each usage has at most one owner. A violation means a number
 * somewhere is inflated, so the sync stops.
 */
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

export async function buildUsageOwners(inputs: { taxa: string; link: string }, usageOwnerFile: string): Promise<void> {
  const conn = await openDuckDB();
  await conn.run(`CREATE TEMP TABLE link AS SELECT * FROM ${parquet(inputs.link)}`);
  await conn.run(`CREATE TEMP TABLE taxa AS SELECT col_id, parent_id, species_id FROM ${parquet(inputs.taxa)}`);

  // 1. What each lumped species owns.
  await conn.run(`CREATE TEMP TABLE lumped AS
    WITH RECURSIVE down(sis, root, usage_key, depth) AS (
      SELECT sis_taxon_id, usage_id, usage_id, 0 FROM link WHERE verdict = 'lumped' AND counted
      UNION ALL
      SELECT d.sis, d.root, t.col_id, d.depth + 1 FROM down d JOIN taxa t ON t.parent_id = d.usage_key WHERE d.depth < 3)
    SELECT sis, root, usage_key FROM down
    QUALIFY row_number() OVER (PARTITION BY usage_key ORDER BY depth, sis, root) = 1`);

  // Every claim on a usage, before checking there is one per usage.
  await conn.run(`CREATE TEMP TABLE claims AS
    SELECT usage_key, sis AS sis_taxon_id, root AS link_usage_id, NULL::VARCHAR AS col_id FROM lumped
    UNION ALL
    -- 2. A species' usages, for the assessed species whose own row it is.
    SELECT t.col_id, l.sis_taxon_id, l.usage_id, NULL
    FROM taxa t JOIN link l ON l.usage_id = t.species_id AND l.verdict = 'own' AND l.counted
    WHERE t.col_id NOT IN (SELECT usage_key FROM lumped)
    UNION ALL
    -- 3. A species no link row names: its own.
    SELECT t.col_id, NULL, NULL, t.species_id
    FROM taxa t
    WHERE t.species_id IS NOT NULL
      AND t.col_id NOT IN (SELECT usage_key FROM lumped)
      AND t.species_id NOT IN (SELECT col_id FROM link WHERE col_id IS NOT NULL)`);

  const twice = (await conn.runAndReadAll(`
    SELECT usage_key, string_agg(coalesce('SIS ' || sis_taxon_id || ' via ' || link_usage_id, 'species ' || col_id), ', ' ORDER BY ALL) AS owners
    FROM claims GROUP BY usage_key HAVING count(*) > 1 ORDER BY usage_key LIMIT 10`)).getRowObjects();
  if (twice.length > 0) {
    throw new Error(`usage_owner: usages counted for more than one species:\n${twice.map((b) => `  ${b.usage_key}: ${b.owners}`).join("\n")}`);
  }
  await conn.run(`COPY (SELECT * FROM claims ORDER BY usage_key)
    TO ${lit(output(usageOwnerFile))} (FORMAT parquet, COMPRESSION zstd)`);
  const [s] = (await conn.runAndReadAll(`SELECT count(*) FILTER (sis_taxon_id IS NOT NULL) AS assessed, count(*) FILTER (col_id IS NOT NULL) AS unassessed
    FROM ${parquet(usageOwnerFile)}`)).getRowObjects();
  console.log(`   ${Number(s.assessed).toLocaleString()} usages count for an assessed species, ${Number(s.unassessed).toLocaleString()} for an unassessed one`);
}
