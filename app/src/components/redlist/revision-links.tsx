/**
 * One renderer for "what Catalogue of Life says about this species", shared by
 * the two surfaces that say it.
 *
 * The dashboard's per-row flag tooltip (RedListView) and the SSC/breakdown
 * panel's Explanation column (TaxaSummary) report the same findings from the
 * same data. They had drifted into two renderings of it: the tooltip linked
 * every name it printed to the CoL record behind it, and the panel printed the
 * same names as plain text, so the surface whose whole job is "here is
 * something you can go and check" was the one you could not check.
 *
 * col-revision.ts owns the words (and the two framings — a tooltip names the
 * species because it stands alone, the panel's column already does). This owns
 * how they are turned into links, so a name is a link in both or neither.
 */
import React from "react";
import { noMatchSentence, noMatchDetailColId, colTaxonUrl, colUrl, type ColRevision } from "@/lib/col-revision";

const LINK_CLASS = "text-blue-300 hover:text-blue-200 underline";

/** A CoL record, or plain text when there is no record to point at. */
export function ColLink({ text, colId }: { text: string; colId?: string }) {
  if (!colId) return <>{text}</>;
  return (
    <a
      href={colUrl(colId)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={LINK_CLASS}
    >
      {text}
    </a>
  );
}

/**
 * Links every occurrence of a known name inside a sentence fragment.
 *
 * The species' own name is a link wherever it appears: for a reason that names
 * no second species ("provisionally accepted", "extinct flag") its record is
 * the only one there is to open, and where a second species IS named, "what
 * does CoL say about THIS one" is the question the flag raises.
 */
export function linkNames(text: string, targets: { name: string; href: string }[]): React.ReactNode {
  const hit = targets
    .map((t) => ({ ...t, at: text.indexOf(t.name) }))
    .filter((t) => t.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (!hit) return text;
  return (
    <>
      {text.slice(0, hit.at)}
      <a
        href={hit.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={LINK_CLASS}
      >
        {hit.name}
      </a>
      {linkNames(text.slice(hit.at + hit.name.length), targets.filter((t) => t.name !== hit.name))}
    </>
  );
}

/**
 * The no-match sentence, with each name it prints linked to its CoL record.
 *
 * `subject` is the species name where the surrounding UI doesn't already give
 * it (the dashboard tooltip), or null where it does (the panel's Name column) —
 * noMatchSentence turns that into the right framing, and this links whatever
 * comes back. `extraTargets` carries a name the sentence mentions that isn't
 * either of those, which today is only a lump's shared accepted name.
 */
export function NoMatchLine({
  flag,
  subject,
  extraTargets = [],
}: {
  flag: ColRevision;
  subject: string | null;
  extraTargets?: { name: string; href: string }[];
}) {
  const s = noMatchSentence(flag, subject);
  const targets = subject ? [{ name: subject, href: colTaxonUrl(flag, subject) }, ...extraTargets] : extraTargets;
  return (
    <>
      {targets.length ? linkNames(s.before, targets) : s.before}
      {s.detail != null && <ColLink text={s.detail} colId={noMatchDetailColId(flag)} />}
      {targets.length ? linkNames(s.after, targets) : s.after}
    </>
  );
}
