/**
 * The taxonomic-difference vocabulary — one place for the signals the
 * dashboard flags on an assessed species, and everything the UI says about them.
 *
 * Two independent signals live on one flag:
 *
 *  1. `reason` — this species has no clean 1:1 Catalogue of Life match, and why
 *     (emitted by classifyNoMatch, lib/data/col-breakdown.ts).
 *  2. `splitInto` — Catalogue of Life now recognises species that were likely
 *     split out of this one. Its CoL match is usually clean; the revision is
 *     that CoL has carved new species off it.
 *
 * They are near-disjoint in practice (72 of ~8.7k flagged species carry both),
 * but they ARE independent, so the filter chart's bars do not partition the
 * flagged set — a species with both counts toward two bars, the same way the
 * Criteria and Habitat charts already work.
 *
 * Two surfaces read the wording:
 *  - the SSC-group view's per-group "No 1:1 CoL Match" panel (TaxaSummary.tsx),
 *    which shows the explanation in a narrow table cell, beside a column that
 *    already names the species (it has its own, separate split display);
 *  - the main assessed dashboard's "Taxonomic differences from Catalogue of
 *    Life" filter chart + per-row flag (RedListView.tsx), where the explanation
 *    stands alone in a tooltip and so has to name the species itself.
 *
 * Hence noMatchSentence's `subject`: one switch, one set of verbs and nouns, two
 * framings — rather than two independently-drifting sets of wording.
 */

import { isGenusMove } from "@/lib/name-parts";

/** The "split" pseudo-reason: not a no-match reason (those come from
 *  classifyNoMatch), but it sits alongside them as a bar and a filter value. */
export const SPLIT_REASON = "split";

/**
 * The accepted-name pseudo-reasons, split by WHERE the difference falls.
 *
 * The commonest kind keeps the epithet and differs only in the genus (Aplexa
 * elongata / Sibirenauta elongata). Separating it lets a reader who does not
 * accept CoL's generic limits set those aside without dismissing the rest, and
 * keeps a single 8k bar off an axis whose next largest is 4k.
 *
 * "differs", never "moved": a move has a direction, and we do not know it. IUCN
 * has the newer treatment at least as often as CoL does — CoL accepts Bos bison
 * for Bison bison, and Myodes glareolus for Clethrionomys glareolus. Naming the
 * act would credit CoL with a revision that, in those cases, IUCN made first.
 */
export const GENUS_DIFFERS_REASON = "genus_differs";
export const RENAMED_REASON = "renamed";

/** Reason codes, in the order the filter chart lists them: most likely to
 *  reflect a real taxonomic revision first, bookkeeping gaps last. */
export const REVISION_REASONS = [
  SPLIT_REASON,
  "lumped",
  GENUS_DIFFERS_REASON,
  RENAMED_REASON,
  "infraspecific",
  "unmatched",
  "missing_from_backbone",
  "classified_elsewhere",
] as const;

/**
 * The bars the chart draws, in axis order.
 *
 * Every bar is currently exactly one reason, and the indirection still earns
 * its place: REVISION_REASON_SHORT has to label the reasons the card does NOT
 * draw as well, because the SSC group panel renders those. Six bars, nine
 * labelled reasons — genuinely different sets. It also means a bar covering
 * several reasons is a data change here rather than a rewrite in RedListView.
 *
 * There was such a bar, briefly: "No 1:1 CoL match", covering not_in_base,
 * provisional and synonym_of. Its claim was that the assessment corresponded to
 * no single accepted CoL species, so our CoL columns for it could not be
 * trusted. The claim is false of all three, for one reason:
 *
 *   CoL holds each of them exactly ONCE, and we already use that record.
 *
 * GBIF's occurrence index is built on CoL's extended release, so an XR-only
 * col_id is as usable as a curated one. 920 not_in_base, 327 provisional and 75
 * synonym_of species carry live GBIF occurrence counts — 11.2M records reaching
 * the dashboard through links the bar was simultaneously calling "no match".
 *
 * synonym_of was the last to go and looked the most like a real failure: the
 * matched record is XR-only while the CURATED release files that name as a
 * synonym of a different accepted species, which reads as two candidates. It is
 * not. Synonymy means one taxon under two names, so the extended release
 * resolves the assessment to exactly one species and the curated release
 * resolves it to exactly one species. There is no reading on which it maps to
 * zero or to two. All 117 of its matched link rows are ACCEPTED in XR.
 *
 * What is left is the only case that fails on arity: CoL holds no record of the
 * name at any status, in any release. Zero candidates.
 */
export const REVISION_BARS: readonly { key: string; label: string; reasons: readonly string[] }[] = [
  { key: SPLIT_REASON, label: "Split on CoL", reasons: [SPLIT_REASON] },
  { key: "lumped", label: "Lumped on CoL", reasons: ["lumped"] },
  { key: GENUS_DIFFERS_REASON, label: "Different genus on CoL", reasons: [GENUS_DIFFERS_REASON] },
  { key: RENAMED_REASON, label: "Different name on CoL", reasons: [RENAMED_REASON] },
  { key: "unmatched", label: "No CoL match", reasons: ["unmatched"] },
  { key: "infraspecific", label: "Below species on CoL", reasons: ["infraspecific"] },
  // Zero in every sync so far; the chart drops empty bars, so they cost nothing
  // until they fire. A reason with no bar would be diagnosed and then silently
  // dropped from the card, which is what the one-bar-per-reason test prevents.
  { key: "missing_from_backbone", label: "Dangling link", reasons: ["missing_from_backbone"] },
  { key: "classified_elsewhere", label: "Reclassified", reasons: ["classified_elsewhere"] },
];

