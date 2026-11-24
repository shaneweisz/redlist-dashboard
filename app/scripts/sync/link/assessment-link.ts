/**
 * assessment_link: the CoL records that represent each assessed species, one
 * row per record, as docs/specs/matching.md's "Output" says. The selection is
 * select.ts; this writes it, with the labels and sentences the app and a
 * reviewer read. Its columns are the link's contract with the rest of the sync.
 *
 * Built from: taxa, assessments, occurrences, matches, seeds/decisions.tsv.
 *
 * Columns:
 *   sis_taxon_id
 *   role           primary (the steps' first record) | covered (the rest, synonym
 *                  records, candidate rows)
 *   relation       is | part of | split into | refused | none (nothing taken) |
 *                  duplicate (another species owns the record)
 *   col_species_id the CoL species the record leads to
 *   col_taxon_id   where its records are counted from: the species for is and
 *                  split into; the record, or the infraspecific CoL files it
 *                  under, for part of
 *   counts         the whole CoL species | only records under its own name | nothing
 *   counted        whether the row's records count (false for refused, duplicate, candidates)
 *   method         the record's CoL status (accepted, provisional, synonym,
 *                  ambiguous_synonym), or for a covered row what added it
 *                  (step_record, synonym_record, undecided_candidate, other_group)
 *   basis          matcher | citation | synonym | decision
 *   decided_by, reviewed   for a decision
 *   step           the primary row's step (1-6)
 *   doubts         the species' doubts, ;-joined, on its primary row
 *   match_reason   how the name found its record (exact, unique | exact, homonym,
 *                  author decides | exact, duplicate in CoL | spelling variant… |
 *                  decision), or why nothing was taken; a covered row's names why it is there
 *   col_treatment  what CoL makes of the record: accepted | synonym, other name |
 *                  synonym, other spelling | lumped, unassessed | lumped, assessed | split;
 *                  a covered row's, the record's CoL status
 *   match_description  the row in a sentence, with names, authors and ids
 *   to_review      why a person needs to look (the queue), on the primary row
 *   match_note, match_records  for a match that isn't plain: why, in sentences, and the CoL records named
 *   match_jury     what the AI jury found, for a species it checked: JSON {kind: decided |
 *                  confirmed | undecided, by, date, votes, transcripts (its runs' keys)}
 */

import { sameName } from "./name-rules";
import { oneOwnerPerUsage, type LinkRow } from "./rules";
import { selectEvery, type ColRecord, type ColSpecies, type Selected, type Selection, type SpeciesInput } from "./select";
import { loadInputs } from "./select-inputs";
import { readDecisions, type Decision } from "./decisions";
import { output, parquet, tables } from "../paths";
import { lit, openDuckDB, rows, writeTable } from "../sql";

export type { LinkRow } from "./rules";

/** What sync.json records about the link. */
export interface LinkSummary {
  byBasis: Record<string, number>;
  unlinked: number;
  steps: Record<string, number>;
  doubts: Record<string, number>;
  queue: Record<string, number>;
}

const status = (s: string | null) => (s ?? "").toLowerCase().replace(/_/g, " ");
const methodOf = (r: ColRecord) => ({ ACCEPTED: "accepted", PROVISIONALLY_ACCEPTED: "provisional", SYNONYM: "synonym",
  AMBIGUOUS_SYNONYM: "ambiguous_synonym" } as Record<string, string>)[r.status] ?? status(r.status).replace(/ /g, "_");
const fmt = (r: { name: string; authorship: string | null; id: string }) => `${r.name}${r.authorship ? ` ${r.authorship}` : ""} [${r.id}]`;
const counts = (relation: string) => relation === "is" || relation === "split into" ? "the whole CoL species"
  : relation === "part of" ? "only records under its own name" : "nothing";

