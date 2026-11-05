/**
 * fetch-col-checklist (#271, Phase 3): download the CURATED Catalogue of Life
 * Checklist (ChecklistBank dataset `3LR`) as an EXTENDED ColDP archive and extract
 * NameUsage.tsv — the input to build-backbone's demotion overlay.
 *
 * Why: our species universe is built from the CoL eXtended Release (XR, see
 * fetch-col-xr), which maximizes coverage but does NOT reconcile conflicting source
 * taxonomies — so it over-splits, surfacing contested splits as accepted species
 * that become spurious "Not Evaluated" rows (e.g. Pycnonotus tricolor, an accepted
 * species in XR but a synonym of the assessed P. barbatus in the curated checklist).
 * The curated checklist applies CoL's editorial reconciliation. We use it as a
 * CORRECTION OVERLAY, not the base: build-backbone drops from the XR universe any
 * col_id the curated checklist DEMOTES (to synonym/infraspecific). Curated silence
 * never deletes coverage (so groups XR has but the checklist lacks — e.g. macroalgae,
 * whose AlgaeBase GSD isn't in the curated assembly — are preserved); only curated
 * contradiction does. col_ids are shared across both datasets, so the join is exact
 * WHERE BOTH CARRY THE USAGE — but the release is NOT a subset of the XR: 94,728 of
 * its 5.4M usages have no XR row (measured, COL26.6 XR vs 3LR). Harmless for
 * demotion, which only ever removes; it does mean anything keyed off an XR row
 * cannot see those usages (see build-backbone's in_checklist).
 *
 * We only need col:ID/status/rank/scientificName, which the smaller SIMPLE archive
 * (~166MB vs ~1.8GB extended) also carries — but ChecklistBank only serves a GET
 * export.zip if that exact archive is already pre-built, and won't build one on
 * demand for anonymous requests (a fresh build needs a token we don't have). The
 * extended archive is the better bet of the two — the simple one has lagged the
 * extended one by days on every release we have watched — so this always asks for
 * extended. `3LR` is the rolling latest CoL release, swappable via env
 * COL_CHECKLIST_DATASET.
 *
 * NEITHER archive is guaranteed to exist when `3LR` moves, which is why
 * resolveChecklistDataset() steps back a release rather than trusting the alias.
 * `3LR` starts pointing at a new release the day CoL publishes it, but the export
 * build is a separate job that runs whenever it runs: COL26.8's archives appeared
 * one day after its release, COL26.7's after three, and COL26.9 had none at all
 * four days in — which is what broke the 2026-09-13 weekly sync, the second
 * rollover failure here after COL26.7's. Since the alias moves first and the
 * archive follows, every monthly rollover opens a window where the newest curated
 * release cannot be downloaded at all.
 *
 * Downloads to a TEMP dir (outside data/) so the TSV is never swept into the R2
 * upload; build-backbone reads it, then the sync removes the temp dir.
 *
 * Returns the path to the extracted NameUsage.tsv.
 *
 *   npx tsx scripts/sync/inputs/fetch-col-checklist.ts        # downloads + prints the TSV path
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { loadEnvFiles } from "../../lib/utils";

const CHECKLIST_DATASET = process.env.COL_CHECKLIST_DATASET || "3LR";

/** Which curated release `3LR` currently points at. */
export interface ChecklistInfo {
  key: string;
  alias: string;
  issued: string;
}

/** The exact archive `run()` downloads — so the availability probe tests the real thing. */
const exportUrl = (key: string) =>
  `https://api.checklistbank.org/dataset/${key}/export.zip?format=ColDP&extended=true`;

/**
 * How far back resolveChecklistDataset() will step looking for a built archive.
 *
 * CoL releases monthly, so this is a ~3-month floor. It is deliberately small: the
 * point of the walk-back is to ride out the days between a release and its export
 * build, not to keep the sync green on top of an overlay from last spring. If
 * three consecutive releases have no archive, something is wrong at CoL's end that
 * a silent fallback would only hide, so the run fails instead.
 */
const MAX_FALLBACK_RELEASES = 3;

