/**
 * The releases the deployed data comes from, as the footer credits them:
 * the Red List version, the date of GBIF's occurrence snapshot, and the
 * Catalogue of Life release the taxonomy follows (CoL's newest). Also the
 * release the snapshot's records were filed under, which a count's note names
 * when the two differ. Baked in at build from the sync's sync.json (next.config.ts).
 */
export interface DataVersions {
  /** "2026-1" */
  redlist?: string;
  /** "1 November 2026" */
  gbifSnapshot?: string;
  /** "COL26.10 XR" */
  col?: string;
  /** "COL26.6 XR": the XR the snapshot is keyed by */
  snapshotCol?: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** sync.json's values, in the footer's words. Anything missing or malformed is left out rather than guessed. */
export function parseDataVersions(raw: string | undefined): DataVersions {
  let v: { redlist?: unknown; gbifSnapshot?: unknown; col?: unknown; snapshotCol?: unknown };
  try {
    v = JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
  const out: DataVersions = {};
  // The Red List database is named for its release: redlist_2026_1 is 2026-1.
  const rl = typeof v.redlist === "string" ? /^redlist_(\d{4})_(\d+)$/.exec(v.redlist) : null;
  if (rl) out.redlist = `${rl[1]}-${rl[2]}`;
  const d = typeof v.gbifSnapshot === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.gbifSnapshot) : null;
  if (d && Number(d[2]) >= 1 && Number(d[2]) <= 12) out.gbifSnapshot = `${Number(d[3])} ${MONTHS[Number(d[2]) - 1]} ${d[1]}`;
  if (typeof v.col === "string" && v.col.trim()) out.col = v.col.trim();
  if (typeof v.snapshotCol === "string" && v.snapshotCol.trim()) out.snapshotCol = v.snapshotCol.trim();
  return out;
}

export const DATA_VERSIONS: DataVersions = parseDataVersions(process.env.NEXT_PUBLIC_DATA_VERSIONS);