export async function buildLink(
  inputs: { taxa: string; assessments: string; matches: string; occurrences?: string; decisions?: Map<number, Decision> },
  out: { link: string },
): Promise<LinkSummary> {
  const conn = await openDuckDB();
  const T = { ...tables(), taxa: inputs.taxa, assessments: inputs.assessments, matches: inputs.matches, ...(inputs.occurrences ? { occurrences: inputs.occurrences } : {}) };
  const loaded = await loadInputs(T, inputs.decisions ?? readDecisions(), conn);
  const selections = selectEvery(loaded.species, loaded.release, loaded.decisions, loaded.verdicts);
  const species = new Map(loaded.species.map((s) => [s.sis, s]));
  const orphaned = [...loaded.decisions.keys()].filter((k) => !species.has(k));
  if (orphaned.length > 0) console.log(`   ${orphaned.length} decisions name species no longer assessed; delete them (SIS ${orphaned.slice(0, 5).join(", ")})`);

  // Where a part-of record's records start: the record, or the non-nominate
  // infraspecific CoL files the synonym under (Fringilla polatzeki → F. teydea polatzeki).
  const partOf = [...new Set(selections.flatMap((s) => s.selected.filter((x) => x.relation === "part of").map((x) => x.record.id)))];
  await writeTable(conn, "part_of", { id: "VARCHAR" }, partOf.map((id) => ({ id })));
  const root = new Map((await rows<{ id: string; root: string }>(conn, `
    SELECT r.col_id AS id, CASE WHEN r.status = 'synonym' AND p.col_id IS NOT NULL AND p.rank <> 'species' AND p.col_id <> r.species_id
        AND NOT (len(string_split(lower(p.scientific_name), ' ')) > 2 AND string_split(lower(p.scientific_name), ' ')[-1] = string_split(lower(p.scientific_name), ' ')[2])
      THEN p.col_id ELSE r.col_id END AS root
    FROM part_of x JOIN ${parquet(T.taxa)} r ON r.col_id = x.id LEFT JOIN ${parquet(T.taxa)} p ON p.col_id = r.parent_id`)).map((r) => [r.id, r.root]));

  const links: LinkRow[] = [];
  const notes = new Map<number, { note: string; records: NoteRecord[] }>();
  for (const sel of selections) {
    const sp = species.get(sel.sis)!;
    const rowsOf = speciesRows(sel, sp, root);
    links.push(...rowsOf);
    const n = matchNote(sel, sp);
    if (n) notes.set(sel.sis, n);
  }

  // What the AI jury found, for the species it checked: a judge's decision that holds, or a verdict that applies.
  const jury = new Map<number, string>();
  for (const sel of selections) {
    const d = loaded.decisions.get(sel.sis);
    if (sel.step === 1 && d?.by.startsWith("judge:")) jury.set(sel.sis, JSON.stringify({ kind: "decided", by: d.by.slice(6), date: d.date, votes: null, transcripts: d.transcripts }));
    else if (sel.jury) jury.set(sel.sis, JSON.stringify({ kind: sel.jury.verdict, by: loaded.verdicts.get(sel.sis)?.by.replace(/^judge:/, "") ?? null,
      date: sel.jury.date, votes: juryVotes(sel.jury.votes), transcripts: sel.jury.transcripts }));
  }
  const flagged = new Set(selections.filter((s) => s.doubts.length > 0).map((s) => s.sis));
  const exactName = new Set(selections.filter((s) => s.selected[0] && sameName(s.selected[0].record.name, species.get(s.sis)!.name)
    && s.selected[0].record.name.trim() === species.get(s.sis)!.name.trim()).map((s) => s.sis));
  const lost = oneOwnerPerUsage(links, flagged, exactName);
  console.log(`   one owner per record: ${lost.size.toLocaleString()} species lose a record to another`);
  const ownerOf = new Map<string, number>();
  for (const l of links) if (l.counted && l.col_taxon_id) ownerOf.set(l.col_taxon_id, l.sis_taxon_id);
  for (const l of links) if (l.relation === "duplicate") {
    const o = ownerOf.get(l.col_taxon_id!);
    l.match_description = `${l.match_description ?? ""} Counts nothing: ${o ? `${species.get(o)?.name ?? "?"} (SIS ${o})` : "another assessed species"} claims the same record.`.trim();
  }

  await writeTable(conn, "link_rows", { sis_taxon_id: "BIGINT", role: "VARCHAR", relation: "VARCHAR", col_species_id: "VARCHAR", col_taxon_id: "VARCHAR",
    counts: "VARCHAR", method: "VARCHAR", basis: "VARCHAR", decided_by: "VARCHAR", reviewed: "BOOLEAN", step: "INTEGER", doubts: "VARCHAR",
    match_reason: "VARCHAR", col_treatment: "VARCHAR", match_description: "VARCHAR", to_review: "VARCHAR", counted: "BOOLEAN",
    match_note: "VARCHAR", match_records: "VARCHAR", match_jury: "VARCHAR" },
    links.map((l) => {
      const n = l.role === "primary" ? notes.get(l.sis_taxon_id) : undefined;
      return { ...l, counts: l.counted ? counts(l.relation) : "nothing", match_note: n?.note ?? null, match_records: n ? JSON.stringify(n.records) : null,
        match_jury: l.role === "primary" ? jury.get(l.sis_taxon_id) ?? null : null };
    }));
  await conn.run(`COPY (SELECT * FROM link_rows ORDER BY sis_taxon_id, role DESC, col_species_id) TO ${lit(output(out.link))} (FORMAT parquet, COMPRESSION zstd)`);

  const tally = (xs: (string | null)[]) => { const o: Record<string, number> = {}; for (const x of xs) if (x) o[x] = (o[x] ?? 0) + 1; return o; };
  const primary = links.filter((l) => l.role === "primary");
  const summary: LinkSummary = {
    byBasis: tally(primary.map((l) => l.basis ?? "none")),
    unlinked: primary.filter((l) => !l.col_species_id).length,
    steps: tally(selections.map((s) => String(s.step))),
    doubts: tally(selections.flatMap((s) => s.doubts)),
    queue: Object.fromEntries(Object.entries(tally(primary.map((l) => l.to_review?.replace(/ \(.*\)$/, "") ?? null))).sort((a, b) => b[1] - a[1])),
  };
  const listed = primary.filter((l) => l.to_review).length;
  console.log(`   steps ${Object.entries(summary.steps).map(([k, v]) => `${k}: ${v.toLocaleString()}`).join(", ")}; ${listed.toLocaleString()} listed for review`);
  return summary;
}

