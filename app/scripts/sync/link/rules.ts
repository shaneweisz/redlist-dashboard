/**
 * The link's rules after the name and concept steps (assessment-link.ts), each a
 * named function: what it decides, in one sentence, why it exists, and the rows
 * it adds or changes. buildLink applies them in order and logs how many species
 * each one touched, so a rule that touches almost nothing shows up as a
 * candidate to drop or turn into a decision.
 *
 * Each takes the link rows built so far and plain rows of evidence (read from
 * the build in assessment-link.ts), so it can be tested on a few rows
 * (__tests__/link-rules.test.ts).
 */

import { sameOrganism, isSeparatelyAssessed, type Verdict } from "./species-key";
import { compareAuthors, normaliseAuthorship } from "../../../src/lib/authors";
import { orthographicKey } from "./name-variants";

export interface LinkRow {
  sis_taxon_id: number;
  role: "primary" | "covered";
  /** The CoL species it is part of. */
  col_species_id: string | null;
  /**
   * The CoL taxon it is: the species itself, or the subspecies or synonym CoL
   * folds it in as. Its records are counted from there down, when `counted`.
   */
  col_taxon_id: string | null;
  verdict: Verdict | "duplicate";
  method: string;
  basis: "matcher" | "decision" | "rule" | null;
  decided_by: string | null;
  /**
   * How the Red List name found its CoL record, a fixed label: exact, unique |
   * exact, homonym, author decides | exact, duplicate in CoL | spelling variant
   * | override | waiting. A covered row's names the rule that added it.
   */
  match_reason: string | null;
  /**
   * What CoL makes of that record: accepted | synonym, other name | synonym,
   * other spelling | lumped, unassessed | lumped, assessed; a covered row's, the
   * record's CoL status. Empty with no link.
   */
  col_treatment: string | null;
  /** Both, and what counts, in a sentence with the names, authors and ids (filled once every rule has run). */
  match_description: string | null;
  /** Why a person needs to look at this link: no decision yet, an override that no longer holds or isn't reviewed. Empty when nothing needs a person. */
  to_review: string | null;
  counted: boolean;
}

/** Ownership order: the more direct the name, the stronger the claim. */
const METHODS = ["accepted", "synonym", "provisional", "ambiguous_synonym",
  "iucn_synonym_covered", "same_name_twin", "respelled_twin", "same_name_synonym", "undecided_candidate"] as const;

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const genus = (n: string) => n.split(" ")[0].toLowerCase();

/**
 * Adds covered rows to `links`, once each, and never one for a species' own
 * target, except as a second usage a lumped species owns. Shared by the covered
 * rules, so a row the first rule adds isn't added again by a later one.
 * Returns whether the row was added.
 */
export type Cover = (row: Omit<LinkRow, "basis" | "decided_by" | "role" | "to_review" | "col_treatment" | "match_description">) => boolean;

export function coverer(links: LinkRow[]): Cover {
  const primaryTarget = new Map(links.filter((l) => l.role === "primary").map((l) => [l.sis_taxon_id, l.col_species_id]));
  const seen = new Set<string>();
  return (row) => {
    // One row per species, taxon counted from (none when nothing counts), so a refused row and an own one for one species stay two.
    const k = `${row.sis_taxon_id}|${row.col_species_id}|${row.counted ? row.col_taxon_id : ""}`;
    if (seen.has(k) || (row.verdict !== "lumped" && primaryTarget.get(row.sis_taxon_id) === row.col_species_id)) return false;
    seen.add(k);
    links.push({ ...row, role: "covered", basis: "rule", decided_by: null, to_review: null, col_treatment: null, match_description: null });
    return true;
  };
}

/** A CoL species an assessed species' name or one of IUCN's synonyms leads to. */
export interface SynonymCandidate {
  sis: number; name: string; authority: string | null;
  target_id: string; target_name: string; target_authorship: string | null;
  /** 0: the name is that accepted species; 1: it is a strict synonym of it. */
  kind: number;
  /** iucn: one of IUCN's synonyms; own_name_synonym: the species' own name, as a CoL synonym. */
  src: "iucn" | "own_name_synonym";
}