/**
 * The bars to draw, commonest first.
 *
 * An empty bar is drawn ONLY when it is the one selected. Cross-filtering can
 * drive the bar you just clicked to zero, and dropping it then would leave
 * nothing on the card to click to undo the filter. Keeping every empty bar
 * whenever anything at all was selected is the wrong reading of that rule: it
 * put "Dangling link" and "Reclassified" — zero in every sync so far — onto the
 * card the moment any filter was applied.
 */
export function visibleBars(
  counts: Readonly<Record<string, number>>,
  selected: ReadonlySet<string>,
): { bar: (typeof REVISION_BARS)[number]; count: number; selected: boolean }[] {
  return REVISION_BARS
    .map((bar) => ({
      bar,
      count: bar.reasons.reduce((n, r) => n + (counts[r] ?? 0), 0),
      selected: bar.reasons.some((r) => selected.has(r)),
    }))
    .filter((b) => b.count > 0 || b.selected)
    .sort((a, b) => b.count - a.count);
}

/** The bar a reason is drawn under, for labelling a tooltip block with the same
 *  words the chart uses — a reader who filtered by a bar has to recognise it. */
export function barForReason(reason: string): { key: string; label: string } | null {
  const bar = REVISION_BARS.find((b) => b.reasons.includes(reason));
  return bar ? { key: bar.key, label: bar.label } : null;
}

/**
 * Diagnosed by classifyNoMatch but deliberately NOT flagged on the dashboard.
 *
 * "extinct_unconfirmed" means CoL's record for the name is flagged extinct
 * while the IUCN category isn't EX/EW. Two things disqualify it from a card
 * about taxonomic differences:
 *
 *  - It isn't a taxonomic difference. It is a disagreement about whether the
 *    species still exists, which is a data-quality observation about CoL.
 *  - It is mostly wrong. Of the 60 it caught, 25 were Least Concern or Near
 *    Threatened — species that by definition are not extinct — and 14 of those
 *    were Columba, where CoL flags 16 of the genus's 35 accepted species
 *    extinct, including the common and abundant C. arquatrix and C. elphinstonii.
 *    That is one contaminated upstream block, not a signal.
 *
 * "not_in_base" (2,113), "provisional" (494) and "synonym_of" (88) are the other
 * three, and they are ONE case: CoL holds the record exactly once, at species
 * rank, under a col_id we already use. What varies is only how CoL's two release
 * products file it — absent from the curated checklist, in it with a hedged
 * status, or in it as a synonym of another accepted species.
 *
 * All three shipped as bars, were dropped, then briefly came back under a "No
 * 1:1 CoL match" bar. The return was the mistake, and what makes it one is the
 * plainest fact in this file: GBIF's occurrence index is BUILT on CoL's extended
 * release, so an XR-only col_id is exactly as usable as a curated one — and we
 * use it. 920 not_in_base, 327 provisional and 75 synonym_of species carry live
 * GBIF occurrence counts on the dashboard: 11.2 million records pulled through
 * links the bar was simultaneously calling "no match".
 *
 * So the bar's claim was false of them. Their match IS 1:1. What differs is
 * which CoL product carries it and how CoL files it there — CoL's editorial
 * state, not the arity of our mapping, and nothing a Red List assessor can act
 * on. They also cost the reader CoL's product vocabulary: "XR", "Base" and
 * "provisionally accepted" name CoL's releases and internal statuses, which an
 * assessor has no reason to know, and at 2,113 not_in_base was large enough to
 * crowd the signals that do carry an action.
 *
 * synonym_of held out longest because it reads as two candidates: we match an
 * XR-only record while the curated release files that name as a synonym of a
 * DIFFERENT accepted species. But synonymy means one taxon under two names, so
 * each release resolves the assessment to exactly one species — never zero,
 * never two. All 117 of its matched link rows are accepted in XR. It is also
 * the case an earlier commit had already rejected on its own merits: a synonym
 * leaves the taxon, and so the assessment, alone.
 *
 * A measurement that looks decisive and is not, recorded so nobody redoes it:
 * 433 of the 494 provisional records ARE in the curated checklist, against 29 of
 * the 2,113 not_in_base ones — which reads as grounds for treating the two
 * differently. It measures how confident CoL is in a record. The bar asks
 * whether WE can map the assessment to one species. Both answer yes.
 *
 * The counter-argument, and why it resolves: sampling showed not_in_base names
 * often ARE synonyms in current usage (80% sit in a genus the curated checklist
 * covers thoroughly). But wherever that can actually be established the
 * classifier already reports it as synonym_of, which names the accepted species
 * and IS flagged. not_in_base is precisely the residue where we cannot say.
 *
 * What this does leave: col_described counts only in_base records, so these
 * 2,607 assessed species sit in the numerator with no denominator entry. Against
 * a ~2.4M denominator that is noise, and it wants a coverage-table footnote
 * rather than a flag on a species row.
 *
 * All three still exist, and the SSC group view still reports them: there they
 * sit in a panel explicitly about CoL-match diagnostics, which is the right home
 * for "CoL says something odd here".
 *
 * Worth knowing separately: a false extinct flag also drops the species from
 * col_described, since the extant universe is `extinct IS NOT TRUE OR IUCN says
 * EX/EW`. 103 assessed species are excluded that way — a real undercount that
 * predates this feature and wants its own fix.
 */
export const UNFLAGGED_REASONS = ["extinct_unconfirmed", "not_in_base", "provisional", "synonym_of"] as const;

export type RevisionReasonCode = (typeof REVISION_REASONS)[number];

/** Short label for a chart axis / filter chip. Kept to a couple of words —
 *  the sentence below is what a tooltip or table cell shows. */
