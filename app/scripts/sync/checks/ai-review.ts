/**
 * The AI taxonomic reviewers (docs/specs/matching.md, "AI taxonomic review"):
 * headless Claude Code, with web search, reads species' facts and says which
 * CoL records it would count; this compares its answer with select.ts's. It
 * runs by hand, outside the sync.
 *
 *   review    each species listed for review whose reviews don't apply, asked by
 *             two independent reviewers (--runs; other batch-mates, other order).
 *             Each reviewer's answer is a row of seeds/ai-reviews.tsv: it agrees
 *             with the rules, suggests other records, or can't tell. The sync
 *             shows them and never counts them. Prints the patterns among the
 *             suggestions, which are candidate rule changes.
 *   first     scores the rules: the species that aren't easy, and a random 1,000 easy ones
 *   changed   scores a rule change: every species whose records differ from --baseline
 *             <old.json> (the old rules' `npm run sync:select` on this build). Reports
 *             Goal 2: per group, how many the old and the new rules have right
 *
 * Before a run it answers the fixture cases, prints its score and the number of
 * calls the run needs, and asks before going on (--yes doesn't ask). Answers are
 * cached in ~/.cache/redlist-dashboard/ai-review-cache/answers (a sync clears .sync/review/),
 * each species apart, by the SHA-256 of its facts without the occurrence counts, the
 * prompt, the model and the reviewer, so a rerun asks only species whose facts changed.
 * first and changed write .sync/review/reviewer-scores.parquet and a report by doubt and by group.
 *
 * Usage: npm run sync:ai-review -- review [--runs N] | first | changed --baseline <old.json>
 *          [--parallel N (calls at once, default 4)] [--yes] [--fixtures-only] [--limit N] [--model m]
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
import { answerRecords, countedWhole, selectEvery, type ColRecord, type Selection, type SpeciesInput } from "../link/select";
import { sameName, sameNameKey } from "../link/name-rules";
import { MATCHING_CASES } from "./fixtures/matching";
import { answerKey, readReviews, reviewBasis, writeReviews, type Finding, type Review, type SuggestedRecord } from "../link/ai-reviews";
import { resultOf, runClaude, type Runner } from "./claude-run";
import { saveTranscript, uploadTranscripts } from "./ai-review-transcripts";
import { readSourcesReleases } from "../sources-releases";
import { plainText } from "../../narratives/build-narratives";
import { MATCHER_VERSION } from "../inputs/matcher";

export const PROMPT = fs.readFileSync(path.join(__dirname, "ai-review-prompt.md"), "utf-8");
// Ten a call: a call's context grows with each page it reads, and the last species in a long batch get less of it.
const BATCH = 10;
/** Its own domains are the one thing a reviewer may not read: it would see our answer. */
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
  /** The call it came from: its transcript is <cacheDir>/transcripts/<this>.jsonl.gz (checks/ai-review-transcripts.ts). */
  transcript?: string }
export type Verdict = "right" | "wrong" | "can't tell";

/** Easy: one group, no doubt and no reason, every step record is, and no synonym record other than refused. */
export const isEasy = (s: Selection) => s.groups <= 1 && s.doubts.length === 0 && !s.reason
  && s.selected.filter((x) => x.basis !== "synonym").every((x) => x.relation === "is")
  && s.selected.filter((x) => x.basis === "synonym").every((x) => x.relation === "refused");

/** What facts() adds from outside the inputs: the assessment's taxonomic notes, and which assessed species file their own name under each CoL species. */
export interface FactsExtra { taxonomicNotes?: string | null; holders?: Map<string, string[]>; wholeBy?: Map<string, string[]> }

/** A species' facts, independent of the rules being judged: not our selection. */
export function facts(sp: SpeciesInput, lineage: Record<string, string | null> | undefined, inputs: Inputs, extra: FactsExtra = {}) {
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
      col_species_counted_whole_by: (r.species ? extra.wholeBy?.get(r.species.id) ?? [] : []).filter((n) => !sameName(n, sp.name)),
    })),
  };
}

