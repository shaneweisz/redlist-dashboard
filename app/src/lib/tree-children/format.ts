import type { NodeSummary } from "@/lib/data/species-store";

/**
 * One pre-built tree file (scripts/build/build-tree-children.ts): every expandable node under
 * a dynamic drilldown root → the children /api/redlist/taxa-subgroups returns for it
 * when unscoped.
 */
export interface TreeChildrenFile {
  v: 1;
  /** Sync timestamp the file was built from (= latest-sync.txt). */
  sync: string;
  root: string;
  children: Record<string, NodeSummary[]>;
}

/** Inside public/prebuilt/<sync>/: `tree/<root>.json.br` (served brotli via next.config). */
export const treeChildrenFileName = (root: string) => `${root}.json.br`;
