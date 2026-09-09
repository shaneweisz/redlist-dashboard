"use client";

/**
 * Searching what the assessors wrote, across every current assessment.
 *
 * The half of issue #474 the nearby-species panel didn't answer: "search across
 * existing red list assessments for keywords … eg habitat type specific words".
 * A threat with no IUCN code, a habitat named the way a field biologist names
 * it, a place — none of those are columns, and all of them are in the prose.
 *
 * A view of its own, reached from the home page's View selector, rather than a
 * card among the filters: it answers a different question from the dashboard's
 * (who mentions this, across everything) and it answers it in sentences, which
 * want the width and the room to be read.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FaArrowLeft, FaChevronDown, FaChevronRight } from "react-icons/fa";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CitationProse } from "@/components/redlist/CitationProse";
import { SpeciesThumbnail } from "@/components/redlist/SpeciesThumbnail";
import { NARRATIVE_LABELS, type NarrativeField } from "@/lib/redlist/narrative-fields";
import { loadAssessment } from "@/lib/redlist/assessment";
import type { AssessmentReference } from "@/lib/mapping/nearby-citations";
import { CATEGORY_COLORS, normalizeCategory } from "@/config/taxa";

interface Hit {
  assessment_id: number;
  sis_taxon_id: number | null;
  scientific_name: string;
  common_name: string | null;
  category: string | null;
  taxon_group: string | null;
  field: NarrativeField | null;
  snippet: string | null;
}

interface WordSwap {
  from: string;
  to: string[];
}

interface Answer {
  hits: Hit[];
  total: number;
  terms: string[];
  prefixes: string[];
  expanded: WordSwap[];
  suggestions: WordSwap[];
  ignored: string[];
  ms: number;
}

interface Narrative {
  assessment_id: number;
  scientific_name: string;
  fields: { field: NarrativeField; text: string }[];
}

const PAGE = 10;

export default function NarrativeSearchPage() {
  const [query, setQuery] = useState("");
  const [fuzzy, setFuzzy] = useState(false);
  /** The query that produced what is on screen, so "loading" is a comparison. */
  const [asked, setAsked] = useState<{ q: string; fuzzy: boolean; page: number } | null>(null);
  const [answer, setAnswer] = useState<{ key: string; data?: Answer; error?: string } | null>(null);
  /** Which results are open, and the full text once it has been fetched. */
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [full, setFull] = useState<Map<number, Narrative | "loading" | "error">>(new Map());
  /**
   * The bibliography each expanded assessment's citations point into.
   *
   * A second request, and deliberately: the text comes from the parquet the
   * search actually matched, so what a reader expands is exactly what was
   * indexed — while the references live on the assessment itself, behind the
   * one loader the rest of the app uses. Missing references are not an error;
   * the prose renders either way.
   */
  const [refs, setRefs] = useState<Map<number, AssessmentReference[]>>(new Map());

  const key = asked ? `${asked.q}|${asked.fuzzy}|${asked.page}` : "";
  const loading = asked != null && answer?.key !== key;
  const data = answer?.key === key ? answer.data : undefined;
  const error = answer?.key === key ? answer.error : undefined;
  const page = asked?.page ?? 0;
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!asked) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: asked.q,
      limit: String(PAGE),
      offset: String(asked.page * PAGE),
    });
    if (asked.fuzzy) params.set("fuzzy", "true");
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
    (q: string, nextPage: number, useFuzzy = fuzzy) => {
      const trimmed = q.trim();
      if (trimmed.length < 2) return;
      setOpen(new Set());
      setAsked({ q: trimmed, fuzzy: useFuzzy, page: nextPage });
      if (nextPage !== page) top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [fuzzy, page]
  );

  /**
   * Open a result, fetching the rest of its narratives the first time.
   *
   * Their own request, not part of the search: a page of ten results is ten
   * assessments' complete prose, and most of it nobody opens.
   */
  const toggle = useCallback((id: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setFull((prev) => {
      if (prev.has(id)) return prev;
      const next = new Map(prev).set(id, "loading" as const);
      fetch(`/api/narrative-search/${id}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const body = (await r.json()) as Narrative;
          setFull((m) => new Map(m).set(id, body));
        })
        .catch(() => setFull((m) => new Map(m).set(id, "error" as const)));
      loadAssessment(id)
        .then(({ assessment }) => setRefs((m) => new Map(m).set(id, assessment?.references ?? [])))
        .catch(() => setRefs((m) => new Map(m).set(id, [])));
      return next;
    });
  }, []);

  const swap = (q: string, word: string, into: string) =>
    q.replace(new RegExp(`(^|\\s)-?${word}(\\*?)(\\s|$)`, "i"), `$1${into}$3`);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="flex items-center gap-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
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

      <div ref={top} className="mx-auto max-w-4xl px-4 py-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search(query, 0);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='limestone quarrying, "cave roost", guano OR dung, quarr*'
            aria-label="Search assessment text"
            autoFocus
            className="min-w-[18rem] flex-1 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 text-sm"
          />
          <label
            className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer select-none"
            title="Also match words a letter away from the ones typed — including the assessors' own typos"
          >
            <input
              type="checkbox"
              checked={fuzzy}
              onChange={(e) => {
                setFuzzy(e.target.checked);
                if (asked) search(asked.q, 0, e.target.checked);
              }}
              className="h-3.5 w-3.5 rounded accent-red-600"
            />
            Include close/similar spellings
          </label>
          <button
            type="submit"
            className="px-3 py-2 rounded-lg text-sm font-medium bg-zinc-800 text-white hover:bg-zinc-900 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-white transition-colors"
          >
            Search
          </button>
        </form>

        <SyntaxHelp onExample={(q) => { setQuery(q); search(q, 0); }} />

        {error && <p className="mt-6 text-sm text-amber-600 dark:text-amber-400">{error}</p>}

        {loading && (
          <p className="mt-8 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Reading the assessments…
          </p>
        )}

        {data && !loading && (
          <>
            <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-300">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {data.total.toLocaleString()}
              </span>{" "}
              {data.total === 1 ? "assessment" : "assessments"}, most relevant first
              <span className="pl-2 text-xs text-zinc-400 dark:text-zinc-500">{data.ms} ms</span>
            </p>

            {/* Everything the search did that the reader did not type. A result
                nobody can account for reads as a bug, and the fix is to say so
                rather than to stop doing it. */}
            {data.expanded.length > 0 && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Close spellings included:{" "}
                {data.expanded.map((e, i) => (
                  <span key={e.from}>
                    {i > 0 && "; "}
                    <span className="font-medium">{e.from}</span> → {e.to.join(", ")}
                  </span>
                ))}
              </p>
            )}
            {data.suggestions.map((s) => (
              <p key={s.from} className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="font-medium">{s.from}</span> is rare here. Did you mean{" "}
                {s.to.slice(0, 3).map((word, i) => (
                  <span key={word}>
                    {i > 0 && ", "}
                    <button
                      type="button"
                      onClick={() => {
                        const next = swap(asked?.q ?? "", s.from, word);
                        setQuery(next);
                        search(next, 0);
                      }}
                      className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      {word}
                    </button>
                  </span>
                ))}
                ?
              </p>
            ))}
            {data.ignored.length > 0 && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Not searched for: {data.ignored.join(", ")} — too common to narrow anything.
              </p>
            )}

            {data.total === 0 ? (
              <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
                Nothing matched. Try fewer words, drop the quotes, or tick “Include close/similar spellings”.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.hits.map((hit) => (
                  <li
                    key={hit.assessment_id}
                    className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
                  >
                    <button
                      type="button"
                      onClick={() => toggle(hit.assessment_id)}
                      aria-expanded={open.has(hit.assessment_id)}
                      // Without this the button's name is the whole snippet,
                      // which is a paragraph to read out before you learn what
                      // pressing it does.
                      aria-label={`${open.has(hit.assessment_id) ? "Collapse" : "Expand"} ${hit.scientific_name}`}
                      className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                    >
                      <span className="flex flex-wrap items-center gap-x-2">
                        {open.has(hit.assessment_id) ? (
                          <FaChevronDown className="h-2.5 w-2.5 text-zinc-400" />
                        ) : (
                          <FaChevronRight className="h-2.5 w-2.5 text-zinc-400" />
                        )}
                        <SpeciesThumbnail
                          name={hit.scientific_name}
                          taxonGroup={hit.taxon_group ?? ""}
                        />
                        <span className="text-sm italic text-zinc-900 dark:text-zinc-100">
                          {hit.scientific_name}
                        </span>
                        {hit.common_name && (
                          <span className="text-sm text-zinc-500 dark:text-zinc-400">
                            ({hit.common_name})
                          </span>
                        )}
                        {hit.category && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                            style={{ backgroundColor: CATEGORY_COLORS[normalizeCategory(hit.category)] }}
                          >
                            {hit.category}
                          </span>
                        )}
                        {hit.field && (
                          <span className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            {NARRATIVE_LABELS[hit.field]}
                          </span>
                        )}
                      </span>
                      {hit.snippet && (
                        <span className="mt-1 block text-sm leading-snug text-zinc-600 dark:text-zinc-300">
                          <Marked text={hit.snippet} terms={data.terms} prefixes={data.prefixes} />
                        </span>
                      )}
                    </button>

                    {open.has(hit.assessment_id) && (
                      <FullNarrative
                        state={full.get(hit.assessment_id)}
                        references={refs.get(hit.assessment_id) ?? []}
                        hit={hit}
                        terms={data.terms}
                        prefixes={data.prefixes}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}

            {data.total > PAGE && (
              <div className="mt-4 flex items-center gap-3 text-sm">
                <button
                  type="button"
                  onClick={() => search(asked?.q ?? "", page - 1)}
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
                  onClick={() => search(asked?.q ?? "", page + 1)}
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
    </div>
  );
}

/** The rest of the assessment, once a reader asks for it. */
function FullNarrative({
  state,
  references,
  hit,
  terms,
  prefixes,
}: {
  state: Narrative | "loading" | "error" | undefined;
  references: AssessmentReference[];
  hit: Hit;
  terms: string[];
  prefixes: string[];
}) {
  if (state === undefined || state === "loading") {
    return (
      <p className="px-3 pb-3 flex items-center gap-2 text-xs text-zinc-400">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Fetching the assessment…
      </p>
    );
  }
  if (state === "error") {
    return <p className="px-3 pb-3 text-xs text-amber-600 dark:text-amber-400">Could not load it.</p>;
  }
  // The section the search was answered in first: it is the one the reader
  // clicked to read, and the others are context they may not want.
  const ordered = [...state.fields].sort(
    (a, b) => Number(b.field === hit.field) - Number(a.field === hit.field)
  );
  return (
    <div className="border-t border-zinc-100 dark:border-zinc-800 px-3 py-3">
      <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-3">
        {ordered.map(({ field, text }) => (
          <div key={field}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {NARRATIVE_LABELS[field]}
              {field === hit.field && (
                <span className="ml-1.5 font-normal normal-case tracking-normal text-zinc-400 dark:text-zinc-500">
                  — where this matched
                </span>
              )}
            </h3>
            {/* The searched words marked, and the citations openable — the
                same reference tooltips the nearby-species panel shows, since
                "(Oldfield 1997)" is exactly as unresolvable here. */}
            <div className="mt-0.5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              <CitationProse
                text={text}
                references={references}
                renderText={(part) => <Marked text={part} terms={terms} prefixes={prefixes} />}
              />
            </div>
          </div>
        ))}
      </div>
      {hit.sis_taxon_id != null && (
        <a
          href={`https://www.iucnredlist.org/species/${hit.sis_taxon_id}/${hit.assessment_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          Open the assessment on iucnredlist.org ↗
        </a>
      )}
    </div>
  );
}

/** What the search looked for, marked where it appears. */
function Marked({
  text,
  terms,
  prefixes,
}: {
  text: string;
  terms: string[];
  prefixes: string[];
}) {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = "a-z0-9À-ɏ-";
  const alts = [...terms.map(esc), ...prefixes.map((p) => `${esc(p)}[${word}]*`)];
  if (alts.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(?<![${word}])(${alts.join("|")})(?![${word}])`, "gi");
  // One capture group, so split alternates plain, matched, plain, …
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 === 1 ? (
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

/** What can be typed into the box, with each convention one click away. */
function SyntaxHelp({ onExample }: { onExample: (q: string) => void }) {
  const examples: [string, string][] = [
    ["limestone quarrying", "both words, anywhere in the assessment"],
    ['"cave roost"', "those words together, in that order"],
    ["guano OR dung", "either word"],
    ["caves -bats", "caves, but not where bats are discussed"],
    ["quarr*", "quarry, quarries, quarrying, quarried"],
  ];
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        {examples.map(([q, what]) => (
          <button
            key={q}
            type="button"
            onClick={() => onExample(q)}
            title={what}
            className="rounded border border-zinc-200 dark:border-zinc-700 px-1.5 py-0.5 font-mono hover:bg-white dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            {q}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        Searches the rationale, range, population, habitat, threats, actions, use &amp; trade,
        trend and taxonomic notes of every current global assessment. Superseded assessments are
        not indexed. Click a result to read the whole section.
      </p>
    </div>
  );
}
