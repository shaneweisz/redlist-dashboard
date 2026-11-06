/**
 * build-tree-children: pre-build the taxonomy tree's unscoped live-drilldown expands.
 *
 * For every dynamic drilldown root (mammals, pl-flowering_plants, inv-molluscs, …),
 * writes public/prebuilt/<sync>/tree/<root>.json.br: every expandable node under
 * that root → the children /api/redlist/taxa-subgroups returns for it (see
 * lib/data/tree-children-build.ts for how, and scripts/build/check-tree-children.ts for the
 * parity proof). The browser (lib/tree-children/loader.ts) fetches one file per root
 * and answers every expand under it locally — on a fresh deployment those expands
 * took 2-22s each (minutes for molluscs) until the edge cache filled.
 *
 * Runs in prebuild after build-species-lists (which clears public/prebuilt/), at
 * build time for the same reason: display names come from code, so the files stay in
 * step with the deployed code. `outdated` is as of the sync's date (getDataSyncDate),
 * not the build's, which is what lets build-prebuilt reuse the files across deploys. Country/realm-scoped
 * expands are not pre-built; they keep using the live route.
 *
 * Usage: npx tsx scripts/build/build-tree-children.ts
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { buildRootChildren } from "../../src/lib/data/tree-children-build";
import { DYNAMIC_DRILLDOWN_ROOTS } from "../../src/lib/dynamic-taxon";
import { treeChildrenFileName, type TreeChildrenFile } from "../../src/lib/tree-children/format";
import { syncPath } from "../../src/lib/data/sync-layout";

const brotli = promisify(zlib.brotliCompress);
const APP_DIR = path.join(__dirname, "..", "..");

async function main() {
  const t0 = Date.now();
  const sync = fs.readFileSync(path.join(APP_DIR, "latest-sync.txt"), "utf-8").trim();
  if (!fs.existsSync(path.join(APP_DIR, "data", "sync", syncPath("assessed.parquet")))) {
    throw new Error("data/sync/" + syncPath("assessed.parquet") + " missing — run fetch-data-from-r2 first (this builds from local data, never from R2)");
  }
  const outDir = path.join(APP_DIR, "public", "prebuilt", sync, "tree");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let nodes = 0;
  let bytes = 0;
  for (const root of [...DYNAMIC_DRILLDOWN_ROOTS].sort()) {
    const children = await buildRootChildren(root);
    nodes += Object.keys(children).length;
    const file: TreeChildrenFile = { v: 1, sync, root, children };
    const buf = await brotli(JSON.stringify(file), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } });
    bytes += buf.length;
    fs.writeFileSync(path.join(outDir, treeChildrenFileName(root)), buf);
  }
  console.log(`tree-children: ${DYNAMIC_DRILLDOWN_ROOTS.size} roots, ${nodes.toLocaleString()} expandable nodes, ` +
    `${(bytes / 1e6).toFixed(1)}MB brotli in ${((Date.now() - t0) / 1000).toFixed(1)}s → public/prebuilt/${sync}/tree/`);
  process.exit(0); // DuckDB keeps the event loop alive
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
