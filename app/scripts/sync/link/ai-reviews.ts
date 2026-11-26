/**
 * seeds/ai-reviews.tsv: the AI taxonomic reviewers' answers (docs/specs/matching.md,
 * "AI taxonomic review"), written by `npm run sync:ai-review -- review`. A
 * review never changes which records are taken: it is shown beside the rules'
 * answer, and says whether a species stays listed for review. One row per
 * species and reviewer, tab-separated so it opens in a spreadsheet and diffs
 * line by line:
 *
 *   sis_taxon_id, redlist_name
 *   reviewer      1 | 2: the independent run it came from (other batch-mates, other order)
 *   finding       agrees | other records | can't tell
 *   records       for "other records", what it would count, "; "-separated: each CoL
 *                 species counted whole (by its id and name), then each part-of record,
 *                 "<id> <relation>: <name> <authorship> [<status>, of <species>], <n> records"
 *                 (n: the GBIF records of the CoL species for is and split into, or
 *                 under the record for part of, when reviewed)
 *   reason        why, in a sentence or two
 *   sources       the pages it read, space-separated
 *   rules_answer  the rules' answer it was given, as answerKey writes it: by the records'
 *                 names, authorship, status and species, not their ids, which move
 *   basis         what else it was given, hashed (reviewBasis)
 *   model, date   YYYY-MM-DD
 *   transcript    the call it came from: its whole conversation, kept in the transcripts
 *                 bucket (checks/ai-review-transcripts.ts)
 *   context       what it was reviewed on: the CoL XR, GBIF snapshot, matcher version
 *                 and prompt (its SHA-256's first 8)
 *
 * A species' rows apply while the rules give the same answer and basis (select.ts).
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SEEDS_DIR } from "../seeds/seeds";
import { normaliseAuthorship } from "./name-rules";

export const REVIEWS_FILE = path.join(SEEDS_DIR, "ai-reviews.tsv");
const COLUMNS = ["sis_taxon_id", "redlist_name", "reviewer", "finding", "records", "reason", "sources", "rules_answer", "basis",
  "model", "date", "transcript", "context"] as const;

export type Finding = "agrees" | "other records" | "can't tell";
const FINDINGS = new Set<string>(["agrees", "other records", "can't tell"]);

/** A record a reviewer would count instead. */
export interface SuggestedRecord { id: string; relation: "is" | "part of" | "split into"; /** Its name and authorship. */ label: string; status: string; species: string | null; records: number }

export interface Review {
  sis: number; redlistName: string; reviewer: number; finding: Finding; records: SuggestedRecord[];
  reason: string; sources: string[]; rulesAnswer: string; basis: string; model: string; date: string; transcript: string; context: string;
}

const RECORD = /^(\S+) (is|part of|split into): (.*?) \[(.*), of (.*)\], (\d+) records$/;
const clean = (s: string | null | undefined) => (s ?? "").replace(/[\t\n]/g, " ");

export const formatRecord = (r: SuggestedRecord) => `${r.id} ${r.relation}: ${r.label.replace(/;/g, ",")} [${r.status}, of ${r.species ?? "-"}], ${r.records} records`;

export function parseRecord(s: string): SuggestedRecord {
  const m = RECORD.exec(s.trim());
  if (!m) throw new Error(`ai-reviews.tsv: can't read the record "${s}"`);
  const [, id, relation, label, status, species, n] = m;
  return { id, relation: relation as SuggestedRecord["relation"], label, status, species: species === "-" ? null : species, records: Number(n) };
}

export function readReviews(file = REVIEWS_FILE): Map<number, Review[]> {
  const out = new Map<number, Review[]>();
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
    if (!FINDINGS.has(get("finding"))) throw new Error(`${base} line ${i + 2}: finding must be agrees, other records or can't tell, not "${get("finding")}"`);
    const r: Review = {
      sis, redlistName: get("redlist_name"), reviewer: Number(get("reviewer")), finding: get("finding") as Finding,
      records: get("records") ? get("records").split("; ").map(parseRecord) : [],
      reason: get("reason"), sources: get("sources").split(/\s+/).filter(Boolean), rulesAnswer: get("rules_answer"), basis: get("basis"),
      model: get("model"), date: get("date"), transcript: get("transcript"), context: get("context"),
    };
    (out.get(sis) ?? out.set(sis, []).get(sis)!).push(r);
  }
  for (const rs of out.values()) rs.sort((a, b) => a.reviewer - b.reviewer);
  return out;
}

export function writeReviews(reviews: Iterable<Review>, file = REVIEWS_FILE): void {
  const lines = [...reviews].sort((a, b) => a.sis - b.sis || a.reviewer - b.reviewer).map((r) =>
    [String(r.sis), r.redlistName, String(r.reviewer), r.finding, r.records.map(formatRecord).join("; "), r.reason, r.sources.join(" "),
      r.rulesAnswer, r.basis, r.model, r.date, r.transcript, r.context].map(clean).join("\t"));
  fs.writeFileSync(file, [COLUMNS.join("\t"), ...lines].join("\n") + "\n");
}

/** The doubt a review adds: one reviewer or both would count other records. */
export const REVIEW_DOUBT = "reviewer suggests other records";

/**
 * What a review was given besides the rules' answer, as a short hash: the Red
 * List name, citation and synonyms, the candidates' species, and the rules'
 * doubts (not the review's own). A new homonym, candidate or synonym changes
 * it, so the species is listed and asked again.
 */
export function reviewBasis(sp: { name: string; authority: string | null; synonyms: { name: string; authors?: string[] }[] },
  s: { candidateSpecies: string[]; doubts: string[] }): string {
  const syn = sp.synonyms.map((y) => `${y.name} ${(y.authors ?? []).join(",")}`).sort();
  const doubts = s.doubts.filter((d) => d !== REVIEW_DOUBT).sort();
  return crypto.createHash("sha256").update(JSON.stringify([sp.name, sp.authority, syn, [...s.candidateSpecies].sort(), doubts])).digest("hex").slice(0, 12);
}

/**
 * A selection's answer as a review keeps it: each taken record (refused left
 * out) by its name, authorship, status and species, with its relation, sorted;
 * by names, so a release that renumbers records keeps it.
 */
export const answerKey = (selected: { name: string; authorship: string | null; status: string; species: string | null; relation: string }[]) =>
  [...new Set(selected.filter((x) => x.relation !== "refused").map((x) =>
    `${x.name} ${normaliseAuthorship(x.authorship ?? undefined)} [${x.status.toLowerCase().replace(/_/g, " ")}, of ${x.species ?? "-"}]: ${x.relation}`))].sort().join("; ");
