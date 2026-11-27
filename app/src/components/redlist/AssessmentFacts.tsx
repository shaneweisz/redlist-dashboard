"use client";

import type { ReactNode } from "react";
import type { RedListAssessment } from "@/lib/redlist/assessment";
import type { AssessmentSection } from "@/components/redlist/AssessmentSections";
import { THREAT_SUB_LEVEL, THREAT_TOP_LEVEL, compareThreatCodes } from "@/lib/mapping/nearby-species";

type Assessment = Partial<RedListAssessment>;

/*
 * The structured half of an assessment: the cards and tables the Red List
 * website shows beside each narrative (habitats, countries, uses, parameters).
 * One component per tab, each returning null when the assessment has nothing
 * for it, so a tab with neither facts nor text can say it records nothing.
 */

/** Whether a tab has anything structured to show. */
export function hasFacts(a: Assessment, section: AssessmentSection): boolean {
  const si = a.supplementary_info ?? {};
  const any = (keys: string[]) => keys.some((k) => si[k] != null);
  switch (section) {
    case "taxonomy":
      return !!a.taxonomy;
    case "range":
      return !!a.locations?.length || !!a.realms?.length || any(RANGE_KEYS.map(([k]) => k));
    case "population":
      return any(POPULATION_KEYS.map(([k]) => k)) || !!a.population_trend || CHANGE_PERIODS.some((p) => si[`${p}_percent_change`] != null);
    case "habitat":
      return !!a.habitats?.length || !!a.systems?.length || any(HABITAT_KEYS.map(([k]) => k));
    case "threats":
      return !!a.threat_classification?.length;
    case "use_trade":
      return !!a.use_trade_classification?.length;
    case "conservation_actions":
      return !!a.conservation_in_place?.length || !!a.conservation_actions_classification?.length || !!a.research_needed?.length;
    default:
      return false;
  }
}

export function AssessmentFacts({ assessment, section }: { assessment: Assessment; section: AssessmentSection }) {
  if (!hasFacts(assessment, section)) return null;
  return <div className="mb-3">{factsFor(assessment, section)}</div>;
}

function factsFor(assessment: Assessment, section: AssessmentSection) {
  switch (section) {
    case "taxonomy":
      return <TaxonomyFacts a={assessment} />;
    case "range":
      return <RangeFacts a={assessment} />;
    case "population":
      return <PopulationFacts a={assessment} />;
    case "habitat":
      return <HabitatFacts a={assessment} />;
    case "threats":
      return <ThreatCards a={assessment} />;
    case "use_trade":
      return <UseTradeFacts a={assessment} />;
    case "conservation_actions":
      return <ConservationFacts a={assessment} />;
    default:
      return null;
  }
}

// ── Pieces ──────────────────────────────────────────────────────────────────

const FACTS = "text-xs leading-snug text-zinc-600 dark:text-zinc-400";
const HEAD = "mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400";
const TH = "py-0.5 pr-3 text-left align-bottom font-normal text-zinc-400 dark:text-zinc-500";
const TD = "py-0.5 pr-3 align-top";

function Block({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className={FACTS}>
      {title && <div className={HEAD}>{title}</div>}
      {children}
    </div>
  );
}

