/**
 * The judge (docs/specs/matching.md, "The judge"): headless Claude Code reads
 * species' facts and says which CoL records it would take; this compares its
 * answer with select.ts's. It runs by hand, outside the sync, and the sync never
 * reads its output.
 *
 *   first     the species that aren't easy, and a random 1,000 easy ones
 *   changed   every species whose records differ from --baseline <old.json>: the old
 *             rules' `npm run sync:select` on this build. Reports Goal 2: per group,
 *             how many the old and the new rules have right, among the species changed
 *
 * Before a run it answers the fixture cases, prints its score and the number of
 * calls the run needs, and asks before going on (--yes doesn't ask). Answers are
 * cached by the SHA-256 of a batch's facts and the prompt, so a rerun asks only
 * what changed. Output: .sync/review/judgements.parquet and a report by doubt and
 * by group.
 *
 * Usage: npm run sync:judge -- first | changed --baseline <old.json> [--yes] [--fixtures-only] [--limit N] [--model m]
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { loadEnvFiles } from "../../lib/utils";
import { REVIEW_DIR, parquet, tables } from "../paths";
import { openDuckDB, rows, writeTable, lit } from "../sql";
import { loadInputs, type Inputs } from "../link/select-inputs";
import { selectEvery, type ColRecord, type Selection, type SpeciesInput } from "../link/select";
import { sameName, sameNameKey } from "../link/name-rules";
import { MATCHING_CASES } from "./fixtures/matching";
import { runClaude, type Runner } from "./claude-run";

export const PROMPT = fs.readFileSync(path.join(__dirname, "judge-prompt.md"), "utf-8");
const BATCH = 20;
/** Its own domains are the one thing the judge may not read: it would see our answer. */
const OWN_DOMAINS = ["dashforlife.org", "vercel.app"];

export const ANSWER_SCHEMA = {
  type: "object", required: ["answers"], properties: { answers: { type: "array", items: {
    type: "object", required: ["sis_taxon_id", "records", "reason", "sources"], properties: {
      sis_taxon_id: { type: "integer" },
      records: { oneOf: [{ const: "can't tell" }, { type: "array", items: { type: "object", required: ["id", "relation"],
        properties: { id: { type: "string" }, relation: { enum: ["is", "part of", "split into"] } } } }] },
      reason: { type: "string" }, sources: { type: "array", items: { type: "string" } } } } } },
};

export interface Answer { sis_taxon_id: number; records: { id: string; relation: string }[] | "can't tell"; reason: string; sources: string[] }
export type Verdict = "right" | "wrong" | "can't tell";

/** Easy: one group, no doubt and no reason, every step record is, and no synonym record other than refused. */
export const isEasy = (s: Selection) => s.groups <= 1 && s.doubts.length === 0 && !s.reason
  && s.selected.filter((x) => x.basis !== "synonym").every((x) => x.relation === "is")
  && s.selected.filter((x) => x.basis === "synonym").every((x) => x.relation === "refused");

/** A species' facts, independent of the rules being judged: not our selection. */
export function facts(sp: SpeciesInput, lineage: Record<string, string | null> | undefined, inputs: Inputs) {
  const own = new Map<string, ColRecord>();
  const add = (r: ColRecord) => { if (r.rank === "SPECIES") own.set(r.id, r); };
  for (const r of [...(sp.match?.answer ? [sp.match.answer] : []), ...(sp.match?.alternatives ?? [])]) {
    if (sameName(r.name, sp.name) || (sp.match?.answerName && sameName(r.name, sp.match.answerName))) add(r);
  }
  for (const n of [sp.name, sp.match?.answerName, ...sp.synonyms.map((y) => y.name)]) if (n) for (const r of inputs.release.recordsNamed(n)) add(r);
  const assessedElsewhere = (n: string | undefined) => !!n && !sameName(n, sp.name) && inputs.release.assessedNames.has(sameNameKey(n));
  const said = (r: ColRecord | null | undefined) => r ? { id: r.id, name: r.name, authorship: r.authorship, rank: r.rank, status: r.status, classification: r.classification ?? null } : null;
  return {
    sis_taxon_id: sp.sis,
    red_list: { name: sp.name, citation: sp.authority, ...lineage, synonyms: sp.synonyms },
    matcher: sp.match ? { match_type: sp.match.matchType, answer: said(sp.match.answer), alternatives: sp.match.alternatives.map(said) } : null,
    col_records: [...own.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => ({
      id: r.id, name: r.name, authorship: r.authorship, status: r.status,
      col_species: r.species ? { id: r.species.id, name: r.species.name, authorship: r.species.authorship, class: r.species.class } : null,
      gbif_records_under: inputs.release.occurrencesUnder(r.id),
      col_species_assessed_separately: assessedElsewhere(r.species?.name),
    })),
  };
}

