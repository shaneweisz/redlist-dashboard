/**
 * agent-match-review: AI agents review Red List -> CoL name matches. Independent
 * Claude reviewers judge each match, and a verdict counts only when every
 * reviewer agrees. Two uses:
 *
 *   waiting (default)  the matches the sync left waiting: the record under review
 *                      is the matcher's answer, and an agreed verdict becomes a
 *                      proposed decision in seeds/agent-match-overrides.tsv
 *   --audit            the links the sync made: the record under review is the
 *                      one the species is linked to, and the verdicts go to
 *                      agent-match-review/audit.tsv, to measure how often each
 *                      kind of link (match_reason · col_treatment) is wrong
 *   --audit --covered  the extra CoL names whose records also count for a linked
 *                      species (covered rows that count records): the record under
 *                      review is that name, beside the species' main link
 *                      (linked_to); verdicts go to agent-match-review/audit-covered.tsv
 *
 *   npm run sync:agent-match-review -- --sis 194894,19620213     the links named
 *   npm run sync:agent-match-review -- --sample 10                N links, round-robin across strata
 *   npm run sync:agent-match-review -- --audit --per-stratum 20  N links from each stratum
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
 *   seeds/agent-match-overrides.tsv (waiting) or agent-match-review/audit.tsv
 *       (--audit)   one row per reviewed link, replacing an earlier review of
 *       it: the stratum, the record under review, the decision, the CoL record
 *       the reviewers chose, each reviewer's verdict, reasoning, sources and
 *       transcript, and blank reviewed / reviewer_note columns for a person
 *
 * Decisions:
 *   - Reviewers see the same evidence in both uses (the Red List side, where it
 *     lives, the record under review, the matcher's answer and alternatives) and
 *     none of the sync's own labels (to_review, match_reason, the description),
 *     so they are not nudged toward "wrong" for a waiting match or "right" for
 *     a made one.
 *   - Strata: waiting matches by to_review; links by match_reason ·
 *     col_treatment, the kinds under 500 links pooled as "rarer kinds".
 *     Within a stratum, links are drawn in a fixed pseudo-random order
 *     (hash of the SIS id), so a run can be repeated and extended.
 *   - Audit decisions: "confirmed" (all agree the linked record is right),
 *     "record right, CoL's lumping disputed" (they agree on the linked record
 *     but call the species CoL files it under another organism),
 *     "wrong, right record found", "wrong, no record", "wrong, not in CoL", or
 *     "no agreement".
 *   - A waiting decision ("link" or "not in CoL") needs every reviewer to give the same
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
const OVERRIDES_TSV = path.join(SEEDS_DIR, "agent-match-overrides.tsv");
const AUDIT_TSV = path.join(HERE, "audit.tsv");
const COVERED_TSV = path.join(HERE, "audit-covered.tsv");

type Verdict = { verdict: string; col_id: string | null; confidence: string; reasoning: string; sources: string[] };
type Row = Record<string, unknown> & { sis_taxon_id: number; stratum: string; under_review: { col_id: string; name: string; authorship: string | null } };

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
    audit: a.includes("--audit") || a.includes("--covered"),
    covered: a.includes("--covered"),
    perStratum: get("per-stratum") ? Number(get("per-stratum")) : undefined,
    dryRun: a.includes("--dry-run"),
  };
}

/** What a reviewer sees: the evidence, without the sync's own labels. */
const SHOWN = ["sis_taxon_id", "redlist_name", "redlist_authority", "common_name", "category", "taxon_group", "class", "order", "family", "countries", "systems",
  "redlist_synonyms", "under_review", "matcher_col_id", "matcher_name", "matcher_authorship", "matcher_status", "matcher_accepted_col_id", "matcher_accepted_name",
  "matcher_accepted_authorship", "matcher_lineage", "match_type", "confidence", "matcher_alternatives"];
const shown = (r: Row) => Object.fromEntries([...SHOWN, ...(r.linked_to ? ["linked_to"] : [])].map((k) => [k, r[k]]));

const SITUATION = {
  waiting: "The sync's rules could not decide this match on their own, so the species is waiting, linked to nothing; the record under review is the matcher's answer.",
  audit: "This is a check on a match the sync made: the record under review is the one the Red List species is linked to now. We are measuring how often such links are right, so judge it on the evidence alone.",
  covered: "This is a check on a match the sync made. The species is linked to `linked_to`; the record under review is a second CoL name whose GBIF records the sync also counts for it (CoL holding the same organism twice, or a name the Red List lists as its synonym). Judge whether that record is this same organism, so that its records are this species' records: \"same species\" or \"lumped\" if so, \"different species\" if not. We are measuring how often such extra names are right, so judge it on the evidence alone.",
};