/**
 * The reason code a row is LABELLED and COUNTED under.
 *
 * One divergence from the raw classifier code, and it is the card's: an
 * assessment whose name CoL files as a synonym of a different accepted species
 * is an accepted-name difference, and the useful split is where the difference
 * falls — genus alone (Sorbus greenii / Aria greenii, 6,377 species on the
 * dashboard) or the epithet too. "Synonym of" describes the CoL record; these
 * describe the disagreement, which is what a reader is looking at.
 */
export function displayReason(row: { reason?: string; name?: string; detail?: string; colName?: string }): string | undefined {
  const reason = canonicalReason(row.reason);
  const accepted = acceptedNameFor(row);
  if (!accepted || !row.name) return reason;
  return isGenusMove(row.name, accepted) ? GENUS_DIFFERS_REASON : RENAMED_REASON;
}

/**
 * CoL's accepted name for the species, where the row's finding IS that name.
 *
 * Two classifier codes carry one finding. `synonym_of` is CoL filing the
 * assessed name under another accepted species; `classified_elsewhere` is the
 * matched record sitting outside the group being viewed — and 186 of genus
 * Sorbus's 187 rows are that, every one of them because CoL accepts the species
 * under another genus (Aria, Karpatiosorbus, Hedlundia) in the same family. The
 * name is the finding in both; the code only records which check noticed it.
 */
function acceptedNameFor(row: { reason?: string; name?: string; detail?: string; colName?: string }): string | undefined {
  const reason = canonicalReason(row.reason);
  const accepted = reason === "synonym_of" ? row.detail : reason === "classified_elsewhere" ? row.colName : undefined;
  // Same name filed somewhere else is a placement difference, not a name one.
  return accepted && row.name && accepted.toLowerCase() !== row.name.toLowerCase() ? accepted : undefined;
}

/**
 * Reason codes shipped by an older build, mapped to the ones in use.
 *
 * Data outlives code here: a summaries artifact is rebuilt by a data sync, not
 * by a deploy, so a renamed code keeps arriving for as long as the artifact
 * that carries it is current. "no_link" became "unmatched", and 322 rows in
 * today's ssc-group-children-summaries.json still say "no_link".
 */
const RETIRED_REASONS: Record<string, string> = { no_link: "unmatched" };

/** The code a reason is known by now — see RETIRED_REASONS. */
export function canonicalReason(reason: string | undefined): string | undefined {
  return reason == null ? reason : (RETIRED_REASONS[reason] ?? reason);
}

/**
 * What a set of no-match diagnoses is MADE OF, commonest first, labelled with
 * the same words the dashboard's filter chart uses.
 *
 * The panel's "No 1:1 CoL Match" is one number over nine quite different
 * findings, and the mix is the part a specialist reads first: 72 lumped is a
 * taxonomy story, 15 "CoL only has the name in its extended release" is a
 * coverage story, and a bare 127 tells neither. Borrowing REVISION_REASON_SHORT
 * rather than inventing labels is deliberate — a reader who has used the
 * dashboard's chart has already learnt these words.
 */
export function reasonComposition(details: readonly { reason?: string; name?: string; detail?: string }[]): { reason: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const d of details) {
    const reason = displayReason(d);
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count, label: REVISION_REASON_SHORT[reason] ?? reason }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export const REVISION_REASON_SHORT: Record<string, string> = {
  // "on CoL" goes on every label that names something BOTH databases do, and
  // nowhere else. Splitting, lumping and assigning a rank are all acts either
  // party could have performed, so bare they leave the agent open — a reader can
  // as easily hear "the Red List split this" as "CoL did". The card title names
  // Catalogue of Life, but a filter chip carries the label away from the title,
  // so it has to stand up by itself.
  //
  // The remaining two say who they mean without help: "No CoL match" names CoL
  // outright, and "CoL's accepted name differs" is about CoL's accepted name.
  split: "Split on CoL",
  lumped: "Lumped on CoL",
  // Split by WHERE the difference falls. Both say "different", not "moved" or
  // "renamed": naming the act would pick a direction, and the direction is
  // genuinely unknown — IUCN has the newer treatment at least as often. It also
  // avoids a second trap: most of the epithet cases are synonymies onto another
  // species (Dalbergia campenonii -> D. emirnensis), where nothing was renamed
  // and something was merged.
  genus_differs: "Different genus on CoL",
  renamed: "Different name on CoL",
  // Not "Renamed": two thirds are genus transfers, which a rename describes
  // well, but the rest are synonymies onto a different species (Dalbergia
  // campenonii -> D. emirnensis), where nothing was renamed.
  //
  // "Accepted" is load-bearing and worth the second line it costs on the axis.
  // Every species has other names in CoL — synonyms, basionyms — so "CoL name
  // differs" is trivially true of almost all of them. The finding is about which
  // name CoL ACCEPTS. Not "Synonym on CoL", which fits on one line but states
  // the assessment's name as the deficient one rather than naming the difference.
  synonym_of: "CoL's accepted name differs",
  // Not bare "Subspecies", which reads as a count of them, and not "Demoted"
  // (accurate, but nobody says it). The "on CoL" suffix is earned for the same
  // reason Split and Lumped earn it: a rank is something both parties assign, so
  // without an agent the label leaves open who did the demoting.
  infraspecific: "Below species on CoL",
  // CoL's own two products, named as CoL names them. "Not in checklist" invited
  // the reading that CoL has nothing at all, when the record is in XR.
  not_in_base: "In XR, not Base",
  // CoL's exact status wording, which the sentence now quotes.
  provisional: "Provisionally accepted",
  // "Unmatched" left open what it failed to match. This is also what the SSC
  // group view has always called it ("No 1:1 CoL Match").
  unmatched: "No CoL match",
  // Diagnosed but not dashboard bars (UNFLAGGED_REASONS); the SSC panel uses them.
  extinct_unconfirmed: "Extinct flag",
  missing_from_backbone: "Dangling link",
  classified_elsewhere: "Reclassified",
};

