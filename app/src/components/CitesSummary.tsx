"use client";

import { useState, useEffect, useMemo, type ReactNode } from "react";
import CitesTradeSummary from "./CitesTradeSummary";
import { ChartPager } from "@/components/redlist/chart-controls";
import type { CountryAnnotation } from "./TradeFlowMap";

interface CitesListing {
  appendix: string;
  effectiveAt: string;
  annotation: string | null;
}

interface CitesReservation {
  appendix: string;
  effectiveAt: string;
  annotation: string | null;
  country: string | null;
  countryCode: string | null;
}

interface CitesSuspension {
  country: string;
  countryCode: string;
  notes: string | null;
  startDate: string;
  appliesTo: "import" | "export";
  notification: { name: string; url: string | null } | null;
}

interface CitesQuota {
  country: string;
  countryCode: string;
  quota: number;
  unit: string | null;
  notes: string | null;
  publicationDate: string;
}

interface CitesCountry {
  name: string;
  code: string;
}

interface CitesData {
  found: boolean;
  scientificName: string;
  authorYear?: string | null;
  rank?: string;
  citesListing?: string | null;
  citesId?: number;
  englishName?: string | null;
  taxonomy?: {
    kingdom?: string;
    phylum?: string;
    class?: string;
    order?: string;
    family?: string;
  };
  currentListings?: CitesListing[];
  reservations?: CitesReservation[];
  suspensions?: CitesSuspension[];
  quotas?: CitesQuota[];
  nativeCountries?: CitesCountry[];
  extinctCountries?: CitesCountry[];
  cached?: boolean;
  error?: string;
}

const APPENDIX_COLORS: Record<string, string> = {
  I: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  II: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  III: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
};

function AppendixBadge({ appendix }: { appendix: string }) {
  return (
    <span
      className={`inline-flex items-center shrink-0 whitespace-nowrap px-2 py-0.5 rounded text-xs font-semibold ${APPENDIX_COLORS[appendix] || "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"}`}
    >
      Appendix {appendix}
    </span>
  );
}

const fmtCitesDate = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** Compact section header with an optional count. */
function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5">
      <h4 className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
        {title}
      </h4>
      {count != null && (
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums">
          {count}
        </span>
      )}
    </div>
  );
}

const PAGE_SIZE = 5;

/**
 * Renders a fixed-size page (5) of a list with Prev/Next controls instead of an
 * expand-all toggle. `children` receives the current page's slice.
 */
function PagedList<T>({
  items,
  children,
}: {
  items: T[];
  children: (slice: T[]) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <>
      {children(slice)}
      {totalPages > 1 && (
        <div className="flex items-center justify-center mt-1">
          <ChartPager
            label={`${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, items.length)} of ${items.length}`}
            canPrev={safePage > 0}
            canNext={safePage < totalPages - 1}
            onPrev={() => setPage(Math.max(0, safePage - 1))}
            onNext={() => setPage(Math.min(totalPages - 1, safePage + 1))}
          />
        </div>
      )}
    </>
  );
}

