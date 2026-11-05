/**
 * check-tree-children: prove the pre-built tree files answer every unscoped expand the
 * way /api/redlist/taxa-subgroups does.
 *
 * Decodes public/prebuilt/<sync>/tree/<root>.json.br (after build-tree-children)
 * and, for every node in it (or a sample with --quick), compares the stored children
 * against getLiveRankChildren(node, nextDynamicRank(node)) — the function the route
 * calls — field by field. Also checks completeness: every stored child that can itself
 * be expanded has its own entry, so the browser never has to fall back mid-tree.
 *
 * Usage: npx tsx scripts/build/check-tree-children.ts [--quick]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { getLiveRankChildren } from "../../src/lib/data/live-taxa-children";
import { DYNAMIC_DRILLDOWN_ROOTS, nextDynamicRank } from "../../src/lib/dynamic-taxon";
import { treeChildrenFileName, type TreeChildrenFile } from "../../src/lib/tree-children/format";

const APP_DIR = path.join(__dirname, "..", "..");
const sync = fs.readFileSync(path.join(APP_DIR, "latest-sync.txt"), "utf-8").trim();
const dir = path.join(APP_DIR, "public", "prebuilt", sync, "tree");

// Key-order-insensitive (byCategory's insertion order depends on row order), and
// JSON-shaped (undefined colDescribed/colNe drop out, as they do in the route's response).
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canon((v as Record<string, unknown>)[k])]))
  : v;

async function main() {
  const quick = process.argv.includes("--quick");
  let checked = 0, failures = 0, missing = 0;
  for (const root of [...DYNAMIC_DRILLDOWN_ROOTS].sort()) {
    const file: TreeChildrenFile = JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, treeChildrenFileName(root)))).toString("utf-8"));
    const ids = Object.keys(file.children);
    for (const id of ids) {
      for (const child of file.children[id]) {
        if (nextDynamicRank(child.id) && !file.children[child.id]) { missing++; if (missing <= 5) console.log(`✗ missing entry for expandable ${child.id}`); }
      }
    }
    // --quick: the root, every first-level child, and an evenly spaced sample below.
    const sample = quick
      ? [...new Set([root, ...file.children[root].map((c) => c.id).filter((c) => file.children[c]), ...ids.filter((_, i) => i % Math.max(1, Math.floor(ids.length / 15)) === 0)])]
      : ids;
    for (const id of sample) {
      const live = await getLiveRankChildren(id, nextDynamicRank(id)!);
      checked++;
      const a = JSON.stringify(canon(live));
      const b = JSON.stringify(canon(file.children[id]));
      if (a !== b) {
        failures++;
        if (failures <= 10) {
          const la = live.length, lb = file.children[id].length;
          const firstDiff = live.findIndex((x, i) => JSON.stringify(canon(x)) !== JSON.stringify(canon(file.children[id][i])));
          console.log(`✗ ${id}: live ${la} children / file ${lb}; first difference at #${firstDiff}\n    live: ${JSON.stringify(canon(live[firstDiff])).slice(0, 300)}\n    file: ${JSON.stringify(canon(file.children[id][firstDiff])).slice(0, 300)}`);
        }
      }
    }
    process.stdout.write(`\r${root.padEnd(28)} ${checked} checked, ${failures} differ   `);
  }
  console.log(`\n${checked - failures}/${checked} nodes match; ${missing} expandable children without an entry`);
  process.exit(failures || missing ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
