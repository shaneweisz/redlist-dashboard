/**
 * The decisions file: which CoL name a Red List species is, where the matcher's
 * answer isn't taken on its own (accept-match.ts).
 *
 * match-overrides.tsv, one row per species, tab-separated so it opens in a
 * spreadsheet and diffs line by line in a pull request:
 *
 *   sis_taxon_id    the Red List taxon
 *   redlist_name    its name when decided; a renamed species is asked again
 *   redlist_authority  the Red List's authority for it then: with the name, what
 *                   the Red List meant, which matters for a homonym. One that
 *                   now clearly names other authors (authors.ts) is asked again;
 *                   a corrected spelling or a reformatting isn't
 *   col_name        the CoL name it is, as CoL spells it; empty means "not in CoL"
 *   col_authorship  that name's CoL authorship, to tell homonyms apart
 *   col_id          the usage's id in the release decided against (a hint: ids move)
 *   col_status      what CoL said that name was then (accepted, provisionally
 *                   accepted, synonym, ...)
 *   col_species     the accepted species it led to then
 *   redlist_version, col_version
 *                   the releases it was decided against: Red List 2026-1,
 *                   COL26.6 XR
 *   by              who decided: a GitHub handle, "agent:<model>", or "fixture"
 *                   for a case checks/fixtures/matching.ts pins down
 *   reviewed        yes once a person has checked it
 *   date            YYYY-MM-DD
 *   note            the evidence, in a sentence
 *
 * A decision names a name, not an outcome: the same concept rules as for a
 * matched name then say what it owns (link/assessment-link.ts). It holds for the
 * releases it names, and is carried to a newer one while what it rested on is
 * still true there: the Red List still calls the species by that name, and CoL
 * still holds that name, with the same status, leading to the same species. When
 * any of that moves it is stale, and asked again; until then the matcher's
 * answer applies if it passes the rule on its own.
 */

import * as fs from "fs";
import * as path from "path";
import { SEEDS_DIR } from "../seeds/seeds";
import { compareAuthors, normaliseAuthorship } from "../../../src/lib/authors";

export const OVERRIDES_FILE = path.join(SEEDS_DIR, "match-overrides.tsv");
export const COLUMNS = ["sis_taxon_id", "redlist_name", "redlist_authority", "col_name", "col_authorship", "col_id", "col_status", "col_species",
  "redlist_version", "col_version", "by", "reviewed", "date", "note"] as const;

export interface MatchOverride {
  sis: number;
  redlistName: string;
  redlistAuthority: string | null;
  colName: string | null;
  colAuthorship: string | null;
  colId: string | null;
  colStatus: string | null;
  colSpecies: string | null;
  redlistVersion: string | null;
  colVersion: string | null;
  by: string;
  reviewed: boolean;
  date: string;
  note: string;
}

export function readOverrides(file = OVERRIDES_FILE): Map<number, MatchOverride> {
  const out = new Map<number, MatchOverride>();
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const header = lines.shift()?.split("\t") ?? [];
  if (COLUMNS.some((c, i) => header[i] !== c)) throw new Error(`${path.basename(file)}: expected columns ${COLUMNS.join(", ")}`);
  for (const [i, line] of lines.entries()) {
    const f = line.split("\t");
    const get = (c: (typeof COLUMNS)[number]) => (f[COLUMNS.indexOf(c)] ?? "").trim();
    const sis = Number(get("sis_taxon_id"));
    if (!Number.isInteger(sis) || sis <= 0) throw new Error(`${path.basename(file)} line ${i + 2}: bad sis_taxon_id "${get("sis_taxon_id")}"`);
    if (out.has(sis)) throw new Error(`${path.basename(file)}: SIS ${sis} is decided twice`);
    if (!get("by")) throw new Error(`${path.basename(file)}: SIS ${sis} has no "by"`);
    out.set(sis, {
      sis, redlistName: get("redlist_name"), redlistAuthority: get("redlist_authority") || null, colName: get("col_name") || null, colAuthorship: get("col_authorship") || null,
      colId: get("col_id") || null, colStatus: get("col_status") || null, colSpecies: get("col_species") || null,
      redlistVersion: get("redlist_version") || null, colVersion: get("col_version") || null, by: get("by"), reviewed: get("reviewed").toLowerCase() === "yes", date: get("date"), note: get("note"),
    });
  }
  return out;
}

export function writeOverrides(decisions: Iterable<MatchOverride>, file = OVERRIDES_FILE): void {
  const clean = (s: string | null) => (s ?? "").replace(/[\t\n]/g, " ");
  const rows = [...decisions].sort((a, b) => a.sis - b.sis).map((d) => [
    d.sis, d.redlistName, d.redlistAuthority, d.colName, d.colAuthorship, d.colId, d.colStatus, d.colSpecies, d.redlistVersion, d.colVersion,
    d.by, d.reviewed ? "yes" : "no", d.date, d.note,
  ].map((x) => clean(x === null ? null : String(x))).join("\t"));
  fs.writeFileSync(file, [COLUMNS.join("\t"), ...rows].join("\n") + "\n");
}

/** A CoL usage a decision may mean, and the accepted species it leads to (itself, when accepted). */
export interface Candidate { col_id: string; scientific_name: string; authorship: string | null; status: string; species_name: string | null }

export type Resolution =
  | { kind: "usage"; colId: string }
  | { kind: "not in CoL" }
  | { kind: "stale"; why: string };

const STATUS_ORDER = ["accepted", "provisionally accepted", "synonym", "ambiguous synonym"];

/**
 * Which usage of this release a decision means. The recorded id if it still
 * carries the recorded name; else the one usage with that name and authorship;
 * else (several, a name CoL holds twice) the accepted one, then the lowest id.
 */
export function resolveOverride(d: MatchOverride, currentName: string, candidates: Candidate[], currentAuthority: string | null = null): Resolution {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  if (norm(d.redlistName) !== norm(currentName)) return { kind: "stale", why: `decided for ${d.redlistName}; the Red List now calls it ${currentName}` };
  if (compareAuthors(d.redlistAuthority, currentAuthority) === "other") {
    return { kind: "stale", why: `decided for ${d.redlistName} ${d.redlistAuthority}; the Red List now cites ${currentAuthority}` };
  }
  if (!d.colName) return { kind: "not in CoL" };
  const named = candidates.filter((c) => norm(c.scientific_name) === norm(d.colName!));
  const auth = normaliseAuthorship(d.colAuthorship ?? undefined);
  const same = named.filter((c) => normaliseAuthorship(c.authorship ?? undefined) === auth);
  const order = (s: string) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? STATUS_ORDER.length : i; };
  same.sort((a, b) => order(a.status) - order(b.status) || a.col_id.localeCompare(b.col_id));
  const hit = (d.colId ? named.find((c) => c.col_id === d.colId) : undefined) ?? same[0];
  if (!hit) return { kind: "stale", why: `CoL has no ${d.colName}${d.colAuthorship ? ` ${d.colAuthorship}` : ""} any more` };
  // What the decision rested on must still hold in this release.
  const since = d.colVersion ? ` (decided against ${d.colVersion})` : "";
  if (d.colStatus && hit.status !== d.colStatus) {
    return { kind: "stale", why: `CoL now holds ${d.colName} as ${hit.status}, not ${d.colStatus}${since}` };
  }
  if (d.colSpecies && hit.species_name && norm(hit.species_name) !== norm(d.colSpecies)) {
    return { kind: "stale", why: `CoL now files ${d.colName} under ${hit.species_name}, not ${d.colSpecies}${since}` };
  }
  return { kind: "usage", colId: hit.col_id };
}
