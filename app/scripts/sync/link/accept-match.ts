/**
 * When the matcher's answer is taken without review.
 *
 * The rule, in one sentence: the Red List name is found exactly, as a species,
 * with full confidence, it leads to an accepted CoL species, and no other CoL
 * name spelled the same way leads to a different species, unless the author
 * citation picks one. Everything else waits for a decision (decisions.tsv).
 *
 * Two kinds of "other name spelled the same way" are not rivals:
 *   - one with the same author citation as the match: CoL holding one name
 *     twice (assessment-link.ts's twin rule then counts both). Not when the match is
 *     a synonym and the twin an accepted species: CoL then says both that it
 *     is a species and that it is another one (Sipyloidea brevicerci)
 *   - a misapplied name: CoL saying that name was used wrongly, not that it
 *     is another species
 *
 * And a synonym match by other authors than the Red List's (authors.ts) waits
 * too: when CoL drops a species, the only name left spelled like it can be
 * another author's, for another organism. COL26.10 dropped Tritoma bipustulata
 * Fabricius, 1775; the one left, Schilsky, 1888, is a synonym of Mycetophagus
 * quadripustulatus, and the beetle IUCN assessed would have shown its records.
 *
 * Author citations are compared in authors.ts.
 */
import { compareAuthors } from "../../../src/lib/authors";

export interface MatchAnswer {
  usage_id: string | null;
  usage_name: string | null;
  usage_authorship: string | null;
  usage_rank: string | null;
  usage_status: string | null;
  match_type: string | null;
  confidence: number | null;
  alternatives: { usage_id: string; name: string; authorship: string | null; rank: string | null; status: string | null }[];
}

export type QueueReason =
  | "informal or qualified name"
  | "no species match"
  | "spelling variant"
  | "provisional name"
  | "ambiguous synonym"
  | "misapplied name"
  | "matched another rank"
  | "lower confidence"
  | "synonym of no species"
  | "homonym the authors don't decide"
  | "accepted and a synonym in CoL"
  | "synonym by other authors";

export type Acceptance =
  | { accepted: true; why: "unique name" | "authors pick it" | "CoL holds it twice" }
  | { accepted: false; reason: QueueReason };

/** Names the Red List itself marks as unsettled: aff., cf., sp., "[...]" in the name; ined., auct., non, sensu in the authority. */
const INFORMAL_NAME = /\b(aff|cf|sp|spp|nov|indet)\.|\[|\bsp\b/i;
const DISOWNED_AUTHORITY = /\b(ined|auct)\b\.?|\bnon\b|\bsensu\b/i;

const binomial = (n: string | null) => (n ?? "").replace(/×/g, "").trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();

/**
 * @param speciesOf the accepted species a CoL usage counts towards (taxa.species_id), or null
 */
export function acceptMatch(
  species: { name: string; authority: string | null },
  m: MatchAnswer,
  speciesOf: (usageId: string) => string | null,
): Acceptance {
  const no = (reason: QueueReason): Acceptance => ({ accepted: false, reason });
  if (INFORMAL_NAME.test(species.name) || DISOWNED_AUTHORITY.test(species.authority ?? "")) return no("informal or qualified name");
  if (!m.usage_id || m.match_type === "HIGHERRANK" || m.match_type === "NONE") return no("no species match");
  if (m.usage_status === "AMBIGUOUS_SYNONYM") return no("ambiguous synonym");
  if (m.usage_status === "PROVISIONALLY_ACCEPTED") return no("provisional name");
  if (m.usage_status === "MISAPPLIED") return no("misapplied name");
  if (m.match_type !== "EXACT") return no("spelling variant");
  if (m.usage_rank !== "SPECIES") return no("matched another rank");
  if ((m.confidence ?? 0) < 99) return no("lower confidence");
  const mine = speciesOf(m.usage_id);
  if (!mine) return no("synonym of no species");
  if (m.usage_status === "SYNONYM" && compareAuthors(species.authority, m.usage_authorship) === "other") return no("synonym by other authors");

  const rivals = m.alternatives.filter((a) => a.status !== "MISAPPLIED" && binomial(a.name) === binomial(m.usage_name)
    && speciesOf(a.usage_id) !== mine);
  if (rivals.length === 0) return { accepted: true, why: "unique name" };
  const same = (a: string | null, b: string | null) => compareAuthors(a, b) === "same";
  const twins = rivals.filter((a) => same(m.usage_authorship, a.authorship));
  if (twins.length > 0) {
    if (m.usage_status === "SYNONYM" && twins.some((a) => a.status === "ACCEPTED")) return no("accepted and a synonym in CoL");
    return { accepted: true, why: "CoL holds it twice" };
  }
  if (same(species.authority, m.usage_authorship) && !rivals.some((a) => same(species.authority, a.authorship))) {
    return { accepted: true, why: "authors pick it" };
  }
  return no("homonym the authors don't decide");
}
