/**
 * When the matcher's answer is taken without review.
 *
 * The rule, in one sentence: the Red List name is found exactly (or spelt
 * differently only as the codes allow), as a species, with full confidence, it
 * leads to an accepted CoL species, and no other CoL name spelled the same way
 * leads to a different species, unless the author citation picks one.
 * Everything else waits for a decision (match-overrides.tsv).
 *
 * A spelling variant counts as found when it is the same name under the codes'
 * rules for Latin endings and transliteration (name-variants.ts: Pseudechis
 * pailsi / pailsei), and the authors are not clearly others. The matcher found
 * the candidate; the spelling rules only corroborate it.
 *
 * Three kinds of "other name spelled the same way" are not rivals:
 *   - one with the same author citation as the match: CoL holding one name
 *     twice (assessment-link.ts's twin rule then counts both). Not when the match is
 *     a synonym and the twin an accepted species: CoL then says both that it
 *     is a species and that it is another one (Sipyloidea brevicerci)
 *   - a provisionally accepted copy of an accepted match, by authors that are
 *     not clearly others: CoL holding the name twice, once provisionally, often
 *     with the Red List's own citation (Cygnus buccinator Richardson, 1832 beside
 *     the accepted Richardson, 1831)
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
import { orthographicallySame } from "./name-variants";

export interface MatchAnswer {
  matcher_col_id: string | null;
  matcher_name: string | null;
  matcher_authorship: string | null;
  matcher_rank: string | null;
  matcher_status: string | null;
  match_type: string | null;
  confidence: number | null;
  alternatives: { col_id: string; name: string; authorship: string | null; rank: string | null; status: string | null }[];
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
  if (!m.matcher_col_id || m.match_type === "HIGHERRANK" || m.match_type === "NONE") return no("no species match");
  if (m.matcher_status === "AMBIGUOUS_SYNONYM") return no("ambiguous synonym");
  if (m.matcher_status === "PROVISIONALLY_ACCEPTED") return no("provisional name");
  if (m.matcher_status === "MISAPPLIED") return no("misapplied name");
  // A variant's confidence is the matcher's doubt about the spelling, which the codes' rules settle.
  const variant = m.match_type !== "EXACT" && !!m.matcher_name && orthographicallySame(binomial(species.name), binomial(m.matcher_name))
    && compareAuthors(species.authority, m.matcher_authorship) !== "other";
  if (m.match_type !== "EXACT" && !variant) return no("spelling variant");
  if (m.matcher_rank !== "SPECIES") return no("matched another rank");
  if (!variant && (m.confidence ?? 0) < 99) return no("lower confidence");
  const mine = speciesOf(m.matcher_col_id);
  if (!mine) return no("synonym of no species");
  if (m.matcher_status === "SYNONYM" && compareAuthors(species.authority, m.matcher_authorship) === "other") return no("synonym by other authors");

  const rivals = m.alternatives.filter((a) => a.status !== "MISAPPLIED" && binomial(a.name) === binomial(m.matcher_name)
    && speciesOf(a.col_id) !== mine);
  if (rivals.length === 0) return { accepted: true, why: "unique name" };
  const same = (a: string | null, b: string | null) => compareAuthors(a, b) === "same";
  const provisionalCopy = (a: MatchAnswer["alternatives"][number]) => m.matcher_status === "ACCEPTED" && a.status === "PROVISIONALLY_ACCEPTED"
    && compareAuthors(m.matcher_authorship, a.authorship) !== "other";
  const twins = rivals.filter((a) => same(m.matcher_authorship, a.authorship) || provisionalCopy(a));
  if (twins.length > 0) {
    if (m.matcher_status === "SYNONYM" && twins.some((a) => a.status === "ACCEPTED")) return no("accepted and a synonym in CoL");
    return { accepted: true, why: "CoL holds it twice" };
  }
  if (same(species.authority, m.matcher_authorship) && !rivals.some((a) => same(species.authority, a.authorship))) {
    return { accepted: true, why: "authors pick it" };
  }
  return no("homonym the authors don't decide");
}
