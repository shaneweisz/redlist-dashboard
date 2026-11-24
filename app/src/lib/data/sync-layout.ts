/**
 * Where each of a sync's files lives: the one list of them.
 *
 * A sync is the same tree in three places: syncs/<timestamp>/ in R2, the
 * sync's build (.sync/publish/ at the repo root) and app/data/sync/.
 * Its files are grouped by what they are for:
 *
 *   lists/      the species the dashboard lists: assessed, their assessment
 *               history, the Not Evaluated list, the CoL species universe,
 *               and the OpenAlex works behind each literature count
 *   taxonomy/   the CoL taxonomy and the links to it, and what the
 *               CoL-differences card and the tree's labels need
 *   search/     the search bar's indexes
 *   summaries/  per-group and per-place totals, precomputed
 *   sync.json   (top level) every input version and check result
 *
 * Everything reads a file by its name (syncPath("assessed.parquet")), so a file
 * moves between folders by moving its line here. A name not listed throws,
 * rather than resolving somewhere nothing writes.
 *
 * Not sync data, so not here: the narratives (narratives/<release>/ in R2,
 * app/data/narratives/ locally) and the map overlays (the maps bucket,
 * app/data/overlays/ locally).
 */

export const SYNC_LAYOUT = {
  lists: ["assessed.parquet", "assessments.parquet", "ne.parquet", "species", "literature-works.parquet"],
  taxonomy: [
    "taxa.parquet", "assessment_link.parquet",
    "col-split-candidates.parquet", "col-synonym-assessed.parquet", "col-to-assessed.parquet",
    "col-revisions.json", "vernacular-names.json",
  ],
  search: ["name-index.parquet", "rank-index.parquet", "synonym-index.parquet"],
  summaries: [
    "taxa-summary.json", "table1a-children-summaries.json", "ssc-group-children-summaries.json",
    "country-stats.json",
  ],
  "": ["sync.json", "sync.log"],
} as const;

const FOLDER = new Map<string, string>(
  Object.entries(SYNC_LAYOUT).flatMap(([folder, names]) => names.map((n) => [n, folder] as const)),
);

/**
 * A sync file's path inside the sync, from its name: "assessed.parquet" →
 * "lists/assessed.parquet". A path inside a listed folder keeps its tail:
 * "species/**\/*.parquet" → "lists/species/**\/*.parquet".
 */
export function syncPath(name: string): string {
  const head = name.split("/")[0];
  const folder = FOLDER.get(head);
  if (folder === undefined) throw new Error(`sync-layout: ${name} is not a sync file (add it to SYNC_LAYOUT)`);
  return folder ? `${folder}/${name}` : name;
}

/** The folders a sync writes into, for a builder to create before writing. */
export const SYNC_FOLDERS = Object.keys(SYNC_LAYOUT).filter(Boolean);