async function selectRows(o: ReturnType<typeof opts>): Promise<Row[]> {
  const T = tables(BUILD_DIR);
  const conn = await openDuckDB();
  const review = o.audit
    ? `struct_pack(col_id := l.col_taxon_id, name := l.col_taxon_name, authorship := l.col_taxon_authorship, status := l.col_taxon_status,
         species_col_id := l.col_species_id, species_name := l.col_species_name, species_authorship := l.col_species_authorship)`
    : `struct_pack(col_id := l.matcher_col_id, name := l.matcher_name, authorship := l.matcher_authorship, status := lower(replace(l.matcher_status, '_', ' ')),
         species_col_id := coalesce(l.matcher_accepted_col_id, l.matcher_col_id), species_name := coalesce(l.matcher_accepted_name, l.matcher_name),
         species_authorship := coalesce(l.matcher_accepted_authorship, l.matcher_authorship))`;
  // Covered: each counting covered row, with its species' primary row for the Red List side and the matcher's evidence; one per species (the most records).
  const source = o.covered
    ? `(SELECT p.* REPLACE (c.col_taxon_id AS col_taxon_id, c.col_taxon_name AS col_taxon_name, c.col_taxon_authorship AS col_taxon_authorship,
          c.col_taxon_status AS col_taxon_status, c.col_species_id AS col_species_id, c.col_species_name AS col_species_name,
          c.col_species_authorship AS col_species_authorship, c.match_reason AS match_reason, c.col_treatment AS col_treatment, c.counts AS counts),
          struct_pack(col_id := p.col_taxon_id, name := p.col_taxon_name, authorship := p.col_taxon_authorship, species_name := p.col_species_name) AS linked_to
        FROM read_parquet('${T.reviewLinks}') c JOIN read_parquet('${T.reviewLinks}') p ON p.sis_taxon_id = c.sis_taxon_id AND p.role = 'primary'
        WHERE c.role = 'covered' AND c.records > 0
        QUALIFY row_number() OVER (PARTITION BY c.sis_taxon_id ORDER BY c.records DESC, c.col_taxon_id) = 1)`
    : `(SELECT *, NULL AS linked_to FROM read_parquet('${T.reviewLinks}'))`;
  const where = o.covered ? "TRUE" : o.audit ? `l.role = 'primary' AND l.col_species_id IS NOT NULL`
    : `l.role = 'primary' AND l.to_review IS NOT NULL AND l.matcher_col_id IS NOT NULL AND l.match_type NOT IN ('HIGHERRANK', 'NONE')`;
  const stratum = o.covered ? `l.match_reason` : o.audit
    ? `CASE WHEN count(*) OVER (PARTITION BY l.match_reason, l.col_treatment) >= 500 THEN l.match_reason || ' · ' || l.col_treatment ELSE 'rarer kinds' END`
    : `l.to_review`;
  const all = await query<Row>(conn, `
    WITH x AS (
      SELECT l.sis_taxon_id::BIGINT AS sis_taxon_id, l.redlist_name, l.redlist_authority, a.common_name, l.category, l.taxon_group, l.class, l."order", l.family,
             a.countries, a.systems, l.redlist_synonyms, ${review} AS under_review,
             l.matcher_col_id, l.matcher_name, l.matcher_authorship, l.matcher_status, l.matcher_accepted_col_id, l.matcher_accepted_name,
             l.matcher_accepted_authorship, l.matcher_lineage, l.match_type, l.confidence, l.matcher_alternatives,
             l.to_review, l.match_reason, l.col_treatment, l.counts, l.linked_to, ${stratum} AS stratum
      FROM ${source} l
      JOIN read_parquet('${T.assessments}') a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
      WHERE ${where})
    SELECT *, row_number() OVER (PARTITION BY stratum ORDER BY hash(sis_taxon_id)) AS k FROM x`);
  const tidy = (r: Row): Row => {
    const list = (v: unknown) => (v as { items?: unknown[] } | null)?.items ?? v ?? [];
    const struct = (v: unknown) => (v as { entries?: unknown } | null)?.entries ?? v;
    return { ...r, sis_taxon_id: Number(r.sis_taxon_id), k: Number(r.k), countries: list(r.countries), systems: list(r.systems), under_review: struct(r.under_review) as Row["under_review"],
      linked_to: r.linked_to ? struct(r.linked_to) : undefined,
      redlist_synonyms: r.redlist_synonyms ? JSON.parse(String(r.redlist_synonyms)) : [],
      matcher_alternatives: r.matcher_alternatives ? JSON.parse(String(r.matcher_alternatives)) : [] };
  };
  if (o.sis) return all.filter((r) => o.sis!.includes(Number(r.sis_taxon_id))).map(tidy);
  if (o.perStratum) return all.filter((r) => Number(r.k) <= o.perStratum!).map(tidy)
    .sort((x, y) => String(x.stratum).localeCompare(String(y.stratum)) || Number(x.k) - Number(y.k));
  // Round-robin across the strata: the first of each, then the second, ...
  return [...all].sort((x, y) => Number(x.k) - Number(y.k) || String(x.stratum).localeCompare(String(y.stratum))).slice(0, o.sample ?? 5).map(tidy);
}

