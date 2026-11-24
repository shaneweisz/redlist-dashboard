/**
 * The judge (docs/specs/matching.md, "How it's checked"): headless Claude Code reads
 * species' facts and says which CoL records it would take; this compares its
 * answer with select.ts's. It runs by hand, outside the sync, and the sync never
 * reads its output.
 *
 *   first     the species that aren't easy, and a random 1,000 easy ones
 *   changed   every species whose records differ from --baseline <old.json>: the old
 *             rules' `npm run sync:select` on this build. Reports Goal 2: per group,
 *             how many the old and the new rules have right, among the species changed
 *   decide    the species listed for review, those with a note (seeds/judge-notes.tsv),
 *             and those whose decision is a fixture's or an unrecorded agent's, less
 *             those an undecided verdict still covers: each is asked in --runs
 *             independent runs (default 2; other batch-mates, other order), and where
 *             they differ, --more runs (default 3), after which --need of them (default
 *             4) must agree. An agreed answer is written: as a `confirmed` verdict
 *             (seeds/judge-verdicts.tsv) when it is the rules' answer, else to
 *             seeds/decisions.tsv as a decision by judge:<model>, if it would hold.
 *             No agreement is an `undecided` verdict (the doubt `judge undecided`). A
 *             person's decision (a GitHub handle in `by`) is never replaced. Prints the
 *             patterns among its decisions, which are candidate rule changes.
 *
 * Before a run it answers the fixture cases, prints its score and the number of
 * calls the run needs, and asks before going on (--yes doesn't ask). Answers are
 * cached in ~/.cache/redlist-dashboard/judge-cache (a sync clears .sync/review/)
 * by the SHA-256 of a batch's facts, the prompt and the model, so a rerun asks only
 * what changed. Output: .sync/review/judgements.parquet and a report by doubt and
 * by group.
 *
 * Usage: npm run sync:judge -- first | changed --baseline <old.json> | decide [--runs N]
 *          [--more N] [--need N] [--yes] [--fixtures-only] [--limit N] [--model m]
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { loadEnvFiles } from "../../lib/utils";
import { CACHE_ROOT, REVIEW_DIR, parquet, tables } from "../paths";
import { openDuckDB, rows, writeTable, lit } from "../sql";
import { loadInputs, type Inputs } from "../link/select-inputs";
import { answerRecords, select, selectEvery, type ColRecord, type Selection, type SpeciesInput } from "../link/select";
import { sameName, sameNameKey } from "../link/name-rules";
import { MATCHING_CASES } from "./fixtures/matching";
import { answerKey, isOverride, readVerdicts, readDecisions, readNotes, writeVerdicts, writeDecisions,
  type JudgeVerdict, type Decision, type Note } from "../link/decisions";
import { resultOf, runClaude, type Runner } from "./claude-run";
import { saveTranscript, transcriptPath, uploadTranscripts } from "./judge-transcripts";
import { readSourcesReleases } from "../sources-releases";
import { plainText } from "../../narratives/build-narratives";
import { MATCHER_VERSION } from "../inputs/matcher";

export const PROMPT = fs.readFileSync(path.join(__dirname, "judge-prompt.md"), "utf-8");
// Ten a call: a call's context grows with each page it reads, and the last species in a long batch get less of it.
const BATCH = 10;
/** Its own domains are the one thing the judge may not read: it would see our answer. */
const OWN_DOMAINS = ["dashforlife.org", "vercel.app"];

export const ANSWER_SCHEMA = {
  type: "object", required: ["answers"], properties: { answers: { type: "array", items: {
    type: "object", required: ["sis_taxon_id", "name", "records", "reason", "sources"], properties: {
      sis_taxon_id: { type: "integer" }, name: { type: "string" },
      records: { oneOf: [{ const: "can't tell" }, { type: "array", items: { type: "object", required: ["id", "name", "relation"],
        properties: { id: { type: "string" }, name: { type: "string" }, relation: { enum: ["is", "part of", "split into"] } } } }] },
      reason: { type: "string" }, sources: { type: "array", items: { type: "string" } } } } } },
};

export interface Answer { sis_taxon_id: number; name?: string; records: { id: string; name?: string; relation: string }[] | "can't tell"; reason: string; sources: string[];
  /** The call it came from: its transcript is <cacheDir>/transcripts/<this>.jsonl.gz (checks/judge-transcripts.ts). */
  transcript?: string }
export type Verdict = "right" | "wrong" | "can't tell";

/** Easy: one group, no doubt and no reason, every step record is, and no synonym record other than refused. */
export const isEasy = (s: Selection) => s.groups <= 1 && s.doubts.length === 0 && !s.reason
  && s.selected.filter((x) => x.basis !== "synonym").every((x) => x.relation === "is")
  && s.selected.filter((x) => x.basis === "synonym").every((x) => x.relation === "refused");