/**
 * One line of context for the short label, for the bar chart's own tooltip.
 *
 * Every line is reported speech — "Catalogue of Life says", not "this species
 * is". The card exists because two checklists disagree, and a bar that states
 * CoL's position as the fact of the matter has quietly picked the winner. That
 * is the reading the whole feature is trying not to invite, and a one-line
 * hover is exactly where it slips in unnoticed.
 *
 * The two that don't say "says" are about what CoL contains rather than what it
 * claims — an absent record isn't an assertion anyone has to be right about.
 */
export const REVISION_REASON_SUMMARY: Record<string, string> = {
  split: "Catalogue of Life says species have been split out of this one",
  genus_differs: "Catalogue of Life's curated release uses a different genus for this species",
  renamed: "Catalogue of Life's curated release accepts a different name for this species",
  lumped: "Catalogue of Life says this is one species with another assessment",
  synonym_of: "Catalogue of Life says it accepts a different name for this species",
  infraspecific: "Catalogue of Life says this is a subspecies, variety or form of another species",
  not_in_base: "Catalogue of Life has this in its extended release only, not its curated checklist",
  provisional: "Catalogue of Life says it accepts this name only provisionally",
  extinct_unconfirmed: "Catalogue of Life says the name is extinct; the assessment says otherwise",
  unmatched: "Catalogue of Life has no species record under this name",
  missing_from_backbone: "Catalogue of Life's record for this no longer resolves",
  classified_elsewhere: "Catalogue of Life says it belongs in a different group",
};

/**
 * The standing caveat, shown on the chart and in every flag tooltip.
 *
 * This feature reports what Catalogue of Life says, and CoL is demonstrably
 * wrong sometimes — it recognises two Dasycercus species where the 2023
 * revision, the Mammal Diversity Database and IUCN itself all recognise six,
 * and it flags Columba arquatrix extinct. A reader who takes a flag as a
 * correction to an assessment has misread it, so the UI says so rather than
 * relying on them to infer it.
 */
export const REVISION_CAVEAT =
  "Flagged for information only — Catalogue of Life can be out of date or incorrect.";

/** The per-species flag the dashboard carries on every assessed row (null when
 *  the species has neither signal — the large majority). */
export interface ColRevision {
  /** Why it has no clean 1:1 CoL match. Absent when the match IS clean and the
   *  only signal is `splitInto`. */
  reason?: string;
  /** The assessed name this flag is about. Carried by the SSC panel's rows
   *  (NoMatchDetail), which pass no `subject` because the column beside them
   *  already names the species — but the wording still has to compare the two
   *  names to say whether CoL's differs in the genus alone. Absent on the
   *  dashboard's own flags, which name the species through `subject`. */
  name?: string;
  /** The species it's lumped with / demoted under ("lumped"/"infraspecific"). */
  detail?: string;
  /** CoL's rank for it when that is below species ("infraspecific" only), so the
   *  wording can name it exactly rather than calling every one a subspecies. */
  rank?: string;
  /** That species' own SIS id, when it's itself IUCN-assessed. */
  detailId?: number;
  /** The CoL id to deep-link to: the record that disagrees with the assessment,
   *  or — for a split-only flag — this species' own CoL record. */
  colId?: string;
  /** The CoL record for `detail`, so that name can link to CoL as well. */
  detailColId?: string;
  /** CoL's own accepted name for that col_id, when it's neither this species
   *  nor `detail` (i.e. the two were merged under some third name). */
  colName?: string;
  /** The OTHER IUCN assessments filed under the same CoL record — the whole
   *  lump group, of which `detail` names only the one that won the tie-break.
   *  Each carries its own synonym record under the shared species (the
   *  checkable evidence, present for ~62%) and its IUCN category, which is
   *  where the awkwardness shows: one CoL species assessed both EX and LC. */
  lumpedWith?: { name: string; colId?: string; category?: string }[];
  /** CoL's accepted name for the shared record — what the group is filed under. */
  lumpedUnder?: string;
  /** Species CoL now recognises that were likely split out of this one, each
   *  with its own CoL record and — as the evidence for the split — the old
   *  infraspecific name that now resolves to it ("Vallonia costata var. montana
   *  Sterki, 1893"). Never empty when present. */
  splitInto?: SplitEntry[];
  /** The accepted name CoL's CURATED release uses for this species, when that is
   *  a different name from IUCN's. Measured against the release rather than
   *  inferred from a failed match: these assessments match CoL cleanly, which is
   *  why no other signal catches them. */
  acceptedName?: string;
  /** That accepted record's CoL id, so the name can link to it. */
  acceptedColId?: string;
  /** The difference is in the genus alone — same epithet, different genus. */
  genusDiffers?: boolean;
  /** Where CoL files the record, "Family (Order)" ("classified_elsewhere" only). */
  colGroup?: string;
}

/** Does this species carry any revision signal at all? */
export function isFlagged(flag: ColRevision | null | undefined): boolean {
  return flag != null && (flag.reason != null || (flag.splitInto?.length ?? 0) > 0
    || (flag.lumpedWith?.length ?? 0) > 0 || flag.acceptedName != null);
}

