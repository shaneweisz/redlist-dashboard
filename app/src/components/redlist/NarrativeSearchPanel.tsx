"use client";

/**
 * Search what the assessors wrote (#474).
 *
 * The half of issue #474 the nearby-species panel didn't answer: "search across
 * existing red list assessments for keywords … eg habitat type specific words".
 * A threat with no IUCN code, a habitat named the way a field biologist names
 * it, a place — none of those are columns, and all of them are in the prose.
 *
 * It sits below the taxonomic-differences card, among the filters, but it is
 * NOT one of them: the index is keyed by word and assessment, and knows nothing
 * about the taxon or category chosen above. Searching every current global
 * assessment is the useful thing anyway — the question is "who mentions this",
 * and narrowing it to the group you had already picked would answer a smaller
 * one. The panel says so, where a reader will look for it.
 */
import { useCallback, useEffect, useState } from "react";
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

const PAGE = 10;

export function NarrativeSearchPanel() {
  const [query, setQuery] = useState("");
  const [phrase, setPhrase] = useState(false);
  /** The query that produced what is on screen, so "loading" is a comparison. */
  const [asked, setAsked] = useState<{ q: string; phrase: boolean; page: number } | null>(null);
  const [answer, setAnswer] = useState<{ key: string; data?: Answer; error?: string } | null>(null);

  const key = asked ? `${asked.q}|${asked.phrase}|${asked.page}` : "";
  const loading = asked != null && answer?.key !== key;
  const data = answer?.key === key ? answer.data : undefined;
  const error = answer?.key === key ? answer.error : undefined;
  const page = asked?.page ?? 0;

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
      setAsked({ q, phrase, page: nextPage });
    },
    [query, phrase]
  );

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-2 min-h-[24px]">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Search what the assessors wrote
        </span>
        {data && !loading && (
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">
            {data.ms.toLocaleString()} ms
          </span>
        )}
      </div>

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
          aria-label="Search assessment text"
          className="min-w-[14rem] flex-1 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 text-sm"
        />
        <label
          className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer select-none"
          title="Only assessments where these words appear together, in this order"
        >
          <input
            type="checkbox"
            checked={phrase}
            onChange={(e) => setPhrase(e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-red-600"
          />
          As a phrase
        </label>
        <button
          type="submit"
          className="px-3 py-2 rounded-lg text-sm font-medium bg-zinc-800 text-white hover:bg-zinc-900 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-white transition-colors"
        >
          Search
        </button>
      </form>

      {/* What this searches, said before anyone is surprised by it — including
          that it ignores the filters it is sitting underneath. */}
      <p className="mt-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        Every word must appear somewhere in the assessment — rationale, range, population,
        habitat, threats, actions, use &amp; trade, trend or taxonomic notes. Searches all current
        global assessments, not the taxon or filters selected above; superseded assessments are
        not indexed.
      </p>

      {error && <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">{error}</p>}

      {loading && (
        <p className="mt-4 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Reading the assessments…
        </p>
      )}

      {data && !loading && (
        <>
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              {data.total.toLocaleString()}
            </span>{" "}
            {data.total === 1 ? "assessment" : "assessments"}{" "}
            {asked?.phrase ? (
              <>
                say{data.total === 1 ? "s" : ""}{" "}
                <span className="rounded bg-yellow-100 dark:bg-yellow-900/50 px-1">
                  {asked.q}
                </span>
              </>
            ) : (
              <>
                mention{data.total === 1 ? "s" : ""}{" "}
                {data.terms.map((t, i) => (
                  <span key={t}>
                    {i > 0 && " and "}
                    <span className="rounded bg-yellow-100 dark:bg-yellow-900/50 px-1">{t}</span>
                  </span>
                ))}
              </>
            )}
          </p>

          {data.total === 0 ? (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              {asked?.phrase
                ? "Nothing says that, word for word. Try it without “As a phrase”."
                : "Nothing mentions all of those words. Try fewer of them."}
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800">
              {data.hits.map((hit) => (
                <li key={hit.assessment_id} className="py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm italic text-zinc-900 dark:text-zinc-100">
                      {hit.scientific_name}
                    </span>
                    {hit.field && (
                      <span className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        {NARRATIVE_LABELS[hit.field]}
                      </span>
                    )}
                    {hit.sis_taxon_id != null && (
                      <a
                        href={`https://www.iucnredlist.org/species/${hit.sis_taxon_id}/${hit.assessment_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        Open the assessment ↗
                      </a>
                    )}
                  </div>
                  {hit.snippet && (
                    <p className="mt-1 text-sm leading-snug text-zinc-600 dark:text-zinc-300">
                      <Highlighted text={hit.snippet} terms={data.terms} />
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {data.total > PAGE && (
            <div className="mt-2 flex items-center gap-3 text-sm">
              <button
                type="button"
                onClick={() => search(page - 1)}
                disabled={page === 0}
                className="px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 disabled:opacity-30 text-zinc-600 dark:text-zinc-300"
              >
                Previous
              </button>
              <span className="text-zinc-500 dark:text-zinc-400">
                {(page * PAGE + 1).toLocaleString()}–
                {Math.min((page + 1) * PAGE, data.total).toLocaleString()} of{" "}
                {data.total.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => search(page + 1)}
                disabled={(page + 1) * PAGE >= data.total}
                className="px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 disabled:opacity-30 text-zinc-600 dark:text-zinc-300"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
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
          <mark
            key={i}
            className="rounded bg-yellow-100 dark:bg-yellow-900/50 dark:text-yellow-100 px-0.5"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
