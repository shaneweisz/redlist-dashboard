/**
 * assessment_link: which CoL species each assessed species is. One primary row
 * per assessed species, plus covered rows for other CoL species that are the
 * same organism. Its columns are the link's contract with the rest of the sync:
 * whatever builds it, the count stage and the lists read only these.
 *
 * Built from: taxa, assessments, matches, seeds/match-overrides.tsv.
 *
 * Columns:
 *   sis_taxon_id
 *   role         primary (the species itself) | covered (another CoL species the
 *                same organism sits under)
 *   col_species_id  the CoL species it is part of
 *   col_taxon_id    the CoL taxon it is: the species itself, or the subspecies
 *                   or synonym CoL folds it in as; its records are counted from
 *                   there down when `counted`. Empty only when there's no link.
 *   verdict      own | lumped | refused | none | duplicate
 *   method       what kind of usage the name is (accepted, synonym,
 *                provisional, ambiguous_synonym, or the covered row's rule)
 *   basis        matcher | decision | rule
 *   decided_by   who made the decision, for basis = decision
 *   reason       one sentence on why
 *   counted      whether the row's records count
 *
 * Also writes match-queue.tsv: the species waiting for a person.
 *
 * Decisions, in two steps kept apart so each can be explained on its own:
 *
 * 1. Name: which CoL usage the Red List name is.
 *      a decision in match-overrides.tsv, if there is one and it still resolves;
 *      else GBIF's matcher's answer (matches.ts), when accept-match.ts takes it
 *      without review;
 *      else nothing yet: the species is queued and counts no records until
 *      someone decides.
 *
 * 2. Concept: what that usage makes the species.
 *      - An accepted CoL species is the species (own).
 *      - A synonym of a species the Red List treats the same way is the
 *        species too, renamed (own); one CoL folds into another species
 *        keeps only the records filed under its own name (lumped), or
 *        nothing if that species is assessed separately (refused). See
 *        species-key.ts' decideKey.
 *      - An ambiguous synonym, a name CoL can't place, keeps only its own records.
 *
 * 3. The rules after it (rules.ts), in order, each a named function logged
 *    with how many species it touched:
 *      - covered rows: other CoL species the same organism sits under (IUCN's
 *        synonyms, CoL holding a name twice, one organism under two genera, a
 *        lumped species' other same-name synonyms), and for a species waiting
 *        for a decision, the CoL species it might be, kept off the NE list
 *      - no link across a phylum
 *      - every usage counts for one assessed species at most
 */

import * as fs from "fs";
import { decideKey, isSeparatelyAssessed, isCoLRespelling } from "./species-key";
import { coverer, coverSynonymSpecies, coverTwins, coverDuplicateConcepts, coverSameNameSynonyms, coverUndecidedCandidates, dropCrossPhylum,
  oneOwnerPerUsage, type LinkRow, type SynonymCandidate, type AcceptedSpecies, type SameNameSynonym, type Candidate as UndecidedCandidate } from "./rules";
import { acceptMatch, type MatchAnswer, type QueueReason } from "./accept-match";
import { orthographicallySame } from "./name-variants";
import { readOverrides, resolveOverride, type Candidate, type MatchOverride } from "./match-overrides";
import { output, parquet } from "../paths";
import { lit, rows, writeTable, openDuckDB } from "../sql";

const NAME = (col: string) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export type { LinkRow } from "./rules";

export interface QueueRow {
  sis_taxon_id: number;
  name: string;
  authority: string | null;
  /** undecided: counts nothing yet. proposed: a decision applies, but no person has checked it. stale: a decision no longer resolves. */
  status: "undecided" | "proposed" | "stale";
  reason: string;
  matcher_col_id: string | null;
  matcher_name: string | null;
  matcher_authorship: string | null;
  match_type: string | null;
  confidence: number | null;
  decided_by: string | null;
}

