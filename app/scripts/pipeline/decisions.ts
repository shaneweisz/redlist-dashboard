/**
 * The decisions file: which CoL name a Red List species is, where the matcher's
 * answer isn't taken on its own (accept-match.ts).
 *
 * decisions.tsv, one row per species, tab-separated so it opens in a
 * spreadsheet and diffs line by line in a pull request:
 *
 *   sis_taxon_id    the Red List taxon
 *   redlist_name    its name when decided; a renamed species is asked again
 *   col_name        the CoL name it is, as CoL spells it; empty means "not in CoL"
 *   col_authorship  that name's CoL authorship, to tell homonyms apart
 *   col_id          the usage's id in the release decided against (a hint: ids move)
 *   by              who decided: a GitHub handle, "agent:<model>", or
 *                   "heuristic" for answers carried over from the old matching passes
 *   reviewed        yes once a person has checked it
 *   date            YYYY-MM-DD
 *   note            the evidence, in a sentence
 *
 * A decision names a name, not an outcome: the same concept rules as for a
 * matched name then say what it owns (build-link.ts). It is re-applied every
 * sync while its names still resolve, and asked again when they don't.
 */

import * as fs from "fs";
import * as path from "path";
import { normaliseAuthorship } from "../species-key";

export const DECISIONS_FILE = path.join(__dirname, "decisions.tsv");
export const COLUMNS = ["sis_taxon_id", "redlist_name", "col_name", "col_authorship", "col_id", "by", "reviewed", "date", "note"] as const;

export interface Decision {
  sis: number;
  redlistName: string;
  colName: string | null;
  colAuthorship: string | null;
  colId: string | null;
  by: string;
  reviewed: boolean;
  date: string;
  note: string;
}

export function readDecisions(file = DECISIONS_FILE): Map<number, Decision> {
  const out = new Map<number, Decision>();
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
      sis, redlistName: get("redlist_name"), colName: get("col_name") || null, colAuthorship: get("col_authorship") || null,
      colId: get("col_id") || null, by: get("by"), reviewed: get("reviewed").toLowerCase() === "yes", date: get("date"), note: get("note"),
    });
  }
  return out;
}

export function writeDecisions(decisions: Iterable<Decision>, file = DECISIONS_FILE): void {
  const clean = (s: string | null) => (s ?? "").replace(/[\t\n]/g, " ");
  const rows = [...decisions].sort((a, b) => a.sis - b.sis).map((d) => [
    d.sis, d.redlistName, d.colName, d.colAuthorship, d.colId, d.by, d.reviewed ? "yes" : "no", d.date, d.note,
  ].map((x) => clean(x === null ? null : String(x))).join("\t"));
  fs.writeFileSync(file, [COLUMNS.join("\t"), ...rows].join("\n") + "\n");
}

export interface Candidate { col_id: string; scientific_name: string; authorship: string | null; status: string }

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
export function resolveDecision(d: Decision, currentName: string, candidates: Candidate[]): Resolution {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  if (norm(d.redlistName) !== norm(currentName)) return { kind: "stale", why: `decided for ${d.redlistName}; the Red List now calls it ${currentName}` };
  if (!d.colName) return { kind: "not in CoL" };
  const named = candidates.filter((c) => norm(c.scientific_name) === norm(d.colName!));
  if (d.colId && named.some((c) => c.col_id === d.colId)) return { kind: "usage", colId: d.colId };
  const auth = normaliseAuthorship(d.colAuthorship ?? undefined);
  const same = named.filter((c) => normaliseAuthorship(c.authorship ?? undefined) === auth);
  if (same.length === 0) return { kind: "stale", why: `CoL has no ${d.colName}${d.colAuthorship ? ` ${d.colAuthorship}` : ""} any more` };
  const order = (s: string) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? STATUS_ORDER.length : i; };
  same.sort((a, b) => order(a.status) - order(b.status) || a.col_id.localeCompare(b.col_id));
  return { kind: "usage", colId: same[0].col_id };
}