/** Our answer, as a reviewer's is written: refused records count as not taken. */
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
  // Every CoL species counted whole, with records or not: counting one hides it from the Not Evaluated list.
  const whole = new Set(xs.filter((x) => x.relation === "is" || x.relation === "split into").map((x) => look.speciesOf(x.id) ?? x.id));
  const parts = xs.filter((x) => x.relation === "part of" && !whole.has(look.speciesOf(x.id) ?? "") && look.under(x.id) > 0).map((x) => x.id);
  return [...[...whole].map((w) => `whole:${w}`), ...parts.map((p) => `part:${p}`)].sort().join(",");
}

/**
 * One reviewer's finding on one species: it **agrees** when its answer counts
 * what the rules' does (counted()); it suggests **other records** when it
 * counts something else and cites a source; else it **can't tell** (no answer,
 * "can't tell", a record it wasn't given, or a change without a source). Other
 * records are written as counting reads them: one per CoL species counted
 * whole (labelled with the species' name), then each *part of* record outside
 * those with GBIF records, each with the GBIF records it counts.
 */
export function findingOf(a: Answer | undefined, ours: { id: string; relation: string }[], look: Lookup, recs: Map<string, FactRecord>):
  { finding: Finding; records: SuggestedRecord[] } {
  const none = { finding: "can't tell" as const, records: [] };
  if (!a || a.records === "can't tell" || a.records.some((x) => !recs.has(x.id))) return none;
  if (counted(a.records, look) === counted(ours, look)) return { finding: "agrees", records: [] };
  if (a.sources.length === 0) return none;
  const xs = asCounted(a.records, look);
  const out = new Map<string, SuggestedRecord>();
  for (const x of xs) {
    if (x.relation === "part of") continue;
    const r = recs.get(x.id)!, sp = r.col_species;
    const k = `whole:${sp?.id ?? r.id}`;
    if (!out.has(k)) out.set(k, { id: sp?.id ?? r.id, relation: x.relation as "is" | "split into", label: sp?.name ?? r.name, status: "accepted", species: sp?.name ?? null,
      records: sp?.gbif_records ?? r.gbif_records_under });
  }
  for (const x of xs) {
    const r = recs.get(x.id)!;
    if (x.relation !== "part of" || out.has(`whole:${r.col_species?.id}`) || look.under(x.id) === 0 || out.has(`part:${r.id}`)) continue;
    out.set(`part:${r.id}`, { id: r.id, relation: "part of", label: `${r.name}${r.authorship ? ` ${r.authorship}` : ""}`, status: r.status.toLowerCase().replace(/_/g, " "),
      species: r.col_species?.name ?? null, records: r.gbif_records_under });
  }
  return { finding: "other records", records: [...out.values()] };
}

/** A CoL record as a species' facts give it. */
export type FactRecord = ReturnType<typeof facts>["col_records"][number];

/** A species' review rows, one per reviewer, from each reviewer's answer. */
export function reviewRows(sp: SpeciesInput, s: Selection, answers: (Answer | undefined)[], look: Lookup, recs: Map<string, FactRecord>,
  meta: { model: string; date: string; context: string }): Review[] {
  const ours = ourAnswer(s);
  return answers.map((a, i) => ({ sis: s.sis, redlistName: sp.name, reviewer: i + 1, ...findingOf(a, ours, look, recs),
    reason: a?.reason ?? "", sources: a?.sources ?? [], rulesAnswer: answerKey(answerRecords(s)), basis: reviewBasis(sp, s),
    model: meta.model, date: meta.date, transcript: a?.transcript ?? "", context: meta.context }));
}