export async function buildLink(
  inputs: { taxa: string; assessments: string; matches: string; decisions?: Map<number, MatchOverride> },
  out: { link: string; matchQueue: string },
): Promise<LinkSummary> {
  const conn = await openDuckDB();
  const decisions = inputs.decisions ?? readOverrides();

  await conn.run(`CREATE OR REPLACE TEMP TABLE redlist_species AS
    SELECT sis_taxon_id::INTEGER AS sis, scientific_name AS name, ${NAME("scientific_name")} AS name_key, authority,
           family, class_name, phylum_name AS phylum, kingdom_name AS kingdom, synonyms
    FROM ${parquet(inputs.assessments)} WHERE is_latest`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE col_usages AS
    SELECT col_id, parent_id, status, rank, scientific_name, authorship, family, class_name, phylum, kingdom, species_id, demoted,
           ${NAME("scientific_name")} AS name_key
    FROM ${parquet(inputs.taxa)}`);

  // IUCN and CoL name one phylum differently (the brown algae); unknown lineage is no evidence.
  const sameLineage = `(r.kingdom IS NULL OR target.kingdom IS NULL OR (r.kingdom = target.kingdom AND (r.phylum IS NULL OR target.phylum IS NULL
    OR replace(r.phylum, 'heterokontophyta', 'ochrophyta') = target.phylum)))`;

  // ── 1. Name ────────────────────────────────────────────────────────────────
  const answers = new Map((await rows<Omit<MatchAnswer, "alternatives"> & { sis_taxon_id: number; alts: string | null }>(conn, `
    SELECT sis_taxon_id, matcher_col_id, matcher_name, matcher_authorship, matcher_rank, matcher_status, match_type, confidence,
           to_json(alternatives)::VARCHAR AS alts
    FROM ${parquet(inputs.matches)}`)).map((m) => [m.sis_taxon_id, { ...m, alternatives: (m.alts ? JSON.parse(m.alts) : null) ?? [] } as MatchAnswer]));
  const speciesOf = new Map((await rows<{ col_id: string; species_id: string | null }>(conn, `
    WITH ids AS (SELECT matcher_col_id AS id FROM ${parquet(inputs.matches)} UNION
                 SELECT unnest(list_transform(alternatives, lambda a: a.col_id)) FROM ${parquet(inputs.matches)})
    SELECT t.col_id, t.species_id FROM ids JOIN col_usages t ON t.col_id = ids.id`)).map((r) => [r.col_id, r.species_id]));
  const decidedNames = [...new Set([...decisions.values()].flatMap((d) => (d.colName ? [norm(d.colName)] : [])))];
  const candidates = new Map<string, Candidate[]>();
  if (decidedNames.length > 0) {
    await conn.run(`CREATE OR REPLACE TEMP TABLE decided_names AS SELECT unnest([${decidedNames.map(lit).join(", ")}]::VARCHAR[]) AS name_key`);
    for (const c of await rows<Candidate & { name_key: string }>(conn, `
        SELECT t.name_key, t.col_id, t.scientific_name, t.authorship, t.status, s.scientific_name AS species_name
        FROM col_usages t JOIN decided_names USING (name_key) LEFT JOIN col_usages s ON s.col_id = t.species_id WHERE t.rank = 'species'`)) {
      candidates.set(c.name_key, [...(candidates.get(c.name_key) ?? []), c]);
    }
  }

  const species = await rows<{ sis: number; name: string; authority: string | null }>(conn, `SELECT sis, name, authority FROM redlist_species ORDER BY sis`);
  // Each species' picked CoL record: the matcher's answer, or an override's.
  const picks: { sis: number; col_id: string; basis: "matcher" | "decision"; by_: string | null }[] = [];
  const queue: QueueRow[] = [];
  const unlinkedReason = new Map<number, string>();
  // Why each species has the CoL name it has, or none (the link's name_reason).
  const nameReason = new Map<number, string>();
  const taken = (a: { why: string; variant?: true }) => `matcher: ${a.why}${a.variant ? ", a spelling the codes allow" : ""}`;
  for (const s of species) {
    const m = answers.get(s.sis);
    const acc = m ? acceptMatch(s, m, (id) => speciesOf.get(id) ?? null) : { accepted: false as const, reason: "no species match" as QueueReason };
    const enqueue = (status: QueueRow["status"], reason: string, by: string | null = null) => queue.push({
      sis_taxon_id: s.sis, name: s.name, authority: s.authority, status, reason,
      matcher_col_id: m?.matcher_col_id ?? null, matcher_name: m?.matcher_name ?? null, matcher_authorship: m?.matcher_authorship ?? null,
      match_type: m?.match_type ?? null, confidence: m?.confidence ?? null, decided_by: by,
    });
    const d = decisions.get(s.sis);
    if (d) {
      const res = resolveOverride(d, s.name, d.colName ? candidates.get(norm(d.colName)) ?? [] : [], s.authority);
      if (res.kind !== "stale") {
        if (!d.reviewed) enqueue("proposed", acc.accepted ? "the matcher would take its answer" : acc.reason, d.by);
        nameReason.set(s.sis, `override by ${d.by}${d.colVersion ? `, decided against ${d.colVersion}` : ""}${res.kind === "usage" ? "" : ": not in CoL"}`);
        if (res.kind === "usage") picks.push({ sis: s.sis, col_id: res.colId, basis: "decision", by_: d.by });
        else unlinkedReason.set(s.sis, `not in CoL (decided by ${d.by})`);
        continue;
      }
      // A decision that no longer resolves is asked again; meanwhile the matcher's answer stands if it is certain.
      enqueue("stale", res.why, d.by);
      nameReason.set(s.sis, acc.accepted ? `${taken(acc)}; its override is stale: ${res.why}` : `waiting: its override is stale: ${res.why}`);
      if (acc.accepted) picks.push({ sis: s.sis, col_id: m!.matcher_col_id!, basis: "matcher", by_: null });
      else unlinkedReason.set(s.sis, `waiting for a decision: ${res.why}`);
      continue;
    }
    if (acc.accepted) { nameReason.set(s.sis, taken(acc)); picks.push({ sis: s.sis, col_id: m!.matcher_col_id!, basis: "matcher", by_: null }); continue; }
    nameReason.set(s.sis, `waiting: ${acc.reason}`);
    enqueue("undecided", acc.reason);
    unlinkedReason.set(s.sis, `waiting for a decision: ${acc.reason}`);
  }
  const rlSis = new Set(species.map((s) => s.sis));
  const orphaned = [...decisions.keys()].filter((k) => !rlSis.has(k));
  if (orphaned.length > 0) console.log(`  ${orphaned.length} decisions name species no longer assessed (SIS ${orphaned.slice(0, 5).join(", ")}${orphaned.length > 5 ? ", ..." : ""})`);

  await writeTable(conn, "picks", { sis: "INTEGER", col_id: "VARCHAR", basis: "VARCHAR", by_: "VARCHAR" }, picks);

  // ── 2. Concept ─────────────────────────────────────────────────────────────
  // The species each usage makes it: itself if accepted, or a synonym's species.
  const primary = await rows<{
    sis: number; name: string; authority: string | null; basis: "matcher" | "decision"; by_: string | null; method: string;
    picked_id: string; picked_name: string; picked_authorship: string | null; picked_status: string;
    picked_parent: string | null; picked_parent_rank: string | null; picked_parent_name: string | null;
    target_id: string | null; target_name: string | null; target_authorship: string | null;
  }>(conn, `
    WITH picked AS (
      SELECT pick.sis, pick.basis, pick.by_, usage.*,
             CASE WHEN usage.status = 'accepted' THEN 'accepted'
                  WHEN usage.status = 'provisionally accepted' THEN 'provisional' WHEN usage.status = 'synonym' THEN 'synonym'
                  WHEN usage.status = 'ambiguous synonym' THEN 'ambiguous_synonym' ELSE replace(usage.status, ' ', '_') END AS method,
             CASE WHEN usage.status IN ('accepted', 'provisionally accepted') THEN usage.col_id
                  WHEN usage.status IN ('synonym', 'ambiguous synonym') THEN usage.species_id END AS target_col_id
      FROM picks pick JOIN col_usages usage ON usage.col_id = pick.col_id)
    SELECT r.sis, r.name, r.authority, picked.basis, picked.by_, picked.method,
           picked.col_id AS picked_id, picked.scientific_name AS picked_name, picked.authorship AS picked_authorship,
           picked.status AS picked_status, picked.parent_id AS picked_parent,
           picked_parent.rank AS picked_parent_rank, picked_parent.scientific_name AS picked_parent_name,
           target.col_id AS target_id, target.scientific_name AS target_name, target.authorship AS target_authorship
    FROM picked JOIN redlist_species r ON r.sis = picked.sis
    LEFT JOIN col_usages target ON target.col_id = picked.target_col_id
    LEFT JOIN col_usages picked_parent ON picked_parent.col_id = picked.parent_id`);

  const assessedNames = new Set((await rows<{ name_key: string }>(conn, `SELECT name_key FROM redlist_species`)).map((r) => r.name_key));
  // Every CoL synonym carrying a species' own name, with the species it leads
  // to: CoL can hold one name several times under different citations
  // (Clithon oualaniensis, three times), and any one may be the respelling.
  await conn.run(`CREATE OR REPLACE TEMP TABLE own_syn AS
    SELECT r.sis, target.col_id AS target_id, u.scientific_name AS name, u.authorship
    FROM redlist_species r JOIN col_usages u ON u.name_key = r.name_key AND u.rank = 'species' AND u.status = 'synonym' AND u.species_id IS NOT NULL
    JOIN col_usages target ON target.col_id = u.species_id AND ${sameLineage}`);
  const ownNameSynonyms = new Map<string, { name: string; authorship: string | null }[]>();
  for (const r of await rows<{ sis: number; target_id: string; name: string; authorship: string | null }>(conn, `SELECT * FROM own_syn`)) {
    const k = `${r.sis}|${r.target_id}`;
    ownNameSynonyms.set(k, [...(ownNameSynonyms.get(k) ?? []), { name: r.name, authorship: r.authorship }]);
  }

  const links: LinkRow[] = [];
  for (const p of primary) {
    if (!p.target_id || !p.target_name) { unlinkedReason.set(p.sis, `${p.picked_name} leads to no accepted species`); continue; }
    // A decision says the Red List name IS this CoL name, however spelled, and so
    // does a spelling the codes' rules make the same name (name-variants.ts:
    // Sminthopsis fuliginosa / fuliginosus), so decideKey may be asked about
    // either spelling: the author comparison can't undo what was settled.
    const asListed = { scientificName: p.name, authorship: p.authority ?? undefined };
    const asDecided = { scientificName: p.picked_name, authorship: p.picked_authorship ?? undefined };
    const usage = { key: p.picked_id, scientificName: p.picked_name, authorship: p.picked_authorship ?? undefined };
    const target = { key: p.target_id, scientificName: p.target_name, authorship: p.target_authorship ?? undefined };
    // Its own name is a CoL synonym that CoL marks as a respelling of the
    // accepted name (same citation): the same species, whatever the Red List's
    // citation says (Meandrina danae / danai).
    const respelled = p.basis === "matcher" && p.method === "synonym"
      && (ownNameSynonyms.get(`${p.sis}|${p.target_id}`) ?? []).some((u) => isCoLRespelling({ scientificName: u.name, authorship: u.authorship ?? undefined }, target))
      && !isSeparatelyAssessed(p.target_name, p.name, assessedNames);
    const d = p.method === "ambiguous_synonym"
      ? { verdict: "lumped" as const, reason: `CoL lists ${p.picked_name} as an ambiguous synonym of ${p.target_name}; counting only records under this name` }
      : respelled
      ? { verdict: "own" as const, reason: `CoL spells it ${p.target_name} (${p.picked_name} is its orthographic variant, same citation)` }
      : (() => {
          const ask = (sp: typeof asListed) => decideKey({ species: sp, reachedBy: "canonical", usage, acceptedUsage: p.target_id !== p.picked_id ? target : undefined, assessedNames });
          const listed = ask(asListed);
          const sameName = p.basis === "decision" || orthographicallySame(p.name, p.picked_name);
          return sameName && listed.verdict !== "own" ? ask(asDecided) : listed;
        })();
    // A lumped species' records start at its own usage, or at the infraspecific
    // CoL files that synonym under (Fringilla polatzeki → F. teydea polatzeki).
    // Not a nominate infraspecific (Rosa villosa subsp. villosa): that is the
    // species' core, whose records are the accepted species', not this one's.
    const nominate = p.picked_parent_name ? (() => { const w = p.picked_parent_name.toLowerCase().split(/\s+/); return w.length > 2 && w[w.length - 1] === w[1]; })() : false;
    const lumpRoot = p.picked_status === "synonym" && p.picked_parent && p.picked_parent_rank && p.picked_parent_rank !== "species" && p.picked_parent !== p.target_id && !nominate
      ? p.picked_parent : p.picked_id;
    links.push({
      // The taxon it is, whether or not its records count: a refused one is still that taxon.
      sis_taxon_id: p.sis, role: "primary", col_species_id: p.target_id,
      col_taxon_id: d.verdict === "own" ? p.target_id : lumpRoot,
      verdict: d.verdict, method: p.method, basis: p.basis, decided_by: p.by_, name_reason: nameReason.get(p.sis) ?? null, reason: d.reason,
      counted: d.verdict === "own" || d.verdict === "lumped",
    });
  }
  const linked = new Set(links.map((l) => l.sis_taxon_id));
  for (const s of species) {
    if (!linked.has(s.sis)) links.push({ sis_taxon_id: s.sis, role: "primary", col_species_id: null, col_taxon_id: null, verdict: "none", method: "unmatched",
      basis: null, decided_by: null, name_reason: nameReason.get(s.sis) ?? null, reason: unlinkedReason.get(s.sis) ?? "no CoL name", counted: false });
  }

  // ── 3. The rules after it, in order (rules.ts): the covered rows, then the
  // checks every row must pass. The evidence each needs is read from the build here.
  // What an IUCN synonym can name: an accepted species (kind 0), or a strict synonym's species (1).
  const synonymCandidates = await rows<SynonymCandidate>(conn, `
    WITH offer AS (
      SELECT name_key, col_id AS target_id, 0 AS kind FROM col_usages WHERE rank = 'species' AND status = 'accepted' AND NOT demoted
      UNION ALL
      SELECT name_key, species_id, 1 FROM col_usages WHERE rank = 'species' AND status = 'synonym' AND species_id IS NOT NULL),
    syn AS (SELECT sis, name, authority, kingdom, phylum, ${NAME("s.name")} AS synonym_name_key FROM redlist_species, unnest(synonyms) AS u(s))
    SELECT DISTINCT r.sis, r.name, r.authority, target.col_id AS target_id, target.scientific_name AS target_name, target.authorship AS target_authorship, o.kind, 'iucn' AS src
    FROM syn r JOIN offer o ON o.name_key = r.synonym_name_key JOIN col_usages target ON target.col_id = o.target_id AND ${sameLineage}
    UNION
    SELECT DISTINCT o.sis, r.name, r.authority, t.col_id, t.scientific_name, t.authorship, 0, 'own_name_synonym'
    FROM own_syn o JOIN redlist_species r ON r.sis = o.sis JOIN col_usages t ON t.col_id = o.target_id`);
  const accepted = await rows<AcceptedSpecies>(conn, `
    SELECT col_id, scientific_name, authorship, family, class_name FROM col_usages
    WHERE rank = 'species' AND status IN ('accepted', 'provisionally accepted') AND NOT demoted`);
  const sameNameSynonyms = await rows<SameNameSynonym>(conn, `
    SELECT r.sis, t.col_id AS usage, t.species_id AS target FROM redlist_species r
    JOIN col_usages t ON t.name_key = r.name_key AND t.rank = 'species' AND t.status IN ('synonym', 'ambiguous synonym') AND t.species_id IS NOT NULL`);
  const listedName = new Map(species.map((s) => [s.sis, norm(s.name)]));
  // What a species waiting for a decision might be: every CoL species a usage with
  // its own name leads to, and the species the matcher's answer leads to.
  const undecidedCandidates = await rows<UndecidedCandidate>(conn, `
    SELECT DISTINCT r.sis, target.col_id AS target_id, target.scientific_name AS target_name
    FROM redlist_species r JOIN col_usages u ON u.name_key = r.name_key AND u.rank = 'species' AND u.species_id IS NOT NULL
    JOIN col_usages target ON target.col_id = u.species_id
    UNION
    SELECT DISTINCT m.sis_taxon_id, target.col_id, target.scientific_name
    FROM ${parquet(inputs.matches)} m JOIN col_usages u ON u.col_id = m.matcher_col_id JOIN col_usages target ON target.col_id = u.species_id`);
  // The pairs whose lineages differ, asked of the build once every row exists.
  const crossing = async () => {
    await writeTable(conn, "linked_pairs", { sis: "INTEGER", col_id: "VARCHAR" },
      links.filter((l) => l.col_species_id).map((l) => ({ sis: l.sis_taxon_id, col_id: l.col_species_id })));
    return new Set((await rows<{ k: string }>(conn, `
      SELECT DISTINCT r.sis || '|' || target.col_id AS k FROM linked_pairs i JOIN redlist_species r ON r.sis = i.sis JOIN col_usages target ON target.col_id = i.col_id
      WHERE NOT ${sameLineage}`)).map((x) => x.k));
  };

  const exactName = new Set(primary.filter((p) => norm(p.name) === norm(p.picked_name)).map((p) => p.sis));
  const cover = coverer(links);
  const rules: [string, () => Set<number> | Promise<Set<number>>][] = [
    ["covered: another accepted species IUCN's synonyms or CoL's name it", () => coverSynonymSpecies(cover, synonymCandidates, assessedNames)],
    ["covered: CoL holds the name twice", () => coverTwins(links, cover, accepted, listedName, assessedNames)],
    ["covered: one organism under two genera", () => coverDuplicateConcepts(links, cover, accepted, listedName, assessedNames)],
    ["covered: a lumped species' other same-name synonyms", () => coverSameNameSynonyms(links, cover, sameNameSynonyms)],
    ["covered: what a species waiting for a decision might be, kept off the NE list", () => coverUndecidedCandidates(links, cover, undecidedCandidates)],
    ["no link across a phylum", async () => dropCrossPhylum(links, await crossing())],
    ["one owner per usage", () => oneOwnerPerUsage(links, exactName)],
  ];
  const touchedBy: Record<string, number> = {};
  for (const [name, apply] of rules) touchedBy[name] = (await apply()).size;
  for (const [name, n] of Object.entries(touchedBy)) console.log(`   ${name}: ${n.toLocaleString()} species`);

  await writeTable<LinkRow>(conn, "link_rows", { sis_taxon_id: "BIGINT", role: "VARCHAR", col_species_id: "VARCHAR", col_taxon_id: "VARCHAR",
    verdict: "VARCHAR", method: "VARCHAR", basis: "VARCHAR", decided_by: "VARCHAR", name_reason: "VARCHAR", reason: "VARCHAR", counted: "BOOLEAN" }, links);
  await conn.run(`COPY (SELECT * FROM link_rows ORDER BY sis_taxon_id, role DESC, col_species_id) TO ${lit(output(out.link))} (FORMAT parquet, COMPRESSION zstd)`);
  writeQueue(queue, output(out.matchQueue));

  const [basis] = await rows<{ matcher: number; decision: number; unlinked: number }>(conn, `
    SELECT count(*) FILTER (basis = 'matcher')::INT AS matcher, count(*) FILTER (basis = 'decision')::INT AS decision,
           count(*) FILTER (basis IS NULL)::INT AS unlinked
    FROM ${parquet(out.link)} WHERE role = 'primary'`);
  console.log(`   ${basis.matcher.toLocaleString()} by the matcher, ${basis.decision.toLocaleString()} by match-overrides.tsv, ` +
    `${queue.length.toLocaleString()} queued for review (${out.matchQueue})`);
  return { byMatcher: basis.matcher, byDecision: basis.decision, unlinked: basis.unlinked, queue: summariseQueue(queue), rules: touchedBy };
}

/** What sync.json records about the link. */
export interface LinkSummary {
  byMatcher: number;
  byDecision: number;
  unlinked: number;
  queue: Record<string, number>;
  /** How many species each rule after the concept step added or changed rows for (rules.ts). */
  rules: Record<string, number>;
}

/** The queue as the TSV a person works through: by status, then reason, then SIS id. */
export function writeQueue(queue: QueueRow[], file: string): void {
  const cols = Object.keys({ sis_taxon_id: 0, name: 0, authority: 0, status: 0, reason: 0, matcher_col_id: 0, matcher_name: 0,
    matcher_authorship: 0, match_type: 0, confidence: 0, decided_by: 0 } satisfies Record<keyof QueueRow, 0>) as (keyof QueueRow)[];
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const sorted = [...queue].sort((a, b) => cmp(a.status, b.status) || cmp(a.reason, b.reason) || a.sis_taxon_id - b.sis_taxon_id);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/[\t\n]/g, " "));
  fs.writeFileSync(file, [cols.join("\t"), ...sorted.map((q) => cols.map((c) => cell(q[c])).join("\t"))].join("\n") + "\n");
}

/** Queued species by status and reason, for the sync log and sync.json. */
export function summariseQueue(queue: QueueRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of queue) { const k = `${q.status}: ${q.reason}`; out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}
