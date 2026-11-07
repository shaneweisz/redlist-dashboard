"use client";

import { useState, useEffect, useMemo } from "react";
import { countriesToRegions, regionColor, countryToRegion } from "@/lib/regions";
import { ALPHA2_TO_NAME } from "@/lib/countries";
import { CHART_SEGMENTED_CLASS, chartSegmentClass, chartControlClass, ChartPager } from "@/components/redlist/chart-controls";
import { candidateScopeToken } from "@/lib/candidate-scope";
import { CREDIT_ROLES, type CandidateRank, type CandidateTier, type CreditCandidate, type CreditRole } from "@/lib/credit-candidates";

interface CandidatesResponse {
  candidates: CreditCandidate[];
  ranks: CandidateRank[];
  defaultRank: CandidateRank;
  labels: Partial<Record<CandidateRank, string>>;
}

interface CandidatesTableProps {
  /** Which credit line to rank people by — drives the copy and the query. */
  role: CreditRole;
  /** Controlled by the parent so the choice persists across species. */
  onRoleChange: (role: CreditRole) => void;
  /** The Not-Evaluated species suggestions are being made for. */
  species: {
    taxonGroup: string;
    scientificName: string;
    className: string | null;
    orderName: string | null;
    family: string | null;
    countries: string[];
  };
}

type SortField = "inRegion" | "total";

const PAGE_SIZE = 10;

const COPY: Record<CreditRole, { label: string; noun: string; verb: string; past: string; none: string; failed: string }> = {
  assessors: { label: "Assessors", noun: "Assessor", verb: "Assessed", past: "assessed", none: "No assessor candidates found", failed: "Failed to load assessor candidates" },
  reviewers: { label: "Reviewers", noun: "Reviewer", verb: "Reviewed", past: "reviewed", none: "No reviewer candidates found", failed: "Failed to load reviewer candidates" },
  facilitators: { label: "Facilitators", noun: "Facilitator", verb: "Facilitated", past: "facilitated", none: "No facilitator candidates found", failed: "Failed to load facilitator candidates" },
};

const RANK_TITLE: Record<CandidateRank, string> = {
  group: "Whole taxon group", class: "Class", order: "Order", family: "Family", genus: "Genus",
};

