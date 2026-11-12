/**
 * How a species' GBIF count was matched: the sync's link (assessment_link, via
 * assessed.parquet's match_* columns), as one key per species, and the GBIF match
 * card's bars. Plain matches (the Red List name found once in CoL) need nothing
 * said; every other key is an edge case worth a look, and "unconfirmed" ones are
 * the matcher's answer the sync's rule doubts, flagged wherever the count shows.
 *
 * The link's labels are the sync's (scripts/sync/link/assessment-link.ts
 * match_reason); this only groups them for a reader.
 */

export type MatchKey =
  | "plain" | "author" | "duplicate" | "variant"
  | "u_homonym" | "u_confidence" | "u_provisional" | "u_other_authors" | "u_ambiguous" | "u_waiting"
  | "decided" | "agent" | "none" | "ne_candidate";

/** What else it counts, beside how it was matched (overlaps the keys above). */
export type CountsKey = "other_names" | "own_name";

export interface MatchBar { key: MatchKey | CountsKey; label: string; unconfirmed?: true; summary: string }

/** The card's bars, in order; "plain" is the header's Confirmed count, not a bar. */
export const MATCH_BARS: MatchBar[] = [
  { key: "u_homonym", label: "Homonym, authors don't settle it", unconfirmed: true, summary: "CoL holds the name for more than one species and the Red List's author citation doesn't pick one; the count follows the matcher's pick." },
  { key: "u_confidence", label: "Matcher less sure", unconfirmed: true, summary: "The matcher's answer is below full confidence." },
  { key: "u_provisional", label: "Provisional name in CoL", unconfirmed: true, summary: "The matcher's answer is a name CoL only provisionally accepts." },
  { key: "u_other_authors", label: "Synonym by other authors", unconfirmed: true, summary: "The matcher's answer is a synonym CoL credits to other authors than the Red List does, so it may be another organism." },
  { key: "u_ambiguous", label: "Ambiguous in CoL", unconfirmed: true, summary: "CoL marks the name an ambiguous synonym, or holds it both as a species and as a synonym of another." },
  { key: "u_waiting", label: "Own name waits, other names count", unconfirmed: true, summary: "Its own name has no confirmed CoL match yet, but records under a CoL name the Red List lists as its synonym count." },
  { key: "author", label: "Homonym, author citation settles it", summary: "CoL holds the name for more than one species; the Red List's author citation matches one." },
  { key: "duplicate", label: "CoL holds the name twice", summary: "CoL holds the same species under two records; both count." },
  { key: "variant", label: "Spelt differently in CoL", summary: "CoL spells the name differently, in a way the codes treat as the same name." },
  { key: "decided", label: "Decided by a person", summary: "A person decided which CoL name it is (match-overrides.tsv)." },
  { key: "agent", label: "Proposed by an agent", unconfirmed: true, summary: "An AI review proposed which CoL name it is; not yet checked by a person." },
  { key: "none", label: "No GBIF match", summary: "No species-level CoL name to count through: the matcher found only a genus, the Red List marks the name unsettled, or CoL doesn't hold it." },
  { key: "other_names", label: "Counts other CoL names too", summary: "Records under other CoL names for the same organism count too: a CoL duplicate, a respelling, a Red List synonym CoL holds as a species, or its name under another species." },
  { key: "own_name", label: "Counts only its own name", summary: "CoL folds it into a broader species, so only records under its own name count." },
  { key: "ne_candidate", label: "Not Evaluated, may be an assessed species", unconfirmed: true, summary: "A Not Evaluated species an unconfirmed or waiting assessed species' name leads to: it may be that species." },
];

const UNCONFIRMED: Record<string, MatchKey> = {
  "homonym the authors don't decide": "u_homonym",
  "lower confidence": "u_confidence",
  "provisional name": "u_provisional",
  "synonym by other authors": "u_other_authors",
  "ambiguous synonym": "u_ambiguous",
  "accepted and a synonym in CoL": "u_ambiguous",
};

/** One species' key, from assessed.parquet's match columns. */
export function matchKey(r: { match_reason?: unknown; match_decided_by?: unknown; count_note?: unknown }): MatchKey {
  const reason = typeof r.match_reason === "string" ? r.match_reason : "";
  if (reason.startsWith("unconfirmed: ")) return UNCONFIRMED[reason.slice("unconfirmed: ".length)] ?? "u_ambiguous";
  if (reason === "override") return String(r.match_decided_by ?? "").startsWith("agent:") ? "agent" : "decided";
  if (r.count_note === "unconfirmed") return "u_waiting";
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

export const isUnconfirmedKey = (k: MatchKey | undefined | null) => !!k && MATCH_BARS.some((b) => b.key === k && b.unconfirmed);

/** The species' match facts as the list carries them. */
export interface SpeciesMatch { match?: MatchKey | null; match_counts_keys?: CountsKey[]; may_be_assessed?: string[] }

/** Does a species pass the GBIF match filter? `selected` holds bar keys, or "plain"; "unconfirmed"/"confirmed" select a whole side. */
export function matchesMatchFilter(s: SpeciesMatch, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true;
  const keys = new Set<string>([...(s.match ? [s.match] : []), ...(s.match_counts_keys ?? []), ...(s.may_be_assessed?.length ? ["ne_candidate"] : [])]);
  const unconfirmed = isUnconfirmedKey(s.match) || keys.has("ne_candidate");
  for (const k of selected) {
    if (k === "unconfirmed" ? unconfirmed : k === "confirmed" ? !!s.match && !unconfirmed && s.match !== "none" : keys.has(k)) return true;
  }
  return false;
}

/** Bar counts, the Confirmed/Unconfirmed totals, for the species in view. */
export function newMatchTally() {
  return { counts: {} as Record<string, number>, confirmed: 0, unconfirmed: 0 };
}
export function tallyMatch(t: ReturnType<typeof newMatchTally>, s: SpeciesMatch): void {
  const keys = [...(s.match && s.match !== "plain" ? [s.match] : []), ...(s.match_counts_keys ?? []), ...(s.may_be_assessed?.length ? ["ne_candidate"] : [])];
  for (const k of keys) t.counts[k] = (t.counts[k] ?? 0) + 1;
  if (isUnconfirmedKey(s.match) || s.may_be_assessed?.length) t.unconfirmed++;
  else if (s.match && s.match !== "none") t.confirmed++;
}

/** The sentence beside a flagged count: why it may be wrong. */
export function unconfirmedText(s: SpeciesMatch & { match_description?: string | null }): string {
  if (s.may_be_assessed?.length) {
    return `Not Evaluated in the Red List, but it may be the assessed ${s.may_be_assessed.join(" or ")}: that species' match to Catalogue of Life is unconfirmed or still waiting.`;
  }
  const bar = MATCH_BARS.find((b) => b.key === s.match);
  return `Unconfirmed match: the count follows GBIF's own matcher, which the dashboard's rules doubt here. ${bar?.summary ?? ""} It may include another organism's records until reviewed.`.replace(/\s+/g, " ").trim();
}

/** The quieter note for a confirmed count that includes other names, or only its own. */
export function countsText(s: SpeciesMatch & { match_other_names?: number | null }): string | null {
  const k = s.match_counts_keys ?? [];
  if (k.includes("other_names")) return `Includes records under ${s.match_other_names ?? "other"} other Catalogue of Life name${s.match_other_names === 1 ? "" : "s"} for the same organism (a duplicate, a respelling, or a name the Red List lists as a synonym).`;
  if (k.includes("own_name")) return "Catalogue of Life folds this species into a broader one, so only records under its own name count.";
  return null;
}
