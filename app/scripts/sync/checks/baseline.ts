/**
 * baseline: a local copy of a published sync, to compare a new sync against.
 *
 * Defaults to the sync production serves, which is whatever latest-sync.txt
 * says on origin/main. Not this branch's copy: a branch that has run an upload
 * has bumped its own pointer, and comparing a sync with itself reports nothing.
 *
 * Copies live in ~/.cache/redlist-dashboard/baseline-<sync>/ and are reused.
 * A copy is complete only once its .complete marker exists.
 *
 * Usage:
 *   npx tsx scripts/sync/checks/baseline.ts            # prod's sync
 *   npx tsx scripts/sync/checks/baseline.ts <sync>     # a specific one
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { loadEnvFiles } from "../../lib/utils";
import { downloadSync } from "../../lib/r2";
import { CACHE_ROOT } from "../paths";
import { inSync } from "./compare/facts";

/**
 * Syncs before 2026-11-05 left col-revisions.json out (git held it); for one of
 * those, it is taken from main's history, if main still has it.
 */
const ONCE_IN_GIT = ["col-revisions.json"];

export function prodSync(): string {
  return execFileSync("git", ["show", "origin/main:app/latest-sync.txt"], {
    encoding: "utf-8",
    cwd: path.join(__dirname, "..", "..", ".."),
  }).trim();
}

export function baselineDir(sync: string): string {
  return path.join(CACHE_ROOT, `baseline-${sync}`);
}

export async function ensureBaseline(sync = prodSync()): Promise<string> {
  const dir = baselineDir(sync);
  const marker = path.join(dir, ".complete");
  if (fs.existsSync(marker)) return dir;
  console.log(`Downloading baseline sync ${sync} into ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const n = await downloadSync(sync, dir);
  for (const name of ONCE_IN_GIT) {
    if (fs.existsSync(inSync(dir, name))) continue;
    try {
      const body = execFileSync("git", ["show", `origin/main:app/data/${name}`], {
        cwd: path.join(__dirname, "..", "..", ".."), maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
      });
      fs.writeFileSync(path.join(dir, name), body);
    } catch { /* not in git either: the comparison reads it as absent */ }
  }
  fs.writeFileSync(marker, JSON.stringify({ sync, files: n, at: new Date().toISOString() }) + "\n");
  return dir;
}

const isDirectRun = process.argv[1]?.endsWith("checks/baseline.ts") || process.argv[1]?.endsWith("checks/baseline.js");
if (isDirectRun) {
  loadEnvFiles();
  ensureBaseline(process.argv[2])
    .then((dir) => console.log(dir))
    .catch((e) => { console.error(e); process.exit(1); });
}
