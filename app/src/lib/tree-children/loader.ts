/**
 * Browser loader for the pre-built tree files (scripts/build-tree-children.ts →
 * public/species-lists/<sync>/tree/<root>.json.br).
 *
 * Answers an UNSCOPED expand of a live-drilldown node (what
 * /api/redlist/taxa-subgroups?nodeId=… returns as `subgroups`) from one file per
 * drilldown root, downloaded once and shared by every expand under that root. Returns
 * null whenever the files can't answer — no file for this deployment (`next dev`, or an
 * old tab after a deploy), a node outside the live drilldown, or an id the file has no
 * entry for — and the caller falls back to the live route. Country/realm-scoped expands
 * never come here; the caller sends those straight to the route.
 */
// taxonomy-utils first: it and dynamic-taxon import each other, and entering the cycle
// through dynamic-taxon hits its constants before they're initialised.
import "@/lib/taxonomy-utils";
import { isLiveDrilldownNode, nextDynamicRank, parseDynamicNodeId } from "@/lib/dynamic-taxon";
import type { NodeSummary } from "@/lib/data/species-store";
import { treeChildrenFileName, type TreeChildrenFile } from "./format";

const SYNC = process.env.NEXT_PUBLIC_SPECIES_LISTS_SYNC ?? "";

const rootFiles = new Map<string, Promise<TreeChildrenFile | null>>();

function loadRoot(root: string): Promise<TreeChildrenFile | null> {
  let load = rootFiles.get(root);
  if (!load) {
    load = fetch(`/species-lists/${SYNC}/tree/${treeChildrenFileName(root)}`)
      .then((res) => (res.ok ? (res.json() as Promise<TreeChildrenFile>) : null))
      .then((f) => (f && f.v === 1 && f.sync === SYNC && f.root === root ? f : null))
      .catch(() => null);
    // A failed download shouldn't pin "no file" for the session; let the next expand retry.
    load.then((f) => { if (!f) rootFiles.delete(root); });
    rootFiles.set(root, load);
  }
  return load;
}

export async function treeChildrenFromFiles(nodeId: string): Promise<NodeSummary[] | null> {
  if (!SYNC || !isLiveDrilldownNode(nodeId)) return null;
  if (!nextDynamicRank(nodeId)) return []; // genus: a leaf — the route answers [] too
  const root = parseDynamicNodeId(nodeId)?.rootId ?? nodeId;
  const file = await loadRoot(root);
  return file?.children[nodeId] ?? null;
}

/** Test hook. */
export function __resetTreeChildrenLoader() {
  rootFiles.clear();
}
