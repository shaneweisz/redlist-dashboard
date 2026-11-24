/**
 * The releases the deployed data comes from, as the footer credits them:
 * the Red List version, the date of GBIF's occurrence snapshot, and the
 * Catalogue of Life release GBIF filed those records under (the one the
 * whole sync uses), and the literature the counts come from. Baked in at build from the sync's sync.json (next.config.ts).
 */
export interface DataVersions {
  /** "2026-1" */
  redlist?: string;
  /** "1 November 2026" */
  gbifSnapshot?: string;
  /** "COL26.6 XR" */
  col?: string;
  /** The OpenAlex snapshot: "14 October 2026" */
  openalex?: string;
  /** BHL's monthly export: "November 2026" */
  bhl?: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** sync.json's values, in the footer's words. Anything missing or malformed is left out rather than guessed. */
export function parseDataVersions(raw: string | undefined): DataVersions {
  let v: { redlist?: unknown; gbifSnapshot?: unknown; col?: unknown; openalex?: unknown; bhl?: unknown };
  try {
    v = JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
  const out: DataVersions = {};
  // The Red List database is named for its release: redlist_2026_1 is 2026-1.
  const rl = typeof v.redlist === "string" ? /^redlist_(\d{4})_(\d+)$/.exec(v.redlist) : null;
  if (rl) out.redlist = `${rl[1]}-${rl[2]}`;
  const gbif = dayInWords(v.gbifSnapshot);
  if (gbif) out.gbifSnapshot = gbif;
  if (typeof v.col === "string" && v.col.trim()) out.col = v.col.trim();
  const openalex = dayInWords(v.openalex);
  if (openalex) out.openalex = openalex;
  const m = typeof v.bhl === "string" ? /^(\d{4})-(\d{2})$/.exec(v.bhl) : null;
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) out.bhl = `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return out;
}

/** "2026-11-01" → "1 November 2026"; anything else → null. */
function dayInWords(v: unknown): string | null {
  const d = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  return d && Number(d[2]) >= 1 && Number(d[2]) <= 12 ? `${Number(d[3])} ${MONTHS[Number(d[2]) - 1]} ${d[1]}` : null;
}

export const DATA_VERSIONS: DataVersions = parseDataVersions(process.env.NEXT_PUBLIC_DATA_VERSIONS);