/** How a suggestion changes what is counted, for the patterns report. */
export function change(ours: { id: string; relation: string }[], theirs: { id: string; relation: string }[], look: Lookup): string {
  const a = new Set(counted(ours, look).split(",").filter(Boolean)), b = new Set(counted(theirs, look).split(",").filter(Boolean));
  const kinds = [...[...b].filter((x) => !a.has(x)).map((x) => `adds ${x.split(":")[0]}`), ...[...a].filter((x) => !b.has(x)).map((x) => `drops ${x.split(":")[0]}`)];
  return [...new Set(kinds)].sort().join(" + ") || "same counts";
}

/** What this process's calls have cost, from each result's total_cost_usd. */
export const spent = { usd: 0, calls: 0 };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** A species' facts as its cache key reads them: without the counts, which every snapshot moves. */
export const stableFacts = (f: ReturnType<typeof facts>) =>
  JSON.stringify(f, (k, v) => (k === "gbif_records" || k === "gbif_records_under" ? undefined : v));

/**
 * Asks a reviewer about species, in batches of the ones not yet cached. Each
 * species' answer is cached apart, keyed by its facts (stableFacts), the
 * prompt, the model and the run, so a later run asks only what changed, and
 * which species share a batch doesn't matter. A later run reorders, so each
 * species has other batch-mates. A species a call leaves unanswered is asked
 * once more, then left out (not cached, so a rerun asks it).
 */
