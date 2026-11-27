"use client";

import { useState, type ReactNode } from "react";
import { narrativeLabel, type NarrativeField, type RedListAssessment } from "@/lib/redlist/assessment";
import { decodeHtmlEntities, stripHtml } from "@/lib/html-text";
import { CitationProse } from "@/components/redlist/CitationProse";
import { chartSegmentClass } from "@/components/redlist/chart-controls";
import { AssessmentFacts, hasFacts } from "@/components/redlist/AssessmentFacts";
import { THREAT_SUB_LEVEL, THREAT_TOP_LEVEL, compareThreatCodes } from "@/lib/mapping/nearby-species";

type Assessment = Partial<RedListAssessment>;

/** One side of a comparison: the assessment and what to call it ("2008 assessment"). */
export interface ComparedAssessment {
  assessment: Assessment;
  label: string;
}

/** A tab: one of the narratives, the taxonomy, or the assessment's bibliography. */
export type AssessmentSection = NarrativeField | "taxonomy" | "bibliography";

/** What a tab holds, as text, so "is it empty" and "did it change" have one answer. */
function sectionText(a: Assessment, section: AssessmentSection): string {
  if (section === "bibliography") return (a.references ?? []).map((r) => stripHtml(r.citation)).join("\n");
  const raw = section === "taxonomy" ? a.taxonomy?.notes : a[section];
  return raw ? stripHtml(String(raw)) : "";
}

/**
 * An assessment's narrative, one section at a time behind a row of tabs.
 *
 * Shared by the dashboard's Red List Assessments tab and the nearby-species
 * panel, which differ only in the sections they offer, the order and which one
 * opens first (the panel leads with threats, which is what it is for). Every
 * section in `sections` gets a tab, and one this assessment says nothing about
 * stays visible but dimmed: "no use and trade recorded" is itself worth knowing.
 *
 * Given `compare`, each tab shows the section from both assessments side by
 * side, older first, and a tab whose text did not change between them is dimmed.
 * The threat summary is left out of a comparison: it is one assessment's answer.
 *
 * `labels` renames a tab (the assessments tab uses the Red List website's own
 * names), and `lead` puts something above a tab's text outside a comparison:
 * the assessments tab files its credits under the rationale, as "Assessment
 * Information" does on the website.
 *
 * Text size is inherited, so each reader keeps its own type.
 */
export function AssessmentSections({
  assessment,
  sections,
  initial,
  compare,
  labels,
  lead,
  facts = false,
}: {
  assessment: Assessment;
  sections: readonly AssessmentSection[];
  initial?: AssessmentSection;
  compare?: { older: ComparedAssessment; newer: ComparedAssessment };
  labels?: Partial<Record<AssessmentSection, string>>;
  lead?: Partial<Record<AssessmentSection, ReactNode>>;
  /** Show each tab's structured data (habitats, countries, ...) above its text. */
  facts?: boolean;
}) {
  const [section, setSection] = useState<AssessmentSection>(initial ?? sections[0]);
  const label = (s: AssessmentSection) =>
    labels?.[s] ?? (s === "bibliography" ? "Bibliography" : s === "taxonomy" ? "Taxonomy" : narrativeLabel(s));

  const quiet = (field: AssessmentSection) =>
    compare
      ? sectionText(compare.older.assessment, field) === sectionText(compare.newer.assessment, field)
      : !sectionText(assessment, field) && !(facts && hasFacts(assessment, field));

  return (
    <div className="space-y-1.5">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-zinc-100 pb-1 dark:border-zinc-800">
        {sections.map((field) => (
          <button
            key={field}
            role="tab"
            onClick={() => setSection(field)}
            aria-selected={section === field}
            title={compare && quiet(field) ? "Same text in both assessments" : undefined}
            className={`rounded-md text-[11px] leading-[14px] ${chartSegmentClass(section === field)} ${
              section !== field && quiet(field) ? "opacity-50" : ""
            }`}
          >
            {label(field)}
          </button>
        ))}
      </div>

      {compare ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[compare.older, compare.newer].map((side, i) => (
            <div key={i} className="min-w-0">
              <div className="mb-1 text-[11px] font-medium text-zinc-400">{side.label}</div>
              <SectionBody assessment={side.assessment} section={section} label={label(section)} />
            </div>
          ))}
        </div>
      ) : (
        <>
          {lead?.[section]}
          {facts && <AssessmentFacts assessment={assessment} section={section} />}
          {/* The panel's compact summary; with facts on, the threat cards replace it. */}
          {section === "threats" && !facts && <ThreatSummary assessment={assessment} />}
          {(sectionText(assessment, section) || !(facts && hasFacts(assessment, section))) && (
            <SectionBody assessment={assessment} section={section} label={label(section)} />
          )}
        </>
      )}
    </div>
  );
}

