/**
 * seeds/decisions.tsv: a person's (or an agent's) answer for a species the
 * rules can't settle (docs/specs/matching.md, "Decisions"). One row per decided
 * CoL record, tab-separated so it opens in a spreadsheet and diffs line by line:
 *
 *   sis_taxon_id, redlist_name, redlist_authority
 *                  the species, and what the Red List called it when decided
 *   id, name, authorship, status, species
 *                  the CoL record, as the release decided against held it, and
 *                  the accepted species it led to; all empty for "not in CoL"
 *   relation       is | part of | split into
 *   candidates     the candidates' species names when decided, sorted, ;-separated
 *   by             a GitHub handle, agent:<model>, or fixture
 *   reviewed       yes once a person has checked it
 *   date           YYYY-MM-DD
 *   evidence       why, in a sentence
 *
 * A species' rows agree on the species-level columns. Whether a decision holds
 * is decisionHolds, below; select.ts applies it.
 */

import * as fs from "fs";
import * as path from "path";
import { SEEDS_DIR } from "../seeds/seeds";
import { compareAuthors, normaliseAuthorship, sameName, sameNameKey } from "./name-rules";

export const DECISIONS_FILE = path.join(SEEDS_DIR, "decisions.tsv");
export const COLUMNS = ["sis_taxon_id", "redlist_name", "redlist_authority", "id", "name", "authorship", "status", "species",
  "relation", "candidates", "by", "reviewed", "date", "evidence"] as const;

export type DecidedRelation = "is" | "part of" | "split into";

export interface DecisionRow {
  id: string | null;
  name: string | null;
  authorship: string | null;
  /** CoL's status, lower-case as in taxa.parquet (accepted, synonym, ...). */
  status: string | null;
  /** The accepted species' name it led to. */
  species: string | null;
  relation: DecidedRelation | null;
}

export interface Decision {
  sis: number;
  redlistName: string;
  redlistAuthority: string | null;
  /** Empty: "not in CoL". */
  rows: DecisionRow[];
  candidates: string[];
  by: string;
  reviewed: boolean;
  date: string;
  evidence: string;
}

const RELATIONS = new Set<string>(["is", "part of", "split into"]);

export function readDecisions(file = DECISIONS_FILE): Map<number, Decision> {
  const out = new Map<number, Decision>();
  if (!fs.existsSync(file)) return out;
  const base = path.basename(file);
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const header = lines.shift()?.split("\t") ?? [];
  if (COLUMNS.some((c, i) => header[i] !== c)) throw new Error(`${base}: expected columns ${COLUMNS.join(", ")}`);
  for (const [i, line] of lines.entries()) {
    const f = line.split("\t");
    const get = (c: (typeof COLUMNS)[number]) => (f[COLUMNS.indexOf(c)] ?? "").trim();
    const sis = Number(get("sis_taxon_id"));
    if (!Number.isInteger(sis) || sis <= 0) throw new Error(`${base} line ${i + 2}: bad sis_taxon_id "${get("sis_taxon_id")}"`);
    if (!get("by")) throw new Error(`${base}: SIS ${sis} has no "by"`);
    const relation = get("relation");
    if (get("id") && !RELATIONS.has(relation)) throw new Error(`${base}: SIS ${sis}: relation must be is, part of or split into, not "${relation}"`);
    const row: DecisionRow = { id: get("id") || null, name: get("name") || null, authorship: get("authorship") || null,
      status: get("status") || null, species: get("species") || null, relation: (relation || null) as DecidedRelation | null };
    const species = {
      sis, redlistName: get("redlist_name"), redlistAuthority: get("redlist_authority") || null,
      candidates: get("candidates") ? get("candidates").split(";").map((s) => s.trim()).filter(Boolean) : [],
      by: get("by"), reviewed: get("reviewed").toLowerCase() === "yes", date: get("date"), evidence: get("evidence"),
    };
    const prev = out.get(sis);
    if (prev) {
      const { rows: _, ...p } = prev;
      if (JSON.stringify(p) !== JSON.stringify(species)) throw new Error(`${base}: SIS ${sis}'s rows disagree on the species-level columns`);
      if (!row.id || prev.rows.length === 0) throw new Error(`${base}: SIS ${sis}: "not in CoL" must be the species' only row`);
      prev.rows.push(row);
    } else out.set(sis, { ...species, rows: row.id ? [row] : [] });
  }
  return out;
}

export function writeDecisions(decisions: Iterable<Decision>, file = DECISIONS_FILE): void {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/[\t\n]/g, " ");
  const lines: string[] = [];
  for (const d of [...decisions].sort((a, b) => a.sis - b.sis)) {
    for (const r of d.rows.length ? d.rows : [null]) {
      lines.push([String(d.sis), d.redlistName, d.redlistAuthority, r?.id, r?.name, r?.authorship, r?.status, r?.species, r?.relation,
        [...d.candidates].sort().join(";"), d.by, d.reviewed ? "yes" : "no", d.date, d.evidence].map(clean).join("\t"));
    }
  }
  fs.writeFileSync(file, [COLUMNS.join("\t"), ...lines].join("\n") + "\n");
}

/** A CoL record as a decision is checked against: taxa.parquet's, with the accepted species it leads to. */
export interface DecidableRecord { id: string; name: string; authorship: string | null; status: string; speciesId: string | null; speciesName: string | null }

/** Why a decision doesn't hold, in the words of to_review's `decision lapsed (...)`. */
export type Lapse = "name" | "citation" | "assessed name" | "record not found";

/**
 * Whether a decision holds, and the records it means in this release. It holds
 * while the Red List still calls the species `redlist_name`, its citation
 * doesn't compare `other` with `redlist_authority`, no record's name or species
 * is another assessed name, and each record is found: by `id` with the recorded
 * name, status and species, else as the one record with those and an equal
 * authorship. It holds only if every row does.
 *
 * `byId` and `byName` look records up in the release (by id; by the same name).
 */
export function decisionHolds<R extends DecidableRecord>(
  d: Decision,
  species: { name: string; citation: string | null },
  release: { byId: (id: string) => R | undefined; byName: (name: string) => R[]; isAnotherAssessedName: (name: string) => boolean },
): { holds: true; records: { record: R; relation: DecidedRelation }[] } | { holds: false; lapse: Lapse } {
  if (!sameName(d.redlistName, species.name)) return { holds: false, lapse: "name" };
  if (compareAuthors(species.citation, d.redlistAuthority) === "other") return { holds: false, lapse: "citation" };
  const records: { record: R; relation: DecidedRelation }[] = [];
  for (const r of d.rows) {
    if ((r.name && release.isAnotherAssessedName(r.name)) || (r.species && release.isAnotherAssessedName(r.species))) return { holds: false, lapse: "assessed name" };
    const matches = (x: R | undefined): x is R => !!x && sameName(x.name, r.name ?? "") && x.status === r.status
      && sameNameKey(x.speciesName ?? "") === sameNameKey(r.species ?? "");
    const byId = r.id ? release.byId(r.id) : undefined;
    const found = matches(byId) ? byId : (() => {
      const same = release.byName(r.name ?? "").filter((x) => matches(x)
        && normaliseAuthorship(x.authorship ?? undefined) === normaliseAuthorship(r.authorship ?? undefined));
      return same.length === 1 ? same[0] : undefined;
    })();
    if (!found) return { holds: false, lapse: "record not found" };
    records.push({ record: found, relation: r.relation! });
  }
  return { holds: true, records };
}
