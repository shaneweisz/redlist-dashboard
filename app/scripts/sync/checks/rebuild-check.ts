/**
 * rebuild-check: can the selection be rebuilt from docs/specs/matching.md alone?
 * (The spec's "How it's checked".) An agent gets a sealed folder:
 *
 *   spec.md          the spec
 *   name-rules.mjs   link/name-rules.ts bundled into one file, the only library it may use
 *   inputs/          the build's inputs as JSON lines: species (with synonyms and
 *                    their authors, and the matcher's response, each record with its
 *                    CoL species' name, authorship, class, kingdom and phylum),
 *                    records (the CoL records each synonym or decided name names, and
 *                    the occurrences under each), decisions.tsv
 *   output.schema.json  what to write: out.json
 *
 * and runs `claude -p` there with only Read, Write, Edit and Bash, no web, no
 * settings or MCP servers, HOME set to the folder. Its out.json is compared with
 * select.ts species by species, and its log kept, with every file it read and
 * every command it ran listed, and any path outside the folder called out.
 *
 * --counting checks the spec's "Counting and the NE list" the same way, apart
 * from selection: the folder holds the spec, select.ts's selection for every
 * species (so counting is tested alone), the CoL taxa (id, parent, species,
 * rank, status, name) and the GBIF records under each usage; the agent writes
 * every assessed species' and every unassessed CoL species' record count, and
 * they are compared with ours: the same selection's link rows through count/owners.ts
 * (kept equal to count/usage_owner.sql by checks/owners-check.ts).
 *
 * Run after every change to the rules and every release move. A run costs an
 * agent session: --prepare builds the folder and prints the command without
 * running it; --compare <out.json> compares an existing answer.
 *
 * Usage: npm run sync:rebuild-check [-- --counting] [-- --prepare] [-- --compare <out.json>] [-- --model <m>]
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync, execSync } from "child_process";
import { loadEnvFiles } from "../../lib/utils";
import { REVIEW_DIR, parquet, tables } from "../paths";
import { openDuckDB, rows, lit } from "../sql";
import { buildLink } from "../link/assessment-link";
import { usageOwners, type OwnerClaim, type OwnerTaxon } from "../count/owners";
import { loadInputs, selectionJson } from "../link/select-inputs";
import { selectEvery } from "../link/select";
import { DECISIONS_FILE } from "../link/decisions";
import { runClaude, claudeArgs, toolUse, type ClaudeRun } from "./claude-run";

const SPEC = path.join(__dirname, "..", "..", "..", "..", "docs", "specs", "matching.md");
const NAME_RULES = path.join(__dirname, "..", "link", "name-rules.ts");

const OUTPUT_SCHEMA = {
  type: "array", items: { type: "object", required: ["sis_taxon_id", "step", "reason", "doubts", "selected"], properties: {
    sis_taxon_id: { type: "integer" }, step: { type: "integer", minimum: 1, maximum: 6 }, reason: { type: ["string", "null"] },
    doubts: { type: "array", items: { type: "string" } },
    selected: { type: "array", items: { type: "object", required: ["id", "relation", "relation_step", "basis"], properties: {
      id: { type: "string" }, relation: { enum: ["is", "part of", "split into", "refused"] },
      relation_step: { type: ["integer", "string"] }, basis: { enum: ["matcher", "citation", "synonym", "decision"] } } } } } },
};

const PROMPT = `This folder holds a specification (spec.md) and the inputs it describes (inputs/).
Implement the spec's selection: for every species in inputs/species.jsonl, its step, reason, doubts, and selected records with
their relation, relation_step and basis, as the spec's Output section describes. Write the result to
out.json in this folder, matching output.schema.json. The only library you may use is name-rules.mjs (import it from node).
inputs/README.md says what each file holds. Work only inside this folder (scratch files go in tmp/). When you are done, say how many species you wrote.`;

type Out = ReturnType<typeof selectionJson>;

/** The sealed folder, from the build's inputs. */
export async function prepare(dir: string): Promise<{ dir: string; species: Out[] }> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tmp"));
  fs.copyFileSync(SPEC, path.join(dir, "spec.md"));
  // rolldown, Vite's bundler, resolves the two src/lib imports into the one file.
  execFileSync(path.join(__dirname, "..", "..", "..", "node_modules", ".bin", "rolldown"),
    [NAME_RULES, "--format", "esm", "--platform", "node", "--file", path.join(dir, "name-rules.mjs")], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "output.schema.json"), JSON.stringify(OUTPUT_SCHEMA, null, 1));
  if (fs.existsSync(DECISIONS_FILE)) fs.copyFileSync(DECISIONS_FILE, path.join(dir, "inputs", "decisions.tsv"));

  const inputs = await loadInputs();
  const lines = (f: string, xs: unknown[]) => fs.writeFileSync(path.join(dir, "inputs", f), xs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  lines("species.jsonl", inputs.species);
  // Every name a synonym or a decision names, with the CoL records of that name (or orthographicallySame), each with the occurrences under it.
  const names = new Set<string>([...inputs.species.flatMap((s) => s.synonyms.map((y) => y.name)),
    ...[...inputs.decisions.values()].flatMap((d) => d.rows.flatMap((r) => (r.name ? [r.name] : [])))]);
  lines("records.jsonl", [...names].map((name) => ({ name, records: inputs.release.recordsNamed(name).map((r) => ({ ...r, occurrences_under: inputs.release.occurrencesUnder(r.id) })) })));
  const decided = [...inputs.decisions.values()].flatMap((d) => d.rows.flatMap((r) => (r.id ? [inputs.release.byId(r.id)].filter(Boolean) : [])));
  lines("records-by-id.jsonl", decided);
  fs.writeFileSync(path.join(dir, "inputs", "README.md"), `# Inputs

- species.jsonl: one assessed species per line: sis, name, authority, kingdom, phylum, synonyms [{name, authors}] in the Red List's
  order, and match: the matcher's response (matchType, answerName, answer, alternatives in its order). Each record: id, name,
  authorship, rank and status (the matcher's forms), classification (the matcher's points against the hints), and species:
  speciesOf(id) with its name, authorship, class, kingdom, phylum (null if it leads to none).
- records.jsonl: for each name a Red List synonym or a decision names, the species-rank CoL records with that name or an
  orthographicallySame one, in the same shape, each with occurrences_under (its own and those below it).
- records-by-id.jsonl: the CoL records decisions.tsv names by id.
- decisions.tsv: seeds/decisions.tsv (statuses lower-case, as CoL writes them).
`);
  const ours = selectEvery(inputs.species, inputs.release, inputs.decisions).map(selectionJson);
  return { dir, species: ours };
}