/** One species' rows: its records (the first the primary row), then candidate rows. */
export function speciesRows(sel: Selection, sp: SpeciesInput, root: Map<string, string>): LinkRow[] {
  const out: LinkRow[] = [];
  const seen = new Set<string>();
  const doubts = sel.doubts.length ? sel.doubts.join(";") : null;
  const steps = sel.selected.filter((x) => x.basis !== "synonym");
  const primaryRecord = steps[0]?.record ?? null;
  const base = { sis_taxon_id: sel.sis, decided_by: null as string | null, reviewed: null as boolean | null, step: null as number | null,
    doubts: null as string | null, to_review: null as string | null };

  const primaryFields = { ...base, role: "primary" as const, step: sel.step, doubts, to_review: sel.toReview,
    decided_by: sel.decision && sel.step === 1 ? sel.decision.by : null, reviewed: sel.decision && sel.step === 1 ? sel.decision.reviewed : null };
  if (!primaryRecord) {
    out.push({ ...primaryFields, col_species_id: null, col_taxon_id: null, relation: "none", method: "unmatched", basis: sel.step === 1 ? "decision" : null,
      match_reason: sel.reason === "decision: not in CoL" ? "decision, not in CoL" : sel.reason ?? "no candidate", col_treatment: null,
      match_description: nothingDescription(sel, sp), counted: false });
  }
  for (const x of sel.selected) {
    const s = x.record.species;
    const taxon = x.relation === "is" || x.relation === "split into" ? s?.id ?? x.record.id : root.get(x.record.id) ?? x.record.id;
    if (seen.has(taxon)) continue;
    seen.add(taxon);
    const isPrimary = out.length === 0;
    const row: LinkRow = {
      ...(isPrimary ? primaryFields : { ...base, role: "covered" as const }),
      col_species_id: s?.id ?? null, col_taxon_id: taxon, relation: x.relation,
      method: isPrimary ? methodOf(x.record) : x.basis === "synonym" ? "synonym_record" : x.basis === "decision" ? "decision_record" : "step_record",
      basis: x.basis,
      decided_by: x.basis === "decision" ? sel.decision?.by ?? null : null,
      reviewed: x.basis === "decision" ? sel.decision?.reviewed ?? null : null,
      match_reason: isPrimary ? primaryReason(sel, sp, x) : coveredReason(x, primaryRecord),
      col_treatment: isPrimary ? treatment(x) : x.relation === "split into" ? "split" : status(x.record.status),
      match_description: describe(x, sp, isPrimary),
      counted: x.relation !== "refused",
    };
    out.push(row);
  }
  // Candidate rows: the untaken groups' CoL species, as a flag on the NE list
  // for a species with a doubt, else as a note there (a settled homonym's other groups).
  for (const c of sel.untakenSpecies) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const doubted = sel.doubts.length > 0;
    out.push({ ...base, role: "covered", col_species_id: c.id, col_taxon_id: c.id, relation: "none",
      method: doubted ? "undecided_candidate" : "other_group", basis: null, match_reason: doubted ? "candidate" : "other group",
      col_treatment: null, counted: false,
      match_description: doubted
        ? `${fmtSpecies(c)} may be it; shown on the Not Evaluated list flagged as possibly this species until someone decides.`
        : `${fmtSpecies(c)} has this name in CoL too, but the citation points elsewhere; it stays on the Not Evaluated list with a note.` });
  }
  return out;
}