/**
 * Every bar this species belongs in — one per signal it carries, so a species
 * with more than one counts toward each.
 *
 * Three independent signals: it has been split, it shares a CoL record with
 * other assessments (lumped), and it has no clean 1:1 match for some other
 * reason. Lumping is derived from the group rather than from `reason` on
 * purpose: EVERY assessment sharing the record is equally affected, and which
 * one the classifier happens to call "lumped" is an accepted-name tie-break, not
 * a fact about the taxonomy — CoL's 347N2 is both Dasycercus cristicauda (EX)
 * and Dasycercus hillieri (LC), and neither assessment is the odd one out.
 */
export function revisionReasons(flag: ColRevision): string[] {
  const out: string[] = [];
  if (flag.splitInto?.length) out.push(SPLIT_REASON);
  // Either source counts: the group (what the dashboard ships) or the
  // classifier's own label (what the SSC panel's data carries, and what an
  // artifact built before the group was collected would have). Without the
  // fallback such a flag would be flagged but sit in no bar, so nothing could
  // select it.
  if (flag.lumpedWith?.length || flag.reason === "lumped") out.push("lumped");
  if (flag.acceptedName != null) out.push(flag.genusDiffers ? GENUS_DIFFERS_REASON : RENAMED_REASON);
  if (flag.reason != null && flag.reason !== "lumped") out.push(flag.reason);
  return out;
}

/**
 * The dashboard's filter predicate. `colMatch` is the coarse toggle
 * ("flagged"/"clean"/no filter); `reasons` narrows the flagged bucket, and
 * implies flagged on its own, so it wins when both are set.
 */
export function matchesRevisionFilter(
  flag: ColRevision | null | undefined,
  colMatch: "flagged" | "clean" | null,
  reasons: Set<string>,
): boolean {
  if (reasons.size > 0) return flag != null && revisionReasons(flag).some((r) => reasons.has(r));
  if (colMatch === "flagged") return isFlagged(flag);
  if (colMatch === "clean") return !isFlagged(flag);
  return true;
}

/**
 * Running totals behind the filter chart.
 *
 * The no-match reasons partition their own set — classifyNoMatch gives a species
 * exactly one — but split and lumped are orthogonal properties, so the bars
 * together do not partition the flagged species. Forcing them to would mean
 * making a bar disagree with the rows clicking it returns, or dropping a true
 * fact about a species. So the bars stay honest and the overlap is stated under
 * the chart instead.
 */
export interface RevisionTally {
  /** Species per signal — what each bar shows, and exactly what clicking it selects. */
  counts: Record<string, number>;
  /** Distinct species carrying at least one signal. */
  flagged: number;
  /** Species carrying neither. flagged + clean === every species tallied. */
  clean: number;
  /** Species carrying more than one signal — the amount by which the bars
   *  over-total `flagged`, which is what the card explains under the chart. */
  multiSignal: number;
}

export function newRevisionTally(): RevisionTally {
  return { counts: {}, flagged: 0, clean: 0, multiSignal: 0 };
}

/** Fold one species' flag into a tally. Mutates — this runs once per species in
 *  a memo over the whole in-view list, so it deliberately allocates nothing. */
export function tallyRevision(t: RevisionTally, flag: ColRevision | null | undefined): void {
  if (!isFlagged(flag)) { t.clean++; return; }
  t.flagged++;
  const reasons = revisionReasons(flag!);
  for (const reason of reasons) t.counts[reason] = (t.counts[reason] ?? 0) + 1;
  if (reasons.length > 1) t.multiSignal++;
}

/** Total across the bars — `flagged` plus one for each extra signal carried. */
export function barTotal(t: RevisionTally): number {
  return Object.values(t.counts).reduce((a, b) => a + b, 0);
}

/**
 * The explanation split into parts, so the SAME wording serves a plain-text
 * tooltip and a rendering where `detail` is a link to that species. `detail` is
 * the only part that is ever a species the app can link to.
 */
export interface NoMatchSentence {
  before: string;
  detail?: string;
  after: string;
}

/** One species in a listed group — a split-off species, or another assessment
 *  sharing a lumped record. */
export interface SplitEntry {
  name: string;
  colId?: string;
  /** The old infraspecific name that now resolves here — the evidence. */
  previousName?: string;
  previousColId?: string;
  /** IUCN category, shown for lump-group members. */
  category?: string;
}

/**
 * The split explanation as a list, so every name in it can be a link to its own
 * CoL record — both the species and the old name behind it. Showing the old name
 * is what makes the inference checkable: CoL's site has no view of "names that
 * used to sit under this species and now resolve elsewhere", so without it a
 * reader has to reconstruct the derivation (see SPLIT_CANDIDATES_SQL's worked
 * example).
 */
export interface SplitSummary {
  lead: string;
  /** Every species split out of this one — not capped. The tooltip scrolls
   *  instead, so a long tail (Rubus fruticosus has 73) stays readable without
   *  the list quietly standing in for names it doesn't show. */
  entries: SplitEntry[];
}

const COL = "Catalogue of Life";

/**
 * Plain-language "what did Catalogue of Life actually do to this species, and
 * what does that mean for this assessment", for the no-match half of the flag.
 *
 * Each standalone sentence carries both halves, matching the split and lump
 * ones: the finding, then what follows from it. Stating only the finding left a
 * reader to work out why it mattered, which is the whole job of a flag.
 *
 * `subject` is the species name for a standalone tooltip, or null where the
 * surrounding UI already names it (the SSC panel's table cell).
 *
 * The two framings do different jobs, so they say different things.
 *
 * The tooltip argues: it names the species, states the finding and says what
 * follows from it, because it stands alone on a dashboard row with nothing else
 * to explain why the flag is there.
 *
 * The panel states: every line is a checkable claim about what Catalogue of
 * Life's own record says — the status it gives the name, the species or rank it
 * files it under — sitting next to a link to that record. A reader who doubts
 * the row can follow the link and see the same words on CoL's page. Drawing the
 * consequence instead ("so it covers part of another species") gives that reader
 * nothing to check, so the panel leaves it to them. It is also a ~240px column,
 * where an inference costs the line that the evidence should be using.
 */