/** Species by species: where the agent's answer differs from select.ts's. */
export function compareSelections(ours: Out[], theirs: Out[]): { agree: number; differ: { sis: number; field: string; ours: unknown; theirs: unknown }[] } {
  const by = new Map(theirs.map((t) => [t.sis_taxon_id, t]));
  const key = (s: Out["selected"]) => s.map((x) => `${x.id}:${x.relation}:${x.basis}`).sort().join(",");
  const differ: { sis: number; field: string; ours: unknown; theirs: unknown }[] = [];
  let agree = 0;
  for (const o of ours) {
    const t = by.get(o.sis_taxon_id);
    if (!t) { differ.push({ sis: o.sis_taxon_id, field: "missing", ours: o, theirs: null }); continue; }
    const fields: [string, unknown, unknown][] = [["step", o.step, t.step], ["reason", o.reason, t.reason],
      ["doubts", [...o.doubts].sort().join(";"), [...t.doubts].sort().join(";")], ["selected", key(o.selected), key(t.selected)]];
    const bad = fields.filter(([, a, b]) => a !== b);
    if (bad.length === 0) agree++;
    for (const [field, a, b] of bad) differ.push({ sis: o.sis_taxon_id, field, ours: a, theirs: b });
  }
  return { agree, differ };
}

function report(ours: Out[], theirs: Out[], dir: string): void {
  const { agree, differ } = compareSelections(ours, theirs);
  const byField: Record<string, number> = {};
  for (const d of differ) byField[d.field] = (byField[d.field] ?? 0) + 1;
  console.log(`rebuild-check: ${agree.toLocaleString()} of ${ours.length.toLocaleString()} species agree; differences by field: ${JSON.stringify(byField)}`);
  fs.writeFileSync(path.join(dir, "..", "differences.json"), JSON.stringify(differ, null, 1));
  for (const d of differ.slice(0, 20)) console.log(`  SIS ${d.sis} ${d.field}: ours ${JSON.stringify(d.ours)}, theirs ${JSON.stringify(d.theirs)}`);
  if (differ.length > 0) process.exitCode = 1;
}

const COUNT_SCHEMA = {
  type: "object", required: ["assessed", "unassessed"], properties: {
    assessed: { type: "object", additionalProperties: { type: "integer" }, description: "SIS id → the GBIF records it counts" },
    unassessed: { type: "object", additionalProperties: { type: "integer" }, description: "CoL species id → the GBIF records it counts, for each species no assessed species counts whole" } },
};

