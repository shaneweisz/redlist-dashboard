"use client";

/**
 * Searching what assessors wrote, across every current assessment.
 *
 * The half of issue #474 the nearby-species panel didn't answer: "search across
 * existing red list assessments for keywords … eg habitat type specific words".
 * A page of its own for now — where this belongs in the dashboard is a question
 * about the dashboard, and it can be answered once the thing works.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FaArrowLeft } from "react-icons/fa";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NARRATIVE_LABELS, type NarrativeField } from "@/lib/redlist/narrative-fields";

interface Hit {
  assessment_id: number;
  sis_taxon_id: number | null;
  scientific_name: string;
  field: NarrativeField | null;
  snippet: string | null;
}

interface Answer {
  hits: Hit[];
  total: number;
  terms: string[];
  ms: number;
}

const PAGE = 20;

export default function NarrativeSearchPage() {
  const [query, setQuery] = useState("");
  const [phrase, setPhrase] = useState(false);
  /** The query that produced what is on screen, so "loading" is a comparison. */
  const [asked, setAsked] = useState<{ q: string; phrase: boolean; page: number } | null>(null);
  const [answer, setAnswer] = useState<{ key: string; data?: Answer; error?: string } | null>(null);
  const [page, setPage] = useState(0);

  const key = asked ? `${asked.q}|${asked.phrase}|${asked.page}` : "";
  const loading = asked != null && answer?.key !== key;
  const data = answer?.key === key ? answer.data : undefined;
  const error = answer?.key === key ? answer.error : undefined;

  useEffect(() => {
    if (!asked) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: asked.q,
      limit: String(PAGE),
      offset: String(asked.page * PAGE),
    });
    if (asked.phrase) params.set("phrase", "true");
    fetch(`/api/narrative-search?${params}`, { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
        setAnswer({ key, data: body as Answer });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setAnswer({ key, error: e instanceof Error ? e.message : "Search failed" });
      });
    return () => controller.abort();
  }, [asked, key]);

  const search = useCallback(
    (nextPage: number) => {
      const q = query.trim();
      if (q.length < 2) return;
      setPage(nextPage);
      setAsked({ q, phrase, page: nextPage });
    },
    [query, phrase]
  );

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-900">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <FaArrowLeft className="h-3 w-3" />
          Dashboard
        </Link>
        <h1 className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
          Search assessment text
        </h1>
        <span className="ml-auto">
          <ThemeToggle />
        </span>
      </header>

      <div className="mx-auto max-w-4xl px-4 py-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search(0);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="limestone quarrying, slash-and-burn, guano, cave roost…"
            className="min-w-[16rem] flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={phrase}
              onChange={(e) => setPhrase(e.target.checked)}
              className="h-3.5 w-3.5 rounded"
            />
            As a phrase
          </label>
          <button
            type="submit"
            className="rounded-lg bg-zinc-800 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-900 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-white"
          >
            Search
          </button>
        </form>

        {/* What this searches, said before anyone is surprised by it. */}
        <p className="pt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Every word must appear somewhere in the assessment — rationale, range,
          population, habitat, threats, actions, use &amp; trade, trend or taxonomic
          notes. Current global assessments only; superseded ones are not indexed.
        </p>

        {error && <p className="pt-6 text-sm text-amber-600 dark:text-amber-400">{error}</p>}

        {loading && (
          <p className="flex items-center gap-2 pt-8 text-sm text-zinc-500 dark:text-zinc-400">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Reading the assessments…
          </p>
        )}

        {data && !loading && (
          <>
            <p className="pt-6 text-sm text-zinc-600 dark:text-zinc-300">
              <span className="font-medium text-zinc-800 dark:text-zinc-100">
                {data.total.toLocaleString()}
              </span>{" "}
              {data.total === 1 ? "assessment" : "assessments"} mention{data.total === 1 ? "s" : ""}{" "}
              {data.terms.map((t, i) => (
                <span key={t}>
                  {i > 0 && " and "}
                  <span className="rounded bg-yellow-100 px-1 dark:bg-yellow-900/50">{t}</span>
                </span>
              ))}
              <span className="pl-2 text-xs text-zinc-400">{data.ms} ms</span>
            </p>

            {/* What the number counts, when it isn't what the list shows. The
                index knows which assessments hold the words, not whether they
                sit together, so a phrase search narrows the page it was handed
                rather than the count behind it — and saying 553 above a list of
                one would otherwise read as a bug. */}
            {asked?.phrase && (
              <p className="pt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Of the {Math.min(PAGE, data.total).toLocaleString()} on this page,{" "}
                <span className="font-medium text-zinc-700 dark:text-zinc-200">
                  {data.hits.length}
                </span>{" "}
                {data.hits.length === 1 ? "has" : "have"} them together as typed. The count above is
                assessments holding all the words somewhere.
              </p>
            )}

            <ul className="divide-y divide-zinc-100 pt-2 dark:divide-zinc-800">
              {data.hits.map((hit) => (
                <li key={hit.assessment_id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm italic text-zinc-800 dark:text-zinc-100">
                      {hit.scientific_name}
                    </span>
                    {hit.field && (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        {NARRATIVE_LABELS[hit.field]}
                      </span>
                    )}
                    {hit.sis_taxon_id != null && (
                      <a
                        href={`https://www.iucnredlist.org/species/${hit.sis_taxon_id}/${hit.assessment_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Open the assessment ↗
                      </a>
                    )}
                  </div>
                  {hit.snippet && (
                    <p className="pt-1 text-sm leading-snug text-zinc-600 dark:text-zinc-300">
                      <Highlighted text={hit.snippet} terms={data.terms} />
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {data.total > PAGE && (
              <div className="flex items-center gap-3 pt-4 text-sm">
                <button
                  onClick={() => search(page - 1)}
                  disabled={page === 0}
                  className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-30 dark:border-zinc-600"
                >
                  Previous
                </button>
                <span className="text-zinc-500 dark:text-zinc-400">
                  {(page * PAGE + 1).toLocaleString()}–
                  {Math.min((page + 1) * PAGE, data.total).toLocaleString()} of{" "}
                  {data.total.toLocaleString()}
                </span>
                <button
                  onClick={() => search(page + 1)}
                  disabled={(page + 1) * PAGE >= data.total}
                  className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-30 dark:border-zinc-600"
                >
                  Next
                </button>
              </div>
            )}

            {data.total === 0 && (
              <p className="pt-6 text-sm text-zinc-500 dark:text-zinc-400">
                Nothing mentions all of those words. Try fewer of them.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The searched words, marked where they appear in the snippet. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi"
  );
  return (
    <>
      {text.split(pattern).map((part, i) =>
        terms.some((t) => t.toLowerCase() === part.toLowerCase()) ? (
          <mark key={i} className="rounded bg-yellow-100 px-0.5 dark:bg-yellow-900/50 dark:text-yellow-100">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