export default function CandidatesTable({ role, onRoleChange, species }: CandidatesTableProps) {
  const [data, setData] = useState<CandidatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState<SortField>("inRegion");
  // Null until the response arrives, then the server's suggested granularity —
  // the finest one with enough people on it to be worth comparing.
  const [rank, setRank] = useState<CandidateRank | null>(null);

  const copy = COPY[role];
  const genus = species.scientificName.trim().split(/\s+/)[0] ?? "";
  const countriesKey = species.countries.join(";");
  const regions = useMemo(() => countriesToRegions(species.countries), [countriesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (species.countries.length === 0) {
      setData(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPage(0);
    setRank(null);

    const params = new URLSearchParams({
      taxonGroup: species.taxonGroup,
      scientificName: species.scientificName,
      countries: countriesKey,
    });
    if (species.className) params.set("class", species.className);
    if (species.orderName) params.set("order", species.orderName);
    if (species.family) params.set("family", species.family);

    params.set("role", role);
    fetch(`/api/redlist/credit-candidates?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<CandidatesResponse>;
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        setData(body);
        setRank(body.defaultRank);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Unknown error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, species.taxonGroup, species.scientificName, species.className, species.orderName, species.family, countriesKey]);

  const activeRank: CandidateRank = rank ?? data?.defaultRank ?? "group";
  const label = data?.labels[activeRank] ?? "";

  // Only people with species at this granularity, sorted by the chosen column.
  const sorted = useMemo(() => {
    if (!data) return [];
    return data.candidates
      .map((c) => ({ name: c.name, tier: c.tiers[activeRank] }))
      .filter((c): c is { name: string; tier: CandidateTier } => !!c.tier && c.tier.total > 0)
      .sort((a, b) => {
        const diff = b.tier[sortBy] - a.tier[sortBy];
        if (diff !== 0) return diff;
        return b.tier.latestDate.localeCompare(a.tier.latestDate);
      });
  }, [data, activeRank, sortBy]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paginated = useMemo(() => sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [sorted, page]);

  const handleSort = (field: SortField) => { setSortBy(field); setPage(0); };
  const sortIndicator = (field: SortField) => sortBy === field ? " ▼" : "";

  // Granularity picker. Shown whenever the species' lineage offers more than the
  // taxon group itself; a rank with nobody on it stays clickable (an empty table
  // is the honest answer to "who has worked on this genus?").
  const rankPicker = data && data.ranks.length > 1 ? (
    <div className="flex flex-wrap items-center gap-1 mb-2">
      <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mr-1">Within</span>
      {data.ranks.map((r) => (
        <button
          key={r}
          title={RANK_TITLE[r]}
          type="button"
          onClick={() => { setRank(r); setPage(0); }}
          aria-pressed={r === activeRank}
          className={chartControlClass(r === activeRank, "bg-blue-600 text-white border-blue-600")}
        >
          {data.labels[r] ?? r}
        </button>
      ))}
    </div>
  ) : null;

  // Credit-line picker, styled like the Assessors/Reviewers/Facilitators toggle on
  // the filter chart so the two read as the same control. Rendered OUTSIDE the
  // loading/error/empty branches below: a role with no candidates must still offer
  // the way back to one that has some.
  const rolePicker = (
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <div className={`${CHART_SEGMENTED_CLASS} shrink-0`}>
        {CREDIT_ROLES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onRoleChange(r)}
            aria-pressed={r === role}
            className={chartSegmentClass(r === role)}
          >
            {COPY[r].label}
          </button>
        ))}
      </div>
      {role === "facilitators" && (
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
          The people behind an organisational assessor — every bird assessment is credited to BirdLife International.
        </span>
      )}
    </div>
  );

  const body = loading ? (
    <div className="flex items-center justify-center p-8">
      <svg className="w-5 h-5 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    </div>
  ) : error ? (
    <div className="text-sm text-red-500 py-3">{copy.failed}</div>
  ) : !data || data.candidates.length === 0 ? (
    <div className="text-sm text-zinc-400 italic py-3">{copy.none}</div>
  ) : (
    <>
      {rankPicker}
      {sorted.length === 0 ? (
        <div className="text-sm text-zinc-400 italic py-3">
          Nobody has {copy.past} a species in {label} yet — try a broader group above.
        </div>
      ) : (
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700">
            <th className="py-2 pr-3 font-medium">{copy.noun}</th>
            <th
              className="py-2 px-3 font-medium text-right cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
              onClick={() => handleSort("total")}
            >
              Total {label} {copy.verb}{sortIndicator("total")}
            </th>
            <th
              className="py-2 px-3 font-medium text-right cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
              onClick={() => handleSort("inRegion")}
            >
              {label} {copy.verb} in Region{sortIndicator("inRegion")}
            </th>
            <th className="py-2 px-3 font-medium">Regions</th>
            <th className="py-2 pl-3 font-medium text-right">Last Assessment</th>
          </tr>
        </thead>
        <tbody>
          {paginated.map(({ name, tier }) => {
            const coveredRegions = regions.filter((r) => (tier.regionCounts[r] ?? 0) > 0);

            // Group country counts by region for tooltips
            const countriesByRegion: Record<string, string[]> = {};
            for (const [code, count] of Object.entries(tier.countryCounts)) {
              const region = countryToRegion(code);
              if (!countriesByRegion[region]) countriesByRegion[region] = [];
              const countryName = ALPHA2_TO_NAME[code] ?? code;
              countriesByRegion[region].push(`${countryName} (${count})`);
            }
            const year = tier.latestDate ? new Date(tier.latestDate).getFullYear().toString() : "—";

            return (
              <tr
                key={name}
                className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer transition-colors"
                onClick={() => {
                  // Open the dashboard on the same slice the row is counting:
                  // this person's species, within the granularity on screen.
                  const taxa = candidateScopeToken(species.taxonGroup, activeRank, {
                    class: species.className, order: species.orderName, family: species.family, genus,
                  });
                  window.open(
                    `/?taxa=${encodeURIComponent(taxa)}&${role}=${encodeURIComponent(name).replace(/%2C/g, ",")}`,
                    "_blank"
                  );
                }}
              >
                <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-200 truncate max-w-[200px]" title={name}>
                  {name}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{tier.total}</td>
                <td className="py-2 px-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{tier.inRegion}</td>
                <td className="py-2 px-3">
                  <div className="flex flex-wrap items-center gap-1">
                    {coveredRegions.map((r) => (
                      <span
                        key={r}
                        className="group/tip relative inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-zinc-600 bg-zinc-100 dark:text-zinc-300 dark:bg-zinc-800"
                      >
                        <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ backgroundColor: regionColor(r) }} />
                        {r}
                        <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover/tip:block whitespace-nowrap rounded bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200 shadow-lg z-50">
                          {countriesByRegion[r]?.join(", ") ?? r}
                        </span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="py-2 pl-3 text-right tabular-nums text-zinc-400">{year}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center mt-2">
          <ChartPager
            label={`${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, sorted.length)} of ${sorted.length}`}
            canPrev={page > 0}
            canNext={page < totalPages - 1}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          />
        </div>
      )}
    </>
  );

  return (
    <div className="px-4 pb-3 pt-1">
      {rolePicker}
      {body}
    </div>
  );
}