const COUNT_PROMPT = `This folder holds a specification (spec.md) and inputs (inputs/). Implement the spec's "Counting and the NE list"
(what each assessed species' rows are, which row wins a clash, and who owns each CoL usage's GBIF records), taking the selection in
inputs/selection.jsonl as given. Write out.json in this folder, matching output.schema.json: for every assessed species the GBIF records
it counts (0 included), and for every CoL species no assessed species counts whole, the GBIF records it counts (only those above 0).
inputs/README.md says what each file holds. The only library you may use is name-rules.mjs (import it from node). Work only inside
this folder (scratch files go in tmp/). When you are done, say how many species of each kind you wrote.`;

/** The counting check's sealed folder, and the build's counts to compare with. */
export async function prepareCounting(dir: string): Promise<{ dir: string; ours: { assessed: Record<string, number>; unassessed: Record<string, number> } }> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tmp"));
  fs.copyFileSync(SPEC, path.join(dir, "spec.md"));
  execFileSync(path.join(__dirname, "..", "..", "..", "node_modules", ".bin", "rolldown"),
    [NAME_RULES, "--format", "esm", "--platform", "node", "--file", path.join(dir, "name-rules.mjs")], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "output.schema.json"), JSON.stringify(COUNT_SCHEMA, null, 1));
  const inputs = await loadInputs();
  const sel = selectEvery(inputs.species, inputs.release, inputs.decisions, inputs.verdicts).map(selectionJson);
  const lines = (f: string, xs: unknown[]) => fs.writeFileSync(path.join(dir, "inputs", f), xs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  lines("species.jsonl", inputs.species.map((sp) => ({ sis: sp.sis, name: sp.name })));
  lines("selection.jsonl", sel);
  const T = tables(), conn = await openDuckDB();
  await conn.run(`COPY (SELECT col_id, parent_id, species_id, rank, status, scientific_name FROM ${parquet(T.taxa)} ORDER BY col_id)
    TO ${lit(path.join(dir, "inputs", "taxa.tsv"))} (FORMAT csv, DELIMITER '\t', HEADER true, QUOTE '')`);
  await conn.run(`COPY (SELECT usage_key, sum(n)::BIGINT AS records FROM ${parquet(T.occurrences)} GROUP BY 1 ORDER BY 1)
    TO ${lit(path.join(dir, "inputs", "occurrences.tsv"))} (FORMAT csv, DELIMITER '\t', HEADER true, QUOTE '')`);
  fs.writeFileSync(path.join(dir, "inputs", "README.md"), `# Inputs

- species.jsonl: every assessed species: sis, name (its Red List name as written).
- selection.jsonl: each species' selection, as the spec's Output section describes (sis_taxon_id, step, reason, doubts, selected
  [{id, relation, relation_step, basis}], in order). Take it as given.
- taxa.tsv: every CoL usage: col_id, parent_id, species_id (the accepted species it leads to; empty for none), rank, status
  (lower-case), scientific_name. Tab-separated with a header; empty fields are empty.
- occurrences.tsv: usage_key (a col_id), records: the GBIF records filed directly under that usage (not those below it).
`);
  // Ours: this selection's link rows (as the sync builds them, from the same seeds) through count/owners.ts, which
  // checks/owners-check.ts keeps equal to usage_owner.sql; so a build older than the seeds can't skew it.
  const link = path.join(dir, "..", "assessment_link.parquet");
  await buildLink({ taxa: T.taxa, assessments: T.assessments, matches: T.matches }, { link });
  const claims = (await rows<OwnerClaim>(conn, `SELECT sis_taxon_id::INTEGER AS sis_taxon_id, relation, counts, col_taxon_id, col_species_id FROM ${parquet(link)}`))
    .map((c) => ({ ...c, sis_taxon_id: Number(c.sis_taxon_id) }));
  const taxa = await rows<OwnerTaxon>(conn, `SELECT col_id, parent_id, species_id FROM ${parquet(T.taxa)}`);
  const occ = new Map((await rows<{ k: string; n: number }>(conn, `SELECT usage_key AS k, sum(n)::BIGINT AS n FROM ${parquet(T.occurrences)} GROUP BY 1`))
    .map((r) => [r.k, Number(r.n)]));
  const assessed: Record<string, number> = Object.fromEntries(inputs.species.map((sp) => [String(sp.sis), 0]));
  const unassessed: Record<string, number> = {};
  for (const [u, o] of usageOwners(claims, taxa)) {
    const n = occ.get(u) ?? 0;
    if (!n) continue;
    if (o.sis !== undefined) assessed[String(o.sis)] = (assessed[String(o.sis)] ?? 0) + n;
    else unassessed[o.col_id] = (unassessed[o.col_id] ?? 0) + n;
  }
  return { dir, ours: { assessed, unassessed } };
}

