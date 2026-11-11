/**
 * agent-match-review: AI agents review the name matches the sync left waiting.
 * Independent Claude reviewers judge each waiting Red List -> CoL match, and a
 * match is decided only when every reviewer agrees.
 *
 *   npm run sync:agent-match-review -- --sis 194894,19620213     the links named
 *   npm run sync:agent-match-review -- --sample 5                 N waiting links, spread across to_review reasons
 *   --dry-run picks the links and prints them, without starting a reviewer
 *   options: --votes 2 (reviewers per link) --concurrency 6 --model haiku --upload (transcripts to B2)
 *
 * Each reviewer is a fresh `claude -p`, logged in with CLAUDE_CODE_OAUTH_TOKEN
 * from app/.env.local (mint one with `claude setup-token`), run in an empty folder (so no CLAUDE.md or
 * memory reaches it), given reviewer-prompt.md with the link's row, the tools
 * curl (Bash limited to curl), WebFetch and WebSearch, and verdict-schema.json
 * as its structured output. Every reviewer gets the same prompt: agreement has
 * to survive the model's own variation.
 *
 * Reads the build's review/links.parquet (run `npm run sync` first). Writes:
 *   .sync/review/agent-match-review/<run>/   manifest.json (git commit, prompt and
 *       schema hashes, CLI version, model, options), rows.json, and per
 *       reviewer <sis>-<n>.jsonl (the full stream-json transcript) and
 *       <sis>-<n>.md (the same, readable)
 *   seeds/agent-match-overrides.tsv    one row per reviewed link, replacing an
 *       earlier review of it: the decision, the CoL record it chose, each
 *       reviewer's verdict, reasoning, sources and transcript, and blank
 *       reviewed / reviewer_note columns for a person
 *
 * Decisions:
 *   - A decision ("link" or "not in CoL") needs every reviewer to give the same
 *     verdict and record, none unsure and none at low confidence. "lumped"
 *     counts as agreeing with "same species": both take the matcher's record.
 *     A link must name a record that leads to a CoL species and isn't marked
 *     misapplied. Everything else keeps waiting: "no agreement", "matcher
 *     wrong, no record" (they agree it's wrong but found nothing right), "no
 *     usable record" (they agree on a record that leads to no species).
 *   - The sync does not read agent-match-overrides.tsv yet.
 *   - Transcripts upload under agent-match-reviews/<run>/ in the public B2 bucket; the
 *     init message is cut to model, version and tools, and local paths are
 *     replaced, before anything is written.
 */
import { spawn, execSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { BUILD_DIR, tables } from "../paths";
import { openDuckDB, rows as query } from "../sql";
import { SEEDS_DIR } from "../seeds/seeds";
import { loadEnvFiles } from "../../lib/utils";
import { syncPath } from "../../../src/lib/data/sync-layout";

const HERE = __dirname;
const PROMPT_FILE = path.join(HERE, "reviewer-prompt.md");
const SCHEMA_FILE = path.join(HERE, "verdict-schema.json");
const TSV = path.join(SEEDS_DIR, "agent-match-overrides.tsv");

type Verdict = { verdict: string; col_id: string | null; confidence: string; reasoning: string; sources: string[] };
type Row = Record<string, unknown> & { sis_taxon_id: number; to_review: string };

function opts() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  return {
    sis: get("sis")?.split(",").map(Number),
    sample: get("sample") ? Number(get("sample")) : undefined,
    votes: Number(get("votes") ?? 2),
    concurrency: Number(get("concurrency") ?? 6),
    model: get("model") ?? "haiku",
    upload: a.includes("--upload"),
    dryRun: a.includes("--dry-run"),
  };
}