/** Whether ChecklistBank will actually serve this release's extended ColDP archive. */
async function hasColdpArchive(key: string): Promise<boolean> {
  try {
    // HEAD, following the redirect: ChecklistBank answers with a 302 to the stored
    // file, so the redirect alone only proves it has a row for the export — the
    // follow is what confirms the archive is really there. No body either way.
    const res = await fetch(exportUrl(key), { method: "HEAD", redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  }
}

/** The curated CoL releases, newest first. */
async function listCuratedReleases(): Promise<ChecklistInfo[]> {
  // origin=release excludes the XR releases (origin=xrelease), which share the
  // project and would otherwise be candidates — an XR is precisely the unreconciled
  // taxonomy this overlay exists to correct, so falling back onto one would delete
  // nothing and quietly turn phase 3 into a no-op.
  const res = await fetch("https://api.checklistbank.org/dataset?releasedFrom=3&origin=release&limit=100");
  if (!res.ok) throw new Error(`Checklist release listing failed: ${res.status}`);
  const body = (await res.json()) as { result?: { key?: number | string; alias?: string; issued?: string }[] };
  return (body.result ?? [])
    .filter((d): d is { key: number | string; alias?: string; issued: string } => Boolean(d.key && d.issued))
    .map((d) => ({ key: String(d.key), alias: d.alias ?? String(d.key), issued: d.issued }))
    .sort((a, b) => b.issued.localeCompare(a.issued));
}

/**
 * Resolve the alias to the concrete release behind it — and to one we can download.
 *
 * `3LR` is a MOVING pointer — it was COL26.6 in June and is COL26.9 now — while
 * the XR pin follows GBIF's occurrence index and moves on its own schedule. The
 * two are routinely months apart, so "has the XR moved?" cannot answer "is our
 * checklist-derived data current?". build-backbone stamps in_checklist,
 * checklist_parent_id and checklist_name from this release, and those carry
 * user-facing claims with links to its pages, so a stale one shows the old
 * accepted name beside a link to the page that now disagrees.
 *
 * The resolved release is then PROBED, because the alias moving is not the same
 * event as the archive being built (see the header): for a few days each month
 * `3LR` names a release nothing can download. Answering with it anyway is what
 * failed the weekly sync twice — and the failure lands in phase 3, killing the
 * GBIF phases after it that had nothing to do with CoL moving. So when the newest
 * release has no archive we step back to the newest one that does, and the sync
 * proceeds on last month's overlay until the build catches up.
 *
 * The nice consequence: the release we step back to is usually the one already on
 * disk, so the sync sees an unmoved checklist and skips the 3.4GB rebuild entirely
 * rather than redoing it to land in the same place.
 *
 * Called before the download, so the sync can compare pins before committing to a
 * 2 GB fetch — and so the release it compares is the one run() will actually get.
 */
export async function resolveChecklistDataset(): Promise<ChecklistInfo> {
  const res = await fetch(`https://api.checklistbank.org/dataset/${CHECKLIST_DATASET}`);
  if (!res.ok) throw new Error(`Checklist metadata fetch failed (${CHECKLIST_DATASET}): ${res.status}`);
  const d = (await res.json()) as { key?: number | string; alias?: string; issued?: string; version?: string };
  const issued = d.issued ?? d.version ?? "";
  if (!d.key || !issued) throw new Error(`Checklist metadata missing key/issued for ${CHECKLIST_DATASET}`);
  const latest: ChecklistInfo = { key: String(d.key), alias: d.alias ?? CHECKLIST_DATASET, issued };

  if (await hasColdpArchive(latest.key)) return latest;

  console.warn(
    `fetch-col-checklist: ${latest.alias} (${latest.key}, issued ${latest.issued}) has no ColDP archive built yet; ` +
      "looking for the newest release that does."
  );
  // Strictly older, by issue date rather than key: the listing carries the XR keys'
  // neighbours and key order is allocation order, not release order.
  const older = (await listCuratedReleases())
    .filter((r) => r.issued < latest.issued)
    .slice(0, MAX_FALLBACK_RELEASES);
  for (const candidate of older) {
    if (await hasColdpArchive(candidate.key)) {
      console.warn(
        `fetch-col-checklist: falling back to ${candidate.alias} (${candidate.key}, issued ${candidate.issued}). ` +
          `The overlay will rebuild on ${latest.alias} once CoL publishes its archive.`
      );
      return candidate;
    }
  }
  throw new Error(
    `fetch-col-checklist: no ColDP archive for ${latest.alias} (${latest.key}) or the ` +
      `${older.length} release(s) before it (${older.map((r) => r.alias).join(", ") || "none found"}). ` +
      "ChecklistBank builds exports on its own schedule, but this is longer than that gap has ever been — check CoL."
  );
}

/**
 * `dataset` is the release resolveChecklistDataset() settled on. Pass the one the
 * caller already resolved — downloading `3LR` again would re-follow the alias and
 * land on the undownloadable newest release the resolver just stepped away from,
 * and would also let the two disagree if CoL published mid-run.
 */
export async function run(opts: { destDir?: string; dataset?: ChecklistInfo } = {}): Promise<string> {
  const dataset = opts.dataset ?? (await resolveChecklistDataset());
  const destDir = opts.destDir || fs.mkdtempSync(path.join(os.tmpdir(), "col-checklist-"));
  fs.mkdirSync(destDir, { recursive: true });
  const zip = path.join(destDir, "checklist.zip");
  const url = exportUrl(dataset.key);

  console.log(`fetch-col-checklist: downloading curated CoL Checklist (${dataset.alias}, ${dataset.key}) ColDP export…`);
  execFileSync("curl", ["-fsSL", url, "-o", zip], { stdio: ["ignore", "inherit", "inherit"] });
  console.log("fetch-col-checklist: extracting NameUsage.tsv…");
  execFileSync("unzip", ["-o", zip, "NameUsage.tsv", "-d", destDir], { stdio: ["ignore", "inherit", "inherit"] });
  fs.rmSync(zip, { force: true });

  const tsv = path.join(destDir, "NameUsage.tsv");
  if (!fs.existsSync(tsv)) throw new Error("fetch-col-checklist: NameUsage.tsv missing after extraction");
  console.log(`fetch-col-checklist: wrote ${tsv} (${(fs.statSync(tsv).size / 1024 / 1024).toFixed(0)} MB)`);
  return tsv;
}

const isDirectRun = process.argv[1]?.endsWith("inputs/fetch-col-checklist.ts") || process.argv[1]?.endsWith("inputs/fetch-col-checklist.js");
if (isDirectRun) {
  loadEnvFiles();
  run().then((tsv) => console.log(tsv)).catch((err) => { console.error("Fatal error:", err); process.exit(1); });
}