/** Where the agent's counts differ from the build's. */
export function compareCounts(ours: Record<string, Record<string, number>>, theirs: Record<string, Record<string, number>>) {
  const differ: { kind: string; id: string; ours: number; theirs: number }[] = [];
  let agree = 0;
  for (const kind of ["assessed", "unassessed"]) {
    const a = ours[kind] ?? {}, b = theirs[kind] ?? {};
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[id] ?? 0, y = b[id] ?? 0;
      if (x === y) agree++; else differ.push({ kind, id, ours: x, theirs: y });
    }
  }
  return { agree, differ };
}

if (require.main === module) {
  (async () => {
    loadEnvFiles();
    const a = process.argv.slice(2);
    const opt = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
    const run = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
    const counting = a.includes("--counting");
    const root = path.join(REVIEW_DIR, counting ? "rebuild-check-counting" : "rebuild-check", run);
    const work = path.join(root, "work");
    let ours: Out[] = [], oursCounts: Awaited<ReturnType<typeof prepareCounting>>["ours"] | null = null;
    if (counting) oursCounts = (await prepareCounting(work)).ours;
    else ours = (await prepare(work)).species;
    console.log(`rebuild-check: sealed folder ${work}`);
    const reportAny = (theirs: unknown) => {
      if (!oursCounts) return report(ours, theirs as Out[], work);
      const { agree, differ } = compareCounts(oursCounts, theirs as Record<string, Record<string, number>>);
      console.log(`rebuild-check --counting: ${agree.toLocaleString()} species' counts agree, ${differ.length.toLocaleString()} differ`);
      fs.writeFileSync(path.join(work, "..", "differences.json"), JSON.stringify(differ, null, 1));
      for (const d of differ.slice(0, 20)) console.log(`  ${d.kind} ${d.id}: ours ${d.ours}, theirs ${d.theirs}`);
      if (differ.length > 0) process.exitCode = 1;
    };
    if (opt("compare")) return reportAny(JSON.parse(fs.readFileSync(path.resolve(opt("compare")!), "utf-8")));
    const r: ClaudeRun = { prompt: counting ? COUNT_PROMPT : PROMPT, cwd: work, home: work, tmpdir: path.join(work, "tmp"), tools: ["Read", "Write", "Edit", "Bash"], allowed: ["Read", "Write", "Edit", "Bash"],
      outputFormat: "stream-json", model: opt("model") };
    if (a.includes("--prepare")) {
      console.log(`Run it with: (cd ${work} && HOME=${work} TMPDIR=${work}/tmp claude ${claudeArgs(r).map((x) => JSON.stringify(x)).join(" ")})`);
      return;
    }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("rebuild-check: CLAUDE_CODE_OAUTH_TOKEN isn't set (app/.env.local, from `claude setup-token`)");
    const res = await runClaude(r);
    fs.writeFileSync(path.join(root, "transcript.jsonl"), res.stdout);
    const used = toolUse(res.stdout);
    // Paths it touched outside the folder: by Read, Write or Edit, or named in a command.
    // Absolute paths under the roots a file could be read from (a bare /x/ in a command is more often a regex).
    const inCommands = used.commands.flatMap((c) => c.match(/(?<![\w.])\/(?:Users|home|tmp|private|var|etc|Volumes)(?:\/[^\s'"`;|&)]*)?/g) ?? []);
    const outside = [...new Set([...used.reads, ...used.writes, ...inCommands].filter((p) => p && !path.resolve(work, p).startsWith(work)))];
    fs.writeFileSync(path.join(root, "tool-use.json"), JSON.stringify({ ...used, outside, claude: execSync("claude --version").toString().trim() }, null, 1));
    console.log(`rebuild-check: the agent read ${used.reads.length} files, wrote ${used.writes.length}, ran ${used.commands.length} commands` +
      (outside.length ? `; OUTSIDE the folder: ${outside.join(", ")}` : ""));
    if (outside.length) process.exitCode = 1;
    const out = path.join(work, "out.json");
    if (!fs.existsSync(out)) throw new Error(`rebuild-check: the agent wrote no out.json (exit ${res.code}); its log is in ${root}`);
    reportAny(JSON.parse(fs.readFileSync(out, "utf-8")));
  })().catch((e) => { console.error(e); process.exit(1); });
}
