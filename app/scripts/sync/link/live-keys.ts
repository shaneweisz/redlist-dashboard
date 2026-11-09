/**
 * taxonomy/gbif-live-keys.json: { taxonomy's GBIF key: [ids to ask GBIF's live
 * API with, in order] }, for every key the app asks with whose id differs in
 * the live XR or the snapshot's.
 *
 * The app's keys are ids of the taxonomy's XR, CoL's newest. GBIF's live index
 * (maps, record breakdowns, photos, nearby species, gbif.org links) runs the
 * XR GBIF last re-indexed against, which is often older: GBIF re-indexes a few
 * times a year, CoL releases monthly. And while GBIF re-indexes (about five
 * days, announced on status.gbif.org), its records sit partly under the
 * previous XR's ids, the snapshot's. The app's server reads this file and
 * asks with the first id GBIF has records under (src/lib/gbif-live-keys.ts).
 * It is empty whenever the snapshot, GBIF and the taxonomy share one XR.
 *
 * Built from: live_usages and snapshot_usages (sources/release-map.ts: the
 * taxonomy's usages onto the live XR's, the snapshot's onto the taxonomy's),
 * assessed and ne (the keys the app uses), src/config/gbif-taxon-keys.json
 * (the groups).
 *
 * Decisions:
 *   - Only the keys the app asks with: assessed and Not Evaluated species', and
 *     the higher taxa of the country map's groups.
 *   - A group's key comes from GBIF's own matcher when the config was derived
 *     (scripts/config/derive-gbif-taxon-keys.ts), so it is an id of whatever XR
 *     GBIF ran then. It is read as the taxonomy's id, else as the snapshot's
 *     (mapped onto the taxonomy's), and then mapped onto the live XR's
 *     (Ostracoda, B8TXJ in COL26.6 XR, is another id in COL26.10 XR).
 *   - The ids to try: the live XR's, then the snapshot's (the usage that maps
 *     onto it by name, when one does). A key the live XR has no counterpart
 *     for tries the taxonomy's own id first.
 */
import * as fs from "fs";
import * as path from "path";
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

/** The higher taxa the app asks GBIF about (the country map's groups). */
function groupKeys(): string[] {
  const file = path.join(__dirname, "..", "..", "..", "src", "config", "gbif-taxon-keys.json");
  const groups = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, { taxonKey?: string }[]>;
  return [...new Set(Object.values(groups).flat().map((e) => e.taxonKey).filter((k): k is string => Boolean(k)))];
}

export async function writeGbifLiveKeys(
  inputs: { assessed: string; ne: string; liveUsages: string; snapshotUsages: string; taxa: string },
  out: string,
): Promise<number> {
  const conn = await openDuckDB();
  const groups = groupKeys();
  const rows = (await conn.runAndReadAll(`
    WITH species AS (
      SELECT gbif_species_key AS k FROM ${parquet(inputs.assessed)} WHERE gbif_species_key IS NOT NULL
      UNION SELECT gbif_species_key FROM ${parquet(inputs.ne)}),
    grp AS (
      SELECT g.k AS config_key,
             CASE WHEN t.col_id IS NOT NULL THEN g.k ELSE s.to_key END AS k
      FROM (SELECT unnest([${groups.length ? groups.map(lit).join(", ") : "NULL"}]::VARCHAR[]) AS k) g
      LEFT JOIN ${parquet(inputs.taxa)} t ON t.col_id = g.k
      LEFT JOIN ${parquet(inputs.snapshotUsages)} s ON s.from_key = g.k
      WHERE g.k IS NOT NULL),
    keyed AS (SELECT k AS app_key, k FROM species UNION SELECT config_key, k FROM grp WHERE k IS NOT NULL),
    -- The snapshot's id for a taxonomy usage: the one usage mapped onto it by name.
    snap AS (
      SELECT to_key AS k, any_value(from_key) AS snapshot_key FROM ${parquet(inputs.snapshotUsages)}
      WHERE how IN ('name', 'name only') GROUP BY 1 HAVING count(*) = 1)
    SELECT keyed.app_key AS k,
           CASE WHEN l.from_key IS NOT NULL AND l.to_key IS NOT NULL THEN l.to_key ELSE keyed.k END AS live,
           coalesce(sn.snapshot_key, keyed.k) AS snapshot
    FROM keyed
    LEFT JOIN ${parquet(inputs.liveUsages)} l ON l.from_key = keyed.k
    LEFT JOIN snap sn ON sn.k = keyed.k
    ORDER BY 1`)).getRowObjects() as { k: string; live: string; snapshot: string }[];
  const pairs = rows
    .map((r) => ({ k: r.k, tries: [...new Set([r.live, r.snapshot])] }))
    .filter((p) => p.tries.length > 1 || p.tries[0] !== p.k);
  fs.writeFileSync(output(out), JSON.stringify(Object.fromEntries(pairs.map((p) => [p.k, p.tries]))) + "\n");
  return pairs.length;
}
