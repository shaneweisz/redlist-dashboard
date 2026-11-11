/**
 * Whether a matched CoL name is this Red List species: the verdict assessment-link.ts
 * gives every match (own, lumped, refused).
 *
 * These rules once lived in three places that disagreed, and every disagreement
 * was a species showing the wrong number (a frog listed EN displayed a
 * congener's records). So they live here, as pure functions, and everything
 * downstream reads the verdict instead of recomputing it.
 *
 * The whole thing reduces to one predicate, sameOrganism, plus one Red List
 * fact: whether the other name is itself separately assessed.
 */

import { canonicalEpithet } from "../../../src/lib/name-parts";
import { normaliseAuthorship } from "../../../src/lib/authors";

const genusOf = (scientificName: string) => scientificName.trim().toLowerCase().split(/\s+/)[0] ?? "";

/** A name as the taxonomies give it: the binomial, and its author citation if known. */
export interface TaxonName {
  scientificName: string;
  authorship?: string;
}

/**
 * The species epithet, lower-cased, with the hybrid marker dropped.
 *
 * Solanum x vallis-mexici and Solanum vallis-mexici are the same plant; the
 * marker is notation, not nomenclature, and leaving it in makes them look
 * thirteen edits apart.
 */
export function epithetOf(scientificName: string): string {
  const parts = scientificName.trim().toLowerCase().split(/\s+/);
  const raw = parts[1] ?? "";
  return raw.replace(/^[×x]$/, "") === "" ? (parts[2] ?? "") : raw.replace(/^×/, "");
}

/** Edit distance, capped — only ever used to ask "is this a respelling?". */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** A respelling changes a letter or two. Beyond that it is a different word. */
const MAX_RESPELLING_EDITS = 3;

/**
 * Are these two names the same organism?
 *
 * Three ways to be, checked in order of how much they prove:
 *
 *   1. The same name. Nothing to decide.
 *
 *   2. The same epithet under a different genus — a genus transfer, which is a
 *      rename and nothing more. Hylatomus pileatus -> Dryocopus pileatus,
 *      Drepanis coccinea -> Vestiaria coccinea. The epithet may have changed
 *      gender to agree with the new genus (Meiostemon tetrandrus -> Combretum
 *      tetrandrum); that is still the same name.
 *
 *   3. The same author, and an epithet within a couple of letters — a respelling
 *      or a gender agreement. Pica nutalli -> nuttallii, Sminthopsis fuliginosa
 *      -> fuliginosus, both (Audubon, 1837) / (Gould, 1852) respectively.
 *
 * Neither signal is sufficient alone, and both failures cost real data:
 *
 *   - Authorship alone said yes to Pseudophilautus abundus -> P. procax. Two
 *     frogs described in the same paper share an author string verbatim, so
 *     authorship cannot distinguish a rename from a pair of congeners. An EN
 *     species displayed the other's records.
 *   - Epithet alone said no to Sminthopsis fuliginosa -> fuliginosus, which is
 *     one animal. Twenty-one species lost their own records that way.
 *
 * So epithet identity is proof on its own; authorship is only proof once the
 * epithet is already nearly identical. Acacia koaia -> Acacia koa is two edits
 * and would pass rule 3 on distance alone — different authors (Hillebr. vs
 * A.Gray) is what refuses it, which is the case that started all of this.
 */
export function sameOrganism(a: TaxonName, b: TaxonName): boolean {
  const nameA = a.scientificName.trim().toLowerCase().replace(/\s*×\s*/g, " ").replace(/\s+/g, " ");
  const nameB = b.scientificName.trim().toLowerCase().replace(/\s*×\s*/g, " ").replace(/\s+/g, " ");
  if (nameA === nameB) return true;

  const epA = epithetOf(a.scientificName);
  const epB = epithetOf(b.scientificName);
  if (!epA || !epB) return false;
  if (epA === epB) return true;
  // A genus transfer whose epithet changed gender to agree with its new genus
  // (Meiostemon tetrandrus -> Combretum tetrandrum). Both codes require the
  // change (ICZN Art. 34.2, ICN Art. 23.5), so it is the same name, and only
  // across genera: within one genus a termination is the variant passes' call.
  if (genusOf(a.scientificName) !== genusOf(b.scientificName) && canonicalEpithet(epA) === canonicalEpithet(epB)) return true;

  const authA = normaliseAuthorship(a.authorship);
  const authB = normaliseAuthorship(b.authorship);
  if (!authA || !authB || authA !== authB) return false;
  return editDistance(epA, epB) <= MAX_RESPELLING_EDITS;
}

/**
 * Is a CoL synonym just a respelling of the accepted name CoL files it under?
 *
 * CoL marks an orthographic variant as a synonym carrying the accepted name's
 * own author citation: Meandrina danae of M. danai, Clithon oualaniensis of
 * C. oualaniense, both cited to the same authors and year. That is CoL saying
 * the two are one name, so a species matched to the synonym by its own name is
 * the accepted species, not lumped into it. sameOrganism can't see this when
 * the Red List's own citation is mistyped ("Milen-Edwards & Haime, 1948").
 *
 * Asked only of two CoL usages: one genus, the same citation (an abbreviated
 * "f." and "fil." count as one), and an epithet that differs by a Latin ending
 * or a letter or two.
 */