const fmtSpecies = (s: ColSpecies) => `${s.name}${s.authorship ? ` ${s.authorship}` : ""} [${s.id}]`;

/** match_reason of the primary row: how the name found its record. */
function primaryReason(sel: Selection, sp: SpeciesInput, x: Selected): string {
  if (x.basis === "decision") return "decision";
  const exact = sameName(x.record.name, sp.name);
  const stepRecords = sel.selected.filter((y) => y.basis !== "synonym");
  const kind = sel.groups > 1 && !sel.doubts.includes("homonym") ? "homonym, author decides"
    : stepRecords.length > 1 ? "duplicate in CoL" : null;
  if (exact) return `exact, ${kind ?? "unique"}`;
  return kind ? `spelling variant, ${kind}` : "spelling variant";
}

/** match_reason of a covered row: why the record is there. */
function coveredReason(x: Selected, primary: ColRecord | null): string {
  if (x.basis === "synonym") return { "is": "CoL duplicate, Red List synonym", "split into": "Red List synonym, split", "part of": "Red List synonym, filed elsewhere",
    "refused": "Red List synonym, assessed separately" }[x.relation];
  if (x.basis === "decision") return "decision";
  if (x.relation === "part of") return "name under another species";
  if (x.relation === "refused") return "refused";
  return primary && !sameName(primary.name, x.record.name) ? "CoL duplicate, respelled" : "CoL duplicate";
}

function treatment(x: Selected): string {
  if (x.relation === "part of") return "lumped, unassessed";
  if (x.relation === "refused") return "lumped, assessed";
  if (x.relation === "split into") return "split";
  if (x.record.status === "ACCEPTED" || x.record.status === "PROVISIONALLY_ACCEPTED" || x.record.id === x.record.species?.id) return "accepted";
  return x.relationStep === 2 ? "synonym, other spelling" : "synonym, other name";
}

const WHY: Record<string, string> = {
  "matcher": "GBIF's matcher answered", "citation": "The Red List's citation also takes", "synonym": "The Red List's synonym names",
  "decision": "A decision takes",
};