export function noMatchSentence(flag: ColRevision, subject: string | null): NoMatchSentence {
  const s = subject ? `${subject} ` : "";
  switch (canonicalReason(flag.reason)) {
    case "lumped": {
      // The interesting sub-case is a lump under a THIRD name — both assessed
      // species merged into a CoL name that is neither of them (e.g. IUCN's
      // Epimyrma ravouxi + this one → CoL's Temnothorax ravouxi). Only ~240 of
      // the ~2.1k lumps do that, so naming it unconditionally would mostly
      // repeat `detail` back at the reader — which it was doing whenever CoL's
      // accepted name IS the winner's, as it usually is: "The same species as
      // Acer oblongum — both are now called Acer oblongum".
      const thirdName = flag.colName && flag.colName !== flag.detail ? flag.colName : null;
      return subject
        ? { before: `According to ${COL}, ${s}is the same species as `, detail: flag.detail, after: `${thirdName ? ` — both are now called ${thirdName}` : ""}.` }
        // One CoL record reached from two assessed names, which is the thing to
        // check: open it and the other assessment's name is on that same page.
        : { before: "CoL lists this and ", detail: flag.detail, after: thirdName ? ` under ${thirdName}.` : " as one species." };
    }
    case "synonym_of":
      // NOT "not in the checklist yet" — the checklist has the name, filed as a
      // synonym of an accepted species. Usually a genus transfer IUCN hasn't
      // adopted (Sorbus minima -> Hedlundia minima).
      return subject
        ? { before: `This assessment is published under ${subject}, but according to ${COL} the accepted name for this species is `, detail: flag.detail, after: "." }
        // The card's framing, because it is the better one: what a reader wants
        // from a row whose name CoL files under another species is the name CoL
        // accepts, and whether the move is the genus alone. "Synonym of" says
        // the same thing about the record without saying either.
        : flag.name && flag.detail && isGenusMove(flag.name, flag.detail)
          ? { before: "CoL uses another genus, accepting ", detail: flag.detail, after: "." }
          : { before: "CoL accepts a different name: ", detail: flag.detail, after: "." };
    case "infraspecific": {
      // Say the rank CoL actually gives it. 124 of these are varieties and one is
      // a form; telling a botanist their variety is a subspecies is simply wrong,
      // and wrong in a way that costs the whole feature credibility.
      const rank = flag.rank && flag.rank !== "subspecies" ? flag.rank : "subspecies";
      return subject
        ? { before: `${COL} ranks ${s}as a ${rank} of `, detail: flag.detail, after: ", so this assessment covers what it treats as part of another species." }
        : { before: `CoL lists this as a ${rank} of `, detail: flag.detail, after: "." };
    }
    // Deliberately NOT "hasn't added it yet": that implies a backlog the
    // checklist is working through, and for most of these it isn't true. Only
    // ~10% were described since 2015 and 39% are pre-1950, and 80% sit in a genus
    // the curated checklist covers thoroughly (Euphorbia has 2,113 accepted
    // species in it, but not Euphorbia ankarensis) — so the checklist knows the
    // group and has not adopted the name. What IS true is where the record comes
    // from, so say that instead.
    case "not_in_base":
      return subject
        ? { before: `${COL}'s curated checklist doesn't accept ${subject}, so the name survives only in its extended release.`, after: "" }
        : { before: "In CoL's extended release only, not its curated checklist.", after: "" };
    case "provisional":
      return subject
        // Quoting CoL's own two status values rather than paraphrasing them: the
        // distinction between them IS the finding, and a reader who goes to look
        // will see those exact words on the page.
        ? { before: `${COL} currently lists ${subject} as a 'provisionally accepted species', not yet an 'accepted species'.`, after: "" }
        : { before: "CoL lists this as a 'provisionally accepted species'.", after: "" };
    // Usually a species-boundary disagreement, not a data error: e.g. Equus ferus
    // (wild horse) — CoL treats it and Equus przewalskii as two species, one of
    // them (the true wild tarpan) extinct; this IUCN assessment lumps them as one,
    // which is why IUCN doesn't call it Extinct/Extinct in the Wild even though
    // CoL's record for this exact name is flagged extinct. Verified case by case
    // — see TaxaSummary.tsx's git history (2026-07-21) to re-check a given species.
    case "extinct_unconfirmed":
      // Deliberately "its record ... is flagged": the flag is a fact about CoL's
      // record, not about the species. Some are real boundary disagreements
      // (Equus ferus), and some are simply wrong upstream — CoL flags
      // Columba elphinstonii (a Least Concern, extant pigeon) extinct.
      return subject
        ? { before: `${COL} marks ${s}extinct and this assessment doesn't, so one of them is wrong about whether it survives.`, after: "" }
        : { before: "CoL's record for this name is flagged extinct.", after: "" };
    case "unmatched":
      return subject
        ? { before: `No ${COL} species matches ${subject}, so there is nothing there to check this assessment against.`, after: "" }
        : { before: "No CoL record of this name, at any status.", after: "" };
    case "missing_from_backbone":
      // Name the id. "A record that no longer resolves" is not something a reader
      // can look up, act on, or report; the id is all three — it is what they
      // would paste into CoL, and what makes the claim falsifiable.
      return subject
        ? { before: `${s}links to ${COL} id ${flag.colId ?? "(unknown)"}, which this release doesn't hold, so the match needs redoing.`, after: "" }
        : { before: `Links to CoL id ${flag.colId ?? "(unknown)"}, which this release doesn't hold.`, after: "" };
    case "classified_elsewhere": {
      // Where CoL accepts the species under another NAME, that is the finding,
      // and the reader wants the name — the group, when it differs too, comes
      // after it. Sorbus is the case: same family, different genus, and a row
      // reading "CoL files this record under Rosaceae" while sitting under
      // Rosaceae said nothing at all.
      const accepted = acceptedNameFor(flag);
      if (accepted) {
        const where = flag.colGroup ? `, in ${flag.colGroup}` : "";
        const genus = flag.name && isGenusMove(flag.name, accepted);
        return subject
          ? genus
            ? { before: `${COL} uses a different genus for ${subject}, accepting `, detail: accepted, after: `${where}.` }
            : { before: `${COL} accepts a different name for ${subject}: `, detail: accepted, after: `${where}.` }
          : genus
            ? { before: "CoL uses another genus, accepting ", detail: accepted, after: `${where}.` }
            : { before: "CoL accepts a different name: ", detail: accepted, after: `${where}.` };
      }
      // Same name, different placement — then the group IS the whole finding, so
      // withholding it leaves nothing to check.
      const where = flag.colGroup;
      return subject
        ? where
          ? { before: `${COL} files ${s}under ${where}, so it won't appear where this assessment places it.`, after: "" }
          : { before: `${COL} files ${s}under a different group, so it won't appear where this assessment places it.`, after: "" }
        : where
          ? { before: `CoL files this record under ${where}.`, after: "" }
          : { before: "CoL files this record under a different group.", after: "" };
    }
    default:
      // Never reached for a shipped reason (the col-revision test asserts every
      // one is handled), so this is for data written by a future or older build.
      // Says what the row is for rather than leaking a code the reader can make
      // nothing of, which is what "no_link" did.
      return { before: `No 1:1 ${COL} match for this name.`, after: "" };
  }
}

