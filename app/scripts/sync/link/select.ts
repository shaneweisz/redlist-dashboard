/**
 * The selection rule of docs/specs/matching.md: for one assessed species, the
 * CoL records that represent it, each with its relation, and the species'
 * doubts or the reason nothing was taken. This code is what the rule does and
 * the spec is what it is meant to do: the rebuild check and the tests keep the
 * two in step. Section names below are the spec's headings.
 *
 * select() is pure: a species and the release's lookups.
 * selectAll() reads a build (sources/ and link/matches.parquet) and runs every
 * species in two passes, as the synonym records need to know which CoL
 * species other assessed species' steps count whole.
 *
 * Usage: npm run sync:select [-- --build <dir>]   writes every species' selection as JSON to stdout
 */

import {
  compareAuthors, orthographicallySame, sameName, sameNameKey, sameOrganism, isCoLRespelling, type TaxonName,
} from "./name-rules";
import { answerKey, reviewBasis, REVIEW_DOUBT, type Review } from "./ai-reviews";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The accepted or provisional CoL species a record leads to (speciesOf). */
export interface ColSpecies { id: string; name: string; authorship: string | null; class: string | null; kingdom: string | null; phylum: string | null }

/** A CoL record (a name usage). Status and rank in the matcher's forms: SYNONYM, AMBIGUOUS_SYNONYM, SPECIES. */
export interface ColRecord {
  id: string; name: string; authorship: string | null; rank: string; status: string;
  /** The matcher's classification points for it against the hints; candidates only. */
  classification?: number | null;
  species: ColSpecies | null;
}

export interface Synonym { name: string; authors: string[] }

export interface SpeciesInput {
  sis: number;
  name: string;
  authority: string | null;
  kingdom: string | null;
  phylum: string | null;
  /** In the Red List's order. */
  synonyms: Synonym[];
  /** The matcher's response; null if it wasn't asked or found nothing. */
  match: { matchType: string | null; answerName: string | null; answer: ColRecord | null; alternatives: ColRecord[] } | null;
}

/** What select() needs from the release beyond the species itself. */
export interface Release {
  /** Every assessed name, as sameNameKey. */
  assessedNames: Set<string>;
  /** Species-rank CoL records with the same or an orthographicallySame name. */
  recordsNamed(name: string): ColRecord[];
  /** Occurrences under a record: its own and the records below it. */
  occurrencesUnder(id: string): number;
  /** A CoL record by id, any rank (the matcher's records). */
  byId(id: string): ColRecord | undefined;
  /** CoL species id → the assessed species whose steps count it whole (pass 1 of selectAll). */
  wholeBySteps: Map<string, Set<number>>;
}

export type Relation = "is" | "part of" | "split into" | "refused";
export type Basis = "matcher" | "citation" | "synonym";
/** 1-5 for the steps' records; 1, 2, 3 (with the doubt) or 3s (s already reached by the steps) for synonym records. */
export type RelationStep = 1 | 2 | 3 | 4 | 5 | "3s";

export interface Selected { record: ColRecord; relation: Relation; relationStep: RelationStep; basis: Basis }

export type Doubt =
  | "chosen by the citation" | "homonym" | "other authors" | "other spelling" | "ambiguous synonym" | "placed elsewhere"
  | "counts nothing" | "split, authors unclear" | "synonym filed elsewhere" | typeof REVIEW_DOUBT;
export const DOUBTS: Doubt[] = ["chosen by the citation", "homonym", "other authors", "other spelling", "ambiguous synonym",
  "placed elsewhere", "counts nothing", "split, authors unclear", "synonym filed elsewhere", REVIEW_DOUBT];

export type Reason = "informal or qualified name" | "no candidate";

