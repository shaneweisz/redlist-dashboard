"use client";

import { useState, useEffect, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts";

interface Contributor {
  login: string;
  name: string | null;
  count: number;
  iconUrl: string | null;
}

interface InatContributorsChartProps {
  speciesKey: number;
  /** Scientific name used to resolve the iNat taxon directly when `speciesKey`
   * isn't a GBIF taxon key (CoL-only / not-yet-assessed species). */
  scientificName?: string;
}

type ViewMode = "observers" | "identifiers";

const PAGE_SIZE = 5;

// Custom Y-axis tick that renders as a clickable link to iNat profile
function ClickableYAxisTick({
  x,
  y,
  payload,
  contributors,
}: {
  x: number;
  y: number;
  payload: { value: string };
  contributors: Contributor[];
}) {
  const c = contributors.find((o) => o.login === payload.value);
  const displayName = c?.name || c?.login || payload.value;
  const truncated =
    displayName.length > 14 ? displayName.slice(0, 14) + "…" : displayName;

  return (
    <a
      href={`https://www.inaturalist.org/people/${payload.value}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <text
        x={x}
        y={y}
        textAnchor="end"
        dominantBaseline="central"
        fontSize={10}
        fill="#71717a"
        className="hover:fill-green-500 cursor-pointer transition-colors"
      >
        {truncated}
      </text>
    </a>
  );
}

export default function InatContributorsChart({
  speciesKey,
  scientificName,
}: InatContributorsChartProps) {
  const [observers, setObservers] = useState<Contributor[]>([]);
  const [identifiers, setIdentifiers] = useState<Contributor[]>([]);
  const [totalObservers, setTotalObservers] = useState(0);
  const [totalIdentifiers, setTotalIdentifiers] = useState(0);
  const [inatTaxonId, setInatTaxonId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("observers");
  const [page, setPage] = useState(0);

  useEffect(() => {
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- loading state for fetch
    const qs = scientificName ? `?name=${encodeURIComponent(scientificName)}` : "";
    fetch(`/api/species/${speciesKey}/inat-top-observers${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.observers) setObservers(data.observers);
        if (data.identifiers) setIdentifiers(data.identifiers);
        setTotalObservers(data.totalObservers || 0);
        setTotalIdentifiers(data.totalIdentifiers || 0);
        setInatTaxonId(data.inatTaxonId || null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [speciesKey, scientificName]);

  const activeData = viewMode === "observers" ? observers : identifiers;
  const activeTotal = viewMode === "observers" ? totalObservers : totalIdentifiers;
  const activeLabel = viewMode === "observers" ? "observers" : "identifiers";
  const countLabel = viewMode === "observers" ? "Observations" : "Identifications";

  const globalMax = activeData.length > 0 ? activeData[0].count : 0;
  const totalPages = Math.ceil(activeData.length / PAGE_SIZE);
  const paginated = activeData.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const chartData = useMemo(
    () =>
      paginated.map((c) => ({
        code: c.login,
        count: c.count,
        label: c.count.toLocaleString(),
      })),
    [paginated]
  );

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    setPage(0);
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
        <div className="px-2 py-1.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400 text-center border-b border-zinc-100 dark:border-zinc-800">
          Top iNaturalist Contributors
        </div>
        <div className="h-[200px] flex items-center justify-center">
          <svg
            className="animate-spin h-5 w-5 text-zinc-400"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      </div>
    );
  }

  if (observers.length === 0 && identifiers.length === 0) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl flex flex-col">
      <div className="px-2 py-1.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400 text-center border-b border-zinc-100 dark:border-zinc-800">
        Top iNaturalist Contributors
      </div>
      <div className="p-3 flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          {/* Toggle between Observers and Identifiers */}
          <div className="inline-flex rounded-md bg-zinc-100 dark:bg-zinc-800 p-0.5">
            <button
              onClick={() => handleViewModeChange("observers")}
              className={`px-2 py-0.5 text-xs font-semibold rounded transition-colors ${
                viewMode === "observers"
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
                  : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              Observers
            </button>
            <button
              onClick={() => handleViewModeChange("identifiers")}
              className={`px-2 py-0.5 text-xs font-semibold rounded transition-colors ${
                viewMode === "identifiers"
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
                  : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              Identifiers
            </button>
          </div>
          {activeTotal > 0 && (
            <span className="text-[10px] text-zinc-400 tabular-nums">
              ({activeTotal.toLocaleString()} total)
            </span>
          )}
        </div>
        {inatTaxonId && (
          <a
            href={`https://www.inaturalist.org/observations?taxon_id=${inatTaxonId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-green-600 hover:text-green-500 transition-colors"
          >
            View on iNaturalist →
          </a>
        )}
      </div>

      <div>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={Math.max(80, chartData.length * 24 + 10)}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 5, right: 40, left: -20, bottom: 5 }}
              barCategoryGap={4}
              barSize={16}
            >
              <XAxis type="number" hide domain={[0, globalMax]} />
              <YAxis
                type="category"
                dataKey="code"
                tickLine={false}
                axisLine={false}
                width={110}
                interval={0}
                tick={(props: Record<string, unknown>) => (
                  <ClickableYAxisTick
                    x={props.x as number}
                    y={props.y as number}
                    payload={props.payload as { value: string }}
                    contributors={activeData}
                  />
                )}
              />
              <Tooltip
                formatter={(value) => [
                  Number(value ?? 0).toLocaleString(),
                  countLabel,
                ]}
                labelFormatter={(login) => {
                  const c = activeData.find((o) => o.login === login);
                  return c?.name || String(login);
                }}
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: "8px",
                }}
                itemStyle={{ color: "#fff" }}
                labelStyle={{ color: "#a1a1aa" }}
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} cursor="pointer">
                {chartData.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill="#22c55e" />
                ))}
                <LabelList
                  dataKey="label"
                  position="right"
                  style={{ fontSize: 11, fill: "#a1a1aa" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <span className="text-xs text-zinc-400">No {activeLabel} data</span>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-1 text-[10px] text-zinc-400">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-1.5 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <span>
            {page * PAGE_SIZE + 1}-
            {Math.min((page + 1) * PAGE_SIZE, activeData.length)} of{" "}
            {activeData.length}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-1.5 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