/** Our answer, as the judge's is written: refused records count as not taken. */
export const ourAnswer = (s: Selection) => s.selected.filter((x) => x.relation !== "refused").map((x) => ({ id: x.record.id, relation: x.relation }));

export function score(ours: { id: string; relation: string }[], theirs: Answer["records"]): Verdict {
  if (theirs === "can't tell") return "can't tell";
  const key = (xs: { id: string; relation: string }[]) => xs.map((x) => `${x.id}:${x.relation}`).sort().join(",");
  return key(ours) === key(theirs) ? "right" : "wrong";
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Asks the judge about species in batches, from the cache where it can. */
export async function judge(batchFacts: ReturnType<typeof facts>[], opts: { cacheDir: string; runner?: Runner; model?: string }): Promise<Map<number, Answer>> {
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const out = new Map<number, Answer>();
  for (let i = 0; i < batchFacts.length; i += BATCH) {
    const batch = batchFacts.slice(i, i + BATCH);
    const stdin = JSON.stringify(batch, null, 1);
    const cache = path.join(opts.cacheDir, `${sha(stdin + PROMPT)}.json`);
    let answers: Answer[];
    if (fs.existsSync(cache)) answers = JSON.parse(fs.readFileSync(cache, "utf-8"));
    else {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
      const res = await (opts.runner ?? runClaude)({ prompt: PROMPT, stdin, cwd, home: cwd, tools: ["WebSearch", "WebFetch"], allowed: ["WebSearch", "WebFetch"],
        disallowed: OWN_DOMAINS.map((d) => `WebFetch(domain:${d})`), outputFormat: "json", schema: ANSWER_SCHEMA, model: opts.model });
      fs.rmSync(cwd, { recursive: true, force: true });
      if (res.code !== 0) throw new Error(`judge: claude exited ${res.code}: ${res.stderr.slice(0, 500)}`);
      const o = JSON.parse(res.stdout);
      const structured = o.structured_output ?? (typeof o.result === "string" ? JSON.parse(o.result) : o.result);
      answers = (structured?.answers ?? []) as Answer[];
      fs.writeFileSync(cache, JSON.stringify(answers));
    }
    for (const a of answers) out.set(a.sis_taxon_id, a);
  }
  return out;
}

/** The judgements, and a report by doubt and by group (the CoL class, or kingdom for plants and fungi). */
export function report(sel: Selection[], answers: Map<number, Answer>, groupOf: Map<number, string>) {
  const rowsOut: { sis_taxon_id: number; answer: string; sources: string; verdict: Verdict; reason: string }[] = [];
  const by = (k: string, v: Verdict, t: Record<string, Record<Verdict, number>>) => { (t[k] ??= { right: 0, wrong: 0, "can't tell": 0 })[v]++; };
  const byDoubt: Record<string, Record<Verdict, number>> = {}, byGroup: Record<string, Record<Verdict, number>> = {};
  for (const s of sel) {
    const a = answers.get(s.sis);
    if (!a) continue;
    const v = score(ourAnswer(s), a.records);
    rowsOut.push({ sis_taxon_id: s.sis, answer: JSON.stringify(a.records), sources: a.sources.join(" "), verdict: v, reason: a.reason });
    for (const d of s.doubts.length ? s.doubts : [isEasy(s) ? "(easy)" : "(no doubt)"]) by(d, v, byDoubt);
    by(groupOf.get(s.sis) ?? "?", v, byGroup);
  }
  return { rows: rowsOut, byDoubt, byGroup };
}

/** Per group, among the species changed: how many the old rules and the new have right. */
export function goal2(chosen: Selection[], old: Map<number, { id: string; relation: string }[]>, answers: Map<number, Answer>, groupOf: Map<number, string>) {
  const out: Record<string, { old: number; new: number; species: number }> = {};
  for (const s of chosen) {
    const a = answers.get(s.sis);
    if (!a) continue;
    const g = (out[groupOf.get(s.sis) ?? "?"] ??= { old: 0, new: 0, species: 0 });
    g.species++;
    if (score(old.get(s.sis) ?? [], a.records) === "right") g.old++;
    if (score(ourAnswer(s), a.records) === "right") g.new++;
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
    if (mode !== "first" && mode !== "changed") throw new Error("Usage: npm run sync:judge -- first | changed --baseline <old rules' sync:select JSON>");
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("judge: CLAUDE_CODE_OAUTH_TOKEN isn't set (app/.env.local, from `claude setup-token`)");
    const T = tables();
    const conn = await openDuckDB();
    const pre = await loadInputs();
    const extra = pre.species.flatMap((s) => [s.name, ...(s.match?.answerName ? [s.match.answerName] : [])]);
    const inputs = await loadInputs(T, pre.decisions, conn, extra);
    const sel = selectEvery(inputs.species, inputs.release, inputs.decisions);
    const bySis = new Map(inputs.species.map((s) => [s.sis, s]));
    const lineage = new Map((await rows<{ sis: number; class_name: string | null; order_name: string | null; family: string | null; kingdom: string | null; phylum: string | null }>(conn, `
      SELECT sis_taxon_id::INTEGER AS sis, kingdom_name AS kingdom, phylum_name AS phylum, class_name, order_name, family FROM ${parquet(T.assessments)} WHERE is_latest`))
      .map((r) => [r.sis, { kingdom: r.kingdom, phylum: r.phylum, class: r.class_name, order: r.order_name, family: r.family }]));
    const groupOf = new Map([...lineage].map(([sis, l]) => [sis, /plantae|fungi/i.test(l.kingdom ?? "") ? (l.kingdom ?? "?") : (l.class ?? "?")]));
    const factsOf = (sis: number) => facts(bySis.get(sis)!, lineage.get(sis), inputs);
    const cacheDir = path.join(REVIEW_DIR, "judge-cache");
    const model = opt("model");

    // Which species.
    let chosen: Selection[];
    let old: Map<number, { id: string; relation: string }[]> | null = null;
    if (mode === "first") {
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
    const fr = report(fixtures, fx, groupOf);
    const tally = (rs: { verdict: Verdict }[]) => ({ right: rs.filter((r) => r.verdict === "right").length, wrong: rs.filter((r) => r.verdict === "wrong").length,
      cant: rs.filter((r) => r.verdict === "can't tell").length });
    const t = tally(fr.rows);
    console.log(`judge: on the ${fixtures.length} fixture species, ${t.right} right, ${t.wrong} wrong, ${t.cant} can't tell`);
    for (const r of fr.rows.filter((x) => x.verdict !== "right")) console.log(`  ${bySis.get(r.sis_taxon_id)?.name}: ${r.verdict}: ${r.answer} (${r.reason.slice(0, 160)})`);
    const calls = Math.ceil(chosen.length / BATCH);
    console.log(`judge ${mode}: ${chosen.length.toLocaleString()} species, ${calls.toLocaleString()} calls of ${BATCH} (before the cache)`);
    if (a.includes("--fixtures-only")) return;
    if (!a.includes("--yes") && !(await ask("Go on? [y/N] "))) return;

    const answers = await judge(chosen.map((s) => factsOf(s.sis)), { cacheDir, model });
    const r = report(chosen, answers, groupOf);
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
      const goal = goal2(chosen, old, answers, groupOf);
      fs.writeFileSync(path.join(REVIEW_DIR, "judgements-goal2.json"), JSON.stringify(goal, null, 1));
      const worse = Object.entries(goal).filter(([, g]) => g.new < g.old);
      console.log(worse.length === 0 ? "judge: Goal 2 holds: no group has fewer right" :
        `judge: Goal 2 FAILS for ${worse.map(([k, g]) => `${k} (${g.old} → ${g.new})`).join(", ")}: each species lost needs a fixture case, or the change doesn't merge`);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
