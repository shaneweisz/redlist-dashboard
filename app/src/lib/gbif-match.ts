/**
 * GBIF matching reconciliation: how each species' Red List name was matched to
 * Catalogue of Life, the taxonomy GBIF counts records by (the sync's
 * assessment_link, via assessed.parquet's match_* and flag_* columns).
 *
 * Three groups, by one simple rule each:
 *   - Exact: the Red List name appears once in CoL. Nothing to say.
 *   - Resolved (grey): not a plain one-name match, but a rule settles it
 *     reliably (an author citation picks a homonym, CoL holds one species twice…).
 *   - Flagged (orange): the count follows GBIF's matcher, but something about the
 *     match is in doubt, so it may include another species' records.
 * Plus "No match": nothing to count through, so no count is shown.
 */

export type MatchKey =
  | "plain" | "author" | "duplicate" | "variant" | "decided"
  | "f_homonym" | "f_confidence" | "f_provisional" | "f_other_authors" | "f_ambiguous" | "f_synonyms_only" | "agent"
  | "none" | "ne_candidate";

/** What else a count includes, beside how it was matched (overlaps the keys above). */
export type CountsKey = "other_names" | "own_name";

export type MatchGroup = "flagged" | "resolved" | "none";

export interface MatchBar { key: MatchKey | CountsKey; label: string; group: MatchGroup }

/** The card's bars, in order. "plain" is the header's Exact count, not a bar. */
export const MATCH_BARS: MatchBar[] = [
  { key: "f_homonym", label: "Homonym the author doesn't settle", group: "flagged" },
  { key: "f_confidence", label: "Matcher not fully sure", group: "flagged" },
  { key: "f_provisional", label: "Provisional name in CoL", group: "flagged" },
  { key: "f_other_authors", label: "CoL name by other authors", group: "flagged" },
  { key: "f_ambiguous", label: "Ambiguous in CoL", group: "flagged" },
  { key: "f_synonyms_only", label: "Only its synonyms matched", group: "flagged" },
  { key: "agent", label: "Proposed by AI, not yet checked", group: "flagged" },
  { key: "ne_candidate", label: "Not Evaluated, may be assessed", group: "flagged" },
  { key: "author", label: "Homonym settled by author", group: "resolved" },
  { key: "duplicate", label: "Same species twice in CoL", group: "resolved" },
  { key: "variant", label: "Spelt differently in CoL", group: "resolved" },
  { key: "decided", label: "Decided by a person", group: "resolved" },
  { key: "other_names", label: "Also counts other CoL names", group: "resolved" },
  { key: "own_name", label: "Counts only its own name", group: "resolved" },
  { key: "none", label: "No match, no count", group: "none" },
];

export const GROUP_COLOR: Record<MatchGroup, string> = { flagged: "#d97706", resolved: "#a1a1aa", none: "#e4e4e7" };

const FLAGGED: Record<string, MatchKey> = {
  "homonym the authors don't decide": "f_homonym",
  "lower confidence": "f_confidence",
  "provisional name": "f_provisional",
  "synonym by other authors": "f_other_authors",
  "ambiguous synonym": "f_ambiguous",
  "accepted and a synonym in CoL": "f_ambiguous",
};

/** One species' key, from assessed.parquet's match columns. */
export function matchKey(r: { match_reason?: unknown; match_decided_by?: unknown; count_note?: unknown }): MatchKey {
  const reason = typeof r.match_reason === "string" ? r.match_reason : "";
  if (reason.startsWith("flagged: ")) return FLAGGED[reason.slice("flagged: ".length)] ?? "f_ambiguous";
  if (reason === "override") return String(r.match_decided_by ?? "").startsWith("agent:") ? "agent" : "decided";
  if (r.count_note === "flagged") return "f_synonyms_only";
  if (r.count_note === "unlinked" || reason === "waiting" || !reason || reason.startsWith("override,") || reason.startsWith("only match")) return "none";
  if (reason.includes("homonym, author decides")) return "author";
  if (reason.includes("duplicate in CoL")) return "duplicate";
  if (reason.startsWith("spelling variant")) return "variant";
  return "plain";
}

export function countsKeys(r: { match_counts?: unknown; match_other_names?: unknown }): CountsKey[] {
  return [
    ...(Number(r.match_other_names ?? 0) > 0 ? ["other_names" as const] : []),
    ...(r.match_counts === "only records under its own name" ? ["own_name" as const] : []),
  ];
}

const GROUP = new Map<string, MatchGroup>(MATCH_BARS.map((b) => [b.key, b.group]));

/** A CoL record a flag is about (the sync's flag_records). */
export interface FlagRecord { id: string; name: string; authorship: string | null; status: string; species: string | null; counted: boolean }

/** The species' match facts as the list carries them. */
export interface SpeciesMatch {
  match?: MatchKey | null;
  match_counts_keys?: CountsKey[];
  match_other_names?: number | null;
  /** NE rows: the assessed species it may be. */
  may_be_assessed?: string[];
  /** Flagged rows: why, in a sentence, and the CoL records it is about. */
  flag_note?: string | null;
  flag_records?: FlagRecord[];
}

export const isFlagged = (s: SpeciesMatch) => GROUP.get(s.match ?? "plain") === "flagged" || !!s.may_be_assessed?.length;

/** Does a species pass the reconciliation filter? `selected` holds bar keys, or "flagged" / "exact" for the header toggles. */
export function matchesMatchFilter(s: SpeciesMatch, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true;
  const keys = new Set<string>([...(s.match ? [s.match] : []), ...(s.match_counts_keys ?? []), ...(s.may_be_assessed?.length ? ["ne_candidate"] : [])]);
  for (const k of selected) {
    if (k === "flagged" ? isFlagged(s) : k === "exact" ? s.match === "plain" : keys.has(k)) return true;
  }
  return false;
}

/** Bar counts and the header's Flagged / Exact totals, for the species in view. */
export function newMatchTally() {
  return { counts: {} as Record<string, number>, exact: 0, flagged: 0 };
}
export function tallyMatch(t: ReturnType<typeof newMatchTally>, s: SpeciesMatch): void {
  const keys = [...(s.match && s.match !== "plain" ? [s.match] : []), ...(s.match_counts_keys ?? []), ...(s.may_be_assessed?.length ? ["ne_candidate"] : [])];
  for (const k of keys) t.counts[k] = (t.counts[k] ?? 0) + 1;
  if (isFlagged(s)) t.flagged++;
  if (s.match === "plain") t.exact++;
}

export const barLabel = (k: string) => MATCH_BARS.find((b) => b.key === k)?.label ?? k;

/** The quiet note beside a count that includes other names, or only its own. */
export function countsText(s: SpeciesMatch): string | null {
  const k = s.match_counts_keys ?? [];
  const n = s.match_other_names ?? 0;
  if (k.includes("other_names")) return `Also counts records under ${n === 1 ? "1 other CoL name" : `${n} other CoL names`} for this species.`;
  if (k.includes("own_name")) return "CoL folds this species into a broader one, so only records under its own name count.";
  return null;
}

/** A CoL record in the release the sync linked against (ChecklistBank). */
export const checklistBankUrl = (datasetKey: string, id: string) => `https://www.checklistbank.org/dataset/${datasetKey}/taxon/${encodeURIComponent(id)}`;
