"use client";

import { useState, useEffect } from "react";
import { ChartPager } from "@/components/redlist/chart-controls";

interface EolImage {
  url: string;
  thumb: string;
  title: string | null;
  rightsHolder: string | null;
  license: string | null;
  source: string | null;
}

interface EolCommonName {
  name: string;
  lang: string;
}

interface EolTraitGroup {
  predicate: string;
  definition: string | null;
  value: string;
  recordCount: number;
  source: string | null;
}

interface EolTraitsData {
  found: boolean;
  traits?: EolTraitGroup[];
  dataUrl?: string;
}

interface EolSummaryData {
  found: boolean;
  eolId?: number;
  pageUrl?: string;
  scientificName?: string;
  commonNames?: EolCommonName[];
  englishNameCount?: number;
  languageCount?: number;
  summary?: {
    html: string;
    title: string | null;
    source: string | null;
    license: string | null;
    rightsHolder: string | null;
  } | null;
  images?: EolImage[];
  providers?: string[];
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-zinc-500 dark:text-zinc-400">
      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      {label}
    </div>
  );
}

// Render a language code (EOL uses ISO 639-1, mostly) as a human label.
const langDisplay = (() => {
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    dn = null;
  }
  // EOL uses a few non-standard codes; normalize the common ones.
  const fix: Record<string, string> = { jp: "ja", iw: "he", in: "id" };
  return (code: string): string => {
    const c = fix[code] || code;
    try {
      return dn?.of(c) || code;
    } catch {
      return code;
    }
  };
})();

const NAMES_PER_PAGE = 18;

