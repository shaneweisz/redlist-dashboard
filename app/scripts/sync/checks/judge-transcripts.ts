/**
 * The judge's transcripts: each call's whole conversation (its searches, the
 * pages it read, and its answer), so a decision it wrote can be audited. Kept
 * gzipped next to the judge's cache, and uploaded to a private Backblaze B2
 * bucket before a decision that cites one is written (B2_TRANSCRIPTS_BUCKET,
 * B2_TRANSCRIPTS_KEY_ID, B2_TRANSCRIPTS_APPLICATION_KEY in app/.env.local; B2_TRANSCRIPTS_ENDPOINT,
 * else B2_ENDPOINT). Private, because a transcript holds the text of the pages
 * it fetched; deletable, should one hold something it shouldn't.
 *
 * Before upload each is scanned for this machine's secrets (the values of
 * environment variables named like a token, key, secret or password, and any
 * email in one), its home folder and the git user's email; a match stops the upload.
 *
 * `npm run sync:trace -- "<species>"` shows a decision's runs (summarise, below).
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const transcriptPath = (cacheDir: string, key: string) => path.join(cacheDir, "transcripts", `${key}.jsonl.gz`);
const objectKey = (key: string) => `judge/${key}.jsonl.gz`;

export function saveTranscript(cacheDir: string, key: string, transcript: string): void {
  fs.mkdirSync(path.join(cacheDir, "transcripts"), { recursive: true });
  fs.writeFileSync(transcriptPath(cacheDir, key), zlib.gzipSync(transcript));
}

function bucket(): { client: S3Client; name: string } | null {
  const { B2_TRANSCRIPTS_BUCKET: name, B2_TRANSCRIPTS_KEY_ID: id, B2_TRANSCRIPTS_APPLICATION_KEY: secret } = process.env;
  const endpoint = process.env.B2_TRANSCRIPTS_ENDPOINT ?? process.env.B2_ENDPOINT;
  if (!name || !id || !secret || !endpoint) return null;
  const region = endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/)?.[1] ?? "us-east-005";
  return { name, client: new S3Client({ endpoint, region, credentials: { accessKeyId: id, secretAccessKey: secret } }) };
}

/** What must never leave this machine: the values of secret-named variables, the home folder, the git email. */
export function secretsToScanFor(env: Record<string, string | undefined> = process.env): string[] {
  const out = Object.entries(env).filter(([k, v]) => /TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(k) && v && v.length >= 12).map(([, v]) => v!);
  out.push(...Object.entries(env).filter(([k, v]) => /EMAIL/i.test(k) && v?.includes("@")).map(([, v]) => v!));
  out.push(os.homedir());
  try { const e = execSync("git config user.email", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); if (e) out.push(e); } catch { /* no git */ }
  // As written, and as it appears inside a JSON string (a transcript is JSON lines).
  return [...new Set(out.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]))];
}

/** Which of the secrets a transcript contains (by index, so the report names none of them). */
export const leaks = (text: string, secrets: string[]) => secrets.flatMap((s, i) => (text.includes(s) ? [i] : []));

/** Uploads the transcripts not yet in the bucket. Throws, before anything is written, if the bucket isn't set or a transcript leaks. */
export async function uploadTranscripts(keys: string[], cacheDir: string): Promise<void> {
  if (keys.length === 0) return;
  const b = bucket();
  if (!b) throw new Error("judge: the transcripts bucket isn't set (B2_TRANSCRIPTS_BUCKET, B2_TRANSCRIPTS_KEY_ID, B2_TRANSCRIPTS_APPLICATION_KEY in app/.env.local); " +
    "nothing was written. Answers and transcripts are cached, so a rerun costs nothing.");
  const secrets = secretsToScanFor();
  const bad: string[] = [];
  for (const k of keys) {
    const f = transcriptPath(cacheDir, k);
    if (!fs.existsSync(f)) throw new Error(`judge: transcript ${k} is missing from ${path.dirname(f)}`);
    if (leaks(zlib.gunzipSync(fs.readFileSync(f)).toString(), secrets).length) bad.push(k);
  }
  if (bad.length) throw new Error(`judge: ${bad.length} transcript(s) hold a secret, the home folder or the git email (${bad.join(", ")}); nothing was uploaded or written`);
  let sent = 0;
  for (const k of keys) {
    try { await b.client.send(new HeadObjectCommand({ Bucket: b.name, Key: objectKey(k) })); continue; } catch { /* not there yet */ }
    await b.client.send(new PutObjectCommand({ Bucket: b.name, Key: objectKey(k), Body: fs.readFileSync(transcriptPath(cacheDir, k)), ContentType: "application/gzip" }));
    sent++;
  }
  console.log(`judge: ${sent} transcript(s) uploaded to the private bucket, ${keys.length - sent} already there`);
}

/** A transcript, from the local cache or else the bucket; null if neither has it. */
export async function readTranscript(key: string, cacheDir: string): Promise<string | null> {
  const f = transcriptPath(cacheDir, key);
  if (fs.existsSync(f)) return zlib.gunzipSync(fs.readFileSync(f)).toString();
  const b = bucket();
  if (!b) return null;
  try {
    const o = await b.client.send(new GetObjectCommand({ Bucket: b.name, Key: objectKey(key) }));
    const body = Buffer.from(await o.Body!.transformToByteArray());
    saveTranscript(cacheDir, key, zlib.gunzipSync(body).toString());
    return zlib.gunzipSync(body).toString();
  } catch { return null; }
}

/**
 * One call's searches and fetches, and its answer for one species. A call asks
 * about a batch, so a search names the species when its genus or epithet is in
 * the query; the rest are counted.
 */
export function summarise(transcript: string, sis: number, name: string): { searches: string[]; fetches: string[]; others: number; answer: unknown } {
  const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const out = { searches: [] as string[], fetches: [] as string[], others: 0, answer: null as unknown };
  for (const line of transcript.split("\n")) {
    let d: { type?: string; message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] }; structured_output?: { answers?: { sis_taxon_id: number }[] } };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "result") out.answer = d.structured_output?.answers?.find((a) => a.sis_taxon_id === sis) ?? null;
    if (d.type !== "assistant") continue;
    for (const c of d.message?.content ?? []) {
      if (c.type !== "tool_use") continue;
      const q = String(c.input?.query ?? c.input?.url ?? "");
      const mine = words.some((w) => q.toLowerCase().includes(w));
      if (!mine) { out.others++; continue; }
      if (c.name === "WebSearch") out.searches.push(q);
      else if (c.name === "WebFetch") out.fetches.push(q);
    }
  }
  return out;
}