export default function CitesSummary({
  scientificName,
}: {
  scientificName: string;
}) {
  const [data, setData] = useState<CitesData | null>(null);
  const [tradeData, setTradeData] = useState<Record<string, unknown> | null>(null);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchCitesData() {
      setLoading(true);
      setTradeData(null);
      setError(null);

      try {
        const res = await fetch(
          `/api/cites?name=${encodeURIComponent(scientificName)}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        if (cancelled) return;
        setData(result);
        setLoading(false);

        // Start trade data fetch immediately (eliminates waterfall)
        if (result.found && result.citesId) {
          setTradeLoading(true);
          try {
            const tradeRes = await fetch(`/api/cites/trade?taxon_id=${result.citesId}`);
            if (tradeRes.ok && !cancelled) {
              setTradeData(await tradeRes.json());
            }
          } catch {
            // Trade data is optional — fail silently
          } finally {
            if (!cancelled) setTradeLoading(false);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setLoading(false);
        }
      }
    }

    fetchCitesData();

    return () => {
      cancelled = true;
    };
  }, [scientificName]);

  // Country codes with active trade suspensions — passed to TradeFlowMap for overlay
  // Must be before early returns to satisfy Rules of Hooks
  const suspensionCountryCodes = useMemo(
    () => new Set((data?.suspensions || []).map((s) => s.countryCode)),
    [data?.suspensions]
  );

  // Per-country annotations (suspensions + quotas) for map hover tooltips
  const countryAnnotations = useMemo(() => {
    const map: Record<string, CountryAnnotation> = {};
    for (const s of data?.suspensions || []) {
      if (!map[s.countryCode]) map[s.countryCode] = {};
      if (!map[s.countryCode].suspensions) map[s.countryCode].suspensions = [];
      map[s.countryCode].suspensions!.push({ type: s.appliesTo, startDate: s.startDate });
    }
    for (const q of data?.quotas || []) {
      if (!map[q.countryCode]) map[q.countryCode] = {};
      if (!map[q.countryCode].quotas) map[q.countryCode].quotas = [];
      map[q.countryCode].quotas!.push({ quota: q.quota, unit: q.unit });
    }
    return map;
  }, [data?.suspensions, data?.quotas]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-zinc-500 dark:text-zinc-400">
        <svg
          className="animate-spin h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Loading CITES data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-sm text-red-500 dark:text-red-400">
        Failed to load CITES data: {error}
      </div>
    );
  }

  if (!data || !data.found) {
    return (
      <div className="p-6 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="italic">{scientificName}</span> is not listed in the
        CITES database.
      </div>
    );
  }

  // Suspensions newest-first; quotas largest-first.
  const sortedSuspensions = [...(data.suspensions || [])].sort(
    (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
  );
  const sortedQuotas = [...(data.quotas || [])].sort(
    (a, b) => (b.quota ?? -Infinity) - (a.quota ?? -Infinity)
  );

  // Group reservations that share an appendix + annotation, so the (often
  // identical) annotation text isn't repeated per country.
  const reservationGroups: {
    appendix: string;
    annotation: string | null;
    parties: { name: string; effectiveAt: string }[];
  }[] = [];
  for (const r of data.reservations || []) {
    const key = `${r.appendix}|${r.annotation ?? ""}`;
    let group = reservationGroups.find(
      (g) => `${g.appendix}|${g.annotation ?? ""}` === key
    );
    if (!group) {
      group = { appendix: r.appendix, annotation: r.annotation, parties: [] };
      reservationGroups.push(group);
    }
    group.parties.push({
      name: r.country || r.countryCode || "Unknown party",
      effectiveAt: r.effectiveAt,
    });
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Listing summary + external links */}
      <div className="flex flex-wrap items-center gap-3">
        {data.citesListing ? (
          <div className="flex items-center gap-2">
            {data.citesListing.split("/").map((app) => (
              <AppendixBadge key={app} appendix={app.trim()} />
            ))}
          </div>
        ) : (
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            No current CITES listing
          </span>
        )}
        <div className="flex items-center gap-3 ml-auto">
          <a
            href={`https://trade.cites.org/en/cites_trade/download?filters%5Btaxon_concepts_ids%5D%5B%5D=${data.citesId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            View on CITES Trade Database
          </a>
          <span className="text-zinc-300 dark:text-zinc-600">|</span>
          <a
            href={`https://www.speciesplus.net/species#/taxon_concepts/${data.citesId}/legal`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            View on Species+
          </a>
        </div>
      </div>

      {/* Trade overview from CITES Trade Database */}
      {data.citesId && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
            International Trade
          </h4>
          <CitesTradeSummary citesId={data.citesId} prefetchedData={tradeData} prefetchedLoading={tradeLoading} suspensionCountries={suspensionCountryCodes} countryAnnotations={countryAnnotations} />
        </div>
      )}

      {/* Current Listings */}
      {data.currentListings && data.currentListings.length > 0 && (
        <div>
          <SectionHeader title="Current Listings" count={data.currentListings.length} />
          <PagedList items={data.currentListings}>
            {(slice) => (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
                {slice.map((listing, i) => (
                  <div key={i} className="px-3 py-2">
                    <div className="flex items-center gap-2 text-xs">
                      <AppendixBadge appendix={listing.appendix} />
                      <span className="text-zinc-400 dark:text-zinc-500 ml-auto whitespace-nowrap">
                        since {fmtCitesDate(listing.effectiveAt)}
                      </span>
                    </div>
                    {listing.annotation && (
                      <p
                        title={listing.annotation}
                        className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug line-clamp-3"
                      >
                        {listing.annotation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </PagedList>
        </div>
      )}

      {/* Reservations */}
      {reservationGroups.length > 0 && (
        <div>
          <SectionHeader title="Reservations" count={data.reservations?.length} />
          <PagedList items={reservationGroups}>
            {(slice) => (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
                {slice.map((group, i) => (
                  <div key={i} className="px-3 py-2">
                    <AppendixBadge appendix={group.appendix} />
                    <div className="mt-1.5 space-y-0.5">
                      {group.parties.map((p, j) => (
                        <div key={j} className="flex items-baseline gap-2 text-xs">
                          <span className="text-zinc-700 dark:text-zinc-300">
                            {p.name}
                          </span>
                          <span className="text-zinc-400 dark:text-zinc-500 ml-auto shrink-0 whitespace-nowrap">
                            since {fmtCitesDate(p.effectiveAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                    {group.annotation && (
                      <p
                        title={group.annotation}
                        className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug line-clamp-3"
                      >
                        {group.annotation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </PagedList>
        </div>
      )}

      {/* Trade Quotas and Suspensions, side by side */}
      {(sortedQuotas.length > 0 || sortedSuspensions.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* Trade Quotas */}
          {sortedQuotas.length > 0 && (
            <div>
              <SectionHeader title="Trade Quotas" count={sortedQuotas.length} />
              <PagedList items={sortedQuotas}>
                {(slice) => (
                  <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
                    <table className="w-full text-[11px] table-fixed">
                      <tbody>
                        {slice.map((q, i) => (
                          <tr
                            key={i}
                            className="border-t first:border-t-0 border-zinc-100 dark:border-zinc-800"
                          >
                            <td
                              title={q.country}
                              className="px-3 py-1 text-zinc-700 dark:text-zinc-300 truncate w-[28%]"
                            >
                              {q.country}
                            </td>
                            <td className="px-3 py-1 text-right text-zinc-700 dark:text-zinc-300 tabular-nums whitespace-nowrap w-[16%]">
                              {q.quota != null ? q.quota.toLocaleString() : "—"}
                              {q.unit ? ` ${q.unit}` : ""}
                            </td>
                            <td
                              title={q.notes || undefined}
                              className="px-3 py-1 text-zinc-400 truncate"
                            >
                              {q.notes || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </PagedList>
            </div>
          )}

          {/* Trade Suspensions */}
          {sortedSuspensions.length > 0 && (
            <div>
              <SectionHeader title="Trade Suspensions" count={sortedSuspensions.length} />
              <PagedList items={sortedSuspensions}>
                {(slice) => (
                  <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
                    <table className="w-full text-[11px]">
                      <tbody>
                        {slice.map((s, i) => (
                          <tr
                            key={i}
                            className="border-t first:border-t-0 border-zinc-100 dark:border-zinc-800"
                          >
                            <td className="px-3 py-1 text-zinc-700 dark:text-zinc-300">
                              {s.country}
                            </td>
                            <td className="px-3 py-1 text-zinc-500 dark:text-zinc-400 capitalize whitespace-nowrap">
                              {s.appliesTo}
                            </td>
                            <td className="px-3 py-1 text-zinc-500 dark:text-zinc-400 whitespace-nowrap tabular-nums">
                              {new Date(s.startDate).toLocaleDateString("en-GB", {
                                year: "numeric",
                                month: "short",
                              })}
                            </td>
                            <td className="px-3 py-1 text-right hidden md:table-cell">
                              {s.notification?.url ? (
                                <a
                                  href={s.notification.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={s.notification.name}
                                  className="text-blue-600 dark:text-blue-400 hover:underline"
                                >
                                  {s.notification.name}
                                </a>
                              ) : (
                                <span className="text-zinc-400">{s.notification?.name || "—"}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </PagedList>
            </div>
          )}
        </div>
      )}

      {/* Footer attribution — required by Species+ Terms of Use */}
      <div className="text-xs sm:text-[10px] text-zinc-400 dark:text-zinc-500 pt-2 space-y-1">
        <p>
          UNEP ({new Date().getFullYear()}).{" "}
          <a
            href="https://www.speciesplus.net"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            The Species+ Website
          </a>
          . Nairobi, Kenya. Compiled by UNEP-WCMC, Cambridge, UK.
          Available at:{" "}
          <a
            href="https://www.speciesplus.net"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            www.speciesplus.net
          </a>
          . [Accessed{" "}
          {new Date().toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          })}
          ].
        </p>
        <p>
          Subject to Species+{" "}
          <a
            href="https://www.speciesplus.net/terms-of-use"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            Terms of Use
          </a>
          .
        </p>
      </div>
    </div>
  );
}