export interface Selection {
  sis: number;
  step: 1 | 2 | 3 | 4 | 5;
  reason: Reason | null;
  doubts: Doubt[];
  /** The steps' records first (the first is the primary row), then synonym records. */
  selected: Selected[];
  /** The number of candidate groups. */
  groups: number;
  /** The CoL species of the groups not taken (for candidate rows and the NE list's notes). */
  untakenSpecies: ColSpecies[];
  /** The candidates' CoL species names, sorted: part of a review's basis. */
  candidateSpecies: string[];
  /** Listed for review: to_review's text, or null. */
  toReview: string | null;
  /** The AI taxonomic reviewers' answers, where they apply: shown beside the records, never counted. */
  reviews?: Review[];
}

// ── Definitions ───────────────────────────────────────────────────────────────

const INFORMAL_NAME = /\b(aff|cf|sp|spp|nov|indet)\.|\[|\bsp\b/i;
const QUALIFIED_CITATION = /\bauct\b\.?|\bnon\b|\bsensu\b/i;
const PRO_PARTE = /\bpro parte\b|(^|[\s,(])p\.\s?p\./;

/** Red List citation: the authority without "ined." and a comma before it; none if empty. */
export const citationOf = (authority: string | null) => (authority ?? "").replace(/,?\s*ined\./g, "").trim() || null;

const qualifiedAuthor = (a: string) => QUALIFIED_CITATION.test(a) || PRO_PARTE.test(a);

const phylumKey = (p: string | null) => { const x = (p ?? "").toLowerCase(); return x === "heterokontophyta" ? "ochrophyta" : x; };

/** Agrees with the lineage: speciesOf exists, and its kingdom and phylum equal the Red List's, a missing one agreeing. */
export function agreesWithLineage(r: ColRecord, sp: Pick<SpeciesInput, "kingdom" | "phylum">): boolean {
  const s = r.species;
  if (!s) return false;
  const kingdomOk = !s.kingdom || !sp.kingdom || s.kingdom.toLowerCase() === sp.kingdom.toLowerCase();
  const phylumOk = !s.phylum || !sp.phylum || phylumKey(s.phylum) === phylumKey(sp.phylum);
  return kingdomOk && phylumOk;
}

const acceptedOrProvisional = (r: ColRecord) => r.status === "ACCEPTED" || r.status === "PROVISIONALLY_ACCEPTED";
const named = (r: ColRecord): TaxonName => ({ scientificName: r.name, authorship: r.authorship });
const speciesName = (s: ColSpecies): TaxonName => ({ scientificName: s.name, authorship: s.authorship });

// ── select ────────────────────────────────────────────────────────────────────

export function select(sp: SpeciesInput, release: Release): Selection {
  const citation = citationOf(sp.authority);
  const me: TaxonName = { scientificName: sp.name, authorship: citation };
  const anotherAssessed = (n: string | null | undefined) => !!n && !sameName(n, sp.name) && release.assessedNames.has(sameNameKey(n));
  const res: Selection = { sis: sp.sis, step: 3, reason: null, doubts: [], selected: [], groups: 0, untakenSpecies: [],
    candidateSpecies: [], toReview: null };

  const cands = candidates(sp);
  res.candidateSpecies = [...new Set(cands.map((r) => r.species!.name))].sort();

  // 1. Informal or qualified name.
  if (INFORMAL_NAME.test(sp.name) || (citation && QUALIFIED_CITATION.test(citation))) {
    res.step = 1; res.reason = "informal or qualified name";
    return finish(res);
  }

  const cmp = (r: ColRecord) => compareAuthors(citation, r.authorship);
  let taken: ColRecord[] = [];
  const relationOf = new Map<ColRecord, Relation>();
  if (cands.length === 0) {
    // 2. No candidates.
    res.step = 2; res.reason = "no candidate";
  } else {
    // Groups: candidates with the same speciesOf, joined through copies.
    const groupOf = groups(cands, cmp);
    const G = (r: ColRecord) => groupOf.get(r)!;
    const all = [...new Set(cands.map(G))];
    res.groups = all.length;
    const M = all.filter((g) => cands.some((r) => G(r) === g && cmp(r) === "same"));
    const answer = sp.match?.answer ? cands.find((r) => r.id === sp.match!.answer!.id) ?? null : null;
    const A = answer ? G(answer) : null;
    const contradicted = answer ? cmp(answer) === "other" : false;

    let chosen: number[];
    const step3 = new Set(M);
    if (A !== null && !contradicted) step3.add(A);
    if (step3.size > 0) { chosen = [...step3]; res.step = 3; }
    else if (A !== null) { chosen = [A]; res.step = 4; }
    else {
      const notOther = all.filter((g) => cands.some((r) => G(r) === g && cmp(r) !== "other"));
      chosen = notOther.length ? notOther : all;
      res.step = 5;
    }
    // Every candidate in a chosen group, the answer first, then in the matcher's order.
    taken = cands.filter((r) => chosen.includes(G(r)));
    if (answer && taken.includes(answer)) taken = [answer, ...taken.filter((r) => r !== answer)];
    const untaken = new Map<string, ColSpecies>();
    for (const r of cands) if (!chosen.includes(G(r))) untaken.set(r.species!.id, r.species!);
    res.untakenSpecies = [...untaken.values()];

    // Relations of the steps' records.
    for (const r of taken) {
      const s = r.species!;
      let relation: Relation, step: RelationStep;
      if (r.status === "AMBIGUOUS_SYNONYM") { relation = "part of"; step = 1; }
      else if (r.status === "SYNONYM" && isCoLRespelling(named(r), speciesName(s)) && !anotherAssessed(s.name)) { relation = "is"; step = 2; }
      else if (sameOrganism(me, speciesName(s)) || (orthographicallySame(sp.name, r.name) && sameOrganism(named(r), speciesName(s)))) {
        relation = anotherAssessed(s.name) ? "refused" : "is"; step = 3;
      } else if (sameOrganism(me, named(r)) || orthographicallySame(sp.name, r.name)) { relation = "part of"; step = 4; }
      else { relation = "refused"; step = 5; }
      relationOf.set(r, relation);
      res.selected.push({ record: r, relation, relationStep: step, basis: r === answer ? "matcher" : "citation" });
    }

    // Doubts on the steps' records.
    const d = res.doubts;
    if (!answer || !taken.includes(answer)) d.push("chosen by the citation");
    if (all.length > 1 && !(M.length === 1 && chosen.length === 1 && chosen[0] === M[0])) d.push("homonym");
    if (taken.every((r) => cmp(r) === "other")) d.push("other authors");
    if (answer && taken.includes(answer) && sp.match?.matchType !== "EXACT" && !orthographicallySame(answer.name, sp.name)) d.push("other spelling");
    if (taken.some((r) => r.status === "AMBIGUOUS_SYNONYM")) d.push("ambiguous synonym");
    if (taken.some((r) => r.classification != null && r.classification < 0)) d.push("placed elsewhere");
    if (taken.every((r) => relationOf.get(r) === "refused")) d.push("counts nothing");
  }

  synonymRecords(sp, res, taken, relationOf, release, citation, anotherAssessed);
  return finish(res);
}

/** to_review: the first doubt (with them all), else the reason. */
function finish(res: Selection): Selection {
  res.toReview = res.doubts.length ? `${res.doubts[0]} (${res.doubts.join("; ")})` : res.reason;
  return res;
}

/**
 * Candidates: the answer and alternatives, once each, at species rank, not
 * MISAPPLIED, that agree with the lineage and have the same name as `name` or
 * the answer, or are orthographicallySame as `name`.
 */
export function candidates(sp: SpeciesInput): ColRecord[] {
  if (!sp.match) return [];
  const seen = new Set<string>();
  const out: ColRecord[] = [];
  for (const r of [...(sp.match.answer ? [sp.match.answer] : []), ...sp.match.alternatives]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.rank !== "SPECIES" || r.status === "MISAPPLIED" || !agreesWithLineage(r, sp)) continue;
    if (sameName(r.name, sp.name) || (sp.match.answerName && sameName(r.name, sp.match.answerName)) || orthographicallySame(sp.name, r.name)) out.push(r);
  }
  return out;
}

/**
 * Copies: the same or orthographicallySame names, whose authorships compare
 * `same`, or that are both accepted or provisional in one known class and don't
 * compare `other` (CoL often holds a copy with no authorship or a year apart:
 * Harpia harpyja).
 */
export function copies(a: ColRecord, b: ColRecord): boolean {
  if (!sameName(a.name, b.name) && !orthographicallySame(a.name, b.name)) return false;
  const c = compareAuthors(a.authorship, b.authorship);
  const oneClass = acceptedOrProvisional(a) && acceptedOrProvisional(b) && !!a.species?.class && a.species.class === b.species?.class;
  return c === "same" || (oneClass && c !== "other");
}

/**
 * Groups: candidates with the same speciesOf, joined (transitively) through
 * copies: two records the citation doesn't contradict, with the same or
 * orthographicallySame names, whose authorships compare `same`, or that are
 * both accepted or provisional in one known class and don't compare `other`.
 * Returns each candidate's group number.
 */
function groups(cands: ColRecord[], cmp: (r: ColRecord) => string): Map<ColRecord, number> {
  const index = new Map<string, number>();
  const parent: number[] = [];
  for (const r of cands) if (!index.has(r.species!.id)) { index.set(r.species!.id, parent.length); parent.push(parent.length); }
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    const a = cands[i], b = cands[j];
    if (a.species!.id === b.species!.id || cmp(a) === "other" || cmp(b) === "other") continue;
    if (copies(a, b)) parent[find(index.get(a.species!.id)!)] = find(index.get(b.species!.id)!);
  }
  return new Map(cands.map((r) => [r, find(index.get(r.species!.id)!)]));
}

