/**
 * seeds/decisions.tsv: the judge's (or a person's) answer for a species the
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
 *   by             judge:<model> (written by `sync:judge -- decide`), a GitHub
 *                  handle (an override: the judge never replaces it), agent:<model>,
 *                  or fixture
 *   reviewed       yes once a person has checked it, or the judge's runs agreed
 *   date           YYYY-MM-DD
 *   evidence       why, in a sentence
 *   sources        the pages or papers it rests on, space-separated
 *   transcripts    the judge's calls it came from, one per run, space-separated: each
 *                  conversation, kept in a private bucket (checks/judge-transcripts.ts)
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
  "relation", "candidates", "by", "reviewed", "date", "evidence", "sources", "transcripts"] as const;

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
  sources: string[];
  transcripts: string[];
}

/** A decision a person made: the judge never replaces it. */
export const isOverride = (d: Pick<Decision, "by">) => !/^(judge|agent):|^fixture$/.test(d.by);

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
      sources: get("sources").split(/\s+/).filter(Boolean), transcripts: get("transcripts").split(/\s+/).filter(Boolean),
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
        [...d.candidates].sort().join(";"), d.by, d.reviewed ? "yes" : "no", d.date, d.evidence, d.sources.join(" "), d.transcripts.join(" ")].map(clean).join("\t"));
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
 * doesn't compare `other` with `redlist_authority`, no record's name is another
 * assessed name, nor the species of an *is* or *split into* record (a *part of*
 * record takes only its own occurrences, so its species may be assessed), and
 * each record is found: by `id` with the recorded
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
    const whole = r.relation === "is" || r.relation === "split into";
    if ((r.name && release.isAnotherAssessedName(r.name)) || (whole && r.species && release.isAnotherAssessedName(r.species))) return { holds: false, lapse: "assessed name" };
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

// ── The judge's other files ───────────────────────────────────────────────────

/**
 * seeds/judge-verdicts.tsv: the judge's verdict on a species whose rules' answer
 * it was asked about, applied while the rules still give that answer and no
 * decision holds: `confirmed` (its runs agreed with the rules; the species
 * leaves the review list) or `undecided` (they didn't agree; the doubt
 * `judge undecided`).
 *
 *   sis_taxon_id, redlist_name
 *   verdict  confirmed | undecided
 *   answer   the rules' answer it was given, as answerKey writes it
 *   votes    how the runs answered, e.g. "3/5 rules; 1/5 other; 1/5 can't tell"
 *   by       judge:<model>
 *   date     YYYY-MM-DD
 *   transcripts  the judge's calls, as in decisions.tsv
 */
export const VERDICTS_FILE = path.join(SEEDS_DIR, "judge-verdicts.tsv");
const VERDICT_COLUMNS = ["sis_taxon_id", "redlist_name", "verdict", "answer", "votes", "by", "date", "transcripts"] as const;
export type VerdictKind = "confirmed" | "undecided";
export interface JudgeVerdict { sis: number; redlistName: string; verdict: VerdictKind; answer: string; votes: string; by: string; date: string; transcripts: string[] }

/** A selection's answer as a verdict keeps it: its taken records and relations, refused left out, sorted. */
export const answerKey = (selected: { id: string; relation: string }[]) =>
  selected.filter((x) => x.relation !== "refused").map((x) => `${x.id}:${x.relation}`).sort().join(",");

/**
 * seeds/judge-notes.tsv: a person's notes to the judge about one species, which
 * it is given with the species' facts, weighed as evidence. A note puts the
 * species in the next `decide` run, and a changed note asks again.
 *
 *   sis_taxon_id, redlist_name, note, by (a GitHub handle), date
 */
export const NOTES_FILE = path.join(SEEDS_DIR, "judge-notes.tsv");
const NOTES_COLUMNS = ["sis_taxon_id", "redlist_name", "note", "by", "date"] as const;
export interface Note { sis: number; redlistName: string; note: string; by: string; date: string }

function readTsv<C extends readonly string[]>(file: string, columns: C): Record<C[number], string>[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const header = lines.shift()?.split("\t") ?? [];
  if (columns.some((c, i) => header[i] !== c)) throw new Error(`${path.basename(file)}: expected columns ${columns.join(", ")}`);
  return lines.map((l) => { const f = l.split("\t"); return Object.fromEntries(columns.map((c, i) => [c, (f[i] ?? "").trim()])) as Record<C[number], string>; });
}
function writeTsv<C extends readonly string[]>(file: string, columns: C, rowsOut: string[][]): void {
  const clean = (s: string) => s.replace(/[\t\n]/g, " ");
  fs.writeFileSync(file, [columns.join("\t"), ...rowsOut.map((r) => r.map(clean).join("\t"))].join("\n") + "\n");
}

export function readVerdicts(file = VERDICTS_FILE): Map<number, JudgeVerdict> {
  return new Map(readTsv(file, VERDICT_COLUMNS).map((r) => {
    if (r.verdict !== "confirmed" && r.verdict !== "undecided") throw new Error(`${path.basename(file)}: verdict "${r.verdict}" for ${r.sis_taxon_id} isn't confirmed or undecided`);
    return [Number(r.sis_taxon_id), { sis: Number(r.sis_taxon_id), redlistName: r.redlist_name, verdict: r.verdict, answer: r.answer, votes: r.votes,
      by: r.by, date: r.date, transcripts: r.transcripts.split(/\s+/).filter(Boolean) }];
  }));
}
export function writeVerdicts(vs: Iterable<JudgeVerdict>, file = VERDICTS_FILE): void {
  writeTsv(file, VERDICT_COLUMNS, [...vs].sort((a, b) => a.sis - b.sis).map((v) => [String(v.sis), v.redlistName, v.verdict, v.answer, v.votes, v.by, v.date, v.transcripts.join(" ")]));
}
export function readNotes(file = NOTES_FILE): Map<number, Note[]> {
  const out = new Map<number, Note[]>();
  for (const r of readTsv(file, NOTES_COLUMNS)) {
    const sis = Number(r.sis_taxon_id);
    if (!Number.isInteger(sis) || sis <= 0 || !r.note) throw new Error(`${path.basename(file)}: a row needs a sis_taxon_id and a note`);
    (out.get(sis) ?? out.set(sis, []).get(sis)!).push({ sis, redlistName: r.redlist_name, note: r.note, by: r.by, date: r.date });
  }
  return out;
}