async function waitingRows(o: ReturnType<typeof opts>): Promise<Row[]> {
  const T = tables(BUILD_DIR);
  const conn = await openDuckDB();
  const all = await query<Row>(conn, `
    SELECT l.sis_taxon_id::BIGINT AS sis_taxon_id, l.redlist_name, l.redlist_authority, a.common_name, l.category, l.taxon_group, l.class, l."order", l.family,
           a.countries, a.systems, l.redlist_synonyms, l.to_review, l.match_description,
           l.matcher_col_id, l.matcher_name, l.matcher_authorship, l.matcher_status, l.matcher_accepted_col_id, l.matcher_accepted_name,
           l.matcher_accepted_authorship, l.matcher_lineage, l.match_type, l.confidence, l.matcher_alternatives,
           row_number() OVER (PARTITION BY l.to_review ORDER BY hash(l.sis_taxon_id)) AS k
    FROM read_parquet('${T.reviewLinks}') l
    JOIN read_parquet('${T.assessments}') a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
    WHERE l.role = 'primary' AND l.to_review IS NOT NULL
      AND l.matcher_col_id IS NOT NULL AND l.match_type NOT IN ('HIGHERRANK', 'NONE')`);
  const tidy = (r: Row): Row => {
    const { k: _k, ...rest } = r;
    const list = (v: unknown) => (v as { items?: unknown[] } | null)?.items ?? v ?? [];
    return { ...rest, sis_taxon_id: Number(r.sis_taxon_id), countries: list(r.countries), systems: list(r.systems),
      redlist_synonyms: r.redlist_synonyms ? JSON.parse(String(r.redlist_synonyms)) : [],
      matcher_alternatives: r.matcher_alternatives ? JSON.parse(String(r.matcher_alternatives)) : [] };
  };
  if (o.sis) return all.filter((r) => o.sis!.includes(Number(r.sis_taxon_id))).map(tidy);
  // Spread a sample across the reasons: the first of each reason, then the second, ...
  const n = o.sample ?? 5;
  return [...all].sort((x, y) => Number(x.k) - Number(y.k) || String(x.to_review).localeCompare(String(y.to_review))).slice(0, n).map(tidy);
}

/** One reviewer: a fresh claude -p, its stream-json transcript kept whole. */
function review(row: Row, prompt: string, schema: string, model: string): Promise<{ lines: string[]; verdict: Verdict | null }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-match-review-"));
  const args = ["-p", prompt.replace("{{row}}", JSON.stringify(row, null, 1)), "--model", model,
    "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "",
    "--tools", "Bash,WebFetch,WebSearch", "--allowedTools", "Bash(curl:*)", "WebFetch", "WebSearch",
    "--permission-mode", "dontAsk", "--json-schema", schema];
  return new Promise((resolve) => {
    const p = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => {
      fs.rmSync(cwd, { recursive: true, force: true });
      const lines = out.split("\n").filter(Boolean);
      const result = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((d) => d?.type === "result");
      resolve({ lines, verdict: result?.structured_output ?? null });
    });
  });
}

/** The transcript as published: the init message cut to what identifies the run, local paths replaced. */
function sanitise(lines: string[]): string[] {
  return lines.map((l) => {
    let d: Record<string, unknown>;
    try { d = JSON.parse(l); } catch { return JSON.stringify({ type: "raw", text: l }); }
    if (d.type === "system" && d.subtype === "init") d = { type: "system", subtype: "init", model: d.model, claude_code_version: d.claude_code_version, tools: d.tools, permissionMode: d.permissionMode };
    return JSON.stringify(d).replace(/\/(Users|private|var\/folders|tmp)\/[^\s"')\\]+/g, "<local path>");
  });
}

/** The same transcript for a person: the task, each tool call with what came back (the full output where the reviewer saw a preview), the verdict. */
function readable(lines: string[], title: string, header: string): string {
  const md = [`# ${title}`, "", header, ""];
  const text = (c: unknown): string => typeof c === "string" ? c
    : Array.isArray(c) ? c.map((b) => (b?.type === "text" ? b.text : "")).join("\n") : JSON.stringify(c);
  const msgs = lines.map((l) => JSON.parse(l));
  const results = new Map<string, string>();
  for (const d of msgs) if (d.type === "user" && Array.isArray(d.message?.content)) for (const b of d.message.content) {
    if (b.type !== "tool_result") continue;
    const full = typeof d.tool_use_result === "object" && d.tool_use_result?.stdout ? String(d.tool_use_result.stdout) : null;
    results.set(b.tool_use_id, `${b.is_error ? "(refused or failed) " : ""}${full ?? text(b.content)}`);
  }
  let step = 0;
  for (const d of msgs) {
    if (d.type === "system" && d.subtype === "init") md.push(`Model ${d.model}, Claude Code ${d.claude_code_version}, tools ${(d.tools ?? []).join(", ")}.`, "");
    if (d.type === "assistant") for (const b of d.message.content) {
      if (b.type === "text" && b.text.trim()) md.push(b.text.trim(), "");
      if (b.type === "tool_use" && b.name === "StructuredOutput") md.push("## Verdict", "", "```json", JSON.stringify(b.input, null, 1), "```", "");
      else if (b.type === "tool_use") {
        step++;
        md.push(`## ${step}. ${b.name}: ${b.input.command ?? b.input.url ?? b.input.query ?? JSON.stringify(b.input)}`, "");
        if (b.input.prompt) md.push(`Asked of the page: ${b.input.prompt}`, "");
        const r = results.get(b.id) ?? "(no result recorded)";
        md.push("Returned:", "", "```", r.length > 30000 ? `${r.slice(0, 30000)}\n… (${r.length.toLocaleString()} characters; the .jsonl has all of it)` : r.trim(), "```", "");
      }
    }
    if (d.type === "result") md.push(`Turns ${d.num_turns}; ${d.usage?.input_tokens ?? 0} input, ${d.usage?.cache_read_input_tokens ?? 0} cached, ${d.usage?.output_tokens ?? 0} output tokens.`);
  }
  return md.join("\n");
}

const key = (v: Verdict | null) => !v || v.verdict === "unsure" || v.confidence === "low" ? null
  : `${v.verdict === "lumped" ? "same species" : v.verdict}|${v.col_id ?? ""}`;

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await f(items[j]); }
  }));
  return out;
}

