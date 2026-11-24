/**
 * An AI jury run's transcript (the judge's stream-json conversation, see
 * scripts/sync/checks/judge-transcripts.ts), read for one species: what it
 * answered, the searches and pages that were about it, and every step of the
 * call, which asked about a batch of species at once.
 */

/** Where the transcripts are served: the jury's public Backblaze B2 bucket, judge/<key>.jsonl.gz. */
export const JURY_TRANSCRIPTS_URL = "https://f005.backblazeb2.com/file/dashboard-agent-transcripts";

export const isTranscriptKey = (k: string) => /^[0-9a-f]{64}$/.test(k);

export interface JuryAnswer {
  sis_taxon_id: number;
  name?: string;
  records: { id: string; name?: string; relation: string }[] | "can't tell";
  reason: string;
  sources: string[];
}

export interface JuryStep {
  kind: "text" | "search" | "fetch" | "tool";
  /** The words, the query, the URL, or the tool's name and input. */
  text: string;
  /** What the tool gave back, for a search or fetch, cut to `RESULT_CHARS`. */
  result?: string;
  /** Whether the step names the species (its genus or epithet). */
  mine: boolean;
}

export interface JuryRun {
  steps: JuryStep[];
  answers: JuryAnswer[];
  model: string | null;
  costUsd: number | null;
}

const RESULT_CHARS = 3000;

type Block = { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; input?: Record<string, unknown>; content?: unknown };

const asText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : (x as Block)?.text ?? "")).join("\n") : "";

/** The run, its steps marked by whether they are about `name` (words over three letters, as in the judge's summarise). */
export function readJuryRun(transcript: string, name: string | null): JuryRun {
  const words = (name ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const about = (s: string) => words.length > 0 && words.some((w) => s.toLowerCase().includes(w));
  const steps: JuryStep[] = [];
  const byTool = new Map<string, JuryStep>();
  const run: JuryRun = { steps, answers: [], model: null, costUsd: null };
  for (const line of transcript.split("\n")) {
    let d: { type?: string; model?: string; message?: { content?: Block[] }; structured_output?: { answers?: JuryAnswer[] }; total_cost_usd?: number };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "system" && d.model) run.model = d.model;
    if (d.type === "result") { run.answers = d.structured_output?.answers ?? []; run.costUsd = d.total_cost_usd ?? null; }
    for (const c of d.message?.content ?? []) {
      if (d.type === "assistant" && c.type === "text" && c.text?.trim()) steps.push({ kind: "text", text: c.text.trim(), mine: about(c.text) });
      if (d.type === "assistant" && c.type === "tool_use") {
        const q = String(c.input?.query ?? c.input?.url ?? "");
        const step: JuryStep = c.name === "WebSearch" ? { kind: "search", text: q, mine: about(q) }
          : c.name === "WebFetch" ? { kind: "fetch", text: q, mine: about(q) }
          : { kind: "tool", text: `${c.name} ${JSON.stringify(c.input ?? {})}`, mine: false };
        steps.push(step);
        if (c.id) byTool.set(c.id, step);
      }
      if (d.type === "user" && c.type === "tool_result" && c.tool_use_id) {
        const step = byTool.get(c.tool_use_id);
        if (step) { const t = asText(c.content); step.result = t.length > RESULT_CHARS ? `${t.slice(0, RESULT_CHARS)}…` : t; }
      }
    }
  }
  return run;
}