export async function askReviewer(batchFacts: ReturnType<typeof facts>[], opts: { cacheDir: string; runner?: Runner; model?: string; run?: number; parallel?: number; retryWaitMs?: number }): Promise<Map<number, Answer>> {
  const dir = path.join(opts.cacheDir, "answers");
  fs.mkdirSync(dir, { recursive: true });
  const run = opts.run ?? 1;
  const cacheOf = (f: ReturnType<typeof facts>) => path.join(dir, `${sha(stableFacts(f) + PROMPT + (opts.model ?? "") + `run ${run}`)}.json`);
  const out = new Map<number, Answer>();
  let todo = batchFacts.filter((f) => { const c = cacheOf(f); if (!fs.existsSync(c)) return true; out.set(f.sis_taxon_id, JSON.parse(fs.readFileSync(c, "utf-8"))); return false; });
  for (let attempt = 1; attempt <= 2 && todo.length; attempt++) {
    const ordered = run === 1 ? todo : [...todo].sort((a, b) => sha(`run ${run} ${a.sis_taxon_id}`).localeCompare(sha(`run ${run} ${b.sis_taxon_id}`)));
    const batches: ReturnType<typeof facts>[][] = [];
    for (let i = 0; i < ordered.length; i += BATCH) batches.push(ordered.slice(i, i + BATCH));
    // Up to `parallel` calls at once; each writes its own answers to the cache as it ends.
    const ask = async (batch: ReturnType<typeof facts>[]) => {
      const stdin = JSON.stringify(batch, null, 1);
      const call = sha(stdin + PROMPT + (opts.model ?? "") + `run ${run} attempt ${attempt}`);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-"));
      const res = await (opts.runner ?? runClaude)({ prompt: PROMPT, stdin, cwd, home: cwd, tools: ["WebSearch", "WebFetch"], allowed: ["WebSearch", "WebFetch"],
        disallowed: OWN_DOMAINS.map((d) => `WebFetch(domain:${d})`), outputFormat: "stream-json", schema: ANSWER_SCHEMA, model: opts.model });
      fs.rmSync(cwd, { recursive: true, force: true });
      if (res.code !== 0) throw new Error(`ai-review: claude exited ${res.code}: ${res.stderr.slice(0, 500)}`);
      // The whole conversation (each search, each page and its answer), kept so a review can be audited.
      saveTranscript(opts.cacheDir, call, res.stdout);
      const o = resultOf(res.stdout) as { total_cost_usd?: number; is_error?: boolean; structured_output?: { answers?: Answer[] }; result?: unknown };
      spent.usd += o.total_cost_usd ?? 0; spent.calls++;
      console.log(`ai-review: run ${run}, call ${spent.calls}, ${batch.length} species, $${(o.total_cost_usd ?? 0).toFixed(3)} (so far $${spent.usd.toFixed(2)})`);
      if (o.is_error) throw new Error(`ai-review: the call failed (${String(o.result ?? "").slice(0, 300)}); what was answered before it is cached, so a rerun asks only the rest`);
      let structured: { answers?: Answer[] } | undefined;
      try { structured = (o.structured_output ?? (typeof o.result === "string" ? JSON.parse(o.result) : o.result)) as typeof structured; }
      catch { structured = undefined; }
      // Only this batch's species, each once and under its own name; a record named otherwise than its id's is an unknown record.
      const byId = new Map(batch.map((b) => [b.sis_taxon_id, b]));
      const all = structured?.answers ?? [];
      const twice = new Set(all.map((a) => a.sis_taxon_id).filter((id, k, xs) => xs.indexOf(id) !== k));
      const answers = all.filter((a) => byId.has(a.sis_taxon_id) && !twice.has(a.sis_taxon_id) && (!a.name || sameName(a.name, byId.get(a.sis_taxon_id)!.red_list.name)))
        .map((a): Answer => { if (a.records === "can't tell") return a;
          const named = new Map(byId.get(a.sis_taxon_id)!.col_records.map((r) => [r.id, r.name]));
          return { ...a, records: a.records.map((x) => (x.name && named.has(x.id) && !sameName(x.name, named.get(x.id)!) ? { ...x, id: `${x.id}?named ${x.name}` } : x)) }; });
      // A first call that answers none of its batch is something wrong with every call (a limit, the schema); a retry that doesn't is one species, left out.
      if (answers.length === 0 && attempt === 1) throw new Error(`ai-review: the call answered none of its ${batch.length} species; nothing cached for them, so a rerun asks again`);
      for (const a of answers) { const ans = { ...a, transcript: call }; fs.writeFileSync(cacheOf(byId.get(a.sis_taxon_id)!), JSON.stringify(ans)); out.set(a.sis_taxon_id, ans); }
    };
    // A call that fails (a dropped connection, an overloaded API) is tried twice more after a wait; one that still fails stops the run.
    const askRetrying = async (batch: ReturnType<typeof facts>[]) => {
      for (let k = 1; ; k++) {
        try { return await ask(batch); }
        catch (e) { if (k >= 3) throw e; console.log(`ai-review: ${(e as Error).message.slice(0, 200)}; trying again (${k} of 2)`); await new Promise((r) => setTimeout(r, (opts.retryWaitMs ?? 30_000) * k)); }
      }
    };
    let next = 0;
    const worker = async () => { while (next < batches.length) await askRetrying(batches[next++]); };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 1, batches.length)) }, worker));
    todo = todo.filter((f) => !out.has(f.sis_taxon_id));
    if (todo.length) console.log(`ai-review: run ${run}: ${todo.length} species unanswered${attempt === 1 ? ", asking them once more" : ", left out (a rerun asks them)"}`);
  }
  return out;
}

