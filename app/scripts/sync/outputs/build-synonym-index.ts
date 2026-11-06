/**
 * build-synonym-index: a name-sorted index mapping CoL synonyms → their
 * accepted species, so a search for an old/synonym name finds the current species.
 *
 * taxa.parquet has ~3.8M synonyms (status='synonym', parent_id → the accepted taxon).
 * We keep only those whose accepted name is a described species (species/: described), and carry whether that accepted species is IUCN-assessed (sis_id via
 * species_link) + its category — so a synonym hit routes to reassessments (assessed) or
 * new-assessments/leaf-node (NE), exactly like a direct hit.
 *
 * Sorted by synonym_name_lower so searchSpecies' prefix-range query prunes to ~1 row group
 * (fast even cold).
 *
 * Input: taxa.parquet, species/, species_link.parquet, assessed.parquet.
 * Output: search/synonym-index.parquet.
 *
 *   npx tsx scripts/sync/outputs/build-synonym-index.ts
 */
import * as fs from "fs";
import * as path from "path";
import { loadEnvFiles, DATA_DIR } from "../../lib/utils";
import { syncPath } from "../../../src/lib/data/sync-layout";
import { requireFiles } from "../paths";
import { openDuckDB } from "../sql";

export async function run(opts: { dataDir?: string } = {}): Promise<void> {
  const dir = opts.dataDir || DATA_DIR;
  const bb = path.join(dir, syncPath("taxa.parquet"));
  const link = path.join(dir, syncPath("species_link.parquet"));
  const asd = path.join(dir, syncPath("assessed.parquet"));
  const speciesGlob = path.join(dir, syncPath("species"), "**", "*.parquet");
  requireFiles("build-synonym-index", bb, link, asd, path.join(dir, syncPath("species")));
  const out = path.join(dir, syncPath("synonym-index.parquet"));

  const conn = await openDuckDB();
  await conn.run(`
    COPY (
      WITH assessed_link AS (
        -- The species whose own link this is, not one merely covering it; the lowest
        -- SIS id if two share it, so a rebuild picks the same one.
        SELECT col_id, arg_min(id, [CASE WHEN match_method = 'iucn_synonym_covered' THEN 1 ELSE 0 END, id]) AS sis_id
        FROM read_parquet('${link}') WHERE src = 'redlist' AND col_id IS NOT NULL GROUP BY col_id
      )
      SELECT
        syn.scientific_name AS synonym_name,
        lower(syn.scientific_name) AS synonym_name_lower,
        acc.scientific_name AS accepted_name,
        acc.col_id AS accepted_col_id,
        acc.taxon_group AS taxon_group,
        al.sis_id AS sis_id,                       -- NULL ⇒ not assessed (NE)
        coalesce(a.iucn_category, 'NE') AS category
      FROM read_parquet('${bb}') syn
      JOIN read_parquet('${speciesGlob}', hive_partitioning=true) acc ON acc.col_id = syn.parent_id
      LEFT JOIN assessed_link al ON al.col_id = acc.col_id
      LEFT JOIN read_parquet('${asd}') a ON a.id = al.sis_id
      WHERE syn.status = 'synonym'
        AND acc.described
        AND lower(syn.scientific_name) <> lower(acc.scientific_name)
      ORDER BY lower(syn.scientific_name)
    ) TO '${out}' (FORMAT parquet, ROW_GROUP_SIZE 50000)`);

  const rows = await (await conn.run(`SELECT count(*) AS n FROM read_parquet('${out}')`)).getRowObjects();
  const bytes = fs.statSync(out).size;
  console.log(`Wrote ${Number(rows[0].n).toLocaleString()} synonym→accepted rows (${(bytes / 1048576).toFixed(1)} MB) → ${out}`);
}

const isDirectRun = process.argv[1]?.endsWith("outputs/build-synonym-index.ts") || process.argv[1]?.endsWith("outputs/build-synonym-index.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
}