/**
 * The split half of the flag, in parts so each split-off species can be linked
 * to its own CoL record, or null when there is none.
 *
 * Deliberately hedged ("likely"): the underlying signal is a name-pattern
 * heuristic — CoL keeps the old subspecies name as a synonym when a subspecies
 * is promoted — not a confirmed taxonomic changelog. See SPLIT_CANDIDATES_SQL
 * in col-breakdown.ts.
 */
export function splitSummary(flag: ColRevision, subject: string): SplitSummary | null {
  const names = flag.splitInto ?? [];
  if (names.length === 0) return null;
  // The species itself is one of the species the old concept split into, so the
  // count is names.length + 1 even though only the OTHERS are listed — which is
  // what "the other species" / "the others" is doing at the end of the lead.
  const total = names.length + 1;
  return {
    lead: `${COL} suggests ${subject} is split into ${total} separate species`
      + `, so this assessment may cover populations now assigned to `
      + (names.length === 1 ? "the other species:" : "the others:"),
    entries: names,
  };
}

/** The lump explanation. One sentence, with the assessments kept as their own
 *  values so each can be a link to its CoL record. */
export interface LumpSentence {
  before: string;
  /** Every assessment CoL files under one species, this one first. */
  members: { name: string; colId?: string; category?: string }[];
  mid: string;
  /** CoL's name for the merged species — its own part, so it can be a link. */
  under?: { name: string; colId?: string };
  after: string;
}

/**
 * The lump half of the flag: IUCN assesses several species that CoL files as
 * one. Reads as a single sentence rather than a list, because the finding is one
 * fact — these are the same species to CoL — and the IUCN categories carry it:
 * "Dasycercus cristicauda (EX) and Dasycercus hillieri (LC)" is the whole
 * problem in one line.
 *
 * The subject is included, first, since the sentence is about the group and it
 * is one of them. Returns null when the group isn't known (an older artifact, or
 * the SSC panel's data, which carries only the tie-break winner) — callers fall
 * back to noMatchSentence.
 */
export function lumpSentence(
  flag: ColRevision,
  subject: string,
  subjectCategory?: string,
): LumpSentence | null {
  const others = flag.lumpedWith ?? [];
  if (others.length === 0) return null;
  return {
    before: `${COL} treats `,
    members: [
      { name: subject, colId: flag.colId, ...(subjectCategory ? { category: subjectCategory } : {}) },
      // A member with no synonym record of its own — typically CoL's accepted
      // name — links to the shared record, which IS its record.
      ...others.map((o) => (o.colId ? o : { ...o, colId: flag.colId })),
    ],
    mid: " as a single species",
    // Named even when it repeats one of the members: the first mention is "an
    // assessment", this one is "what CoL calls the merged species".
    ...(flag.lumpedUnder ? { under: { name: flag.lumpedUnder, colId: flag.colId } } : {}),
    after: ".",
  };
}

/** The lump sentence as one plain string, for a context that can't hold links. */
export function flattenLump(l: LumpSentence | null): string | null {
  if (!l) return null;
  const parts = l.members.map((m) => (m.category ? `${m.name} (${m.category})` : m.name));
  const joined = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : parts[0];
  return `${l.before}${joined}${l.mid}${l.under ? `, ${l.under.name}` : ""}${l.after}`;
}

/** The summary flattened to one plain string, for a context that can't hold links. */
export function splitSentence(flag: ColRevision, subject: string): string | null {
  return flattenSummary(splitSummary(flag, subject));
}

/** A list summary as one plain string, for a context that can't hold links. */
export function flattenSummary(s: SplitSummary | null): string | null {
  if (!s) return null;
  const listed = s.entries.map((e) =>
    e.previousName ? `${e.name} (previously ${e.previousName})`
      : e.category ? `${e.name} (${e.category})`
      : e.name);
  return `${s.lead} ${listed.join("; ")}.`;
}