function readTsv(file: string): Record<string, string>[] {
  if (!fs.existsSync(file)) return [];
  const [head, ...body] = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const cols = head.split("\t");
  return body.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [cols[i], v])));
}

async function upload(dir: string, run: string): Promise<string> {
  const e = process.env;
  const region = e.B2_ENDPOINT!.match(/s3\.([^.]+)\./)![1];
  const s3 = new S3Client({ endpoint: e.B2_ENDPOINT, region, credentials: { accessKeyId: e.B2_KEY_ID!, secretAccessKey: e.B2_APPLICATION_KEY! } });
  for (const f of fs.readdirSync(dir)) {
    const Key = `agent-match-reviews/${run}/${f}`;
    try { await s3.send(new HeadObjectCommand({ Bucket: e.B2_BUCKET, Key })); continue; } catch { /* new key */ }
    await s3.send(new PutObjectCommand({ Bucket: e.B2_BUCKET, Key, Body: fs.readFileSync(path.join(dir, f)),
      ContentType: f.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8" }));
  }
  return `https://f005.backblazeb2.com/file/${e.B2_BUCKET}/agent-match-reviews/${run}`;
}

async function main() {
  const o = opts();
  loadEnvFiles(); // CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) for the reviewers, B2_* for --upload
  const prompt = fs.readFileSync(PROMPT_FILE, "utf-8");
  const schema = fs.readFileSync(SCHEMA_FILE, "utf-8");
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
  const commit = execSync("git rev-parse --short HEAD").toString().trim();
  const dirty = execSync(`git status --porcelain -- ${HERE}`).toString().trim() !== "";
  const run = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;
  const dir = path.join(BUILD_DIR, "review", "agent-match-review", run);
  fs.mkdirSync(dir, { recursive: true });
  const sync = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, "publish", syncPath("sync.json")), "utf-8"));
  const releases = { redlist: sync.redlist?.database ?? "", col: sync.col?.xr?.alias ?? "", col_dataset: sync.col?.xr?.key ?? "" };

  const links = await waitingRows(o);
  if (o.dryRun) {
    for (const l of links) console.log(`${l.sis_taxon_id}\t${l.to_review}\t${l.redlist_name} ${l.redlist_authority ?? ""} -> ${l.matcher_name} ${l.matcher_authorship ?? ""}\t${JSON.stringify(l.countries)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  const cli = execSync("claude --version").toString().trim();
  const manifest = { run, commit, prompt_changed_since_commit: dirty, prompt_sha: sha(prompt), schema_sha: sha(schema), claude_code: cli,
    model: o.model, votes: o.votes, links: links.length, releases };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(dir, "rows.json"), JSON.stringify(links, null, 1));
  console.log(`agent-match-review ${run}: ${links.length} links × ${o.votes} reviewers (${o.model}), prompt ${manifest.prompt_sha}${dirty ? " (uncommitted)" : ""}`);

  const jobs = links.flatMap((row) => Array.from({ length: o.votes }, (_, n) => ({ row, n: n + 1 })));
  const done = await pool(jobs, o.concurrency, async ({ row, n }) => {
    const r = await review(row, prompt, schema, o.model);
    const clean = sanitise(r.lines);
    fs.writeFileSync(path.join(dir, `${row.sis_taxon_id}-${n}.jsonl`), clean.join("\n") + "\n");
    fs.writeFileSync(path.join(dir, `${row.sis_taxon_id}-${n}.md`), readable(clean, `${row.redlist_name} (SIS ${row.sis_taxon_id}), reviewer ${n} of ${o.votes}`,
      `agent-match-review run ${run}, commit ${commit}${dirty ? " (prompt uncommitted)" : ""}, prompt ${manifest.prompt_sha}. Web pages read with WebFetch come back as a model's summary of the page; curl output is the raw response.`));
    console.log(`  ${row.sis_taxon_id} #${n}: ${r.verdict ? `${r.verdict.verdict} ${r.verdict.col_id ?? ""} (${r.verdict.confidence})` : "no verdict"}`);
    return { sis: row.sis_taxon_id, n, verdict: r.verdict };
  });

  const base = o.upload ? await upload(dir, run) : null;
  const conn = await openDuckDB();
  const T = tables(BUILD_DIR);
  const out = [];
  for (const row of links) {
    const votes = done.filter((d) => d.sis === row.sis_taxon_id).sort((a, b) => a.n - b.n).map((d) => d.verdict);
    const k = votes.map(key);
    const agreed = k[0] !== null && k.every((x) => x === k[0]);
    const agreedId = agreed ? votes[0]!.col_id : null;
    const [t] = agreedId ? await query<Record<string, string>>(conn, `SELECT t.scientific_name AS name, t.authorship, t.status, s.scientific_name AS species
      FROM read_parquet('${T.taxa}') t LEFT JOIN read_parquet('${T.taxa}') s ON s.col_id = t.species_id WHERE t.col_id = '${agreedId.replace(/'/g, "")}'`) : [];
    // A link has to name a record that leads to a CoL species and isn't a misapplication.
    const decision = !agreed ? "no agreement"
      : votes[0]!.verdict === "not in CoL" ? "not in CoL"
      : !agreedId ? "matcher wrong, no record"
      : !t?.species || t.status === "misapplied" ? "no usable record"
      : "link";
    const colId = decision === "link" ? agreedId : null;
    const rec: Record<string, unknown> = {
      sis_taxon_id: row.sis_taxon_id, redlist_name: row.redlist_name, redlist_authority: row.redlist_authority, to_review: row.to_review,
      matcher_col_id: row.matcher_col_id, matcher_name: row.matcher_name, matcher_authorship: row.matcher_authorship, matcher_status: row.matcher_status,
      decision, col_id: colId ?? agreedId, col_name: t?.name, col_authorship: t?.authorship, col_status: t?.status, col_species: t?.species,
    };
    votes.forEach((v, i) => Object.assign(rec, {
      [`vote${i + 1}_verdict`]: v?.verdict ?? "no verdict", [`vote${i + 1}_col_id`]: v?.col_id, [`vote${i + 1}_confidence`]: v?.confidence,
      [`vote${i + 1}_reasoning`]: v?.reasoning, [`vote${i + 1}_sources`]: v?.sources?.join(" "),
      [`vote${i + 1}_trace`]: base ? `${base}/${row.sis_taxon_id}-${i + 1}.md` : path.relative(path.join(BUILD_DIR, ".."), path.join(dir, `${row.sis_taxon_id}-${i + 1}.md`)),
    }));
    Object.assign(rec, { model: o.model, claude_code: cli, prompt_sha: manifest.prompt_sha, commit, run_id: run,
      redlist_version: releases.redlist, col_version: releases.col, date: run.slice(0, 10), reviewed: "", reviewer_note: "" });
    out.push(rec);
  }

  // Merge: this run's rows replace earlier reviews of the same links.
  const kept = readTsv(TSV).filter((r) => !links.some((l) => String(l.sis_taxon_id) === r.sis_taxon_id));
  const all = [...kept, ...out.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? "" : String(v).replace(/[\t\n]/g, " ")])))];
  const cols = [...new Set(all.flatMap((r) => Object.keys(r)))];
  fs.writeFileSync(TSV, [cols.join("\t"), ...all.sort((a, b) => Number(a.sis_taxon_id) - Number(b.sis_taxon_id)).map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n");

  const tally = out.reduce<Record<string, number>>((m, r) => ({ ...m, [String(r.decision)]: (m[String(r.decision)] ?? 0) + 1 }), {});
  console.log(`\n${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}. Transcripts: ${base ?? dir}\nWrote ${path.relative(process.cwd(), TSV)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
