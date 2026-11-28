"use client";

/**
 * Regional Red List assessments (issue #469): IUCN's assessments of a species
 * within one region (Europe, the Mediterranean, Pan-Africa, …), beside its
 * global one.
 *
 * Its own route, reached from the home page's View selector, and its own data
 * (regional-assessments.parquet, read by /api/regional), so nothing else in the
 * dashboard reads or counts regional assessments. Dropping the feature is
 * deleting this folder, the route, lib/regional and the sync source, and the
 * one option in TaxaSummary's View selector.
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FaArrowLeft } from "react-icons/fa";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ChartPager } from "@/components/redlist/chart-controls";
import { ALPHA2_TO_NAME } from "@/lib/countries";

const getCountryName = (code: string) => ALPHA2_TO_NAME[code] ?? code;
import type { CountryStats } from "@/components/WorldMap";
import {
  REGIONAL_CATEGORY_ORDER, comparison, groupLabel, isThreatened, regionalCategoryColor, regionalCategoryName,
  type RegionDetail, type RegionSummary, type RegionalRow,
} from "@/lib/regional/regional";

const WorldMap = dynamic(() => import("@/components/WorldMap"), { ssr: false });

const PAGE = 50;
type Compare = "all" | "differs" | "no-global";
const COMPARE_LABEL: Record<Compare, string> = {
  all: "All",
  differs: "Regional ≠ global",
  "no-global": "No global assessment",
};

function CategoryBadge({ code }: { code: string | null }) {
  if (!code) return <span className="text-zinc-400 dark:text-zinc-500">—</span>;
  const bg = regionalCategoryColor(code);
  const dark = ["EX", "EW", "RE", "CR"].includes(code);
  return (
    <span
      title={regionalCategoryName(code)}
      className="inline-block min-w-[2.25rem] rounded px-1.5 py-0.5 text-center text-[11px] font-semibold"
      style={{ backgroundColor: bg, color: dark ? "#fff" : "#18181b" }}
    >
      {code}
    </span>
  );
}

function RegionalView() {
  const router = useRouter();
  const params = useSearchParams();
  const region = params.get("region") ?? "Europe";
  const country = params.get("country");

  const [regions, setRegions] = useState<RegionSummary[] | null>(null);
  const [detail, setDetail] = useState<RegionDetail | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [group, setGroup] = useState<string>("");
  const [compare, setCompare] = useState<Compare>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value == null) next.delete(key);
    else next.set(key, value);
    if (key === "region") next.delete("country");
    // A new region or country starts its filters over.
    setCategory(null); setGroup(""); setCompare("all"); setPage(0);
    router.replace(`/regional?${next.toString()}`, { scroll: false });
  };

  useEffect(() => {
    fetch("/api/regional").then((r) => r.json()).then((d) => setRegions(d.regions)).catch(() => setError("Couldn't load the regions."));
  }, []);

  const key = `${region}|${country ?? ""}`;
  const loading = loadedKey !== key;
  useEffect(() => {
    const qs = new URLSearchParams({ region });
    if (country) qs.set("country", country);
    fetch(`/api/regional?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: RegionDetail) => { setDetail(d); setError(null); })
      .catch(() => setError("Couldn't load this region."))
      .finally(() => setLoadedKey(`${region}|${country ?? ""}`));
  }, [region, country]);
  // Any filter change goes back to the first page.
  const filter = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };

  const rows = useMemo(() => detail?.rows ?? [], [detail]);
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.group ?? "", (m.get(r.group ?? "") ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // Every filter but the category, so the category bar shows what clicking would narrow to.
  const beforeCategory = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) =>
      (!group || (r.group ?? "") === group) &&
      (compare === "all" || comparison(r) === compare) &&
      (!q || r.name.toLowerCase().includes(q) || (r.common ?? "").toLowerCase().includes(q)));
  }, [rows, group, compare, query]);
  const shown = useMemo(() => (category ? beforeCategory.filter((r) => r.category === category) : beforeCategory), [beforeCategory, category]);

  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of beforeCategory) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    const known = new Set<string>(REGIONAL_CATEGORY_ORDER);
    return [...REGIONAL_CATEGORY_ORDER.filter((c) => m.has(c)), ...[...m.keys()].filter((c) => !known.has(c))]
      .map((c) => ({ code: c, n: m.get(c)! }));
  }, [beforeCategory]);

  const mapStats: CountryStats = useMemo(() => Object.fromEntries(
    Object.entries(detail?.countries ?? {}).map(([code, c]) => [code, { species: c.species, occurrences: 0 }])), [detail]);

  const summary = regions?.find((r) => r.region === region);
  const threatened = rows.filter((r) => isThreatened(r.category)).length;
  const differs = rows.filter((r) => comparison(r) === "differs").length;
  const noGlobal = rows.filter((r) => comparison(r) === "no-global").length;
  const pageRows = shown.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="flex items-center gap-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
        <Link href="/" className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
          <FaArrowLeft className="h-3 w-3" />
          Dashboard
        </Link>
        <h1 className="text-sm font-medium text-zinc-800 dark:text-zinc-100">Regional Red List assessments</h1>
        <span className="ml-auto"><ThemeToggle /></span>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-6 space-y-5">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          IUCN also assesses species within a region, using its{" "}
          <a href="https://www.iucnredlist.org/resources/regionalguidelines" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-800 dark:hover:text-zinc-200">
            regional guidelines
          </a>
          . A regional category says how a species is doing in that region only, so it can differ from its global one:
          a species common elsewhere can be threatened, or Regionally Extinct (RE), within the region. Not Applicable (NA)
          marks species the region doesn&apos;t assess, such as vagrants or recent introductions.
        </p>

        {/* Region picker */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Region">
          {(regions ?? []).map((r) => (
            <button
              key={r.region}
              type="button"
              onClick={() => setParam("region", r.region)}
              aria-pressed={r.region === region}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${r.region === region
                ? "border-emerald-600 bg-emerald-50 text-emerald-800 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-200 font-semibold"
                : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
            >
              {r.region} <span className="tabular-nums text-zinc-400">{r.species.toLocaleString()}</span>
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* Headline */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: country ? `Assessed for ${region}, native to ${getCountryName(country)}` : `Species assessed for ${region}`, value: rows.length },
              { label: "Regionally threatened (CR, EN, VU)", value: threatened, pct: true },
              { label: "Regional category differs from global", value: differs, pct: true },
              { label: "No global assessment", value: noGlobal, pct: true },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
                <div className="text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {loading ? "…" : s.value.toLocaleString()}
                  {s.pct && !loading && rows.length > 0 && (
                    <span className="ml-1.5 text-xs font-normal text-zinc-400">{Math.round((100 * s.value) / rows.length)}%</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Map */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 h-[380px] flex flex-col">
          <WorldMap
            selectedCountries={new Set(country ? [country] : [])}
            onCountrySelect={(code) => setParam("country", code === country ? null : code)}
            precomputedStats={mapStats}
            speciesLabel="# Regionally assessed"
            showGbifToggle={false}
            showOutdatedMode={false}
            showColorModeDropdown={false}
            titleInfo={
              <span className="text-xs text-zinc-400" title="Species in this region's assessments that are native to each country, counting their whole recorded range: a country outside the region can show a few.">
                species in {region}&apos;s assessments native to each country (excluding NA)
              </span>
            }
          />
        </div>

        {/* Category bar */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span>Regional category {category && (
              <button type="button" className="ml-2 underline" onClick={() => filter(setCategory)(null)}>clear</button>
            )}</span>
            <span className="tabular-nums">{beforeCategory.length.toLocaleString()} species</span>
          </div>
          <div className="flex h-7 w-full overflow-hidden rounded">
            {byCategory.map(({ code, n }) => (
              <button
                key={code}
                type="button"
                onClick={() => filter(setCategory)(category === code ? null : code)}
                title={`${regionalCategoryName(code)}: ${n.toLocaleString()}`}
                className="h-full text-[10px] font-semibold transition-opacity"
                style={{
                  width: `${(100 * n) / Math.max(1, beforeCategory.length)}%`,
                  backgroundColor: regionalCategoryColor(code),
                  color: ["EX", "EW", "RE", "CR"].includes(code) ? "#fff" : "#18181b",
                  opacity: category && category !== code ? 0.3 : 1,
                }}
              >
                {n / Math.max(1, beforeCategory.length) > 0.04 ? code : ""}
              </button>
            ))}
          </div>
        </div>

        {/* Species table */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-3 py-2">
            <input
              value={query}
              onChange={(e) => filter(setQuery)(e.target.value)}
              placeholder="Search species"
              aria-label="Search species"
              className="h-7 w-48 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 text-xs"
            />
            <select
              value={group}
              onChange={(e) => filter(setGroup)(e.target.value)}
              aria-label="Group"
              className="h-7 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-1.5 text-xs"
            >
              <option value="">All groups</option>
              {groups.map(([g, n]) => <option key={g} value={g}>{groupLabel(g || null)} ({n.toLocaleString()})</option>)}
            </select>
            <div className="inline-flex rounded border border-zinc-200 dark:border-zinc-700 overflow-hidden" role="group" aria-label="Compare with global">
              {(Object.keys(COMPARE_LABEL) as Compare[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => filter(setCompare)(c)}
                  aria-pressed={compare === c}
                  className={`h-7 px-2 text-xs ${compare === c ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
                >
                  {COMPARE_LABEL[c]}
                </button>
              ))}
            </div>
            {country && (
              <button type="button" onClick={() => setParam("country", null)} className="h-7 rounded bg-zinc-100 dark:bg-zinc-800 px-2 text-xs text-zinc-700 dark:text-zinc-200">
                {getCountryName(country)} ✕
              </button>
            )}
            <span className="ml-auto">
              <ChartPager
                label={`${shown.length ? page * PAGE + 1 : 0}–${Math.min(shown.length, (page + 1) * PAGE)} of ${shown.length.toLocaleString()}`}
                canPrev={page > 0}
                canNext={page < pages - 1}
                onPrev={() => setPage(page - 1)}
                onNext={() => setPage(page + 1)}
              />
            </span>
          </div>
          <table className="w-full text-xs">
            <thead className="text-left text-zinc-500 dark:text-zinc-400">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="px-3 py-1.5 font-medium">Species</th>
                <th className="px-3 py-1.5 font-medium">Group</th>
                <th className="px-3 py-1.5 font-medium">{region}</th>
                <th className="px-3 py-1.5 font-medium">Global</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r: RegionalRow) => (
                <tr key={r.sis} className="border-b border-zinc-100 dark:border-zinc-800/60 last:border-0">
                  <td className="px-3 py-1.5">
                    <a
                      href={`https://www.iucnredlist.org/species/${r.sis}/${r.assessmentId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="italic text-zinc-800 hover:underline dark:text-zinc-100"
                      title="This regional assessment on the IUCN Red List website"
                    >
                      {r.name}
                    </a>
                    {r.common && <span className="ml-1.5 text-zinc-400">{r.common}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-500 dark:text-zinc-400">{groupLabel(r.group)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <CategoryBadge code={r.category} />
                    <span className="ml-1.5 text-zinc-400 tabular-nums">{r.year}</span>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <CategoryBadge code={r.globalCategory} />
                    {r.globalYear && <span className="ml-1.5 text-zinc-400 tabular-nums">{r.globalYear}</span>}
                  </td>
                </tr>
              ))}
              {!loading && pageRows.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-zinc-400">No species match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function RegionalPage() {
  return (
    <Suspense>
      <RegionalView />
    </Suspense>
  );
}