function describe(x: Selected, sp: SpeciesInput, isPrimary: boolean): string {
  const r = x.record, s = r.species;
  const where = !s ? "." : s.id === r.id ? `, ${status(r.status)}.` : `, ${status(r.status)} of ${fmtSpecies(s)}.`;
  const what = {
    "is": ` Counts every record of ${s?.name ?? r.name}.`,
    "split into": ` CoL holds as a species what the Red List includes in ${sp.name}: counts every record of ${s?.name ?? r.name}.`,
    "part of": ` Counts only the records under ${r.name}, not the rest of ${s?.name ?? "that species"}.`,
    "refused": s && !sameName(s.name, sp.name) ? ` Counts nothing: ${s.name} is assessed separately, or isn't this species.` : " Counts nothing.",
  }[x.relation];
  return `${isPrimary ? WHY[x.basis] : WHY[x.basis].replace("GBIF's matcher answered", "The matcher's answer")} ${fmt(r)}${where}${what}`;
}

function nothingDescription(sel: Selection, sp: SpeciesInput): string {
  if (sel.reason === "decision: not in CoL") return `${sel.decision?.by ?? "A decision"} decided it is not in CoL.`;
  if (sel.reason === "informal or qualified name") return `${sp.name}${sp.authority ? ` ${sp.authority}` : ""} is an informal or qualified name; nothing is counted.`;
  const m = sp.match;
  const said = !m?.answer ? "The matcher found no CoL record" : `The matcher answered ${fmt(m.answer)}, ${status(m.answer.rank)}`;
  return `${said}, and no CoL species record has the name. Waiting: ${sel.toReview ?? "no candidate"}.`;
}

/** A CoL record a match note names, for the app to link to. */
interface NoteRecord {
  id: string; name: string; authorship: string | null; status: string; species: string | null;
  /** counted: the record the link counts through; also: another CoL name whose records count too; not: named, not counted. */
  role: "counted" | "also" | "not";
}

const DOUBT_SENTENCE: Record<string, (sp: SpeciesInput, sel: Selection) => string> = {
  "chosen by the citation": (sp) => `GBIF's matcher answered another record; the Red List's citation, ${sp.authority ?? "none"}, picks this one.`,
  "homonym": (sp, sel) => `CoL has records named ${sp.name} under ${sel.groups} different species, and the citation doesn't settle which.`,
  "other authors": (sp) => `The Red List cites ${sp.authority ?? "no author"}; the CoL records taken are by other authors. It may be a different species.`,
  "other spelling": (sp) => `CoL has no ${sp.name}: the matcher takes a name spelt differently, which the naming codes don't make one name.`,
  "ambiguous synonym": () => "CoL marks a record taken as an ambiguous synonym: a name it can't place under one species.",
  "placed elsewhere": () => "The matcher places a record taken in a different part of the tree than the Red List's lineage.",
  "counts nothing": () => "Every record taken leads to a species the Red List assesses separately, so nothing counts.",
  "split, authors unclear": () => "A Red List synonym CoL holds as its own species counts whole, but its authors can't be told apart from another species'.",
  "synonym filed elsewhere": () => "A Red List synonym is filed in CoL under a species that isn't this one; only the records under that name count.",
  "judge undecided": (_sp, sel) => `Checked by an AI jury${sel.jury ? ` on ${sel.jury.date}` : ""}, which couldn't agree which CoL records are this species${sel.jury ? ` (${juryVotes(sel.jury.votes)})` : ""}; the count follows the rules until a person decides.`,
};