function SectionBody({
  assessment,
  section,
  label,
}: {
  assessment: Assessment;
  section: AssessmentSection;
  label: string;
}) {
  if (!sectionText(assessment, section)) {
    return <span className="block text-zinc-400">This assessment records no {label.toLowerCase()}.</span>;
  }
  if (section === "bibliography") return <Bibliography references={assessment.references ?? []} />;
  const text = sectionText(assessment, section);
  if (section === "taxonomy") {
    return (
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Taxonomic notes</div>
        <CitationProse text={text} references={assessment.references ?? []} />
      </div>
    );
  }
  return <CitationProse text={text} references={assessment.references ?? []} />;
}

/**
 * The references as a list, alphabetical as on the Red List website: one per
 * row, titles in italics (the API marks them with <i>), links live.
 */
function Bibliography({ references }: { references: { citation: string }[] }) {
  const sorted = [...references].sort((x, y) =>
    stripHtml(x.citation).localeCompare(stripHtml(y.citation), "en", { sensitivity: "base" })
  );
  return (
    <div>
      <div className="mb-1 text-[11px] text-zinc-400">
        {sorted.length} reference{sorted.length === 1 ? "" : "s"}
      </div>
      <ol className="divide-y divide-zinc-100 text-xs leading-relaxed dark:divide-zinc-800">
        {sorted.map((r, i) => (
          <li key={i} className="py-1.5 [overflow-wrap:anywhere]">
            <CitationText html={r.citation} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A citation's text with its italics kept and its URLs and DOIs made links. */
function CitationText({ html }: { html: string }) {
  // Split on the italic tags only; everything else is reduced to text.
  const parts = html.split(/(<\/?(?:i|em)>)/i);
  let italic = false;
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (/^<\/?(?:i|em)>$/i.test(part)) {
      italic = !part.startsWith("</");
      return;
    }
    // Not stripHtml: it trims, and the spaces either side of a title are text.
    const text = decodeHtmlEntities(part.replace(/<[^>]*>/g, ""));
    if (!text) return;
    const linked = linkify(text, i);
    out.push(italic ? <em key={i}>{linked}</em> : <span key={i}>{linked}</span>);
  });
  return <>{out}</>;
}

function linkify(text: string, key: number): ReactNode[] {
  const re = /(https?:\/\/[^\s<>]+[^\s<>.,;:)]|\b10\.\d{4,9}\/[^\s<>]+[^\s<>.,;:)])/g;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const href = m[0].startsWith("http") ? m[0] : `https://doi.org/${m[0]}`;
    out.push(
      <a key={`${key}-${m.index}`} href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
        {m[0]}
      </a>
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The threat classification rolled up to its twelve top-level categories, with
 * the full scoring a click away.
 *
 * What was ticked comes before what was written about it: the classification is
 * the assessment's own answer to "what is threatening this?", a line of it,
 * where the narrative is paragraphs of argument. Opened straight into the full
 * table, a species with a dozen scored leaves buried the answer, so the summary
 * comes first and the table is behind it.
 */
function ThreatSummary({ assessment }: { assessment: Assessment }) {
  const [tableOpen, setTableOpen] = useState(false);
  const rows = [...(assessment.threat_classification ?? [])].sort((x, y) => compareThreatCodes(x.code, y.code));

  const byTop = new Map<string, { label: string; leaves: number; worst: string | null }>();
  for (const r of rows) {
    const top = r.code.replace(/_/g, ".").split(".")[0];
    const at = byTop.get(top) ?? { label: THREAT_TOP_LEVEL[top] ?? top, leaves: 0, worst: null };
    at.leaves += 1;
    // "Low Impact: 5": the number ranks them, and the highest is the one the
    // species is actually up against.
    const score = Number((r.score ?? "").match(/(\d+)\s*$/)?.[1] ?? NaN);
    const best = Number((at.worst ?? "").match(/(\d+)\s*$/)?.[1] ?? NaN);
    if (Number.isFinite(score) && (!Number.isFinite(best) || score > best)) at.worst = r.score;
    byTop.set(top, at);
  }
  // By code: sorted by weight, the summary reordered itself between species and
  // you could not run your eye down the column to compare two.
  const summary = [...byTop.entries()].sort((x, y) => compareThreatCodes(x[0], y[0]));
  if (summary.length === 0) return null;

  return (
    <div>
      <button onClick={() => setTableOpen((v) => !v)} className="flex w-full items-center gap-1.5 text-left">
        <svg
          className={`h-3 w-3 shrink-0 text-zinc-400 transition-transform ${tableOpen ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="flex flex-wrap gap-1">
          {summary.map(([code, t]) => (
            // Just the pressure, named. The code and the tally are what the
            // table is for, and in the summary they made a plain-English line
            // into something to decode.
            <span
              key={code}
              className="rounded bg-zinc-100 px-1 text-[11px] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200"
              title={`${code}. ${t.label} — ${t.leaves} scored` + (t.worst ? `, worst ${t.worst}` : "")}
            >
              {t.label}
            </span>
          ))}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-400">{tableOpen ? "Hide scoring" : "Show scoring"}</span>
      </button>

      {tableOpen && (
        <table className="mt-1 w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left align-bottom text-zinc-400 dark:text-zinc-500">
              <th className="pr-2 font-normal">Threat</th>
              <th className="pr-2 font-normal">Timing</th>
              <th className="pr-2 font-normal">Scope</th>
              <th className="pr-2 font-normal">Severity</th>
              <th className="font-normal">Impact</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => {
              // "5_4_1" is a path, not a label: the assessment names only its
              // own leaf, so the two levels above it come from the classification.
              const parts = t.code.replace(/_/g, ".").split(".");
              const top = parts[0];
              const sub = parts.slice(0, 2).join(".");
              const levels = [
                { code: top, label: THREAT_TOP_LEVEL[top] },
                parts.length > 1 ? { code: sub, label: THREAT_SUB_LEVEL[sub] } : null,
                parts.length > 2 ? { code: parts.join("."), label: t.name } : null,
              ].filter(Boolean) as { code: string; label?: string }[];
              // A two-level code carries its own name at the second level.
              if (parts.length === 2 && levels[1]) levels[1].label = levels[1].label ?? t.name;
              return (
                <tr key={`${t.code}-${i}`} className="border-t border-zinc-50 align-top dark:border-zinc-800/60">
                  <td className="py-0.5 pr-2 text-zinc-700 dark:text-zinc-200">
                    {levels.map((l, depth) => (
                      <span key={l.code} className="block" style={{ paddingLeft: depth * 10 }}>
                        <span className="tabular-nums text-zinc-400">{l.code}.</span> {l.label ?? "—"}
                      </span>
                    ))}
                    {t.named && (
                      <span
                        className="block italic text-zinc-500 dark:text-zinc-400"
                        style={{ paddingLeft: levels.length * 10 }}
                      >
                        {t.named}
                      </span>
                    )}
                  </td>
                  <td className="py-0.5 pr-2 text-zinc-500 dark:text-zinc-400">{t.timing ?? "—"}</td>
                  <td className="py-0.5 pr-2 text-zinc-500 dark:text-zinc-400">{t.scope ?? "—"}</td>
                  <td className="py-0.5 pr-2 text-zinc-500 dark:text-zinc-400">{t.severity ?? "—"}</td>
                  <td className="py-0.5 text-zinc-500 dark:text-zinc-400">{t.score ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
