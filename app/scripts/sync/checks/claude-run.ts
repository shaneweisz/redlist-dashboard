/**
 * One headless Claude Code run (`claude -p`), as the rebuild check and the judge
 * use it: no settings, no MCP servers, only the tools named, in a folder of its
 * own. It logs in with CLAUDE_CODE_OAUTH_TOKEN (app/.env.local, from `claude
 * setup-token`), so HOME can point at the run's own folder.
 */

import { spawn } from "child_process";

export interface ClaudeRun {
  /** The prompt, as -p's argument. */
  prompt: string;
  /** Sent on stdin (the judge's facts). */
  stdin?: string;
  cwd: string;
  /** --tools: the only tools it has. */
  tools: string[];
  /** --allowedTools / --disallowedTools: what runs without asking, and what never runs. */
  allowed?: string[];
  disallowed?: string[];
  /** --json-schema: the final answer's shape. */
  schema?: object;
  outputFormat: "json" | "stream-json";
  /** HOME for the run: the folder itself, so nothing of the maintainer's leaks in. */
  home?: string;
  model?: string;
}

export interface ClaudeResult { code: number; stdout: string; stderr: string }

/** Runs `claude`; stubbed in tests. */
export type Runner = (r: ClaudeRun) => Promise<ClaudeResult>;

export function claudeArgs(r: ClaudeRun): string[] {
  return ["-p", r.prompt, "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
    "--tools", r.tools.join(","), ...(r.allowed?.length ? ["--allowedTools", ...r.allowed] : []),
    ...(r.disallowed?.length ? ["--disallowedTools", ...r.disallowed] : []),
    "--permission-mode", "dontAsk", "--output-format", r.outputFormat, ...(r.outputFormat === "stream-json" ? ["--verbose"] : []),
    ...(r.schema ? ["--json-schema", JSON.stringify(r.schema)] : []), ...(r.model ? ["--model", r.model] : [])];
}

export const runClaude: Runner = (r) => new Promise((resolve, reject) => {
  const env = { ...process.env, ...(r.home ? { HOME: r.home } : {}) };
  const p = spawn("claude", claudeArgs(r), { cwd: r.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", (d) => (stderr += d));
  p.on("error", reject);
  p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  p.stdin.end(r.stdin ?? "");
});

/** From a stream-json transcript: every file it read or wrote, and every command it ran. */
export function toolUse(transcript: string): { reads: string[]; writes: string[]; commands: string[] } {
  const out = { reads: [] as string[], writes: [] as string[], commands: [] as string[] };
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let d: { type?: string; message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant") continue;
    for (const c of d.message?.content ?? []) {
      if (c.type !== "tool_use") continue;
      const i = c.input ?? {};
      if (c.name === "Read") out.reads.push(String(i.file_path ?? ""));
      else if (c.name === "Write" || c.name === "Edit") out.writes.push(String(i.file_path ?? ""));
      else if (c.name === "Bash") out.commands.push(String(i.command ?? ""));
    }
  }
  return out;
}
