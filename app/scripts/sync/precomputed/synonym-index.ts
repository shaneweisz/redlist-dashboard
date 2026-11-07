/**
 * search/synonym-index: one row per CoL synonym of a described species, sorted
 * by name, so a search for an old name finds the current species.
 *
 * taxa.parquet has ~3.8M synonyms (status='synonym', parent_id → the accepted taxon).
 * We keep only those whose accepted name is a described species (species/: described), and carry whether that accepted species is IUCN-assessed (sis_id via
 * assessment_link) + its category — so a synonym hit routes to reassessments (assessed) or
 * new-assessments/leaf-node (NE), exactly like a direct hit.
 *
 * Sorted by synonym_name_lower so searchSpecies' prefix-range query prunes to ~1 row group
 * (fast even cold).
 *
 * Built from: taxonomy/taxa, species/, assessment_link, lists/assessed.
 */
import * as fs from "fs";
import { output } from "../paths";
import { openDuckDB } from "../sql";

export async function buildSynonymIndex(
  inputs: { appTaxa: string; species: string; link: string; assessed: string },
  synonymIndexFile: string,
): Promise<void> {
  const bb = inputs.appTaxa;
  const link = inputs.link;
  const asd = inputs.assessed;
  const speciesGlob = `${inputs.species}/**/*.parquet`;
  const out = output(synonymIndexFile);

  const conn = await openDuckDB();
  await conn.run(`
    COPY (
      WITH assessed_link AS (
        -- The species whose own link this is, not one merely covering it; the lowest
        -- SIS id if two share it, so a rebuild picks the same one.
        SELECT col_id, arg_min(sis_taxon_id, [CASE WHEN role = 'covered' THEN 1 ELSE 0 END, sis_taxon_id]) AS sis_id
        FROM read_parquet('${link}') WHERE col_id IS NOT NULL GROUP BY col_id
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
