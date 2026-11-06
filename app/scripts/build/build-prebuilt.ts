/**
 * build-prebuilt: the three pre-built file sets (species lists, search shards,
 * tree children), reused between deploys when nothing they depend on changed.
 *
 * Building them is three-quarters of a deploy (about 3.5 of 4.8 minutes on
 * Vercel's 3 cores, search shards alone 2.3), yet they change only when the
 * sync or the code that builds them does. So the output is kept in
 * .next/cache, which Vercel restores at the start of every build, under a key
 * made of:
 *
 *   - the sync name (latest-sync.txt): a sync's files never change once
 *     uploaded, and its date is the "as of" date the files use
 *   - every source file the builders import, followed through their imports
 *     (relative and @/ paths), and package-lock.json
 *
 * A hit copies the cached folder into public/prebuilt/<sync>/; a miss runs the
 * three builders and caches what they wrote. Only the latest entry is kept, so
 * the cache holds one set (about 165 MB).
 *
 * Usage:  npx tsx scripts/build/build-prebuilt.ts [--no-cache]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP_DIR = path.join(__dirname, "..", "..");
const CACHE_ROOT = path.join(APP_DIR, ".next", "cache", "prebuilt");
const BUILDERS = ["build-species-lists", "build-search-shards", "build-tree-children"];

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(APP_DIR, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package: package-lock.json covers it
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`build-prebuilt: can't resolve ${spec} from ${path.relative(APP_DIR, from)}`);
}

/** Every source file reachable from the entries through relative and @/ imports. */
export function sourceClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const todo = [...entries];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(ts|tsx|js|mjs)$/.test(f)) continue; // JSON and the like: hashed, not parsed
    const src = fs.readFileSync(f, "utf-8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolveImport(f, m[1] ?? m[2] ?? m[3] ?? m[4]);
      if (r && !seen.has(r)) todo.push(r);
    }
  }
  return [...seen].sort();
}

export function cacheKey(sync: string): { key: string; files: number } {
  const files = sourceClosure(BUILDERS.map((b) => path.join(APP_DIR, "scripts", "build", `${b}.ts`)));
  const h = createHash("sha256").update(`sync ${sync}\n`);
  for (const f of [...files, path.join(APP_DIR, "package-lock.json")]) {
    h.update(`${path.relative(APP_DIR, f)}\n`).update(fs.readFileSync(f));
  }
  return { key: h.digest("hex").slice(0, 16), files: files.length };
}

function main(): void {
  const sync = fs.readFileSync(path.join(APP_DIR, "latest-sync.txt"), "utf-8").trim();
  const out = path.join(APP_DIR, "public", "prebuilt", sync);
  const { key, files } = cacheKey(sync);
  const cached = path.join(CACHE_ROOT, `${sync}-${key}`);
  const useCache = !process.argv.includes("--no-cache");

  if (useCache && fs.existsSync(path.join(cached, ".complete"))) {
    fs.rmSync(path.join(APP_DIR, "public", "prebuilt"), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.cpSync(cached, out, { recursive: true, filter: (src) => path.basename(src) !== ".complete" });
    console.log(`build-prebuilt: reused ${sync} (key ${key}, ${files} source files) from .next/cache`);
    return;
  }

  console.log(`build-prebuilt: building ${sync} (key ${key}, ${files} source files)`);
  for (const b of BUILDERS) execFileSync("npm", ["run", b], { cwd: APP_DIR, stdio: "inherit" });
  if (!useCache) return;
  // One entry: whatever was cached before is for another sync or older code.
  fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  fs.cpSync(out, cached, { recursive: true });
  fs.writeFileSync(path.join(cached, ".complete"), "");
  console.log(`build-prebuilt: cached ${sync} as ${path.relative(APP_DIR, cached)}`);
}

const isDirectRun = process.argv[1]?.endsWith("build/build-prebuilt.ts") || process.argv[1]?.endsWith("build/build-prebuilt.js");
if (isDirectRun) main();