/** What facts() adds from outside the inputs: the assessment's taxonomic notes, and which assessed species file their own name under each CoL species. */
export interface FactsExtra { taxonomicNotes?: string | null; holders?: Map<string, string[]> }

/** A species' facts, independent of the rules being judged: not our selection. */
export function facts(sp: SpeciesInput, lineage: Record<string, string | null> | undefined, inputs: Inputs, notes: Note[] = [], extra: FactsExtra = {}) {
  const own = new Map<string, ColRecord>();
  const add = (r: ColRecord) => { if (r.rank === "SPECIES") own.set(r.id, r); };
  for (const r of [...(sp.match?.answer ? [sp.match.answer] : []), ...(sp.match?.alternatives ?? [])]) {
    if (sameName(r.name, sp.name) || (sp.match?.answerName && sameName(r.name, sp.match.answerName))) add(r);
  }
  for (const n of [sp.name, sp.match?.answerName, ...sp.synonyms.map((y) => y.name)]) if (n) for (const r of inputs.release.recordsNamed(n)) add(r);
  const assessedElsewhere = (n: string | undefined) => !!n && !sameName(n, sp.name) && inputs.release.assessedNames.has(sameNameKey(n));
  const notesText = extra.taxonomicNotes ? (extra.taxonomicNotes.length > 2000 ? `${extra.taxonomicNotes.slice(0, 2000)}…` : extra.taxonomicNotes) : null;
  const said = (r: ColRecord | null | undefined) => r ? { id: r.id, name: r.name, authorship: r.authorship, rank: r.rank, status: r.status, classification: r.classification ?? null } : null;
  return {
    sis_taxon_id: sp.sis,
    red_list: { name: sp.name, citation: sp.authority, ...lineage, synonyms: sp.synonyms, ...(notesText ? { taxonomic_notes: notesText } : {}) },
    matcher: sp.match ? { match_type: sp.match.matchType, answer: said(sp.match.answer), alternatives: sp.match.alternatives.map(said) } : null,
    col_records: [...own.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => ({
      id: r.id, name: r.name, authorship: r.authorship, status: r.status,
      col_species: r.species ? { id: r.species.id, name: r.species.name, authorship: r.species.authorship, class: r.species.class,
        gbif_records: inputs.release.occurrencesUnder(r.species.id) } : null,
      gbif_records_under: inputs.release.occurrencesUnder(r.id),
      name_assessed_separately: assessedElsewhere(r.name),
      col_species_assessed_as: assessedElsewhere(r.species?.name) ? r.species!.name : null,
      col_species_holds_assessed: (r.species ? extra.holders?.get(r.species.id) ?? [] : []).filter((n) => !sameName(n, sp.name)),
    })),
    ...(notes.length ? { notes_from_people: notes.map((n) => ({ note: n.note, by: n.by, date: n.date })) } : {}),
  };
}

/** Our answer, as the judge's is written: refused records count as not taken. */
export const ourAnswer = (s: Selection) => s.selected.filter((x) => x.relation !== "refused").map((x) => ({ id: x.record.id, relation: x.relation }));

/** Where a record leads and how many occurrences sit under a record or species: from the release. */
export interface Lookup { speciesOf: (id: string) => string | null | undefined; under: (id: string) => number }

/**
 * Right when both answers count the same occurrences: the same CoL species counted
 * whole (is or split into), and the same part-of records outside those. Listing a
 * record under a species already counted whole, or one with no occurrences, changes
 * nothing, so it isn't scored.
 */
export function score(ours: { id: string; relation: string }[], theirs: Answer["records"], look: Lookup): Verdict {
  if (theirs === "can't tell") return "can't tell";
  return counted(ours, look) === counted(theirs, look) ? "right" : "wrong";
}

/**
 * A relation as counting reads it (count/usage_owner.sql): a record that is
 * itself its CoL species takes that species whatever it's called, so *part of*
 * there is *is*; a record leading to no species takes only what is filed under
 * it, so any relation there is *part of*.
 */
export function asCounted<T extends { id: string; relation: string }>(xs: T[], look: Lookup): T[] {
  return xs.map((x) => { const sp = look.speciesOf(x.id);
    return !sp ? { ...x, relation: "part of" } : x.relation === "part of" && sp === x.id ? { ...x, relation: "is" } : x; });
}