/** The whole flag as plain sentences — one per signal it carries. */
export function revisionSentences(flag: ColRevision, subject: string): string[] {
  const out: string[] = [];
  const lump = flattenLump(lumpSentence(flag, subject));
  if (lump) out.push(lump);
  // NOT `else`: a lump and a no-match reason are independent findings, and 69
  // species carry both (Fukomys damarensis is lumped with Cryptomys natalensis
  // AND ranked a subspecies of Cryptomys hottentotus). Skipping the reason left
  // a species selectable by a bar whose finding its own tooltip never showed.
  // The only reason to skip is "lumped" WHEN the group sentence already said it;
  // without a group (the SSC panel's data) that reason still needs its own line.
  if (flag.reason != null && !(lump && flag.reason === "lumped")) {
    const { before, detail, after } = noMatchSentence(flag, subject);
    out.push(`${before}${detail ?? ""}${after}`);
  }
  const accepted = acceptedNameSentence(flag, subject);
  if (accepted) out.push(`${accepted.before}${accepted.detail}${accepted.after}`);
  const split = splitSentence(flag, subject);
  if (split) out.push(split);
  return out;
}

/**
 * "CoL's curated release accepts a different name for this species", in parts so
 * the accepted name can be a link to its own CoL record.
 *
 * Reported speech throughout, like every other sentence here: CoL accepts a
 * name, it does not establish one. Two checklists can differ permanently on a
 * species concept without either being wrong, and the card says so beneath.
 */
export function acceptedNameSentence(
  flag: ColRevision,
  subject: string | null = null,
): { before: string; detail: string; after: string } | null {
  if (flag.acceptedName == null) return null;
  const name = flag.acceptedName;
  if (subject == null) {
    // The SSC panel names the species in the column beside this one.
    return flag.genusDiffers
      ? { before: `${COL} uses another genus: `, detail: name, after: "" }
      : { before: `${COL} accepts `, detail: name, after: "" };
  }
  return flag.genusDiffers
    ? { before: `${COL} uses a different genus for ${subject}, accepting `, detail: name, after: "." }
    : { before: `${COL} accepts a different name for ${subject}: `, detail: name, after: "." };
}

/**
 * Why a Catalogue of Life species has no IUCN assessment, where we can say —
 * the Not Evaluated half of the same panel, in the same voice as the no-match
 * half above: a checkable statement about CoL's record, with the related
 * assessed species named so a reader can see the assessment does exist, just
 * not under this name.
 *
 * Two shapes, both derived from CoL's own synonymy (col-breakdown.ts):
 *
 *  - `neSynonym` — CoL files an IUCN-ASSESSED name among this species' synonyms
 *    (SYNONYM_ASSESSED_SQL). Checkable on the species' CoL page, under Synonyms.
 *  - `split` — CoL keeps an old infraspecific name under an assessed species
 *    that now resolves here (SPLIT_CANDIDATES_SQL). A heuristic, so it stays
 *    hedged, and the evidence is only visible from THIS species' CoL page —
 *    hence a tooltip alongside saying what to look for.
 *
 * Most NE species get neither: they are simply species nobody has assessed,
 * which the panel says by leaving the cell empty rather than padding it out.
 */
export function neSynonymSentence(assessedName: string): NoMatchSentence {
  return { before: "CoL lists the assessed ", detail: assessedName, after: " as a synonym of this species." };
}

export function neSplitSentence(parentName: string): NoMatchSentence {
  return { before: "Likely split from the assessed ", detail: parentName, after: "." };
}

/** The evidence behind neSplitSentence's hedge, for the tooltip beside it. */
export const NE_SPLIT_EVIDENCE =
  `Heuristic, not a confirmed taxonomic changelog: ${COL} still files an old subspecies name of the linked species as a synonym of this one. Its page lists that name under Synonyms.`;

/**
 * The CoL record `noMatchSentence`'s `detail` names, for linking it.
 *
 * Usually detailColId — the record for the second species a row names. For a
 * reclassified row the second name IS the record this assessment matched, which
 * the classifier files under colId, so the link target has to follow the name
 * rather than sit on one fixed field. Without this the reclassified rows print
 * "accepting Aria greenii" as plain text, which is the one sentence in the
 * column whose whole point is that you can go and look at it.
 */
export function noMatchDetailColId(flag: ColRevision): string | undefined {
  if (flag.detailColId) return flag.detailColId;
  return canonicalReason(flag.reason) === "classified_elsewhere" ? flag.colId : undefined;
}

/** The sentence as one plain string, for a `title`/tooltip that can't hold a link. */
export function noMatchExplanation(flag: ColRevision, subject: string | null = null): string {
  const { before, detail, after } = noMatchSentence(flag, subject);
  return `${before}${detail ?? ""}${after}`;
}

/**
 * Where the ⚑ sends you: the CoL record this flag is about — the one that
 * disagrees with the assessment, or the species' own record for a split-only
 * flag. Falls back to a CoL name search when there's no col_id at all, which is
 * the "unmatched" case (there is no record to link to — that IS the finding).
 */
/** A CoL record's public page. */
export function colUrl(colId: string): string {
  return `https://www.catalogueoflife.org/data/taxon/${colId}`;
}

/** A source dataset's page on CoL — where a record came from. */
export function colDatasetUrl(key: number): string {
  return `https://www.catalogueoflife.org/data/dataset/${key}`;
}

export function colTaxonUrl(flag: ColRevision, scientificName: string): string {
  return flag.colId
    ? colUrl(flag.colId)
    : `https://www.catalogueoflife.org/data/search?q=${encodeURIComponent(scientificName)}`;
}
