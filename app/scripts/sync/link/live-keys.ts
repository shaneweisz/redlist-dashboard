/**
 * live_keys: the id GBIF's *live* occurrence index files a species' records
 * under, where that differs from the snapshot's. The app's live GBIF queries
 * (maps, record breakdowns, photos, nearby species) go to that index, not the
 * snapshot, so they need its ids.
 *
 * The two differ for the weeks between GBIF re-indexing against a newer XR and
 * the first snapshot filed under it; CoL renumbers about 2% of ids per release.
 * Every other month the releases are the same and this table is empty.
 *
 * Built from: the snapshot's taxa, and the same link stage run on GBIF's live
 * XR (its taxa, matcher answers and link), see sync.ts.
 *
 * Columns:
 *   kind      'assessed' (id is a SIS taxon id) | 'species' | 'group' (id is a
 *             CoL id; a group is a higher taxon the app asks GBIF about,
 *             src/config/gbif-taxon-keys.json)
 *   id        the species, as the snapshot names it
 *   live_key  the live index's id for it
 *
 * Decisions:
 *   - An assessed species takes its live link's usage_id: where its records
 *     start, by the same rules as the snapshot's link (a rename follows to the
 *     new accepted species, a lump keeps to its own name's usage). Refused,
 *     duplicate and unlinked species get no row.
 *   - Any other CoL species follows its name: the live usage with its id and
 *     name, else the one usage with its name and authorship, and then that
 *     usage's species (taxa.species_id, the species GBIF counts its records
 *     towards).
 *   - A group follows its name and rank to the live release's accepted taxon
 *     (Ostracoda, B8TXJ in COL26.6 XR, is another id in COL26.10 XR).
 *   - Only differences are kept for CoL species (a few percent of 2.3M); every
 *     assessed species gets a row, and the lists keep it only where it differs.
 *   - Never used for counts or taxonomy: those come from the snapshot's release.
 */
import * as fs from "fs";
import * as path from "path";
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

/**
 * taxonomy/gbif-live-keys.json: { snapshot GBIF key: live GBIF key }, for every
 * assessed and Not Evaluated species whose key differs (lists' gbif_live_key).
 * The app's server reads it to point live GBIF queries at the live index
 * (src/lib/gbif-live-keys.ts). Empty most months.
 */
export async function writeGbifLiveKeys(inputs: { assessed: string; ne: string; liveKeys: string }, out: string): Promise<number> {
  const conn = await openDuckDB();
  const pairs = (await conn.runAndReadAll(`
    SELECT gbif_species_key AS k, gbif_live_key AS v FROM ${parquet(inputs.assessed)} WHERE gbif_live_key IS NOT NULL
    UNION SELECT gbif_species_key, gbif_live_key FROM ${parquet(inputs.ne)} WHERE gbif_live_key IS NOT NULL
    UNION SELECT id, live_key FROM ${parquet(inputs.liveKeys)} WHERE kind = 'group'
    ORDER BY 1`)).getRowObjects() as { k: string; v: string }[];
  fs.writeFileSync(output(out), JSON.stringify(Object.fromEntries(pairs.map((p) => [p.k, p.v]))) + "\n");
  return pairs.length;
}

/** The higher taxa the app asks GBIF about (the country map's groups). */
function groupKeys(): string[] {
  const file = path.join(__dirname, "..", "..", "..", "src", "config", "gbif-taxon-keys.json");
  const groups = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, { taxonKey?: string }[]>;
  return [...new Set(Object.values(groups).flat().map((e) => e.taxonKey).filter((k): k is string => Boolean(k)))];
}

export async function buildLiveKeys(
  inputs: { taxa: string; live: { taxa: string; link: string } | null },
  out: string,
): Promise<number> {
  const conn = await openDuckDB();
  const empty = `SELECT NULL::VARCHAR AS kind, NULL::VARCHAR AS id, NULL::VARCHAR AS live_key WHERE false`;
  const sql = !inputs.live ? empty : `
    WITH snap AS (
      SELECT col_id, scientific_name, authorship FROM ${parquet(inputs.taxa)}
      WHERE rank = 'species' AND status = 'accepted'),
    live AS (SELECT col_id, scientific_name, authorship, species_id, rank, status FROM ${parquet(inputs.live.taxa)}),
    by_id AS (
      SELECT s.col_id, l.species_id AS live_key FROM snap s
      JOIN live l ON l.col_id = s.col_id AND l.scientific_name = s.scientific_name),
    by_name AS (
      SELECT s.col_id, any_value(l.species_id) AS live_key FROM snap s
      JOIN live l ON l.scientific_name = s.scientific_name AND l.authorship IS NOT DISTINCT FROM s.authorship
      WHERE s.col_id NOT IN (SELECT col_id FROM by_id)
      GROUP BY s.col_id HAVING count(DISTINCT l.species_id) = 1),
    species AS (SELECT * FROM by_id UNION ALL SELECT * FROM by_name),
    groups AS (
      SELECT g.id, any_value(l.col_id) AS live_key
      FROM (SELECT unnest([${groupKeys().map(lit).join(", ")}]::VARCHAR[]) AS id) g
      JOIN ${parquet(inputs.taxa)} s ON s.col_id = g.id
      JOIN live l ON l.scientific_name = s.scientific_name AND l.rank = s.rank AND l.status = 'accepted'
      GROUP BY g.id HAVING count(DISTINCT l.col_id) = 1)
    SELECT 'assessed' AS kind, sis_taxon_id::VARCHAR AS id, usage_id AS live_key
    FROM ${parquet(inputs.live.link)}
    WHERE role = 'primary' AND verdict IN ('own', 'lumped') AND usage_id IS NOT NULL
    UNION ALL
    SELECT 'species', col_id, live_key FROM species WHERE live_key IS NOT NULL AND live_key <> col_id
    UNION ALL
    SELECT 'group', id, live_key FROM groups WHERE live_key <> id`;
  await conn.run(`COPY (${sql} ORDER BY kind, id) TO ${lit(output(out))} (FORMAT parquet, COMPRESSION zstd)`);
  const [{ n }] = (await conn.runAndReadAll(`SELECT count(*)::INTEGER AS n FROM ${parquet(out)} WHERE kind = 'species'`)).getRowObjects() as { n: number }[];
  return n;
}