/** Label/value pairs, two to a row where there is room. */
function Pairs({ rows, narrow }: { rows: [string, ReactNode][]; narrow?: boolean }) {
  const shown = rows.filter(([, v]) => v != null && v !== "");
  if (shown.length === 0) return null;
  return (
    <dl className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 ${narrow ? "" : "sm:grid-cols-[auto_1fr_auto_1fr]"}`}>
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-400">{k}</dt>
          <dd className="text-zinc-700 dark:text-zinc-300">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "179136" → "179,136"; ranges and words are left as written. */
function num(v: unknown, unit?: string): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  const n = Number(s);
  const shown = Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s.trim()) ? n.toLocaleString("en") : s;
  return unit ? `${shown} ${unit}` : shown;
}

function range(lo: unknown, hi: unknown, unit: string): string | null {
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null) return `${num(lo)}–${num(hi)} ${unit}`;
  return lo != null ? `from ${num(lo, unit)}` : `up to ${num(hi, unit)}`;
}

const tick = (v: boolean | null) => (v ? "✓" : <span className="text-zinc-300 dark:text-zinc-600">—</span>);

// ── Taxonomy ────────────────────────────────────────────────────────────────

/** The Red List's languages are ISO 639-2 codes; the B forms Intl doesn't know. */
const LANGUAGES: Record<string, string> = {
  eng: "English", fre: "French", spa: "Spanish", ger: "German", por: "Portuguese", dut: "Dutch",
  chi: "Chinese", jpn: "Japanese", rus: "Russian", ara: "Arabic", ita: "Italian", swa: "Swahili",
};
function languageName(code: string | null): string {
  if (!code) return "Other";
  if (LANGUAGES[code]) return LANGUAGES[code];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const cap = (s: string | null) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : null);

function TaxonomyFacts({ a }: { a: Assessment }) {
  const t = a.taxonomy;
  if (!t) return null;
  const byLanguage = new Map<string, string[]>();
  for (const c of t.common_names) {
    const lang = languageName(c.language);
    byLanguage.set(lang, [...(byLanguage.get(lang) ?? []), c.name]);
  }
  // English first, then alphabetical: the dashboard is in English.
  const languages = [...byLanguage.entries()].sort(([x], [y]) =>
    x === "English" ? -1 : y === "English" ? 1 : x.localeCompare(y)
  );
  return (
    <div className="space-y-3">
      <Block>
        <Pairs
          rows={[
            ["Kingdom", cap(t.kingdom)],
            ["Phylum", cap(t.phylum)],
            ["Class", cap(t.class)],
            ["Order", cap(t.order)],
            ["Family", cap(t.family)],
            ["Genus", t.genus && <em>{t.genus}</em>],
            ["Scientific name", t.scientific_name && <em>{t.scientific_name}</em>],
            ["Authority", t.authority],
            [
              "Specialist group",
              t.ssc_groups.length > 0 &&
                t.ssc_groups.map((g, i) => (
                  <span key={g.name}>
                    {i > 0 && ", "}
                    {g.url ? (
                      <a href={g.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                        {g.name}
                      </a>
                    ) : (
                      g.name
                    )}
                  </span>
                )),
            ],
          ]}
        />
      </Block>
      {languages.length > 0 && (
        <Block title="Common names">
          <Pairs narrow rows={languages.map(([lang, names]) => [lang, names.join(", ")])} />
        </Block>
      )}
      {t.synonyms.length > 0 && (
        <Block title="Synonyms">
          <div className="italic text-zinc-700 dark:text-zinc-300">{t.synonyms.join("; ")}</div>
        </Block>
      )}
    </div>
  );
}

// ── Geographic range ────────────────────────────────────────────────────────

const RANGE_KEYS: [string, string, string?][] = [
  ["estimated_extent_of_occurence", "Extent of occurrence (EOO)", "km²"],
  ["estimated_area_of_occupancy", "Area of occupancy (AOO)", "km²"],
  ["number_of_locations", "Number of locations"],
  ["continuing_decline_in_area", "Continuing decline in area"],
  ["continuing_decline_in_extent_of_occurence", "Continuing decline in EOO"],
  ["continuing_decline_in_area_of_occupancy", "Continuing decline in AOO"],
  ["continuing_decline_in_number_of_locations", "Continuing decline in locations"],
  ["extreme_fluctuations_in_extent_of_occurence", "Extreme fluctuations in EOO"],
  ["extreme_fluctuations_in_area_of_occupancy", "Extreme fluctuations in AOO"],
  ["extreme_fluctuations_in_number_of_locations", "Extreme fluctuations in locations"],
  ["area_restricted_is_restricted", "Restricted area"],
];

function RangeFacts({ a }: { a: Assessment }) {
  const si = a.supplementary_info ?? {};
  // As the website groups them: "Native: Extant", "Native: Extinct Post-1500", "Reintroduced: Extant".
  const groups = new Map<string, string[]>();
  for (const l of a.locations ?? []) {
    const key = [l.origin, l.presence].filter(Boolean).join(": ") || "Other";
    groups.set(key, [...(groups.get(key) ?? []), l.name]);
  }
  const order = (k: string) => (k.startsWith("Native: Extant") ? 0 : k.startsWith("Native") ? 1 : 2);
  const sorted = [...groups.entries()].sort(([x], [y]) => order(x) - order(y) || x.localeCompare(y));
  return (
    <div className="space-y-3">
      <Block>
        <Pairs
          rows={[
            ...RANGE_KEYS.map(([k, label, unit]) => [label, num(si[k], unit)] as [string, ReactNode]),
            ["Elevation", range(si.lower_elevation_limit, si.upper_elevation_limit, "m")],
            ["Depth", range(si.upper_depth_limit, si.lower_depth_limit, "m")],
            ["Biogeographic realms", a.realms?.length ? a.realms.join(", ") : null],
          ]}
        />
      </Block>
      {sorted.length > 0 && (
        <Block title={`Countries and areas (${a.locations!.length})`}>
          <Pairs narrow rows={sorted.map(([k, names]) => [k, names.sort().join("; ")])} />
        </Block>
      )}
    </div>
  );
}

// ── Population ──────────────────────────────────────────────────────────────

const POPULATION_KEYS: [string, string][] = [
  ["population_size", "Mature individuals"],
  ["population_continuing_decline", "Continuing decline of mature individuals"],
  ["population_severely_fragmented", "Severely fragmented"],
  ["extreme_fluctuations", "Extreme fluctuations"],
  ["no_of_subpopulations", "Subpopulations"],
  ["no_of_individuals_in_largest_subpopulation", "Individuals in largest subpopulation"],
  ["all_individuals_in_one_subpopulation", "All in one subpopulation"],
  ["continuing_decline_in_subpopulations", "Continuing decline in subpopulations"],
  ["extreme_fluctuations_in_subpopulations", "Extreme fluctuations in subpopulations"],
];
const CHANGE_PERIODS = ["past", "ongoing", "future"] as const;

function PopulationFacts({ a }: { a: Assessment }) {
  const si = a.supplementary_info ?? {};
  const trend = typeof a.population_trend === "string" ? a.population_trend : a.population_trend?.description;
  const changes = CHANGE_PERIODS.filter((p) => si[`${p}_percent_change`] != null);
  return (
    <div className="space-y-3">
      <Block>
        <Pairs
          rows={[
            [
              "Current trend",
              trend ? (
                <span
                  className={
                    /decreasing/i.test(trend) ? "text-red-500" : /increasing/i.test(trend) ? "text-green-600" : undefined
                  }
                >
                  {trend}
                </span>
              ) : null,
            ],
            ...POPULATION_KEYS.map(([k, label]) => [label, num(si[k])] as [string, ReactNode]),
          ]}
        />
      </Block>
      {changes.length > 0 && (
        <Block title="Population change">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Period</th>
                <th className={TH}>Change</th>
                <th className={TH}>Basis</th>
                <th className={TH}>Causes</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((p) => (
                <tr key={p} className="border-t border-zinc-50 dark:border-zinc-800/60">
                  <td className={`${TD} capitalize`}>{p}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {si[`${p}_reduction_or_increase`] ?? "Change"} of {si[`${p}_percent_change`]}%
                  </td>
                  <td className={TD}>{si[`${p}_population_reduction_basis`] ?? "—"}</td>
                  <td className={TD}>{si[`${p}_causes_of_reduction`] ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}
    </div>
  );
}

// ── Habitat & ecology ───────────────────────────────────────────────────────

const HABITAT_KEYS: [string, string, string?][] = [
  ["generational_length", "Generation length", "years"],
  ["movement_patterns", "Movement patterns"],
  ["congregatory", "Congregatory"],
];

function HabitatFacts({ a }: { a: Assessment }) {
  const si = a.supplementary_info ?? {};
  const systems = (a.systems ?? []).map((s) => (typeof s === "string" ? s : s.description || s.code));
  return (
    <div className="space-y-3">
      {!!a.habitats?.length && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1.5">
          {a.habitats.map((h, i) => (
            <div
              key={`${h.code}-${i}`}
              className={`rounded-md border px-2 py-1 text-xs ${
                h.major_importance
                  ? "border-zinc-300 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800/60"
                  : "border-zinc-100 dark:border-zinc-800"
              }`}
            >
              <div className="text-zinc-700 dark:text-zinc-200">
                <span className="tabular-nums text-zinc-400">{h.code.replace(/_/g, ".")}.</span> {h.name}
              </div>
              <div className="text-[11px] text-zinc-400">
                {[h.suitability, h.season, h.major_importance ? "Major importance" : null].filter(Boolean).join(" · ")}
              </div>
            </div>
          ))}
        </div>
      )}
      <Block>
        <Pairs
          rows={[
            ["Systems", systems.length ? systems.join(", ") : null],
            ...HABITAT_KEYS.map(([k, label, unit]) => [label, num(si[k], unit)] as [string, ReactNode]),
          ]}
        />
      </Block>
    </div>
  );
}

// ── Threats ─────────────────────────────────────────────────────────────────

/** "High Impact: 8" → the impact band the score falls in, for the card's colour. */
function impactBand(score: string | null): "high" | "medium" | "low" | null {
  if (!score) return null;
  if (/high/i.test(score)) return "high";
  if (/medium/i.test(score)) return "medium";
  if (/low/i.test(score)) return "low";
  return null;
}
const IMPACT_CHIP: Record<"high" | "medium" | "low", string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  medium: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

/**
 * One card per scored threat, as the habitats are shown: the threat by name
 * with the classification above it, then how it was scored and what it does to
 * the species. Ordered by code, so two assessments read in the same order.
 */
function ThreatCards({ a }: { a: Assessment }) {
  const rows = [...(a.threat_classification ?? [])].sort((x, y) => compareThreatCodes(x.code, y.code));
  if (rows.length === 0) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-1.5">
      {rows.map((t, i) => {
        const parts = t.code.replace(/_/g, ".").split(".");
        const top = parts[0];
        const sub = parts.slice(0, 2).join(".");
        // The levels above the threat's own, by name: "Biological resource use › Hunting & trapping".
        const path = [
          parts.length > 1 ? THREAT_TOP_LEVEL[top] : null,
          parts.length > 2 ? THREAT_SUB_LEVEL[sub] : null,
        ].filter(Boolean);
        const band = impactBand(t.score);
        const scoring = [t.timing, t.scope, t.severity].filter(Boolean);
        return (
          <div
            key={`${t.code}-${i}`}
            className={`rounded-md border px-2 py-1 text-xs ${
              band === "high" || band === "medium"
                ? "border-zinc-300 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800/60"
                : "border-zinc-100 dark:border-zinc-800"
            }`}
          >
            {path.length > 0 && <div className="text-[11px] text-zinc-400">{path.join(" › ")}</div>}
            <div className="text-zinc-700 dark:text-zinc-200">
              <span className="tabular-nums text-zinc-400">{parts.join(".")}.</span>{" "}
              {parts.length === 1 ? THREAT_TOP_LEVEL[top] ?? t.name : t.name}
            </div>
            {t.named && <div className="italic text-zinc-500 dark:text-zinc-400">{t.named}</div>}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-400">
              {t.score && <span className={`rounded px-1 ${band ? IMPACT_CHIP[band] : IMPACT_CHIP.low}`}>{t.score}</span>}
              {scoring.length > 0 && <span>{scoring.join(" · ")}</span>}
            </div>
            {!!t.stresses?.length && (
              <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="text-zinc-400">Stresses:</span> {t.stresses.join(", ")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Use & trade ─────────────────────────────────────────────────────────────

function UseTradeFacts({ a }: { a: Assessment }) {
  if (!a.use_trade_classification?.length) return null;
  return (
    <Block>
      <table className="border-collapse">
        <thead>
          <tr>
            <th className={TH}>End use</th>
            <th className={`${TH} text-center`}>Subsistence</th>
            <th className={`${TH} text-center`}>National</th>
            <th className={`${TH} text-center`}>International</th>
          </tr>
        </thead>
        <tbody>
          {a.use_trade_classification.map((u, i) => (
            <tr key={`${u.code}-${i}`} className="border-t border-zinc-50 dark:border-zinc-800/60">
              <td className={TD}>{u.name}</td>
              <td className={`${TD} text-center`}>{tick(u.subsistence)}</td>
              <td className={`${TD} text-center`}>{tick(u.national)}</td>
              <td className={`${TD} text-center`}>{tick(u.international)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Block>
  );
}

// ── Conservation actions ────────────────────────────────────────────────────

function CodedList({ items }: { items: { code: string; name: string }[] }) {
  return (
    <ul className="space-y-0.5">
      {items.map((c, i) => (
        <li key={`${c.code}-${i}`}>
          <span className="tabular-nums text-zinc-400">{c.code.replace(/_/g, ".")}.</span> {c.name}
        </li>
      ))}
    </ul>
  );
}

function ConservationFacts({ a }: { a: Assessment }) {
  const inPlace = (a.conservation_in_place ?? []).filter((g) => g.actions.length > 0);
  return (
    <div className="space-y-3">
      {inPlace.length > 0 && (
        <Block title="In place">
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {inPlace.map((g) => (
              <div key={g.name}>
                <div className="text-zinc-500 dark:text-zinc-400">{g.name.replace(/^In-place (.)/, (_, c: string) => c.toUpperCase())}</div>
                <Pairs narrow rows={g.actions.map((x) => [x.name, x.value])} />
              </div>
            ))}
          </div>
        </Block>
      )}
      {!!a.conservation_actions_classification?.length && (
        <Block title="Needed">
          <CodedList items={a.conservation_actions_classification} />
        </Block>
      )}
      {!!a.research_needed?.length && (
        <Block title="Research needed">
          <CodedList items={a.research_needed} />
        </Block>
      )}
    </div>
  );
}