/**
 * Rule: another accepted CoL species that one of IUCN's synonyms names, or that
 * the species' own name is a CoL synonym of, is the same organism, so it is
 * covered: kept off the Not Evaluated list, and counted when the evidence is
 * direct (Hylatomus / Dryocopus pileatus). Reached through a CoL synonym it is
 * not counted: that two-hop route took Chiococca alba to the snowberry. Under
 * another genus the authors must agree too: Himantopus leucocephalus Gould is
 * the pied stilt, not the banded stilt Cladorhynchus leucocephalus (Vieillot).
 */
export function coverSynonymSpecies(cover: Cover, candidates: SynonymCandidate[], assessedNames: Set<string>): Set<number> {
  const touched = new Set<number>();
  for (const c of candidates) {
    const otherGenus = genus(c.name) !== genus(c.target_name);
    const authorsAgree = !c.authority || !c.target_authorship || compareAuthors(c.authority, c.target_authorship) === "same";
    const same = (c.kind === 0 || c.src === "own_name_synonym")
      && sameOrganism({ scientificName: c.name, authorship: c.authority ?? undefined }, { scientificName: c.target_name, authorship: c.target_authorship ?? undefined })
      && (!otherGenus || authorsAgree)
      && !isSeparatelyAssessed(c.target_name, c.name, assessedNames);
    const added = cover({
      sis_taxon_id: c.sis, col_species_id: c.target_id, col_taxon_id: c.target_id, verdict: same ? "own" : "refused",
      method: "iucn_synonym_covered", match_reason: same ? "CoL duplicate, Red List synonym" : "Red List synonym",
      counted: same,
    });
    if (added) touched.add(c.sis);
  }
  return touched;
}

/** An accepted (or provisionally accepted) CoL species, as the twin rules compare them. */
export interface AcceptedSpecies { col_id: string; scientific_name: string; authorship: string | null; family: string | null; class_name: string | null }

/** Adds a covered row for `id` beside a species' own target, unless it is a species the Red List assesses separately. */
function coverAlongside(cover: Cover, l: LinkRow, target: AcceptedSpecies, other: AcceptedSpecies, listedName: string | undefined,
  assessedNames: Set<string>, method: string, match_reason: string): boolean {
  // A twin carrying this species' own Red List name is this species, not a
  // separately assessed one (Utricularia ochroleuca, matched to its × twin).
  const ownName = norm(other.scientific_name) === listedName;
  if (other.col_id === target.col_id || (!ownName && isSeparatelyAssessed(other.scientific_name, target.scientific_name, assessedNames))) return false;
  return cover({ sis_taxon_id: l.sis_taxon_id, col_species_id: other.col_id, col_taxon_id: other.col_id, verdict: "own", method, match_reason, counted: true });
}

/** Each assessed species' own target: its primary row, when the species is that CoL species. */
const ownTargets = (links: LinkRow[]) => links.filter((l) => l.role === "primary" && l.verdict === "own" && l.col_species_id);

const twinName = (n: string) => n.toLowerCase().replace(/\s*×\s*/g, " ").replace(/\s+/g, " ").trim();
const twinKeys = (x: AcceptedSpecies) => [
  ...(x.class_name ? [`c|${x.class_name}|${twinName(x.scientific_name)}`] : []),
  ...(x.authorship ? [`a|${normaliseAuthorship(x.authorship)}|${twinName(x.scientific_name)}`] : []),
];

/**
 * Rule: CoL holding one name twice, the identical name (a hybrid sign aside:
 * Utricularia × ochroleuca) in one class or under one author citation, is one
 * organism, so both count (Andoa berthelotiana sits in two moss families, both
 * "(Mont.) Ochyra"). Class, not kingdom: Centropogon australis is a plant and a fish.
 *
 * So is the name spelt two ways the codes make one name (name-variants.ts), in
 * one class, where the citations name the same author and year, or one has
 * none (CoL's extra copies often don't): CoL holds the yellow-billed magpie as
 * Pica nutallii and, outside its curated core, as Pica nuttalli with 121,763
 * records; and Witheringia stramoniifolia beside stramonifolia, both Kunth.
 * Folded endings alone are too loose: Mycalesis ita Felder, 1863 and M. itys
 * Felder, 1867 fold alike and are two butterflies. A respelling the Red List
 * assesses separately is left alone.
 */