/** What an answer counts: the CoL species it counts whole and the part-of records outside them, with occurrences. */
export function counted(given: { id: string; relation: string }[], look: Lookup): string {
  const xs = asCounted(given, look);
  const whole = new Set(xs.filter((x) => x.relation === "is" || x.relation === "split into")
    .map((x) => look.speciesOf(x.id) ?? x.id).filter((sp) => look.under(sp) > 0));
  const parts = xs.filter((x) => x.relation === "part of" && !whole.has(look.speciesOf(x.id) ?? "") && look.under(x.id) > 0).map((x) => x.id);
  return [...[...whole].map((w) => `whole:${w}`), ...parts.map((p) => `part:${p}`)].sort().join(",");
}

/**
 * What the decide mode does with one species' runs, of which `need` (default:
 * all) must count the same: `confirm` when that is what the rules count,
 * `decide` when it isn't, `split` when no answer has `need` runs. A run that is
 * missing, can't tell, or names a record not in its facts agrees with nothing.
 * `votes` says how the runs answered, for the verdict.
 */
export function outcome(runs: (Answer | undefined)[], ours: { id: string; relation: string }[], look: Lookup, known: Set<string>, need = runs.length):
  ({ kind: "confirm" } | { kind: "split" } | { kind: "decide"; answer: Answer }) & { votes: string } {
  const mine = counted(ours, look);
  // An answer that would change the count must rest on a source it read.
  const keyOf = (a: Answer | undefined) => { if (!a || a.records === "can't tell") return "can't tell";
    if (a.records.some((x) => !known.has(x.id))) return "unknown record";
    const k = counted(a.records, look);
    return k !== mine && a.sources.length === 0 ? "unsourced" : k; };
  const keys = runs.map(keyOf);
  const n = new Map<string, number>();
  for (const k of keys) n.set(k, (n.get(k) ?? 0) + 1);
  const label = (k: string) => k === mine ? "rules" : k === "can't tell" || k === "unknown record" || k === "unsourced" ? k : "other";
  const tally = new Map<string, number>();
  for (const [k, c] of n) tally.set(label(k), (tally.get(label(k)) ?? 0) + c);
  const votes = [...tally].sort((x, y) => y[1] - x[1]).map(([l, c]) => `${c}/${runs.length} ${l}`).join("; ");
  const [best, count] = [...n].filter(([k]) => k !== "can't tell" && k !== "unknown record" && k !== "unsourced").sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
  if (runs.length === 0 || count < need) return { kind: "split", votes };
  return best === mine ? { kind: "confirm", votes } : { kind: "decide", answer: runs[keys.indexOf(best)]!, votes };
}

/** How a decision changes what is counted, for the patterns report. */
export function change(ours: { id: string; relation: string }[], theirs: { id: string; relation: string }[], look: Lookup): string {
  const a = new Set(counted(ours, look).split(",").filter(Boolean)), b = new Set(counted(theirs, look).split(",").filter(Boolean));
  const kinds = [...[...b].filter((x) => !a.has(x)).map((x) => `adds ${x.split(":")[0]}`), ...[...a].filter((x) => !b.has(x)).map((x) => `drops ${x.split(":")[0]}`)];
  return [...new Set(kinds)].sort().join(" + ") || "same counts";
}