/**
 * Synonym records (steps 2 to 5): each Red List synonym, in order, adds the
 * CoL records with its name, accepted and provisional first, then by id, that
 * agree with the lineage, aren't taken, don't lead to a species already
 * counted whole, and whose authorship one of its unqualified authors doesn't
 * compare `other` with (or it has none); if one of those compares `same`,
 * only such records and their copies.
 */
function synonymRecords(sp: SpeciesInput, res: Selection, taken: ColRecord[], relationOf: Map<ColRecord, Relation>, release: Release,
  citation: string | null, anotherAssessed: (n: string | null | undefined) => boolean): void {
  const me: TaxonName = { scientificName: sp.name, authorship: citation };
  const stepSpecies = new Set(taken.map((r) => r.species!.id));
  const takenIds = new Set(res.selected.map((x) => x.record.id));
  const whole = new Set(taken.filter((r) => relationOf.get(r) === "is").map((r) => r.species!.id));
  let splitUnclear = false, filedElsewhere = false;

  for (const syn of sp.synonyms) {
    const unqualified = syn.authors.filter((a) => !qualifiedAuthor(a));
    if (syn.authors.length > 0 && unqualified.length === 0) continue;
    const order = (r: ColRecord) => (acceptedOrProvisional(r) ? 0 : 1);
    const pool = release.recordsNamed(syn.name)
      .filter((r) => r.rank === "SPECIES" && r.status !== "MISAPPLIED")
      .sort((a, b) => order(a) - order(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let eligible = pool.filter((r) => agreesWithLineage(r, sp) && !takenIds.has(r.id) && !whole.has(r.species!.id)
      && (unqualified.length === 0 || unqualified.some((a) => compareAuthors(a, r.authorship) !== "other")));
    const sameAuthors = (r: ColRecord) => unqualified.some((a) => compareAuthors(a, r.authorship) === "same");
    // Matching records win over ones merely not contradicted, as in the steps; their copies come along.
    const matching = eligible.filter(sameAuthors);
    if (matching.length > 0) eligible = eligible.filter((r) => sameAuthors(r) || matching.some((m) => copies(m, r)));

    for (const r of eligible) {
      if (takenIds.has(r.id) || whole.has(r.species!.id)) continue;
      const s = r.species!;
      const isS = r.id === s.id;
      let relation: Relation, step: RelationStep;
      if (sameOrganism(me, speciesName(s)) && ((isS && compareAuthors(citation, s.authorship) !== "other")
          || (r.status === "SYNONYM" && compareAuthors(citation, s.authorship) === "same"))) { relation = "is"; step = 1; }
      else if (isS) { relation = "split into"; step = 2; }
      else if (stepSpecies.has(s.id)) { relation = "part of"; step = "3s"; }
      else {
        // s is another species the steps don't reach: the record counts only its own name, if no other assessed species has s.
        const otherWhole = [...(release.wholeBySteps.get(s.id) ?? [])].some((x) => x !== sp.sis);
        if (anotherAssessed(s.name) || otherWhole) continue;
        relation = "part of"; step = 3;
      }
      if ((step === 1 || step === 2) && anotherAssessed(s.name)) relation = "refused";
      takenIds.add(r.id);
      if (relation === "is" || relation === "split into") whole.add(s.id);
      if (relation === "split into" && !sameAuthors(r)) splitUnclear = true;
      if (step === 3 && release.occurrencesUnder(r.id) > 0) filedElsewhere = true;
      res.selected.push({ record: r, relation, relationStep: step, basis: "synonym" });
    }
  }
  if (splitUnclear) res.doubts.push("split, authors unclear");
  if (filedElsewhere) res.doubts.push("synonym filed elsewhere");
}

/** A selection's records as answerKey reads them. */
export const answerRecords = (s: Selection) => s.selected.map((x) => ({ name: x.record.name, authorship: x.record.authorship, status: x.record.status,
  species: x.record.species?.name ?? null, relation: x.relation }));

/** The CoL species a selection counts whole: its *is* and *split into* records' species. */
export const countedWhole = (s: Selection) => s.selected.filter((x) => x.relation === "is" || x.relation === "split into").map((x) => x.record.species!.id);

/**
 * Every species, in two passes: the steps (without synonym records) to learn
 * which CoL species each assessed species' steps count whole, then each
 * species in full.
 */
export function selectEvery(species: SpeciesInput[], release: Omit<Release, "wholeBySteps">,
  /** The AI taxonomic reviews, applied while the rules give the answer and basis they were given (ai-reviews.ts). */
  reviews: Map<number, Review[]> = new Map()): Selection[] {
  const wholeBySteps = new Map<string, Set<number>>();
  const firstPass: Release = { ...release, wholeBySteps: new Map() };
  for (const sp of species) {
    for (const id of countedWhole(select({ ...sp, synonyms: [] }, firstPass))) {
      (wholeBySteps.get(id) ?? wholeBySteps.set(id, new Set()).get(id)!).add(sp.sis);
    }
  }
  const full: Release = { ...release, wholeBySteps };
  return species.map((sp) => {
    const s = select(sp, full);
    const rs = reviews.get(sp.sis);
    if (!rs?.length) return s;
    const answer = answerKey(answerRecords(s)), basis = reviewBasis(sp, s);
    if (!rs.every((r) => r.rulesAnswer === answer && r.basis === basis)) return s;
    s.reviews = rs;
    // Every reviewer agrees: the species leaves the review list, keeping its doubts. One suggests other records: a doubt.
    if (rs.every((r) => r.finding === "agrees")) s.toReview = null;
    else if (rs.some((r) => r.finding === "other records")) {
      s.doubts.push(REVIEW_DOUBT);
      s.toReview = `${REVIEW_DOUBT} (${rs.map((r) => r.finding).join("; ")})`;
    }
    return s;
  });
}
