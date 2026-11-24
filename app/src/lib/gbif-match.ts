/**
 * GBIF matching reconciliation: how each species' Red List name was matched to
 * Catalogue of Life, the taxonomy GBIF counts records by (the sync's
 * assessment_link, via assessed.parquet's match_* columns).
 *
 * Three groups, by one simple rule each:
 *   - Exact: the Red List name appears once in CoL, accepted there or as a
 *     synonym of one species (Sorbus greenii, counted under Aria greenii). The
 *     rename itself is a taxonomic difference, which the CoL card shows.
 *   - Resolved (grey): not a plain one-name match, but a rule settles it
 *     reliably (an author citation picks a homonym, CoL holds one species twice…).
 *   - Flagged (orange): the match has doubts (docs/specs/matching.md, "Doubts"),
 *     so the count may include another species' records, or miss some. Each doubt
 *     is a bar of its own; a species can have several.
 * Plus "No match": nothing to count through, so no count is shown.
 */

export type MatchKey =
  | "plain" | "renamed" | "author" | "duplicate" | "variant" | "decided"
  | DoubtKey | "f_synonyms_only" | "agent"
  | "none" | "ne_candidate" | "ne_assessed_here";

/** One bar per doubt the sync can give (docs/specs/matching.md, "Doubts"). */
export type DoubtKey = "f_author_pick" | "f_homonym" | "f_other_authors" | "f_spelling" | "f_ambiguous" | "f_confidence"
  | "f_counts_nothing" | "f_split_unclear" | "f_filed_elsewhere";

/** The sync's doubt → its bar. */
const DOUBT_KEY: Record<string, DoubtKey> = {
  "chosen by the citation": "f_author_pick",
  "homonym": "f_homonym",
  "other authors": "f_other_authors",
  "other spelling": "f_spelling",
  "ambiguous synonym": "f_ambiguous",
  "placed elsewhere": "f_confidence",
  "counts nothing": "f_counts_nothing",
  "split, authors unclear": "f_split_unclear",
  "synonym filed elsewhere": "f_filed_elsewhere",
};

/** A species' doubts, from assessed.parquet's match_doubts (';'-joined), as bar keys. */
export function doubtKeys(r: { match_doubts?: unknown }): DoubtKey[] {
  const doubts = typeof r.match_doubts === "string" ? r.match_doubts.split(";").filter(Boolean) : [];
  return [...new Set(doubts.map((d) => DOUBT_KEY[d] ?? "f_ambiguous"))];
}

/** What else a count includes, beside how it was matched (overlaps the keys above). */
export type CountsKey = "other_names" | "own_name";

/** The card's sections: how the name was matched (flagged or resolved), what the count includes, and no match. */
export type MatchGroup = "flagged" | "resolved" | "includes" | "none";

export interface MatchBar { key: MatchKey | CountsKey; label: string; group: MatchGroup }

/** The card's bars, in order. "plain" and "renamed" are the header's Exact count, not bars. */
export const MATCH_BARS: MatchBar[] = [
  { key: "f_homonym", label: "Homonym the author doesn't settle", group: "flagged" },
  { key: "f_author_pick", label: "Picked by the author citation", group: "flagged" },
  { key: "f_spelling", label: "Different spelling in CoL", group: "flagged" },
  { key: "f_confidence", label: "Placed elsewhere by the matcher", group: "flagged" },
  { key: "f_other_authors", label: "CoL name by other authors", group: "flagged" },
  { key: "f_ambiguous", label: "Ambiguous in CoL", group: "flagged" },
  { key: "f_counts_nothing", label: "No records counted", group: "flagged" },
  { key: "f_split_unclear", label: "Split, authors unclear", group: "flagged" },
  { key: "f_filed_elsewhere", label: "Synonym filed elsewhere", group: "flagged" },
  { key: "f_synonyms_only", label: "Only its synonyms matched", group: "flagged" },
  { key: "agent", label: "Proposed by AI, not yet checked", group: "flagged" },
  { key: "ne_candidate", label: "Not Evaluated, may be assessed", group: "flagged" },
  { key: "ne_assessed_here", label: "Not Evaluated, includes an assessed species", group: "includes" },
  { key: "author", label: "Homonym settled by author", group: "resolved" },
  { key: "duplicate", label: "Same species twice in CoL", group: "resolved" },
  { key: "variant", label: "Spelt differently in CoL", group: "resolved" },
  { key: "decided", label: "Decided by a person", group: "resolved" },
  { key: "other_names", label: "Also counts other CoL names", group: "includes" },
  { key: "own_name", label: "Only its own name counts", group: "includes" },
  { key: "none", label: "No match, no count", group: "none" },
];

export const GROUP_COLOR: Record<MatchGroup, string> = { flagged: "#d97706", resolved: "#a1a1aa", includes: "#a1a1aa", none: "#d4d4d8" };

/** Each section's heading and one-line meaning. */
export const GROUP_TITLE: Record<MatchGroup, { title: string; sub: string }> = {
  flagged: { title: "⚑ Flagged", sub: "the count may include another species' records" },
  resolved: { title: "Resolved by a rule", sub: "not one exact name, but reliable" },
  includes: { title: "What the count includes", sub: "beyond the matched name" },
  none: { title: "No match", sub: "no count shown" },
};