/** What this process's calls have cost, from each result's total_cost_usd. */
export const spent = { usd: 0, calls: 0 };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Asks the judge about species in batches, from the cache where it can. */
export async function judge(batchFacts: ReturnType<typeof facts>[], opts: { cacheDir: string; runner?: Runner; model?: string; run?: number }): Promise<Map<number, Answer>> {
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const out = new Map<number, Answer>();
  // Run 1 asks in the given order; a later run reorders, so each species has other batch-mates, and is cached apart.
  const run = opts.run ?? 1;
  const ordered = run === 1 ? batchFacts : [...batchFacts].sort((a, b) => sha(`run ${run} ${a.sis_taxon_id}`).localeCompare(sha(`run ${run} ${b.sis_taxon_id}`)));
  for (let i = 0; i < ordered.length; i += BATCH) {
    const batch = ordered.slice(i, i + BATCH);
    const stdin = JSON.stringify(batch, null, 1);
    const key = sha(stdin + PROMPT + (opts.model ?? "") + (run === 1 ? "" : `run ${run}`));
    const cache = path.join(opts.cacheDir, `${key}.json`);
    let answers: Answer[];
    if (fs.existsSync(cache)) answers = JSON.parse(fs.readFileSync(cache, "utf-8"));
    else {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
      const res = await (opts.runner ?? runClaude)({ prompt: PROMPT, stdin, cwd, home: cwd, tools: ["WebSearch", "WebFetch"], allowed: ["WebSearch", "WebFetch"],
        disallowed: OWN_DOMAINS.map((d) => `WebFetch(domain:${d})`), outputFormat: "stream-json", schema: ANSWER_SCHEMA, model: opts.model });
      fs.rmSync(cwd, { recursive: true, force: true });
      if (res.code !== 0) throw new Error(`judge: claude exited ${res.code}: ${res.stderr.slice(0, 500)}`);
      // The whole conversation (each search, each page and its answer), kept so a decision can be audited.
      saveTranscript(opts.cacheDir, key, res.stdout);
      const o = resultOf(res.stdout) as { total_cost_usd?: number; is_error?: boolean; structured_output?: { answers?: Answer[] }; result?: unknown };
      spent.usd += o.total_cost_usd ?? 0; spent.calls++;
      console.log(`judge: run ${run}, call ${spent.calls}, ${batch.length} species, $${(o.total_cost_usd ?? 0).toFixed(3)} (so far $${spent.usd.toFixed(2)})`);
      if (o.is_error) throw new Error(`judge: the call failed (${String(o.result ?? "").slice(0, 300)}); nothing cached, so a rerun asks again`);
      let structured: { answers?: Answer[] } | undefined;
      try { structured = (o.structured_output ?? (typeof o.result === "string" ? JSON.parse(o.result) : o.result)) as typeof structured; }
      catch { structured = undefined; }
      // Only this batch's species, each once and under its own name; a record named otherwise than its id's is an unknown record.
      const byId = new Map(batch.map((b) => [b.sis_taxon_id, b]));
      const all = structured?.answers ?? [];
      const twice = new Set(all.map((a) => a.sis_taxon_id).filter((id, i, xs) => xs.indexOf(id) !== i));
      answers = all.filter((a) => byId.has(a.sis_taxon_id) && !twice.has(a.sis_taxon_id) && (!a.name || sameName(a.name, byId.get(a.sis_taxon_id)!.red_list.name)))
        .map((a) => { if (a.records === "can't tell") return a;
          const named = new Map(byId.get(a.sis_taxon_id)!.col_records.map((r) => [r.id, r.name]));
          return { ...a, records: a.records.map((x) => (x.name && named.has(x.id) && !sameName(x.name, named.get(x.id)!) ? { ...x, id: `${x.id}?named ${x.name}` } : x)) }; });
      if (answers.length === 0) throw new Error(`judge: the call answered none of its ${batch.length} species; nothing cached, so a rerun asks again`);
      if (answers.length < batch.length) console.log(`judge: ${batch.length - answers.length} of the batch unanswered, left for review`);
      fs.writeFileSync(cache, JSON.stringify(answers));
    }
    const transcript = fs.existsSync(transcriptPath(opts.cacheDir, key)) ? key : undefined;
    for (const a of answers) out.set(a.sis_taxon_id, { ...a, transcript });
  }
  return out;
}

/** The facts' outside parts: the assessments' taxonomic notes (the narratives build, joined by assessment), and which assessed species file their own name under each CoL species. */
export async function loadFactsExtra(conn: Awaited<ReturnType<typeof openDuckDB>>, T: ReturnType<typeof tables>, inputs: Inputs) {
  const narratives = path.join(__dirname, "..", "..", "..", "data", "narratives", "narratives.parquet");
  if (!fs.existsSync(narratives)) throw new Error(`judge: ${narratives} is missing (npm run fetch-data-from-r2): the judge needs the taxonomic notes`);
  const taxNotes = new Map((await rows<{ sis: number; notes: string }>(conn, `
    SELECT a.sis_taxon_id::INTEGER AS sis, n.taxonomic_notes AS notes FROM ${parquet(T.assessments)} a
    JOIN ${lit(narratives)} n ON n.assessment_id = a.assessment_id WHERE a.is_latest AND coalesce(n.taxonomic_notes, '') <> ''`))
    .map((r) => [r.sis, plainText(r.notes).replace(/\s+/g, " ").trim()]));
  const holders = new Map<string, string[]>();
  for (const sp of inputs.species) for (const r of inputs.release.recordsNamed(sp.name))
    if (r.species && sameName(r.name, sp.name)) { const h = holders.get(r.species.id) ?? holders.set(r.species.id, []).get(r.species.id)!; if (!h.includes(sp.name)) h.push(sp.name); }
  return { taxNotes, holders };
}