export function coverTwins(links: LinkRow[], cover: Cover, accepted: AcceptedSpecies[], listedName: Map<number, string>,
  assessedNames: Set<string>): Set<number> {
  const byId = new Map(accepted.map((x) => [x.col_id, x]));
  const twins = new Map<string, string[]>();
  for (const x of accepted) for (const t of twinKeys(x)) twins.set(t, [...(twins.get(t) ?? []), x.col_id]);
  const spellingKey = (x: AcceptedSpecies) => { const k = x.class_name ? orthographicKey(x.scientific_name) : null; return k ? `${x.class_name}|${k}` : null; };
  const respellings = new Map<string, string[]>();
  for (const x of accepted) { const k = spellingKey(x); if (k) respellings.set(k, [...(respellings.get(k) ?? []), x.col_id]); }
  const touched = new Set<number>();
  for (const l of ownTargets(links)) {
    const t = byId.get(l.col_species_id!);
    if (!t) continue;
    const same = new Set(twinKeys(t).flatMap((k) => twins.get(k) ?? []));
    for (const id of same) {
      if (coverAlongside(cover, l, t, byId.get(id)!, listedName.get(l.sis_taxon_id), assessedNames, "same_name_twin", "CoL duplicate")) {
        touched.add(l.sis_taxon_id);
      }
    }
    const k = spellingKey(t);
    for (const id of k ? respellings.get(k) ?? [] : []) {
      const other = byId.get(id)!;
      if (same.has(id) || (t.authorship && other.authorship && compareAuthors(t.authorship, other.authorship) !== "same")) continue;
      if (coverAlongside(cover, l, t, other, listedName.get(l.sis_taxon_id), assessedNames, "respelled_twin",
        "CoL duplicate, respelled")) touched.add(l.sis_taxon_id);
    }
  }
  return touched;
}

/** A CoL synonym usage carrying an assessed species' exact name, and the species CoL files it under. */
export interface SameNameSynonym { sis: number; usage: string; target: string; authority?: string | null; authorship?: string | null }

/**
 * Rule: a lumped species owns every synonym usage carrying its exact name, not
 * just the one matched, when its authors aren't clearly others: the same name by
 * another author is another organism (Ilex wallichii Hook.f. is not Steudel's,
 * filed under I. malayana), as for a synonym match (accept-match.ts).
 */
export function coverSameNameSynonyms(links: LinkRow[], cover: Cover, synonyms: SameNameSynonym[]): Set<number> {
  const lumped = new Map(links.filter((l) => l.role === "primary" && l.verdict === "lumped" && ["synonym", "ambiguous_synonym"].includes(l.method))
    .map((l) => [l.sis_taxon_id, l]));
  const touched = new Set<number>();
  for (const x of synonyms) {
    const l = lumped.get(x.sis);
    if (!l || x.usage === l.col_taxon_id || compareAuthors(x.authority, x.authorship) === "other") continue;
    if (cover({ sis_taxon_id: x.sis, col_species_id: x.target, col_taxon_id: x.usage, verdict: "lumped", method: "same_name_synonym",
      match_reason: "name under another species", counted: true })) touched.add(x.sis);
  }
  return touched;
}

/** A CoL species a species waiting for a decision might be: its name leads there, or the matcher guessed it. */
export interface Candidate { sis: number; target_id: string; target_name: string }

/** A primary row the matcher's answer made though the rule doubts it (assessment-link.ts). */
export const isUnconfirmed = (l: Pick<LinkRow, "match_reason">) => !!l.match_reason?.startsWith("unconfirmed: ");

