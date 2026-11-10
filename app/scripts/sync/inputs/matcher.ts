/**
 * The name matcher: GBIF's own, matching-ws, run locally against the CoL XR
 * release the sync uses.
 *
 * It is the service GBIF interprets occurrence records with, so a Red List name
 * matched here lands where GBIF filed that name's records. It is pinned twice:
 * to a matching-ws release (the one GBIF's hosted service reports) and to the
 * XR's dataset key. Neither moves unless this file or the XR does.
 *
 * Three things are built once and cached under ~/.cache/redlist-dashboard/matching-ws/:
 *   src-<version>/        the matching-ws source at that tag, and its jar (built in a Maven container)
 *   export-<key>/<key>/   the XR's NameUsage as the CSV matching-ws indexes
 *   index-<key>-<version>/ the index (about 13 minutes, 1.5 GB)
 *
 * The server runs in Docker as redlist-matcher-<key> on MATCHER_PORT (8190),
 * and is left running between syncs. It is checked to be serving the right
 * release before any name is sent.
 *
 * Usage (build and start only, on the last sync's XR):  npx tsx scripts/sync/inputs/matcher.ts
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { loadEnvFiles } from "../../lib/utils";
import { CACHE_ROOT, cachedDir } from "../paths";
import { ensureColInputs, lastXr } from "./col";
import { lit, openDuckDB } from "../sql";

export const MATCHER_VERSION = "v1.0.12";
const REPO = "https://github.com/gbif/matching-ws.git";
const BUILD_IMAGE = "maven:3.9-eclipse-temurin-25";
const RUN_IMAGE = "eclipse-temurin:25-jre";
const ROOT = path.join(CACHE_ROOT, "matching-ws");
const PORT = Number(process.env.MATCHER_PORT ?? 8190);

export interface Matcher {
  url: string;
  version: string;
  /** The XR dataset key the index was built from. */
  datasetKey: string;
  nameUsages: number;
}

const sh = (cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}) =>
  execFileSync(cmd, args, { cwd: opts.cwd, encoding: "utf-8", stdio: opts.quiet ? "pipe" : ["ignore", "inherit", "inherit"] });
const jarName = () => `matching-ws-${MATCHER_VERSION.replace(/^v/, "")}-exec.jar`;

async function ensureJar(): Promise<string> {
  const src = await cachedDir(path.join(ROOT, `src-${MATCHER_VERSION}`), (src) => {
    console.log(`   building matching-ws ${MATCHER_VERSION} (a few minutes, once)`);
    sh("git", ["clone", "-q", "--depth", "1", "--branch", MATCHER_VERSION, REPO, src]);
    fs.mkdirSync(path.join(ROOT, "m2"), { recursive: true });
    sh("docker", ["run", "--rm", "-v", `${src}:/build`, "-v", `${path.join(ROOT, "m2")}:/root/.m2`, "-w", "/build",
      BUILD_IMAGE, "mvn", "-q", "-B", "-DskipTests", "clean", "install", "spring-boot:repackage"]);
    if (!fs.existsSync(path.join(src, "target", jarName()))) throw new Error(`matcher: ${jarName()} was not built`);
  });
  return path.join(src, "target");
}

/** The XR as matching-ws reads a CSV export: $-separated, upper-case enums, BOLD BINs as OTUs. */
async function ensureExport(xr: { key: string; alias: string }, nameUsage: string): Promise<string> {
  // matching-ws reads <export root>/<key>/index.csv.
  const exportRoot = path.join(ROOT, `export-${xr.key}`);
  await cachedDir(path.join(exportRoot, xr.key), async (dir) => {
    const conn = await openDuckDB();
    const clean = (c: string) => `replace(replace(${c}, '$', ''), '"', '')`;
    await conn.run(`COPY (
      SELECT "col:ID" AS id, "col:parentID" AS parentId,
             ${clean(`regexp_replace("col:scientificName", '[/\\\\]', '', 'g')`)} AS scientificName,
             ${clean(`"col:authorship"`)} AS authorship,
             upper(replace("col:status", ' ', '_')) AS status,
             upper(replace(coalesce("col:rank", 'unranked'), ' ', '_')) AS rank,
             upper("col:code") AS code,
             "col:genericName" AS genericName, "col:infragenericEpithet" AS infragenericEpithet,
             "col:specificEpithet" AS specificEpithet, "col:infraspecificEpithet" AS infraspecificEpithet,
             CASE WHEN "col:scientificName" LIKE 'BOLD:%' THEN 'OTU' ELSE 'SCIENTIFIC' END AS type,
             '' AS category, "col:environment" AS environments, '' AS extension
      FROM read_csv(${lit(nameUsage)}, delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true)
      WHERE "col:ID" IS NOT NULL
    ) TO ${lit(path.join(dir, "index.csv"))} (DELIMITER '$', HEADER, QUOTE '"')`);
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ clbKey: Number(xr.key), title: "Catalogue of Life", alias: xr.alias }) + "\n");
  });
  return exportRoot;
}