/** The judgements, and a report by doubt and by group (the CoL class, or kingdom for plants and fungi). */
export function report(sel: Selection[], answers: Map<number, Answer>, groupOf: Map<number, string>, look: Lookup) {
  const rowsOut: { sis_taxon_id: number; answer: string; sources: string; verdict: Verdict; reason: string }[] = [];
  const by = (k: string, v: Verdict, t: Record<string, Record<Verdict, number>>) => { (t[k] ??= { right: 0, wrong: 0, "can't tell": 0 })[v]++; };
  const byDoubt: Record<string, Record<Verdict, number>> = {}, byGroup: Record<string, Record<Verdict, number>> = {};
  for (const s of sel) {
    const a = answers.get(s.sis);
    if (!a) continue;
    const v = score(ourAnswer(s), a.records, look);
    rowsOut.push({ sis_taxon_id: s.sis, answer: JSON.stringify(a.records), sources: a.sources.join(" "), verdict: v, reason: a.reason });
    for (const d of s.doubts.length ? s.doubts : [isEasy(s) ? "(easy)" : "(no doubt)"]) by(d, v, byDoubt);
    by(groupOf.get(s.sis) ?? "?", v, byGroup);
  }
  return { rows: rowsOut, byDoubt, byGroup };
}

/** Per group, among the species changed: how many the old rules and the new have right. */
export function goal2(chosen: Selection[], old: Map<number, { id: string; relation: string }[]>, answers: Map<number, Answer>, groupOf: Map<number, string>, look: Lookup) {
  const out: Record<string, { old: number; new: number; species: number }> = {};
  for (const s of chosen) {
    const a = answers.get(s.sis);
    if (!a) continue;
    const g = (out[groupOf.get(s.sis) ?? "?"] ??= { old: 0, new: 0, species: 0 });
    g.species++;
    if (score(old.get(s.sis) ?? [], a.records, look) === "right") g.old++;
    if (score(ourAnswer(s), a.records, look) === "right") g.new++;
  }
  return out;
}

async function ask(q: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a: string = await new Promise((r) => rl.question(q, r));
  rl.close();
  return /^y/i.test(a.trim());
}

