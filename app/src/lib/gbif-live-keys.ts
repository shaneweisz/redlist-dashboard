/**
 * Which key to ask GBIF's live API with, for a species the app keys by the
 * taxonomy's CoL release (CoL's newest).
 *
 * GBIF's live index runs the XR it last re-indexed against, a few times a
 * year, so between re-indexes some of the app's keys are ids it doesn't have,
 * or has as something else; and while GBIF re-indexes (about five days), its
 * records sit partly under the old ids. The sync writes, for each key that
 * differs, the ids to try in order (the live XR's, then the snapshot's) to
 * taxonomy/gbif-live-keys.json (scripts/sync/link/live-keys.ts); this reads it
 * once per server process. The app's key stays a species' identity (URLs,
 * saved edits); only requests to GBIF change.
 *
 * Server-only. Whenever GBIF runs CoL's newest XR the file is empty and every
 * key maps to itself.
 */
import fs from "fs";
import path from "path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { syncPath } from "@/lib/data/sync-layout";
import { GBIF_CHECKLIST_KEY } from "@/lib/gbif";
import { gbifJson } from "@/lib/gbif-fetch";

const FILE = syncPath("gbif-live-keys.json");
const LOCAL = path.join(process.cwd(), "data", "sync", FILE);

export interface LiveKeys {
  /** app key → the ids to ask GBIF with, in order */
  live: Map<string, string[]>;
  /** any of those ids → app key */
  app: Map<string, string>;
}

async function readFromR2(): Promise<string> {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_DATA_BUCKET_NAME } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_DATA_BUCKET_NAME) throw new Error("R2 is not configured");
  const sync = fs.readFileSync(path.join(process.cwd(), "latest-sync.txt"), "utf-8").trim();
  const client = new S3Client({ region: "auto", endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } });
  const object = await client.send(new GetObjectCommand({ Bucket: R2_DATA_BUCKET_NAME, Key: `syncs/${sync}/${FILE}` }));
  return (await object.Body?.transformToString()) ?? "{}";
}

/** The file's { key: ids to try }; a sync from before the list wrote { key: live id }, meaning [live id, key]. */
export function parseLiveKeys(json: string): LiveKeys {
  const pairs = Object.entries(JSON.parse(json) as Record<string, string | string[]>)
    .map(([k, v]): [string, string[]] => [k, Array.isArray(v) ? v : [v, k]]);
  return {
    live: new Map(pairs),
    app: new Map(pairs.flatMap(([k, tries]) => tries.filter((t) => t !== k).map((t): [string, string] => [t, k]))),
  };
}

let loading: Promise<LiveKeys> | null = null;

/** The map, loaded once: from disk in development, else from the deployed sync in R2. */
export function liveKeys(): Promise<LiveKeys> {
  if (!loading) {
    loading = (async () => {
      try {
        return parseLiveKeys(fs.existsSync(LOCAL) ? fs.readFileSync(LOCAL, "utf-8") : await readFromR2());
      } catch {
        // A sync from before this file, or R2 unreachable: ask with the app's
        // key, as before. Not remembered, so the next request retries.
        loading = null;
        return parseLiveKeys("{}");
      }
    })();
  }
  return loading;
}

/** The keys to ask GBIF's live API with, in order: the live XR's id, then the snapshot's, where they differ. */
export function queryKeys(keys: LiveKeys, key: string): string[] {
  return keys.live.get(key) ?? [key];
}

const HOUR = 60 * 60 * 1000;
const chosen = new Map<string, { key: string; at: number }>();

/**
 * The key to ask GBIF's live API with for this species. Most months it is the
 * key itself, with no request made. Otherwise the first id to try that GBIF
 * has records under, else the first: while GBIF re-indexes, records move from
 * the old ids to the new. Remembered for an hour, so a species page's several
 * panels ask once.
 */
export async function liveGbifKey(key: string): Promise<string> {
  const tries = queryKeys(await liveKeys(), key);
  if (tries.length === 1) return tries[0];
  const hit = chosen.get(key);
  if (hit && Date.now() - hit.at < HOUR) return hit.key;
  let pick = tries[0];
  try {
    for (const t of tries) {
      const live = (await gbifJson(`https://api.gbif.org/v1/occurrence/search?${new URLSearchParams({
        taxonKey: t, checklistKey: GBIF_CHECKLIST_KEY, limit: "0" })}`)) as { count?: number };
      if ((live.count ?? 0) > 0) { pick = t; break; }
    }
  } catch {
    // GBIF unreachable: the caller's own request will say so.
  }
  chosen.set(key, { key: pick, at: Date.now() });
  return pick;
}

/** A key GBIF's live API returned (a facet, an occurrence's taxonKey), as the app keys that species. */
export function appKey(keys: LiveKeys, key: string): string {
  return keys.app.get(key) ?? key;
}