/** The facts' outside parts: the assessments' taxonomic notes (the narratives build, joined by assessment), and which assessed species file their own name under each CoL species. */
export async function loadFactsExtra(conn: Awaited<ReturnType<typeof openDuckDB>>, T: ReturnType<typeof tables>, inputs: Inputs) {
  const narratives = path.join(__dirname, "..", "..", "..", "data", "narratives", "narratives.parquet");
  if (!fs.existsSync(narratives)) throw new Error(`ai-review: ${narratives} is missing (npm run fetch-data-from-r2): the reviewers need the taxonomic notes`);
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
export function report(sel: Selection[], answers: Map<number, Answer>, groupOf: Map<number, string>, lookAny: Lookup | ((sis: number) => Lookup)) {
  const rowsOut: { sis_taxon_id: number; answer: string; sources: string; verdict: Verdict; reason: string }[] = [];
  const by = (k: string, v: Verdict, t: Record<string, Record<Verdict, number>>) => { (t[k] ??= { right: 0, wrong: 0, "can't tell": 0 })[v]++; };
  const byDoubt: Record<string, Record<Verdict, number>> = {}, byGroup: Record<string, Record<Verdict, number>> = {};
  for (const s of sel) {
    const a = answers.get(s.sis);
    if (!a) continue;
    const look = typeof lookAny === "function" ? lookAny(s.sis) : lookAny;
    const v = score(ourAnswer(s), a.records, look);
    rowsOut.push({ sis_taxon_id: s.sis, answer: JSON.stringify(a.records), sources: a.sources.join(" "), verdict: v, reason: a.reason });
    for (const d of s.doubts.length ? s.doubts : [isEasy(s) ? "(easy)" : "(no doubt)"]) by(d, v, byDoubt);
    by(groupOf.get(s.sis) ?? "?", v, byGroup);
  }
  return { rows: rowsOut, byDoubt, byGroup };
}

/** Per group, among the species changed: how many the old rules and the new have right. */
export function goal2(chosen: Selection[], old: Map<number, { id: string; relation: string }[]>, answers: Map<number, Answer>, groupOf: Map<number, string>, lookAny: Lookup | ((sis: number) => Lookup)) {
  const out: Record<string, { old: number; new: number; species: number }> = {};
  for (const s of chosen) {
    const a = answers.get(s.sis);
    if (!a) continue;
    const g = (out[groupOf.get(s.sis) ?? "?"] ??= { old: 0, new: 0, species: 0 });
    g.species++;
    const look = typeof lookAny === "function" ? lookAny(s.sis) : lookAny;
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

/** What the review mode found for its species: each species' findings, and the patterns among the suggestions. */
export function reviewTally(chosen: Selection[], reviews: Map<number, Review[]>, names: Map<number, string>, look: Lookup) {
  const findings: Record<string, number> = {};
  const patterns = new Map<string, string[]>();
  for (const s of chosen) {
    const rs = reviews.get(s.sis) ?? [];
    const k = rs.map((r) => r.finding).sort().join(" + ") || "(none)";
    findings[k] = (findings[k] ?? 0) + 1;
    const other = rs.find((r) => r.finding === "other records");
    if (!other) continue;
    const p = `${s.doubts[0] ?? s.reason ?? "(no doubt)"}: ${change(ourAnswer(s), other.records, look)}`;
    (patterns.get(p) ?? patterns.set(p, []).get(p)!).push(names.get(s.sis) ?? String(s.sis));
  }
  return { findings, patterns };
}

if (require.main === module) {
  (async () => {
    loadEnvFiles();
    const a = process.argv.slice(2);
    const opt = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
    const mode = a[0];
    if (mode !== "review" && mode !== "first" && mode !== "changed") throw new Error("Usage: npm run sync:ai-review -- review [--runs N] | first | changed --baseline <old rules' sync:select JSON>");
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("ai-review: CLAUDE_CODE_OAUTH_TOKEN isn't set (app/.env.local, from `claude setup-token`)");
    const T = tables();
    const conn = await openDuckDB();
    const pre = await loadInputs();
    const extra = pre.species.flatMap((s) => [s.name, ...(s.match?.answerName ? [s.match.answerName] : [])]);
    const inputs = await loadInputs(T, conn, extra);
    const sel = selectEvery(inputs.species, inputs.release, inputs.reviews);
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
    const { taxNotes, holders } = await loadFactsExtra(conn, T, inputs);
    // Which assessed species count each CoL species whole by the rules.
    const wholeBy = new Map<string, string[]>();
    for (const s of sel) for (const id of countedWhole(s)) { const w = wholeBy.get(id) ?? wholeBy.set(id, []).get(id)!; const n = bySis.get(s.sis)!.name; if (!w.includes(n)) w.push(n); }
    const factsOf = (sis: number) => facts(bySis.get(sis)!, lineage.get(sis), inputs, { taxonomicNotes: taxNotes.get(sis), holders, wholeBy });
    // Outside the build, which a sync clears: answers cost money.
    const cacheDir = path.join(CACHE_ROOT, "ai-review-cache");
    const model = opt("model") ?? (mode === "review" ? "claude-opus-5-5" : undefined);
    const whole = (k: string, d: number, min: number) => { const v = Number(opt(k) ?? d);
      if (!Number.isInteger(v) || v < min) throw new Error(`ai-review: --${k} must be a whole number from ${min}, not ${opt(k)}`); return v; };
    const runs = whole("runs", 2, 1), parallel = whole("parallel", 4, 1);

    /** review: each species asked by `runs` independent reviewers; each reviewer's answer is a row of ai-reviews.tsv. */
    async function review(chosen: Selection[]) {
      const asked: Map<number, Answer>[] = [];
      for (let k = 1; k <= runs; k++) asked.push(await askReviewer(chosen.map((s) => factsOf(s.sis)), { cacheDir, model, run: k, parallel }));
      const date = new Date().toISOString().slice(0, 10);
      // What these rows were reviewed on, so a later model, prompt, release or matcher can find them.
      const rel = readSourcesReleases(tables().sourcesReleases);
      const context = `xr ${rel?.xr ?? "?"}; snapshot ${rel?.snapshot ?? "?"}; matcher ${MATCHER_VERSION}; prompt ${sha(PROMPT).slice(0, 8)}`;
      const reviews = readReviews();
      for (const s of chosen) {
        const recs = new Map(factsOf(s.sis).col_records.map((r) => [r.id, r]));
        reviews.set(s.sis, reviewRows(bySis.get(s.sis)!, s, asked.map((m) => m.get(s.sis)), look, recs, { model: model!, date, context }));
      }
      // The transcripts behind the rows go to the transcripts bucket first: a row must lead to its evidence.
      await uploadTranscripts([...new Set(chosen.flatMap((s) => (reviews.get(s.sis) ?? []).map((r) => r.transcript).filter(Boolean)))], cacheDir);
      writeReviews([...reviews.values()].flat());
      const { findings, patterns } = reviewTally(chosen, reviews, new Map([...bySis].map(([k, v]) => [k, v.name])), look);
      console.log(`ai-review: ${chosen.length.toLocaleString()} species reviewed; $${spent.usd.toFixed(2)}`);
      for (const [k, n] of Object.entries(findings).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
      console.log("Patterns among the suggestions (first doubt: what changes), candidate rule changes:");
      for (const [k, names] of [...patterns].sort((x, y) => y[1].length - x[1].length).slice(0, 15))
        console.log(`  ${String(names.length).padStart(5)}  ${k}  (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""})`);
    }

    // Which species.
    let chosen: Selection[];
    let old: Map<number, { id: string; relation: string }[]> | null = null;
    if (mode === "review") {
      // Listed for review, and not covered by reviews that still apply.
      chosen = sel.filter((s) => s.toReview !== null && !s.reviews);
    } else if (mode === "first") {
      const easy = sel.filter(isEasy).sort((x, y) => sha(`easy ${x.sis}`).localeCompare(sha(`easy ${y.sis}`))).slice(0, 1000);
      chosen = [...sel.filter((s) => !isEasy(s)), ...easy];
    } else {
      const base = opt("baseline");
      if (!base) throw new Error("ai-review changed: --baseline <old.json>, the old rules' `npm run sync:select` on this build");
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
    const fx = await askReviewer(fixtures.map((s) => factsOf(s.sis)), { cacheDir, model, parallel });
    const fr = report(fixtures, fx, groupOf, look);
    const tally = (rs: { verdict: Verdict }[]) => ({ right: rs.filter((r) => r.verdict === "right").length, wrong: rs.filter((r) => r.verdict === "wrong").length,
      cant: rs.filter((r) => r.verdict === "can't tell").length });
    const t = tally(fr.rows);
    console.log(`ai-review: on the ${fixtures.length} fixture species, ${t.right} right, ${t.wrong} wrong, ${t.cant} can't tell`);
    for (const r of fr.rows.filter((x) => x.verdict !== "right")) console.log(`  ${bySis.get(r.sis_taxon_id)?.name}: ${r.verdict}: ${r.answer} (${r.reason.slice(0, 160)})`);
    const perCall = spent.calls ? spent.usd / spent.calls : null;
    if (mode === "review") {
      for (let k = 2; k <= runs; k++) {
        const again = await askReviewer(fixtures.map((s) => factsOf(s.sis)), { cacheDir, model, run: k, parallel });
        const same = fixtures.filter((s) => { const x = fx.get(s.sis), y = again.get(s.sis);
          return x && y && x.records !== "can't tell" && y.records !== "can't tell" && counted(x.records, look) === counted(y.records, look); }).length;
        console.log(`ai-review: reviewer ${k} on the fixtures agrees with reviewer 1 on ${same} of ${fixtures.length}`);
      }
    }
    const calls = Math.ceil(chosen.length / BATCH) * (mode === "review" ? runs : 1);
    console.log(`ai-review ${mode}: ${chosen.length.toLocaleString()} species, ${calls.toLocaleString()} calls of ${BATCH} (before the cache)` +
      (perCall ? `, about $${(perCall * calls).toFixed(0)} at the fixtures' $${perCall.toFixed(2)} a call` : ""));
    if (a.includes("--fixtures-only")) return;
    if (!a.includes("--yes") && !(await ask("Go on? [y/N] "))) return;

    if (mode === "review") return review(chosen);

    const answers = await askReviewer(chosen.map((s) => factsOf(s.sis)), { cacheDir, model, parallel });
    const r = report(chosen, answers, groupOf, look);
    await writeTable(conn, "scores", { sis_taxon_id: "BIGINT", answer: "VARCHAR", sources: "VARCHAR", verdict: "VARCHAR", reason: "VARCHAR", model: "VARCHAR" },
      r.rows.map((x) => ({ ...x, model: model ?? "default" })));
    const out = path.join(REVIEW_DIR, "reviewer-scores.parquet");
    await conn.run(`COPY scores TO ${lit(out)} (FORMAT parquet)`);
    fs.writeFileSync(path.join(REVIEW_DIR, "reviewer-scores-report.json"), JSON.stringify({ mode, byDoubt: r.byDoubt, byGroup: r.byGroup }, null, 1));
    const all = tally(r.rows);
    console.log(`ai-review: ${all.right} right, ${all.wrong} wrong, ${all.cant} can't tell; ${out}`);
    for (const [d, v] of Object.entries(r.byDoubt).sort()) console.log(`  ${d.padEnd(26)} ${v.right} right, ${v.wrong} wrong, ${v["can't tell"]} can't tell`);
    if (old) {
      // Goal 2: among the species changed, no group has fewer judged right under the new rules.
      const goal = goal2(chosen, old, answers, groupOf, look);
      fs.writeFileSync(path.join(REVIEW_DIR, "reviewer-scores-goal2.json"), JSON.stringify(goal, null, 1));
      const worse = Object.entries(goal).filter(([, g]) => g.new < g.old);
      console.log(worse.length === 0 ? "ai-review: Goal 2 holds: no group has fewer right" :
        `ai-review: Goal 2 FAILS for ${worse.map(([k, g]) => `${k} (${g.old} → ${g.new})`).join(", ")}: each species lost needs a fixture case, or the change doesn't merge`);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