/** A verdict's votes in words: "2/2 rules" → "2 independent runs agreed with the rules"; "4/5 rules; 1/5 can't tell" → "4 of 5 independent runs agreed with the rules, 1 couldn't tell". */
export function juryVotes(votes: string): string {
  const say: Record<string, (n: string) => string> = { rules: (n) => `${n} agreed with the rules`, other: (n) => `${n} gave another answer`,
    "can't tell": (n) => `${n} couldn't tell`, missing: (n) => `${n} gave no answer`, "unknown record": (n) => `${n} named a record it wasn't given`,
    unsourced: (n) => `${n} cited no source` };
  const parts = votes.split(";").map((p) => p.trim().match(/^(\d+)\/(\d+) (.+)$/)).filter((m): m is RegExpMatchArray => !!m);
  if (!parts.length) return votes;
  return parts.map((m, i) => (i === 0 ? `${m[1] === m[2] ? m[1] : `${m[1]} of ${m[2]}`} independent runs ` : "") + (say[m[3]] ?? ((n: string) => `${n} ${m[3]}`))(i === 0 ? "" : m[1]).trim()).join(", ");
}

/** match_note and match_records: for a match that isn't plain, why in sentences, and the records named. */
export function matchNote(sel: Selection, sp: SpeciesInput): { note: string; records: NoteRecord[] } | null {
  const rec = (r: ColRecord, role: NoteRecord["role"]): NoteRecord => ({ id: r.id, name: r.name, authorship: r.authorship, status: status(r.status),
    species: r.species?.name ?? null, role });
  const sentences: string[] = [];
  const records: NoteRecord[] = [];
  for (const [i, x] of sel.selected.entries()) records.push(rec(x.record, x.relation === "refused" ? "not" : i === 0 ? "counted" : "also"));
  for (const r of sel.decision && sel.step === 1 ? [] : candidatesNotTaken(sel, sp)) records.push(rec(r, "not"));

  const by = sel.decision?.by ?? "?";
  if (sel.step === 1) sentences.push(`Decided by ${by.startsWith("judge:") ? `an AI jury (${by.slice(6)}), its runs agreeing` : by}${sel.reason ? ": not in CoL." : "."}`);
  for (const d of sel.doubts) sentences.push(DOUBT_SENTENCE[d](sp, sel));
  if (sel.jury?.verdict === "confirmed") sentences.push(`Checked by an AI jury on ${sel.jury.date}: ${juryVotes(sel.jury.votes)}; the doubt stands, but the records match.`);
  const first = sel.selected[0];
  if (sentences.length === 0 && first && first.basis !== "synonym") {
    if (!sameName(first.record.name, sp.name)) sentences.push(`CoL spells it ${first.record.name}, not ${sp.name}: the naming codes treat the two as one name.`);
    if (sel.groups > 1) sentences.push(`CoL has records named ${sp.name} under ${sel.groups} species; the Red List's citation, ${sp.authority}, settles which.`);
    if (first.relation === "is" && first.record.species && first.record.species.id !== first.record.id) {
      sentences.push(`CoL holds ${first.record.name} as a synonym of ${fmtSpecies(first.record.species)}, so GBIF counts its records under ${first.record.species.name}.`);
    }
    if (first.relation === "part of") sentences.push(`CoL files ${first.record.name} under ${first.record.species?.name ?? "a broader species"}, so only records under ${first.record.name} count.`);
  }
  const also = sel.selected.slice(1).filter((x) => x.relation !== "refused");
  if (also.length > 0) sentences.push(`Also counts records under ${also.map((x) => fmt(x.record)).join("; ")}.`);
  if (!first && also.length === 0 && sentences.length === 0) return null;
  if (sentences.length === 0) return null;
  return { note: sentences.join(" "), records };
}

/** The candidates not taken (for a note's records). */
function candidatesNotTaken(sel: Selection, sp: SpeciesInput): ColRecord[] {
  const taken = new Set(sel.selected.map((x) => x.record.id));
  const untaken = new Set(sel.untakenSpecies.map((s) => s.id));
  return [...(sp.match?.answer ? [sp.match.answer] : []), ...(sp.match?.alternatives ?? [])]
    .filter((r, i, a) => a.findIndex((y) => y.id === r.id) === i && !taken.has(r.id) && !!r.species && untaken.has(r.species.id));
}