export function isCoLRespelling(synonym: TaxonName, accepted: TaxonName): boolean {
  if (genusOf(synonym.scientificName) !== genusOf(accepted.scientificName)) return false;
  const cite = (a?: string) => normaliseAuthorship(a).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\bfil\b/g, "f");
  const ca = cite(synonym.authorship);
  if (!ca || ca !== cite(accepted.authorship)) return false;
  const a = epithetOf(synonym.scientificName);
  const b = epithetOf(accepted.scientificName);
  if (!a || !b || a === b) return false;
  return canonicalEpithet(a) === canonicalEpithet(b) || editDistance(a, b) <= MAX_RESPELLING_EDITS;
}

/**
 * Does the Red List assess this other name in its own right?
 *
 * Even when CoL is sure two names are one taxon, the Red List having assessed
 * both means one key cannot serve both: whichever species claims it first wins
 * and the other is left with nothing, so Red List row order silently decides
 * which of the pair keeps the records. Fifty-four species were resolved that
 * way, twenty-two of them CR/EN/VU — Actinodaphne latifolia (CR) showing
 * A. nitida's records, Pleurobema furvum (CR) showing P. rubellum's.
 *
 * Each keeping its own usage is the only answer that is right for both.
 */
export function isSeparatelyAssessed(
  otherName: string,
  ownName: string,
  assessedNames: ReadonlySet<string>
): boolean {
  const other = otherName.trim().toLowerCase();
  return other !== ownName.trim().toLowerCase() && assessedNames.has(other);
}

/**
 * What happened to a species when it was matched. assessment-link.ts records it on
 * each assessment_link row, so every later step reads the decision instead of
 * making its own.
 */
export type Verdict =
  /** GBIF's accepted usage is this species, under this name or a rename of it. */
  | "own"
  /** CoL folds it into a different species; we keep its own usage, counted separately. */
  | "lumped"
  /** CoL folds it into a different species and we cannot safely keep anything. */
  | "refused"
  /** No usable match. */
  | "none";

export interface KeyDecision {
  key: string | null;
  verdict: Verdict;
  /** Human-readable, so "why does this species show nothing?" is answerable (sync:trace). */
  reason: string;
  /** What CoL makes of the name, as assessment_link's col_treatment. */
  treatment: "accepted" | "synonym, other name" | "lumped, unassessed" | "lumped, assessed";
  /** The taxon CoL wanted to fold this species into, when it did. */
  lumpedInto?: string;
}

/**
 * The decision itself, for one matched name.
 *
 * `reachedBy` is what separates the safe case from the dangerous one. Searching
 * the species' OWN name and getting a usage back means that usage is this
 * species' name — including when GBIF labels the match VARIANT, which is just
 * its way of saying "same name, spelled differently". Searching one of the Red
 * List's SYNONYMS can instead land on another species' accepted usage:
 * Catapodium borgesii, a VU grass, came back holding Catapodium
 * marinum's key and 19,901 records of a widespread European grass.
 */
export function decideKey(input: {
  species: TaxonName;
  /** Which of the species' names was searched to get this result. */
  reachedBy: "canonical" | "synonym";
  /** The usage GBIF matched the searched name to. */
  usage: TaxonName & { key: string };
  /** The accepted usage CoL redirects that one to, when it is a synonym. */
  acceptedUsage?: TaxonName & { key: string };
  assessedNames: ReadonlySet<string>;
}): KeyDecision {
  const { species, reachedBy, usage, acceptedUsage, assessedNames } = input;
  const target = acceptedUsage ?? usage;

  if (sameOrganism(species, target)) {
    if (isSeparatelyAssessed(target.scientificName, species.scientificName, assessedNames)) {
      return {
        key: null,
        verdict: "refused",
        reason: `CoL holds it as ${target.scientificName}, which the Red List assesses separately; counts nothing`,
        treatment: "lumped, assessed",
        lumpedInto: target.scientificName,
      };
    }
    const renamed = !!acceptedUsage && acceptedUsage.key !== usage.key;
    return { key: target.key, verdict: "own", treatment: renamed ? "synonym, other name" : "accepted",
      reason: renamed ? `renamed: CoL accepts it as ${target.scientificName}` : "the species itself" };
  }

  // A lump. Its own usage is still worth keeping — but only if we got here by
  // its own name, so we know the usage really is this species'.
  if (reachedBy === "canonical" && sameOrganism(species, usage)) {
    return {
      key: usage.key,
      verdict: "lumped",
      reason: `CoL folds it into ${target.scientificName}; only the records under its own name count`,
      treatment: "lumped, unassessed",
      lumpedInto: target.scientificName,
    };
  }
  return {
    key: null,
    verdict: "refused",
    reason: `CoL folds it into ${target.scientificName}, reached only through a synonym; counts nothing`,
    treatment: "lumped, assessed",
    lumpedInto: target.scientificName,
  };
}
