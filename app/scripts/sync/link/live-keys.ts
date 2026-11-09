/**
 * taxonomy/gbif-live-keys.json: { taxonomy's GBIF key: live index's GBIF key },
 * for every key the app asks GBIF's live API with whose id differs there.
 *
 * The app's keys are ids of the taxonomy's XR, CoL's newest. GBIF's live index
 * (maps, record breakdowns, photos, nearby species, gbif.org links) runs the
 * XR GBIF last re-indexed against, which is often older: GBIF re-indexes a few
 * times a year, CoL releases monthly. The app's server reads this file to ask
 * GBIF with the ids its index uses (src/lib/gbif-live-keys.ts). It is empty
 * whenever GBIF runs CoL's newest XR.
 *
 * Built from: live_usages (sources/release-map.ts: the taxonomy's usages onto
 * the live XR's), snapshot_usages (for the groups, below), assessed and ne (the
 * keys the app uses), src/config/gbif-taxon-keys.json (the groups).
 *
 * Decisions:
 *   - Only the keys the app asks with: assessed and Not Evaluated species', and
 *     the higher taxa of the country map's groups.
 *   - A group's key comes from GBIF's own matcher when the config was derived
 *     (scripts/config/derive-gbif-taxon-keys.ts), so it is an id of whatever XR
 *     GBIF ran then. It is read as the taxonomy's id, else as the snapshot's
 *     (mapped onto the taxonomy's), and then mapped onto the live XR's
 *     (Ostracoda, B8TXJ in COL26.6 XR, is another id in COL26.10 XR).
 *   - A key the live XR has no counterpart for is left out: the app then asks
 *     with the taxonomy's id, and GBIF answers for what it has.
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
  const pairs = (await conn.runAndReadAll(`
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
    keyed AS (SELECT k AS app_key, k FROM species UNION SELECT config_key, k FROM grp WHERE k IS NOT NULL)
    SELECT keyed.app_key AS k, coalesce(l.to_key, keyed.k) AS v
    FROM keyed LEFT JOIN ${parquet(inputs.liveUsages)} l ON l.from_key = keyed.k
    WHERE (l.from_key IS NULL OR l.to_key IS NOT NULL) AND coalesce(l.to_key, keyed.k) <> keyed.app_key
    ORDER BY 1`)).getRowObjects() as { k: string; v: string }[];
  fs.writeFileSync(output(out), JSON.stringify(Object.fromEntries(pairs.map((p) => [p.k, p.v]))) + "\n");
  return pairs.length;
}