if (require.main === module) {
  (async () => {
    loadEnvFiles();
    const a = process.argv.slice(2);
    const opt = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
    const mode = a[0];
    if (mode !== "first" && mode !== "changed" && mode !== "decide") throw new Error("Usage: npm run sync:judge -- first | changed --baseline <old rules' sync:select JSON> | decide [--runs N]");
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("judge: CLAUDE_CODE_OAUTH_TOKEN isn't set (app/.env.local, from `claude setup-token`)");
    const T = tables();
    const conn = await openDuckDB();
    const pre = await loadInputs();
    const extra = pre.species.flatMap((s) => [s.name, ...(s.match?.answerName ? [s.match.answerName] : [])]);
    const inputs = await loadInputs(T, pre.decisions, conn, extra);
    const sel = selectEvery(inputs.species, inputs.release, inputs.decisions, inputs.verdicts);
    // Where a record leads: from the records named in the facts (the release's byId holds only the matcher's records).
    const leadsTo = new Map<string, string | undefined>();
    for (const sp of inputs.species) for (const n of [sp.name, sp.match?.answerName, ...sp.synonyms.map((y) => y.name)])
      if (n) for (const r of inputs.release.recordsNamed(n)) leadsTo.set(r.id, r.species?.id);
    const look: Lookup = { speciesOf: (id) => leadsTo.get(id) ?? inputs.release.byId(id)?.species?.id, under: (id) => inputs.release.occurrencesUnder(id) };
    const bySis = new Map(inputs.species.map((s) => [s.sis, s]));
    const lineage = new Map((await rows<{ sis: number; class_name: string | null; order_name: string | null; family: string | null; kingdom: string | null; phylum: string | null }>(conn, `
      SELECT sis_taxon_id::INTEGER AS sis, kingdom_name AS kingdom, phylum_name AS phylum, class_name, order_name, family FROM ${parquet(T.assessments)} WHERE is_latest`))
      .map((r) => [r.sis, { kingdom: r.kingdom, phylum: r.phylum, class: r.class_name, order: r.order_name, family: r.family }]));
    const groupOf = new Map([...lineage].map(([sis, l]) => [sis, /plantae|fungi/i.test(l.kingdom ?? "") ? (l.kingdom ?? "?") : (l.class ?? "?")]));
    const notes = readNotes();
    const { taxNotes, holders } = await loadFactsExtra(conn, T, inputs);
    const factsOf = (sis: number) => facts(bySis.get(sis)!, lineage.get(sis), inputs, notes.get(sis), { taxonomicNotes: taxNotes.get(sis), holders });
    // Outside the build, which a sync clears: answers cost money.
    const cacheDir = path.join(CACHE_ROOT, "judge-cache");
    const model = opt("model") ?? (mode === "decide" ? "claude-opus-5-5" : undefined);
    const whole = (k: string, d: number, min: number) => { const v = Number(opt(k) ?? d);
      if (!Number.isInteger(v) || v < min) throw new Error(`judge: --${k} must be a whole number from ${min}, not ${opt(k)}`); return v; };
    const runs = whole("runs", 2, 1), more = whole("more", 3, 0), need = whole("need", 4, 1);
    if (more > 0 && need > runs + more) throw new Error(`judge: --need ${need} is more than the ${runs + more} runs`);

    /** decide: ask each species in `runs` runs, and those they don't agree on in `more`; then write the verdicts and decisions. */
    async function decide(chosen: Selection[]) {
      const asked: Map<number, Answer>[] = [];
      for (let k = 1; k <= runs; k++) asked.push(await judge(chosen.map((s) => factsOf(s.sis)), { cacheDir, model, run: k }));
      const known = (s: Selection) => new Set(factsOf(s.sis).col_records.map((r) => r.id));
      const disputed = more ? chosen.filter((s) => outcome(asked.map((m) => m.get(s.sis)), ourAnswer(s), look, known(s)).kind === "split") : [];
      if (disputed.length) console.log(`judge: the runs differ on ${disputed.length} species; asking those ${more} more times`);
      for (let k = runs + 1; k <= runs + more && disputed.length; k++) asked.push(await judge(disputed.map((s) => factsOf(s.sis)), { cacheDir, model, run: k }));
      const isDisputed = new Set(disputed.map((s) => s.sis));
      const by = `judge:${model}`, date = new Date().toISOString().slice(0, 10);
      // What these rows were decided on, so a later model, prompt, release or matcher can find them.
      const rel = readSourcesReleases(tables().sourcesReleases);
      const context = `xr ${rel?.xr ?? "?"}; snapshot ${rel?.snapshot ?? "?"}; matcher ${MATCHER_VERSION}; prompt ${sha(PROMPT).slice(0, 8)}`;
      const decisions = readDecisions(), verdicts = readVerdicts();
      const tally = { confirm: 0, decide: 0, split: 0 };
      const transcriptsOf = (sis: number) => asked.map((m) => m.get(sis)?.transcript).filter((t): t is string => !!t);
      const sourcesOf = (sis: number) => [...new Set(asked.flatMap((m) => m.get(sis)?.sources ?? []))];
      const runs1 = (sis: number) => asked[0]?.get(sis);
      // What this run writes, and what it holds back: a decision that would lapse, or a species a person overrode meanwhile.
      const written = new Set<number>(), wouldLapse: string[] = [];
      let overridden = 0;
      const patterns = new Map<string, string[]>();
      const fixtureNames = new Set(MATCHING_CASES.map((c) => c.name.toLowerCase()));
      const fixturesToUpdate: string[] = [];
      for (const s of chosen) {
        const sp = bySis.get(s.sis)!;
        const f = factsOf(s.sis);
        const recs = new Map(f.col_records.map((r) => [r.id, r]));
        const ours = ourAnswer(s);
        const mine = isDisputed.has(s.sis) ? asked.map((m) => m.get(s.sis)) : asked.slice(0, runs).map((m) => m.get(s.sis));
        const o = outcome(mine, ours, look, new Set(recs.keys()), isDisputed.has(s.sis) ? need : runs);
        tally[o.kind]++;
        const verdict = (v: JudgeVerdict["verdict"]): JudgeVerdict =>
          ({ sis: s.sis, redlistName: sp.name, verdict: v, answer: answerKey(answerRecords(s)), votes: o.votes, by, date, transcripts: transcriptsOf(s.sis), context });
        if (o.kind === "split") {
          // No agreement: the rules' count stands, flagged on the dashboard, and the species isn't asked again while this holds.
          if (isOverride(decisions.get(s.sis) ?? { by: "judge:" })) { overridden++; continue; }
          verdicts.set(s.sis, verdict("undecided"));
          written.add(s.sis);
          continue;
        }
        if (o.kind === "confirm") {
          // The rules' answer: a decision that holds is kept, now the judge's (its reason and sources); a lapsed one gives way to a verdict.
          if (isOverride(decisions.get(s.sis) ?? { by: "judge:" })) { overridden++; continue; }
          if (s.decision && !s.decision.lapse) {
            const held = decisions.get(s.sis)!;
            decisions.set(s.sis, { ...held, by, reviewed: true, date, evidence: runs1(s.sis)?.reason ?? held.evidence, sources: sourcesOf(s.sis), transcripts: transcriptsOf(s.sis), context });
            written.add(s.sis);
          } else {
            decisions.delete(s.sis);
            verdicts.set(s.sis, verdict("confirmed"));
            written.add(s.sis);
          }
          continue;
        }
        const answer = asCounted(o.answer.records as { id: string; relation: string }[], look) as { id: string; relation: "is" | "part of" | "split into" }[];
        const d: Decision = {
          sis: s.sis, redlistName: sp.name, redlistAuthority: sp.authority, candidates: s.candidateSpecies, by, reviewed: true, date,
          evidence: o.answer.reason, sources: sourcesOf(s.sis), transcripts: transcriptsOf(s.sis), context,
          rows: answer.map((x) => { const r = recs.get(x.id)!;
            return { id: r.id, name: r.name, authorship: r.authorship, status: r.status.toLowerCase().replace(/_/g, " "), species: r.col_species?.name ?? null, relation: x.relation }; }),
        };
        // Only a decision that would hold on the next sync (select() applies it the same way); else it stays listed.
        const check = select(sp, { ...inputs.release, wholeBySteps: new Map() }, d);
        if (!check.decision || check.decision.lapse) { wouldLapse.push(`${sp.name} (${check.decision?.lapse ?? "?"})`); tally.decide--; tally.split++; continue; }
        if (isOverride(decisions.get(s.sis) ?? { by: "judge:" })) { overridden++; continue; }
        decisions.set(s.sis, d);
        verdicts.delete(s.sis);
        written.add(s.sis);
        const k = `${s.doubts[0] ?? s.reason ?? "(no doubt)"}: ${change(ours, answer, look)}`;
        (patterns.get(k) ?? patterns.set(k, []).get(k)!).push(sp.name);
        if (fixtureNames.has(sp.name.toLowerCase())) fixturesToUpdate.push(sp.name);
      }
      // The transcripts behind what was written go to the private bucket first: a row must lead to its evidence.
      const behind = new Set([...written].flatMap((sis) => (decisions.get(sis) ?? verdicts.get(sis))?.transcripts ?? []));
      await uploadTranscripts([...behind], cacheDir);
      writeDecisions(decisions.values());
      writeVerdicts(verdicts.values());
      console.log(`judge decide: ${tally.confirm} confirmed, ${tally.decide} decided, ${tally.split} undecided or would lapse (left listed); $${spent.usd.toFixed(2)}`);
      if (wouldLapse.length) console.log(`Agreed answers not written, as the decision wouldn't hold (${wouldLapse.length}): ${wouldLapse.slice(0, 20).join(", ")}${wouldLapse.length > 20 ? ", ..." : ""}`);
      if (overridden) console.log(`${overridden} species overridden by a person during the run, left as they are`);
      console.log("Patterns among the decisions (first doubt: what changes), candidate rule changes:");
      for (const [k, names] of [...patterns].sort((x, y) => y[1].length - x[1].length).slice(0, 15))
        console.log(`  ${String(names.length).padStart(5)}  ${k}  (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""})`);
      if (fixturesToUpdate.length) console.log(`Fixture cases the judge decided otherwise, to update in checks/fixtures/matching.ts: ${fixturesToUpdate.join(", ")}`);
    }

    // Which species.
    let chosen: Selection[];
    let old: Map<number, { id: string; relation: string }[]> | null = null;
    if (mode === "decide") {
      chosen = sel.filter((s) => {
        const d = inputs.decisions.get(s.sis);
        if (d && isOverride(d)) return false;
        if (notes.has(s.sis)) return true;
        // An undecided verdict that still applies: asking again would get the same split.
        if (s.doubts.includes("judge undecided")) return false;
        return s.toReview !== null || (d !== undefined && !d.by.startsWith("judge:"));
      });
    } else if (mode === "first") {
      const easy = sel.filter(isEasy).sort((x, y) => sha(`easy ${x.sis}`).localeCompare(sha(`easy ${y.sis}`))).slice(0, 1000);
      chosen = [...sel.filter((s) => !isEasy(s)), ...easy];
    } else {
      const base = opt("baseline");
      if (!base) throw new Error("judge changed: --baseline <old.json>, the old rules' `npm run sync:select` on this build");
      const prev = JSON.parse(fs.readFileSync(path.resolve(base), "utf-8")) as { sis_taxon_id: number; selected: { id: string; relation: string }[] }[];
      old = new Map(prev.map((p) => [p.sis_taxon_id, p.selected.filter((x) => x.relation !== "refused").map(({ id, relation }) => ({ id, relation }))]));
      const key = (xs: { id: string; relation: string }[]) => xs.map((x) => `${x.id}:${x.relation}`).sort().join(",");
      chosen = sel.filter((s) => key(old!.get(s.sis) ?? []) !== key(ourAnswer(s)));
    }
    const limit = Number(opt("limit") ?? Infinity);
    chosen = chosen.slice(0, limit);

    // The fixture cases first: their answers are known.
    const fixtureSis = new Set(inputs.species.filter((s) => MATCHING_CASES.some((c) => sameName(c.name, s.name))).map((s) => s.sis));
    const fixtures = sel.filter((s) => fixtureSis.has(s.sis));
    const fx = await judge(fixtures.map((s) => factsOf(s.sis)), { cacheDir, model });
    const fr = report(fixtures, fx, groupOf, look);
    const tally = (rs: { verdict: Verdict }[]) => ({ right: rs.filter((r) => r.verdict === "right").length, wrong: rs.filter((r) => r.verdict === "wrong").length,
      cant: rs.filter((r) => r.verdict === "can't tell").length });
    const t = tally(fr.rows);
    console.log(`judge: on the ${fixtures.length} fixture species, ${t.right} right, ${t.wrong} wrong, ${t.cant} can't tell`);
    for (const r of fr.rows.filter((x) => x.verdict !== "right")) console.log(`  ${bySis.get(r.sis_taxon_id)?.name}: ${r.verdict}: ${r.answer} (${r.reason.slice(0, 160)})`);
    const perCall = spent.calls ? spent.usd / spent.calls : null;
    const fxAgain: Map<number, Answer>[] = [];
    if (mode === "decide") {
      for (let k = 2; k <= runs; k++) {
        const again = await judge(fixtures.map((s) => factsOf(s.sis)), { cacheDir, model, run: k });
        fxAgain.push(again);
        const same = fixtures.filter((s) => { const x = fx.get(s.sis), y = again.get(s.sis);
          return x && y && x.records !== "can't tell" && y.records !== "can't tell" && counted(x.records, look) === counted(y.records, look); }).length;
        console.log(`judge: run ${k} on the fixtures agrees with run 1 on ${same} of ${fixtures.length}`);
      }
    }
    // decide: and for the species the first runs differ on (as many as the fixtures', proportionally), `more` runs.
    const fxSplit = mode === "decide" && runs > 1 ? fixtures.filter((s) => outcome([fx.get(s.sis), ...fxAgain.map((m) => m.get(s.sis))], ourAnswer(s), look,
      new Set(factsOf(s.sis).col_records.map((r) => r.id))).kind === "split").length / Math.max(1, fixtures.length) : 0;
    const calls = Math.ceil(chosen.length / BATCH) * (mode === "decide" ? runs : 1) + (mode === "decide" ? Math.ceil(chosen.length * fxSplit / BATCH) * more : 0);
    console.log(`judge ${mode}: ${chosen.length.toLocaleString()} species, ${calls.toLocaleString()} calls of ${BATCH} (before the cache)` +
      (perCall ? `, about $${(perCall * calls).toFixed(0)} at the fixtures' $${perCall.toFixed(2)} a call` : ""));
    if (a.includes("--fixtures-only")) return;
    if (!a.includes("--yes") && !(await ask("Go on? [y/N] "))) return;

    if (mode === "decide") return decide(chosen);

    const answers = await judge(chosen.map((s) => factsOf(s.sis)), { cacheDir, model });
    const r = report(chosen, answers, groupOf, look);
    await writeTable(conn, "judgements", { sis_taxon_id: "BIGINT", answer: "VARCHAR", sources: "VARCHAR", verdict: "VARCHAR", reason: "VARCHAR", model: "VARCHAR" },
      r.rows.map((x) => ({ ...x, model: model ?? "default" })));
    const out = path.join(REVIEW_DIR, "judgements.parquet");
    await conn.run(`COPY judgements TO ${lit(out)} (FORMAT parquet)`);
    fs.writeFileSync(path.join(REVIEW_DIR, "judgements-report.json"), JSON.stringify({ mode, byDoubt: r.byDoubt, byGroup: r.byGroup }, null, 1));
    const all = tally(r.rows);
    console.log(`judge: ${all.right} right, ${all.wrong} wrong, ${all.cant} can't tell; ${out}`);
    for (const [d, v] of Object.entries(r.byDoubt).sort()) console.log(`  ${d.padEnd(26)} ${v.right} right, ${v.wrong} wrong, ${v["can't tell"]} can't tell`);
    if (old) {
      // Goal 2: among the species changed, no group has fewer judged right under the new rules.
      const goal = goal2(chosen, old, answers, groupOf, look);
      fs.writeFileSync(path.join(REVIEW_DIR, "judgements-goal2.json"), JSON.stringify(goal, null, 1));
      const worse = Object.entries(goal).filter(([, g]) => g.new < g.old);
      console.log(worse.length === 0 ? "judge: Goal 2 holds: no group has fewer right" :
        `judge: Goal 2 FAILS for ${worse.map(([k, g]) => `${k} (${g.old} → ${g.new})`).join(", ")}: each species lost needs a fixture case, or the change doesn't merge`);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
