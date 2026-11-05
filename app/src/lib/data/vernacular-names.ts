/**
 * Loads data/vernacular-names.json (built by scripts/sync/core/build-taxa.ts from the
 * CoL XR export's VernacularName.tsv — see that script's file comment) into
 * dynamic-taxon.ts's EXTRA_VERNACULAR_NAMES, once per warm server process.
 *
 * Server-only (fs) — deliberately kept out of dynamic-taxon.ts itself, which is
 * bundled into the browser too (TaxaSummary.tsx imports it directly). Call
 * ensureVernacularNamesLoaded() before any server-side dynamicNodeDisplayName()
 * call that should reflect CoL-derived names (getLiveRankChildren,
 * getLiveBreakdown, filter-vocab.ts's taxonLabel) — idempotent, so calling it
 * on every request is cheap after the first.
 */
import fs from "fs";
import path from "path";
import { syncPath } from "./sync-layout";
import { setVernacularNames } from "@/lib/dynamic-taxon";

const VERNACULAR_NAMES_PATH = path.join(process.cwd(), "data", "sync", syncPath("vernacular-names.json"));

let loaded = false;

export function ensureVernacularNamesLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const content = fs.readFileSync(VERNACULAR_NAMES_PATH, "utf-8");
    setVernacularNames(JSON.parse(content) as Record<string, string>);
  } catch {
    // Missing (e.g. a partial local sync without a full backbone rebuild, or a
    // pre-this-feature data sync) — degrade to dynamic-taxon.ts's hand-curated
    // COMMON_NAME_BY_VALUE only, same behavior as before this file existed.
  }
}