/** One reviewer: a fresh claude -p, its stream-json transcript kept whole. */
function review(row: Row, prompt: string, schema: string, model: string, situation: string): Promise<{ lines: string[]; verdict: Verdict | null }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-match-review-"));
  const args = ["-p", prompt.replace("{{situation}}", situation).replace("{{row}}", JSON.stringify(shown(row), null, 1)), "--model", model,
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

  const mode = o.covered ? "covered" : o.audit ? "audit" : "waiting";
  const TSV = o.covered ? COVERED_TSV : o.audit ? AUDIT_TSV : OVERRIDES_TSV;
  const links = await selectRows(o);
  if (o.dryRun) {
    for (const l of links) console.log(`${l.sis_taxon_id}\t${l.stratum}\t${l.redlist_name} ${l.redlist_authority ?? ""} -> ${l.under_review.name} ${l.under_review.authorship ?? ""} [${l.under_review.col_id}]\t${JSON.stringify(l.countries)}`);
    console.log(`${links.length} links`);
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  const cli = execSync("claude --version").toString().trim();
  const manifest = { run, commit, prompt_changed_since_commit: dirty, prompt_sha: sha(prompt), schema_sha: sha(schema), claude_code: cli,
    mode, model: o.model, votes: o.votes, links: links.length, releases };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(dir, "rows.json"), JSON.stringify(links, null, 1));
  console.log(`agent-match-review ${run} (${mode}): ${links.length} links × ${o.votes} reviewers (${o.model}), prompt ${manifest.prompt_sha}${dirty ? " (uncommitted)" : ""}`);

  const jobs = links.flatMap((row) => Array.from({ length: o.votes }, (_, n) => ({ row, n: n + 1 })));
  const done = await pool(jobs, o.concurrency, async ({ row, n }) => {
    const r = await review(row, prompt, schema, o.model, SITUATION[mode]);
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
    const v0 = votes[0]?.verdict;
    const right = v0 === "same species" || v0 === "lumped";
    // A link has to name a record that leads to a CoL species and isn't a misapplication.
    const decision = o.audit
      ? (!agreed ? "no agreement"
        : right ? (agreedId === row.under_review.col_id ? "confirmed" : "no agreement")
        : v0 === "not in CoL" ? "wrong, not in CoL"
        : !agreedId ? "wrong, no record"
        // Its own name is right; they dispute the broader species CoL files it under.
        : agreedId === row.under_review.col_id ? "record right, CoL's lumping disputed"
        : "wrong, right record found")
      : (!agreed ? "no agreement"
        : v0 === "not in CoL" ? "not in CoL"
        : !agreedId ? "matcher wrong, no record"
        : !t?.species || t.status === "misapplied" ? "no usable record"
        : "link");
    const u = row.under_review as Record<string, unknown>;
    const rec: Record<string, unknown> = {
      sis_taxon_id: row.sis_taxon_id, redlist_name: row.redlist_name, redlist_authority: row.redlist_authority, category: row.category, taxon_group: row.taxon_group,
      stratum: row.stratum, match_reason: row.match_reason, col_treatment: row.col_treatment, counts: row.counts, to_review: row.to_review,
      reviewed_col_id: u.col_id, reviewed_name: u.name, reviewed_authorship: u.authorship, reviewed_status: u.status, reviewed_species: u.species_name,
      decision, col_id: agreedId, col_name: t?.name, col_authorship: t?.authorship, col_status: t?.status, col_species: t?.species,
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