function ensureIndex(xrKey: string, jarDir: string, exportRoot: string): Promise<string> {
  return cachedDir(path.join(ROOT, `index-${xrKey}-${MATCHER_VERSION}`), (dir) => {
    console.log(`   indexing XR ${xrKey} with matching-ws (about 15 minutes, once per release)`);
    sh("docker", ["run", "--rm", "--name", `redlist-matcher-index-${xrKey}`,
      "-v", `${jarDir}:/app`, "-v", `${exportRoot}:/export`, "-v", `${dir}:/index`, RUN_IMAGE,
      "java", "-Xmx48g", "--enable-native-access=ALL-UNNAMED", "-jar", `/app/${jarName()}`,
      "--mode=INDEX", `--clb.dataset.id=${xrKey}`, "--index.path=/index", "--export.path=/export",
      "--temp.path=/index/tmp", "--indexing.threads=16"], { quiet: true });
    fs.rmSync(path.join(dir, "tmp"), { recursive: true, force: true });
    if (!fs.existsSync(path.join(dir, "main"))) throw new Error(`matcher: indexing XR ${xrKey} produced no index`);
  });
}

async function metadata(url: string): Promise<{ key: string; usages: number } | null> {
  try {
    const res = await fetch(`${url}/v2/species/match/metadata`);
    if (!res.ok) return null;
    const m = (await res.json()) as { mainIndex?: { clbDatasetKey?: string; nameUsageCount?: number } };
    return m.mainIndex?.clbDatasetKey ? { key: String(m.mainIndex.clbDatasetKey), usages: m.mainIndex.nameUsageCount ?? 0 } : null;
  } catch {
    return null;
  }
}

async function serve(xrKey: string, jarDir: string, index: string): Promise<Matcher> {
  const url = `http://localhost:${PORT}`;
  const name = `redlist-matcher-${xrKey}`;
  let m = await metadata(url);
  if (m && m.key !== xrKey) {
    // Another release's matcher holds the port: stop it if it is ours, else refuse.
    const ours = sh("docker", ["ps", "--filter", `publish=${PORT}`, "--format", "{{.Names}}"], { quiet: true }).trim();
    if (!ours.startsWith("redlist-matcher-")) throw new Error(`matcher: port ${PORT} serves XR ${m.key} from ${ours || "something else"}; set MATCHER_PORT`);
    sh("docker", ["rm", "-f", ours], { quiet: true });
    m = null;
  }
  if (!m) {
    sh("docker", ["rm", "-f", name], { quiet: true });
    sh("docker", ["run", "-d", "--name", name, "-p", `${PORT}:8080`, "-v", `${jarDir}:/app:ro`, "-v", `${index}:/index`, RUN_IMAGE,
      "java", "-Xmx16g", "--enable-native-access=ALL-UNNAMED", "-jar", `/app/${jarName()}`,
      "--mode=RUN", "--index.path=/index", "--server.port=8080"], { quiet: true });
    for (let i = 0; i < 120 && !m; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      m = await metadata(url);
    }
    if (!m) throw new Error(`matcher: ${name} did not come up on ${url} (docker logs ${name})`);
  }
  if (m.key !== xrKey) throw new Error(`matcher: ${url} serves XR ${m.key}, not ${xrKey}`);
  return { url, version: MATCHER_VERSION, datasetKey: xrKey, nameUsages: m.usages };
}

export async function ensureMatcher(xr: { key: string; alias: string }, nameUsage: string): Promise<Matcher> {
  const jarDir = await ensureJar();
  const exportRoot = await ensureExport(xr, nameUsage);
  const index = await ensureIndex(xr.key, jarDir, exportRoot);
  return serve(xr.key, jarDir, index);
}

const isDirectRun = process.argv[1]?.endsWith("inputs/matcher.ts");
if (isDirectRun) {
  loadEnvFiles();
  const xr = lastXr();
  if (!xr) throw new Error("matcher: no XR recorded in src/config/col-release.json");
  ensureColInputs(xr)
    .then((col) => ensureMatcher(col.xr, col.nameUsage))
    .then((m) => console.log(`matching-ws ${m.version} serving XR ${m.datasetKey} (${m.nameUsages.toLocaleString()} usages) at ${m.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