/**
 * Rule: for a species whose link is unconfirmed or still waiting, every CoL
 * species its own name leads to (as an accepted name, or as a synonym CoL files
 * under it), and the matcher's guess, is a candidate: a row counting nothing,
 * which the Not Evaluated list shows flagged ("may be the assessed X") rather
 * than as plainly unassessed (Agama armata; Coenonympha gardetta's name, which
 * CoL files under the small heath, C. pamphilus). Its records count for it there.
 */
export function coverUndecidedCandidates(links: LinkRow[], cover: Cover, candidates: Candidate[]): Set<number> {
  const waiting = new Set(links.filter((l) => l.role === "primary" && (!l.col_species_id || isUnconfirmed(l))).map((l) => l.sis_taxon_id));
  const touched = new Set<number>();
  for (const c of candidates) {
    if (!waiting.has(c.sis)) continue;
    if (cover({ sis_taxon_id: c.sis, col_species_id: c.target_id, col_taxon_id: c.target_id, verdict: "refused", method: "undecided_candidate",
      match_reason: "candidate", counted: false })) touched.add(c.sis);
  }
  return touched;
}

/**
 * Rule: no link crosses a phylum, however it was made: old genus names are
 * homonyms across kingdoms (the surgeonfish Acanthurus lineatus and the crab
 * Hepatus lineatus), and twins and lumps are found by name alone. A covered row
 * across one goes; a primary row is unlinked. `crossing` holds the
 * "sis|col_species_id" pairs whose lineages differ (assessment-link.ts asks the build).
 */
export function dropCrossPhylum(links: LinkRow[], crossing: Set<string>): Set<number> {
  const touched = new Set<number>();
  for (let i = links.length - 1; i >= 0; i--) {
    const l = links[i];
    if (!l.col_species_id || !crossing.has(`${l.sis_taxon_id}|${l.col_species_id}`)) continue;
    touched.add(l.sis_taxon_id);
    if (l.role === "covered") { links.splice(i, 1); continue; }
    Object.assign(l, { col_species_id: null, col_taxon_id: null, verdict: "none", method: "unmatched", counted: false,
      match_reason: "only match in another phylum", col_treatment: null });
  }
  return touched;
}

/**
 * Rule: each usage counts for one assessed species at most. When two claim it,
 * one wins: confirmed before unconfirmed (an unconfirmed link never takes a
 * confirmed species' records; it loses, flagged), then primary before covered, own before lumped, the matcher before a
 * decision, the more direct name, the name CoL spells exactly before a spelling
 * variant of it, then the lower SIS id. The loser counts nothing; a losing
 * primary row becomes a duplicate. The spelling matters where the Red List
 * assesses one plant twice under two spellings (Peltophorum dasyrhachis, as CoL
 * writes it, and dasyrachis): the exact one keeps the records.
 *
 * `exactName`: the species whose primary row's CoL name is their Red List name, as written.
 */
export function oneOwnerPerUsage(links: LinkRow[], exactName: Set<number> = new Set()): Set<number> {
  const unconfirmed = new Set(links.filter((l) => l.role === "primary" && isUnconfirmed(l)).map((l) => l.sis_taxon_id));
  const rank = (l: LinkRow) => [unconfirmed.has(l.sis_taxon_id) ? 1 : 0, l.role === "primary" ? 0 : 1, l.verdict === "own" ? 0 : 1, l.basis === "decision" ? 1 : 0,
    Math.max(0, (METHODS as readonly string[]).indexOf(l.method)), l.role === "primary" && exactName.has(l.sis_taxon_id) ? 0 : 1, l.sis_taxon_id];
  const claimants = links.filter((l) => l.counted).sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const owner = new Map<string, number>();
  const touched = new Set<number>();
  for (const l of claimants) {
    const prev = owner.get(l.col_taxon_id!);
    if (prev === undefined) { owner.set(l.col_taxon_id!, l.sis_taxon_id); continue; }
    l.counted = false;
    touched.add(l.sis_taxon_id);
    // Still that taxon: only its records go to the other species.
    if (l.role === "primary") l.verdict = "duplicate";
  }
  return touched;
}