/** One species' key, from assessed.parquet's match columns: its first doubt, else how it was matched. */
export function matchKey(r: { match_reason?: unknown; match_decided_by?: unknown; match_reviewed?: unknown; count_note?: unknown; match_treatment?: unknown; match_doubts?: unknown }): MatchKey {
  const reason = typeof r.match_reason === "string" ? r.match_reason : "";
  const doubts = doubtKeys(r);
  if (doubts.length > 0) return doubts[0];
  // An AI's decision is flagged until a person has reviewed it.
  if (reason === "decision") return String(r.match_decided_by ?? "").startsWith("agent:") && r.match_reviewed !== true ? "agent" : "decided";
  if (r.count_note === "flagged") return "f_synonyms_only";
  if (r.count_note === "unlinked" || !reason || reason.startsWith("decision,") || reason === "no candidate" || reason === "informal or qualified name") return "none";
  if (reason.includes("homonym, author decides")) return "author";
  if (reason.includes("duplicate in CoL")) return "duplicate";
  if (reason.startsWith("spelling variant")) return "variant";
  // Found once, but CoL accepts the species under another name (Sorbus greenii → Aria greenii).
  if (typeof r.match_treatment === "string" && r.match_treatment.startsWith("synonym")) return "renamed";
  return "plain";
}

export function countsKeys(r: { match_counts?: unknown; match_other_names?: unknown }): CountsKey[] {
  return [
    ...(Number(r.match_other_names ?? 0) > 0 ? ["other_names" as const] : []),
    ...(r.match_counts === "only records under its own name" ? ["own_name" as const] : []),
  ];
}

const GROUP = new Map<string, MatchGroup>(MATCH_BARS.map((b) => [b.key, b.group]));
/** A bar key's section (flagged, resolved, includes, none). */
export const barGroup = (k: string): MatchGroup | undefined => GROUP.get(k);

/** An NE species' assessed_here item ("<name> (part of | same name)") as its name and why. */
export function assessedHere(item: string): { name: string; kind: "part of" | "same name" } {
  const m = item.match(/^(.*) \((part of|same name)\)$/);
  return m ? { name: m[1], kind: m[2] as "part of" | "same name" } : { name: item, kind: "same name" };
}

/** A CoL record a match note names (the sync's match_records): counted through, also counted, or named only. */
export interface NoteRecord {
  id: string; name: string; authorship: string | null; status: string; species: string | null; role: "counted" | "also" | "not";
  /** A counted record's share of the all-records count: records under it, or under a usage below it no closer record claims. */
  records?: number | null;
}

/** The species' match facts as the list carries them. */
export interface SpeciesMatch {
  match?: MatchKey | null;
  /** Every doubt, as bar keys (the first is `match`). */
  match_doubt_keys?: DoubtKey[];
  match_counts_keys?: CountsKey[];
  match_other_names?: number | null;
  /** The Red List's authority and listed synonyms, where there are match records. */
  redlist_authority?: string | null;
  redlist_synonyms?: string[];
  /** NE rows: the assessed species with a doubt it may be (flagged). */
  may_be_assessed?: string[];
  /** NE rows: assessed species whose part-of records lie under it, or whose name it holds ("<name> (part of | same name)"); a note, not a flag. */
  assessed_here?: string[];
  /** A match that isn't plain: the CoL records it is about. */
  match_records?: NoteRecord[];
  /** A decision: who made it (a GitHub handle, agent:<model>). */
  match_decided_by?: string | null;
}

export const isFlagged = (s: SpeciesMatch) => GROUP.get(s.match ?? "plain") === "flagged" || !!s.match_doubt_keys?.length || !!s.may_be_assessed?.length;

/** Every key a species shows: its match key, its doubts, what its count includes, and the NE flag. */
const keysOf = (s: SpeciesMatch) => [...new Set<string>([...(s.match ? [s.match] : []), ...(s.match_doubt_keys ?? []), ...(s.match_counts_keys ?? []),
  ...(s.may_be_assessed?.length ? ["ne_candidate"] : []), ...(s.assessed_here?.length ? ["ne_assessed_here"] : [])])];

/** Does a species pass the reconciliation filter? `selected` holds bar keys, or "flagged" / "exact" for the header toggles. */
export function matchesMatchFilter(s: SpeciesMatch, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true;
  const keys = new Set<string>(keysOf(s));
  for (const k of selected) {
    if (k === "flagged" ? isFlagged(s) : k === "exact" ? isExact(s) : keys.has(k)) return true;
  }
  return false;
}

/** Bar counts and the header's Flagged / Exact totals, for the species in view. */
export function newMatchTally() {
  return { counts: {} as Record<string, number>, exact: 0, flagged: 0 };
}
export function tallyMatch(t: ReturnType<typeof newMatchTally>, s: SpeciesMatch): void {
  const keys = keysOf(s).filter((k) => !(isExact(s) && (k === "plain" || k === "renamed")));
  for (const k of keys) t.counts[k] = (t.counts[k] ?? 0) + 1;
  if (isFlagged(s)) t.flagged++;
  if (isExact(s)) t.exact++;
}

/** Exact matches: one CoL record for the name, whether CoL accepts it or holds it as a synonym. */
export const isExact = (s: SpeciesMatch) => (s.match === "plain" || s.match === "renamed") && !s.match_doubt_keys?.length;

export const barLabel = (k: string) => (k === "renamed" ? "Exact, under CoL's accepted name" : MATCH_BARS.find((b) => b.key === k)?.label ?? k);

/** A CoL record in the release the sync linked against (ChecklistBank). */
export const checklistBankUrl = (datasetKey: string, id: string) => `https://www.checklistbank.org/dataset/${datasetKey}/taxon/${encodeURIComponent(id)}`;