function CommonNamesList({ names, englishCount, languageCount }: { names: EolCommonName[]; englishCount: number; languageCount: number }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(names.length / NAMES_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * NAMES_PER_PAGE;
  const slice = names.slice(start, start + NAMES_PER_PAGE);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <div className="text-xs uppercase tracking-wider text-zinc-400">
          Common names ({names.length})
          {languageCount > 1 && <span className="normal-case tracking-normal"> · {languageCount} languages</span>}
        </div>
        {pageCount > 1 && (
          <ChartPager
            label={`${start + 1}–${Math.min(start + NAMES_PER_PAGE, names.length)} of ${names.length}`}
            canPrev={safePage > 0}
            canNext={safePage < pageCount - 1}
            onPrev={() => setPage(safePage - 1)}
            onNext={() => setPage(safePage + 1)}
          />
        )}
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
        {slice.map((n, i) => (
          <li key={start + i} className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-zinc-700 dark:text-zinc-300 truncate">{n.name}</span>
            <span className="text-[10px] uppercase tracking-wide text-zinc-400 flex-shrink-0" title={langDisplay(n.lang)}>{n.lang === "en" ? "EN" : langDisplay(n.lang)}</span>
          </li>
        ))}
      </ul>
      {englishCount === 0 && (
        <div className="text-[11px] text-zinc-400 mt-1">No English common name recorded; names shown are from other languages.</div>
      )}
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function TraitsTable({ traits, dataUrl }: { traits: EolTraitGroup[]; dataUrl: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-zinc-400 mb-1.5">Traits ({traits.length})</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-zinc-400">
              <th className="text-left font-medium pb-1 pr-3">Trait</th>
              <th className="text-left font-medium pb-1 pr-3">Value</th>
              <th className="text-right font-medium pb-1">Source</th>
            </tr>
          </thead>
          <tbody>
            {traits.map((t, i) => {
              const tooltip = [t.definition, t.recordCount > 1 ? `${t.recordCount} records` : null].filter(Boolean).join(" — ");
              return (
                <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1 pr-3 align-top whitespace-nowrap">
                    <span className="text-zinc-600 dark:text-zinc-300" title={tooltip || undefined}>
                      {capitalize(t.predicate)}
                    </span>
                  </td>
                  <td className="py-1 pr-3 align-top text-zinc-700 dark:text-zinc-300">{t.value}</td>
                  <td className="py-1 align-top text-right">
                    {t.source && (
                      <a href={t.source} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400" title={`Source: ${t.source}`}>
                        ↗
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <a href={dataUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1.5 inline-block">
        View full trait data on EOL ↗
      </a>
    </div>
  );
}

export default function EolSummary({ scientificName }: { scientificName: string }) {
  const [data, setData] = useState<EolSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [traitsData, setTraitsData] = useState<EolTraitsData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setTraitsData(null);
    (async () => {
      try {
        const res = await fetch(`/api/eol?name=${encodeURIComponent(scientificName)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        if (!cancelled) setData(result);
        if (!cancelled && result.found && result.eolId) {
          fetch(`/api/eol/traits?pageId=${result.eolId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((t) => {
              if (!cancelled && t) setTraitsData(t);
            })
            .catch(() => {});
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scientificName]);

  if (loading) return <Spinner label="Loading Encyclopedia of Life data..." />;
  if (error) return <div className="p-6 text-sm text-red-500 dark:text-red-400">Failed to load EOL data: {error}</div>;
  if (!data || !data.found) {
    return (
      <div className="p-6 text-sm text-zinc-500 dark:text-zinc-400">
        No Encyclopedia of Life page found for <span className="italic">{scientificName}</span>.
      </div>
    );
  }

  const { pageUrl, commonNames = [], englishNameCount = 0, languageCount = 0, summary, images = [], providers = [] } = data;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C7 2 3 6 3 11c0 5 4 9 9 9 1 0 2-.2 2-.2-.5-2-1.3-3.6-2.4-5C10 12.5 8 11.5 6 11c2.3-.2 4.3.4 6 1.6 1.2-2.3 3.2-4 5.8-5C16.7 4.5 14.5 2 12 2z" />
        </svg>
        {pageUrl ? (
          <a href={pageUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline">
            {data.scientificName} — Encyclopedia of Life ↗
          </a>
        ) : (
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{data.scientificName}</span>
        )}
      </div>

      {/* Traits (TraitBank) — surfaced above common names since this is the
          data an assessor is most likely to be looking for. */}
      {traitsData?.found && traitsData.traits && traitsData.dataUrl && (
        <TraitsTable traits={traitsData.traits} dataUrl={traitsData.dataUrl} />
      )}

      {/* Common names — paginated, English first, with language labels */}
      {commonNames.length > 0 && (
        <CommonNamesList names={commonNames} englishCount={englishNameCount} languageCount={languageCount} />
      )}

      {/* Image gallery */}
      {images.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-400 mb-1.5">Images ({images.length})</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {images.map((img, i) => (
              <a key={i} href={pageUrl ?? img.url} target="_blank" rel="noopener noreferrer" className="group block" title={img.title ?? undefined}>
                <img src={img.thumb} alt={img.title ?? data.scientificName ?? "EOL image"} loading="lazy" className="w-full h-28 object-cover rounded border border-zinc-200 dark:border-zinc-700" />
                <div className="text-[10px] text-zinc-400 mt-0.5 truncate">
                  {img.rightsHolder ?? "Unknown"}{img.license ? ` · ${img.license}` : ""}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Brief summary */}
      {summary && (
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-400 mb-1">{summary.title || "Summary"}</div>
          <div
            className="eol-content text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 [&_p]:mb-2 [&_a]:text-blue-600 dark:[&_a]:text-blue-400 [&_a:hover]:underline [&_i]:italic [&_b]:font-semibold [&_img]:hidden"
            dangerouslySetInnerHTML={{ __html: summary.html }}
          />
          {(summary.source || summary.rightsHolder || summary.license) && (
            <div className="text-[10px] text-zinc-400 mt-1">
              {[summary.rightsHolder, summary.source, summary.license].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
      )}

      {/* Data providers */}
      {providers.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-400 mb-1">Data providers ({providers.length})</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">{providers.join(" · ")}</div>
        </div>
      )}

      <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
        Data from the <a href={pageUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">Encyclopedia of Life</a>. Image rights belong to their respective holders.
      </p>
    </div>
  );
}
