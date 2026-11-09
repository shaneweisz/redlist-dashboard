/**
 * Which key to ask GBIF's live API with, for a species the sync keyed by its
 * snapshot's CoL release.
 *
 * GBIF re-indexes against a newer CoL XR between monthly snapshots, and the
 * live API then files records under that release's ids: for a few weeks, some
 * snapshot keys point at nothing or at a synonym live (1,130 and 4,494
 * assessed species when COL26.10 XR replaced COL26.6 XR). The sync writes
 * those species' live keys to taxonomy/gbif-live-keys.json (link/live-keys.ts);
 * this reads it once per server process. The snapshot key stays the app's
 * identity for a species (URLs, saved edits); only requests to GBIF change.
 *
 * Server-only. Most months the file is empty and every key maps to itself.
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
  /** snapshot key → live key */
  live: Map<string, string>;
  /** live key → snapshot key */
  snapshot: Map<string, string>;
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

export function parseLiveKeys(json: string): LiveKeys {
  const pairs = Object.entries(JSON.parse(json) as Record<string, string>);
  return { live: new Map(pairs), snapshot: new Map(pairs.map(([k, v]) => [v, k])) };
}

let loading: Promise<LiveKeys> | null = null;

/** The map, loaded once: from disk in development, else from the deployed sync in R2. */
export function liveKeys(): Promise<LiveKeys> {
  if (!loading) {
    loading = (async () => {
      try {
        return parseLiveKeys(fs.existsSync(LOCAL) ? fs.readFileSync(LOCAL, "utf-8") : await readFromR2());
      } catch {
        // A sync from before this file, or R2 unreachable: ask with the
        // snapshot key, as before. Not remembered, so the next request retries.
        loading = null;
        return parseLiveKeys("{}");
      }
    })();
  }
  return loading;
}

/** The keys to ask GBIF's live API with, in order: the live key where it differs, then the snapshot key. */
export function queryKeys(keys: LiveKeys, key: string): string[] {
  const live = keys.live.get(key);
  return live ? [live, key] : [key];
}

const HOUR = 60 * 60 * 1000;
const chosen = new Map<string, { key: string; at: number }>();

/**
 * The key to ask GBIF's live API with for this species. Most months it is the
 * key itself, with no request made. Where a live key exists, it is used if GBIF
 * has records under it, else the snapshot key: between GBIF publishing a new
 * release and finishing re-filing its records, the old key is the one that
 * works. Remembered for an hour, so a species page's several panels ask once.
 */
export async function liveGbifKey(key: string): Promise<string> {
  const tries = queryKeys(await liveKeys(), key);
  if (tries.length === 1) return key;
  const hit = chosen.get(key);
  if (hit && Date.now() - hit.at < HOUR) return hit.key;
  let pick = key;
  try {
    const live = (await gbifJson(`https://api.gbif.org/v1/occurrence/search?${new URLSearchParams({
      taxonKey: tries[0], checklistKey: GBIF_CHECKLIST_KEY, limit: "0" })}`)) as { count?: number };
    if ((live.count ?? 0) > 0) pick = tries[0];
  } catch {
    // GBIF unreachable: the caller's own request will say so; ask with the snapshot key.
  }
  chosen.set(key, { key: pick, at: Date.now() });
  return pick;
}

/** A key GBIF's live API returned (a facet, an occurrence's taxonKey), as the app keys that species. */
export function snapshotKey(keys: LiveKeys, key: string): string {
  return keys.snapshot.get(key) ?? key;
}
