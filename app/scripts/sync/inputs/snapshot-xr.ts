/**
 * The XR a GBIF snapshot is keyed by: the one GBIF's occurrence index ran when
 * the snapshot was made. Snapshots don't say (gbif/occurrence#559), and GBIF
 * re-indexes between them (COL26.10 XR went live after the 1 November 2026
 * snapshot, which is COL26.6 XR), so it is found by testing: the XR that holds
 * all but a sliver of the snapshot's keys. CoL renumbers about 2% of ids per
 * release, so the wrong XR leaves out ~2% of records and the right one a few
 * hundred of billions (976 of 3.9 billion, 2026-11-01).
 *
 * Candidates, in order: GBIF_SNAPSHOT_XR, the XRs the last sync used, GBIF's
 * live index's, the taxonomy's, then CoL's XRs newest first. Each tested is
 * downloaded (cached by key), so the likely ones go first. The answer is cached
 * beside the snapshot's counts.
 */
import * as fs from "fs";
import * as path from "path";
import { lit, openDuckDB } from "../sql";
import { ensureXr } from "./col";
import { xreleases, type XrDatasetInfo } from "./col-xr";

/** At most this share of a snapshot's records may have keys its XR doesn't hold. */
export const MAX_UNKNOWN_KEY_SHARE = 0.001;

/** The share of the snapshot's records whose keys `nameUsage` doesn't hold. */
export async function unknownKeyShare(snapshotCounts: string, nameUsage: string): Promise<number> {
  const conn = await openDuckDB();
  const [r] = (await conn.runAndReadAll(`
    WITH k AS (SELECT usage_key, sum(n) AS n FROM read_parquet(${lit(path.join(snapshotCounts, "counts-*.parquet"))}) GROUP BY 1),
         ids AS (SELECT "col:ID" AS id FROM read_csv(${lit(nameUsage)}, delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true))
    SELECT sum(n) AS total, coalesce(sum(n) FILTER (ids.id IS NULL), 0) AS unknown FROM k LEFT JOIN ids ON ids.id = k.usage_key`)).getRowObjects();
  return Number(r.unknown) / Math.max(1, Number(r.total));
}

export async function resolveSnapshotXr(
  snapshotCounts: string,
  candidates: (XrDatasetInfo | null)[],
): Promise<XrDatasetInfo> {
  const cache = path.join(snapshotCounts, "xr.json");
  const pinned = process.env.GBIF_SNAPSHOT_XR;
  if (!pinned && fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf-8")) as XrDatasetInfo;
  const all = pinned ? (await xreleases()).filter((x) => x.key === pinned || x.alias === pinned)
    : [...candidates.filter((c): c is XrDatasetInfo => c !== null), ...(await xreleases())];
  const tried = new Set<string>();
  for (const xr of all) {
    if (tried.has(xr.key)) continue;
    tried.add(xr.key);
    const share = await unknownKeyShare(snapshotCounts, await ensureXr(xr));
    console.log(`   ${xr.alias} holds all but ${(share * 100).toFixed(3)}% of the snapshot's records' keys`);
    if (share <= MAX_UNKNOWN_KEY_SHARE) {
      fs.writeFileSync(cache, JSON.stringify(xr, null, 2) + "\n");
      return xr;
    }
    if (pinned) break;
  }
  throw new Error(`snapshot-xr: no XR holds the snapshot's keys (tried ${[...tried].join(", ")})` +
    (pinned ? "; GBIF_SNAPSHOT_XR names one that doesn't" : ""));
}
