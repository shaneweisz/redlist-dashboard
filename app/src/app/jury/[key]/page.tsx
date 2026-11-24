/**
 * One AI jury run, read for one species: /jury/<transcript key>?sis=<SIS id>.
 *
 * The jury (scripts/sync/checks/judge.ts) asks about a batch of species per
 * call; this shows what the run answered for this species, the searches and
 * pages that were about it, and then the whole conversation. The transcript is
 * the call's stream-json log, from the jury's public B2 bucket (in development,
 * also the local cache).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { JURY_TRANSCRIPTS_URL, isTranscriptKey, readJuryRun, type JuryStep } from "@/lib/jury-transcript";

export const metadata: Metadata = {
  title: "AI jury run",
  description: "What one AI jury run searched, read and answered about a species' Catalogue of Life records.",
};

async function transcript(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${JURY_TRANSCRIPTS_URL}/judge/${key}.jsonl.gz`, { next: { revalidate: 60 * 60 * 24 * 30 } });
    if (res.ok) return zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
  } catch { /* fall through */ }
  if (process.env.NODE_ENV === "development") {
    const f = path.join(os.homedir(), ".cache", "redlist-dashboard", "judge-cache", "transcripts", `${key}.jsonl.gz`);
    if (fs.existsSync(f)) return zlib.gunzipSync(fs.readFileSync(f)).toString();
  }
  return null;
}

const muted = "text-zinc-500 dark:text-zinc-400";
const link = "underline decoration-dotted hover:decoration-solid break-all";

function Step({ s }: { s: JuryStep }) {
  const label = s.kind === "search" ? "Searched" : s.kind === "fetch" ? "Read" : s.kind === "tool" ? "Tool" : "Thought";
  return (
    <li className="py-1.5">
      <span className={`${muted} text-xs uppercase tracking-wide mr-2`}>{label}</span>
      {s.kind === "fetch" ? <a className={link} href={s.text} target="_blank" rel="noopener noreferrer">{s.text}</a>
        : s.kind === "text" ? <span className="whitespace-pre-wrap">{s.text}</span> : <span>{s.text}</span>}
      {s.result && (
        <details className="mt-1">
          <summary className={`${muted} text-xs cursor-pointer`}>What it got back</summary>
          <pre className="mt-1 p-2 text-xs whitespace-pre-wrap bg-zinc-50 dark:bg-zinc-800 rounded max-h-80 overflow-auto">{s.result}</pre>
        </details>
      )}
    </li>
  );
}

export default async function JuryRunPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ sis?: string }> }) {
  const { key } = await params;
  const { sis } = await searchParams;
  if (!isTranscriptKey(key)) notFound();
  const text = await transcript(key);
  if (!text) notFound();
  const sisId = sis ? Number(sis) : null;
  const first = readJuryRun(text, null);
  const answer = first.answers.find((a) => a.sis_taxon_id === sisId) ?? null;
  const run = readJuryRun(text, answer?.name ?? null);
  const mine = run.steps.filter((s) => s.mine && s.kind !== "text");

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 text-sm text-zinc-700 dark:text-zinc-300">
      <Link href="/" className={`text-xs ${muted} underline`}>← Back to the dashboard</Link>
      <h1 className="mt-6 text-xl font-semibold text-zinc-800 dark:text-zinc-100">
        AI jury run{answer?.name ? <> for <i>{answer.name}</i></> : null}
      </h1>
      <p className={`mt-1 ${muted}`}>
        One of the independent runs that checked how this Red List species matches the Catalogue of Life.
        The run asked about {run.answers.length} species at once{run.model ? `, using ${run.model}` : ""}.
      </p>

      {answer ? (
        <section className="mt-6">
          <h2 className="font-semibold text-zinc-800 dark:text-zinc-100">Its answer</h2>
          {answer.records === "can't tell" ? <p className="mt-1">Can&apos;t tell.</p> : (
            <ul className="mt-1 list-disc pl-5">
              {answer.records.length === 0 ? <li>None of the CoL records is this species.</li>
                : answer.records.map((r) => <li key={r.id}><i>{r.name ?? r.id}</i> <span className={muted}>({r.id})</span>: {r.relation}</li>)}
            </ul>
          )}
          <p className="mt-2">{answer.reason}</p>
          {answer.sources.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {answer.sources.map((u) => <li key={u}><a className={link} href={u} target="_blank" rel="noopener noreferrer">{u}</a></li>)}
            </ul>
          )}
        </section>
      ) : sisId ? <p className="mt-6">This run has no answer for SIS {sisId}.</p> : null}

      {answer && (
        <section className="mt-6">
          <h2 className="font-semibold text-zinc-800 dark:text-zinc-100">Its research on this species</h2>
          {mine.length ? <ul className="mt-1 divide-y divide-zinc-200 dark:divide-zinc-700">{mine.map((s, i) => <Step key={i} s={s} />)}</ul>
            : <p className={`mt-1 ${muted}`}>No search or page named it; see the whole run below.</p>}
        </section>
      )}

      <details className="mt-8">
        <summary className="font-semibold text-zinc-800 dark:text-zinc-100 cursor-pointer">The whole run ({run.steps.length} steps, all {run.answers.length} species)</summary>
        <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-700">{run.steps.map((s, i) => <Step key={i} s={s} />)}</ul>
      </details>
      <p className={`mt-8 text-xs ${muted}`}>
        Pages the run fetched are shown as it received them, from their own sites. Raw log:{" "}
        <a className={link} href={`${JURY_TRANSCRIPTS_URL}/judge/${key}.jsonl.gz`}>{key}.jsonl.gz</a>
      </p>
    </div>
  );
}
