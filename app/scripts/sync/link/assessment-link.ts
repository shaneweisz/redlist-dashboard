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
 *   counts       what the row counts: the whole CoL species | only records under
 *                its own name | nothing
 *   method       what kind of usage the name is (accepted, synonym,
 *                provisional, ambiguous_synonym, or the covered row's rule)
 *   basis        matcher | decision | rule
 *   decided_by   who made the decision, for basis = decision
 *   match_reason how the Red List name found its CoL record: exact, unique |
 *                exact, homonym, author decides | exact, duplicate in CoL |
 *                spelling variant | override | waiting; a covered row's names
 *                the rule that added it
 *   col_treatment  what CoL makes of that record: accepted | synonym, other
 *                name | synonym, other spelling | lumped, unassessed | lumped,
 *                assessed; a covered row's, the record's CoL status
 *   match_description  all of it in a sentence, with the names, authors and ids
 *   to_review    why a person needs to look, or empty
 *   counted      whether the row's records count
 *
 * to_review says which links need a person, and why (the queue).
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

import { decideKey, isSeparatelyAssessed, isCoLRespelling } from "./species-key";
import { coverer, coverSynonymSpecies, coverTwins, coverSameNameSynonyms, coverUndecidedCandidates, dropCrossPhylum,
  oneOwnerPerUsage, type LinkRow, type SynonymCandidate, type AcceptedSpecies, type SameNameSynonym, type Candidate as UndecidedCandidate } from "./rules";
import { acceptMatch, type MatchAnswer, type QueueReason } from "./accept-match";
import { orthographicallySame } from "./name-variants";
import { compareAuthors } from "../../../src/lib/authors";
import { readOverrides, resolveOverride, type Candidate, type MatchOverride } from "./match-overrides";
import { output, parquet } from "../paths";
import { lit, rows, writeTable, openDuckDB } from "../sql";

/** Doubts with no answer to show: no species found, a name the Red List marks unsettled, a spelling the codes don't make the same name. */
const NO_GUESS = new Set<QueueReason>(["no species match", "informal or qualified name", "spelling variant", "matched another rank"]);

const NAME = (col: string) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export type { LinkRow } from "./rules";


export async function buildLink(
  inputs: { taxa: string; assessments: string; matches: string; decisions?: Map<number, MatchOverride> },
  out: { link: string },
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
           matcher_accepted_name, matcher_accepted_authorship, alternatives AS alts
    FROM ${parquet(inputs.matches)}`)).map((m) => [m.sis_taxon_id, { ...m, alternatives: (m.alts ? JSON.parse(m.alts) : null) ?? [] } as MatchAnswer]));
  const speciesOf = new Map((await rows<{ col_id: string; species_id: string | null }>(conn, `
    WITH ids AS (SELECT matcher_col_id AS id FROM ${parquet(inputs.matches)} UNION
                 SELECT unnest(json_extract_string(alternatives, '$[*].col_id')) FROM ${parquet(inputs.matches)})
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
  const unlinkedReason = new Map<number, string>();
  // How each species' CoL name was found (match_reason's first part), and why a person needs to look.
  const nameReason = new Map<number, string>();
  const toReview = new Map<number, string>();
  const WHY = { "unique name": "exact, unique", "authors pick it": "exact, homonym, author decides", "CoL holds it twice": "exact, duplicate in CoL" } as const;
  const taken = (a: { why: keyof typeof WHY; variant?: true }) => !a.variant ? WHY[a.why] : a.why === "unique name" ? "spelling variant" : `spelling variant, ${WHY[a.why].slice("exact, ".length)}`;
  // What the description needs from the name step.
  const nameCtx = new Map<number, { why?: keyof typeof WHY; variant?: true; override?: MatchOverride }>();
  // The matcher's answer is the link even when the rule doubts it, as GBIF files a
  // record with that bare name there: flagged, labelled with the doubt, and
  // queued for review. Not when there's no species answer, the Red List marks the
  // name unsettled, or the spelling is one the codes don't make the same name.
  const guess = (m: MatchAnswer | undefined, reason: QueueReason) => !!m?.matcher_col_id && !NO_GUESS.has(reason);
  const takeGuess = (sis: number, m: MatchAnswer, reason: QueueReason) => {
    nameReason.set(sis, `flagged: ${reason}`);
    picks.push({ sis, col_id: m.matcher_col_id!, basis: "matcher", by_: null });
  };
  for (const s of species) {
    const m = answers.get(s.sis);
    const acc = m ? acceptMatch(s, m, (id) => speciesOf.get(id) ?? null) : { accepted: false as const, reason: "no species match" as QueueReason };
    // Why a person needs to look at this species' link (the queue): none when the rule or a reviewed override settled it.
    const d = decisions.get(s.sis);
    if (d) {
      const res = resolveOverride(d, s.name, d.colName ? candidates.get(norm(d.colName)) ?? [] : [], s.authority);
      if (res.kind !== "stale") {
        if (!d.reviewed) toReview.set(s.sis, `override not yet reviewed (${d.by}; ${acc.accepted ? "the matcher would take its own answer" : `the matcher's: ${acc.reason}`})`);
        nameReason.set(s.sis, "override");
        nameCtx.set(s.sis, { override: d });
        if (res.kind === "usage") picks.push({ sis: s.sis, col_id: res.colId, basis: "decision", by_: d.by });
        else unlinkedReason.set(s.sis, "override, not in CoL");
        continue;
      }
      // A decision that no longer resolves is asked again; meanwhile the matcher's answer stands if it is certain.
      toReview.set(s.sis, `override no longer holds: ${res.why}`);
      if (acc.accepted) { nameReason.set(s.sis, taken(acc)); nameCtx.set(s.sis, { why: acc.why, variant: acc.variant }); }
      if (acc.accepted) picks.push({ sis: s.sis, col_id: m!.matcher_col_id!, basis: "matcher", by_: null });
      else if (guess(m, acc.reason)) takeGuess(s.sis, m!, acc.reason);
      continue;
    }
    if (acc.accepted) { nameReason.set(s.sis, taken(acc)); nameCtx.set(s.sis, { why: acc.why, variant: acc.variant }); picks.push({ sis: s.sis, col_id: m!.matcher_col_id!, basis: "matcher", by_: null }); continue; }
    toReview.set(s.sis, acc.reason);
    if (guess(m, acc.reason)) takeGuess(s.sis, m!, acc.reason);
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
    if (!p.target_id || !p.target_name) {
      const r = nameReason.get(p.sis);
      unlinkedReason.set(p.sis, r?.startsWith("flagged: ") ? "waiting" : r ?? "waiting");
      continue;
    }
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
      ? { verdict: "lumped" as const, treatment: "lumped, unassessed" }
      : respelled
      ? { verdict: "own" as const, treatment: "synonym, other spelling" }
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
      verdict: d.verdict, method: p.method, basis: p.basis, decided_by: p.by_,
      match_reason: nameReason.get(p.sis) ?? null, col_treatment: d.treatment, match_description: null, to_review: toReview.get(p.sis) ?? null,
      counted: d.verdict === "own" || d.verdict === "lumped",
    });
  }
  const linked = new Set(links.map((l) => l.sis_taxon_id));
  for (const s of species) {
    if (!linked.has(s.sis)) links.push({ sis_taxon_id: s.sis, role: "primary", col_species_id: null, col_taxon_id: null, verdict: "none", method: "unmatched",
      basis: null, decided_by: null, match_reason: unlinkedReason.get(s.sis) ?? "waiting", col_treatment: null, match_description: null,
      to_review: toReview.get(s.sis) ?? null, counted: false });
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
    SELECT r.sis, t.col_id AS usage, t.species_id AS target, r.authority, t.authorship FROM redlist_species r
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
    ["covered: a lumped species' other same-name synonyms", () => coverSameNameSynonyms(links, cover, sameNameSynonyms)],
    ["covered: what a flagged or waiting species might be, flagged on the NE list", () => coverUndecidedCandidates(links, cover, undecidedCandidates)],
    ["no link across a phylum", async () => dropCrossPhylum(links, await crossing())],
    ["one owner per usage", () => oneOwnerPerUsage(links, exactName)],
  ];
  const touchedBy: Record<string, number> = {};
  for (const [name, apply] of rules) touchedBy[name] = (await apply()).size;
  for (const [name, n] of Object.entries(touchedBy)) console.log(`   ${name}: ${n.toLocaleString()} species`);

  // ── 4. Each row in words, now that every rule has run.
  const ids = new Set<string>();
  for (const l of links) for (const id of [l.col_taxon_id, l.col_species_id]) if (id) ids.add(id);
  for (const p of primary) ids.add(p.picked_id);
  await writeTable(conn, "described_ids", { col_id: "VARCHAR" }, [...ids].map((col_id) => ({ col_id })));
  const usages = new Map((await rows<Usage>(conn, `
    SELECT u.col_id, u.scientific_name AS name, u.authorship, u.status FROM described_ids JOIN col_usages u USING (col_id)`)).map((u) => [u.col_id, u]));
  const sisByName = new Map(species.map((s) => [norm(s.name), s.sis]));
  describeLinks(links, { usages, sisByName, species: new Map(species.map((s) => [s.sis, s])), answers, nameCtx,
    primary: new Map(primary.map((p) => [p.sis, p])), toReview });
  const notes = matchNotes(links, { usages, species: new Map(species.map((s) => [s.sis, s])), answers, nameCtx, primary: new Map(primary.map((p) => [p.sis, p])) });

  // counts, not the rules' verdict: what the row counts is what a reader needs.
  const counts = (l: LinkRow) => !l.counted ? "nothing" : l.verdict === "own" ? "the whole CoL species" : "only records under its own name";
  await writeTable(conn, "link_rows", { sis_taxon_id: "BIGINT", role: "VARCHAR", col_species_id: "VARCHAR", col_taxon_id: "VARCHAR",
    counts: "VARCHAR", method: "VARCHAR", basis: "VARCHAR", decided_by: "VARCHAR", match_reason: "VARCHAR", col_treatment: "VARCHAR",
    match_description: "VARCHAR", to_review: "VARCHAR", counted: "BOOLEAN", match_note: "VARCHAR", match_records: "VARCHAR" },
    links.map(({ verdict: _, ...l }) => {
      const f = l.role === "primary" ? notes.get(l.sis_taxon_id) : undefined;
      return { ...l, counts: counts({ verdict: _, ...l }), match_note: f?.note ?? null, match_records: f ? JSON.stringify(f.records) : null };
    }));
  await conn.run(`COPY (SELECT * FROM link_rows ORDER BY sis_taxon_id, role DESC, col_species_id) TO ${lit(output(out.link))} (FORMAT parquet, COMPRESSION zstd)`);

  const [basis] = await rows<{ matcher: number; decision: number; unlinked: number }>(conn, `
    SELECT count(*) FILTER (basis = 'matcher')::INT AS matcher, count(*) FILTER (basis = 'decision')::INT AS decision,
           count(*) FILTER (basis IS NULL)::INT AS unlinked
    FROM ${parquet(out.link)} WHERE role = 'primary'`);
  console.log(`   ${basis.matcher.toLocaleString()} by the matcher, ${basis.decision.toLocaleString()} by match-overrides.tsv, ` +
    `${toReview.size.toLocaleString()} to review`);
  // The queue by kind and reason, for the sync log and sync.json.
  const queue: Record<string, number> = {};
  for (const v of toReview.values()) { const k = v.replace(/ \(.*\)$/, ""); queue[k] = (queue[k] ?? 0) + 1; }
  return { byMatcher: basis.matcher, byDecision: basis.decision, unlinked: basis.unlinked,
    queue: Object.fromEntries(Object.entries(queue).sort((a, b) => b[1] - a[1])), rules: touchedBy };
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

interface Usage { col_id: string; name: string; authorship: string | null; status: string }

const fmt = (u: { name: string; authorship: string | null; col_id: string } | undefined) =>
  u ? `${u.name}${u.authorship ? ` ${u.authorship}` : ""} [${u.col_id}]` : "?";
const status = (s: string | null) => (s ?? "").toLowerCase().replace(/_/g, " ");
const binomialOf = (n: string) => n.replace(/×/g, "").trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();

/**
 * match_description: each row in a sentence a person can check against CoL,
 * with the names, authors and ids it rests on. The sentence follows the
 * columns: how the name found its record (match_reason), what CoL makes of it
 * (col_treatment), and what counts.
 */
function describeLinks(links: LinkRow[], ctx: {
  usages: Map<string, Usage>; sisByName: Map<string, number>; species: Map<number, { sis: number; name: string; authority: string | null }>;
  answers: Map<number, MatchAnswer>; nameCtx: Map<number, { why?: string; variant?: true; override?: MatchOverride }>;
  primary: Map<number, { picked_id: string; method: string; name: string }>; toReview: Map<number, string>;
}): void {
  const u = (id: string | null) => (id ? ctx.usages.get(id) : undefined);
  // Who owns a CoL record a row lost to another assessed species.
  const ownerOf = new Map<string, number>();
  for (const l of links) if (l.counted && l.col_taxon_id) ownerOf.set(l.col_taxon_id, l.sis_taxon_id);
  const owner = (l: LinkRow) => {
    const o = l.col_taxon_id ? ownerOf.get(l.col_taxon_id) : undefined;
    return o === undefined ? "another assessed species" : `${ctx.species.get(o)?.name ?? "?"} (SIS ${o})`;
  };

  for (const l of links) {
    const sp = ctx.species.get(l.sis_taxon_id);
    const taxon = u(l.col_taxon_id), target = u(l.col_species_id);
    if (l.role === "covered") {
      const lead: Record<string, string> = {
        "CoL duplicate": `CoL also holds it as ${fmt(taxon)}, ${status(taxon?.status ?? null)}`,
        "CoL duplicate, respelled": `CoL also holds it spelt ${fmt(taxon)}`,
        "CoL duplicate, Red List synonym": `CoL also holds it as ${fmt(taxon)}, a name the Red List lists as a synonym`,
        "name under another species": `CoL also files ${fmt(taxon)} under ${fmt(target)}`,
        "Red List synonym": `The Red List lists ${fmt(taxon)} as a synonym; kept off the Not Evaluated list`,
        "candidate": `${fmt(target)} may be it; shown on the Not Evaluated list flagged as possibly this species until someone decides`,
      };
      const counts = l.counted ? "; its records count too." : l.verdict === "refused" ? ", not counted." : `; not counted: ${owner(l)} owns its records.`;
      l.col_treatment = taxon ? status(taxon.status) : null;
      l.match_description = `${lead[l.match_reason ?? ""] ?? `${l.match_reason}: ${fmt(taxon)}`}${counts}`;
      continue;
    }

    const m = ctx.answers.get(l.sis_taxon_id);
    const n = ctx.nameCtx.get(l.sis_taxon_id) ?? {};
    const p = ctx.primary.get(l.sis_taxon_id);
    const picked = p ? u(p.picked_id) : undefined;
    // CoL's other records with the picked name, for a homonym or a duplicate.
    const others = picked && m ? m.alternatives.filter((a) => a.col_id !== picked.col_id && a.status !== "MISAPPLIED"
      && binomialOf(a.name) === binomialOf(picked.name)) : [];
    const copies = () => [picked!, ...others.map((a) => ({ ...a, status: a.status ?? "" }))]
      .map((a) => `${a.authorship ?? "no author"} [${a.col_id}], ${status(a.status)}`).join("; ");

    // How the name found its record.
    let found: string;
    if (n.override) found = `${n.override.by} decided it is ${fmt(picked)}${n.override.colVersion ? `, against ${n.override.colVersion}` : ""}`;
    else if (!picked) found = "";
    else if (l.match_reason?.startsWith("flagged: ")) {
      const alts = (m?.alternatives ?? []).filter((a) => a.col_id !== picked.col_id).slice(0, 3).map((a) => fmt({ name: a.name, authorship: a.authorship, col_id: a.col_id }));
      found = `Flagged (${l.match_reason.slice("flagged: ".length)}): the matcher answered ${fmt(picked)}, ${m?.confidence ?? "?"}% sure, where GBIF files records with that bare name${alts.length ? `; it also weighed ${alts.join("; ")}` : ""}`;
    }
    else {
      const many = n.why === "authors pick it"
        ? `CoL has ${others.length + 1} records named ${picked.name}: ${copies()}. The Red List's authority, ${sp?.authority ?? "none"}, matches ${picked.authorship ?? "no author"} [${picked.col_id}]`
        : n.why === "CoL holds it twice"
        ? `CoL has ${others.length + 1} records named ${picked.name}, all one species: ${copies()}. This link takes ${picked.authorship ?? "no author"} [${picked.col_id}]`
        : null;
      found = n.variant
        ? `CoL has no record spelt ${sp?.name}; the matcher found ${fmt(picked)}, a spelling the codes treat as the same name${many ? `. ${many}` : ""}`
        : many ?? `CoL has one record named ${fmt(picked)}`;
    }

    if (!l.col_species_id) {
      const why = ctx.toReview.get(l.sis_taxon_id);
      if (n.override && !picked) l.match_description = `${n.override.by} decided it is not in CoL.`;
      else if (l.match_reason === "only match in another phylum") l.match_description = `${found}, in another phylum; not linked.`;
      else if (picked && !why) l.match_description = `${found}, which leads to no accepted species.`;
      else {
        const leads = (name?: string | null, auth?: string | null) => name ? `, a synonym of ${name}${auth ? ` ${auth}` : ""}` : "";
        const answer = !m?.matcher_col_id ? "The matcher found no CoL record"
          : m.match_type === "HIGHERRANK" || m.match_type === "NONE" ? `The matcher found no species, only ${m.matcher_name}${m.matcher_authorship ? ` ${m.matcher_authorship}` : ""} [${m.matcher_col_id}], a ${status(m.matcher_rank)}`
          : `The matcher answered ${m.matcher_name}${m.matcher_authorship ? ` ${m.matcher_authorship}` : ""} [${m.matcher_col_id}], ${status(m.matcher_status)}${leads(m.matcher_accepted_name, m.matcher_accepted_authorship)}, ${status(m.match_type)}, ${m.confidence}% sure`;
        const alts = (m?.alternatives ?? []).slice(0, 3).map((a) => `${a.name}${a.authorship ? ` ${a.authorship}` : ""} [${a.col_id}], ${status(a.status)}${leads(a.accepted_name, a.accepted_authorship)}`);
        const more = (m?.alternatives.length ?? 0) > 3 ? `, and ${m!.alternatives.length - 3} more` : "";
        l.match_description = `${`${answer}${alts.length ? `; it also weighed ${alts.join("; ")}${more}` : ""}`.replace(/\.$/, "")}. Waiting: ${why ?? "no decision yet"}.`;
      }
      continue;
    }

    // What CoL makes of it.
    const assessed = target ? ctx.sisByName.get(norm(target.name)) : undefined;
    const made: Record<string, string> = {
      "accepted": ", CoL's accepted name.",
      "synonym, other name": `, a synonym; CoL accepts the species as ${fmt(target)}.`,
      "synonym, other spelling": `, which CoL lists as a variant spelling; it accepts the species as ${fmt(target)}.`,
      "lumped, unassessed": p?.method === "ambiguous_synonym"
        ? `, an ambiguous synonym CoL places under ${fmt(target)}, which the Red List doesn't assess.`
        : `, a synonym CoL folds into ${fmt(target)}, which the Red List doesn't assess.`,
      "lumped, assessed": `, a synonym of ${fmt(target)}, which the Red List assesses separately${assessed ? ` (SIS ${assessed})` : ""}.`,
    };
    const counts = !l.counted
      ? l.verdict === "duplicate" ? ` Counts nothing: ${owner(l)} claims the same record and owns its records.` : " Counts nothing."
      : l.verdict === "own" ? ` Counts every record of ${target?.name}.` : ` Counts only the records under ${fmt(taxon)}.`;
    l.match_description = `${found}${made[l.col_treatment ?? ""] ?? "."}${counts}`;
  }
}

/** A CoL record a match note names, for the app to link to (ChecklistBank, in the release the sync used). */
interface NoteRecord {
  id: string; name: string; authorship: string | null; status: string; species: string | null;
  /** counted: the record the link counts through; also: another CoL name whose records count too; not: named, not counted. */
  role: "counted" | "also" | "not";
}

/**
 * match_note / match_records: for every species whose match isn't a plain one
 * (the Red List name once in CoL, counting that species), how it was matched or
 * why it is in doubt, in short sentences with the names, and the CoL records
 * they are about. A sentence on what the count also includes (other CoL names,
 * or only its own name) follows. Exact matches with nothing else to say: none.
 */
function matchNotes(links: LinkRow[], ctx: {
  usages: Map<string, Usage>; species: Map<number, { sis: number; name: string; authority: string | null }>;
  answers: Map<number, MatchAnswer>; primary: Map<number, { picked_id: string; method: string }>;
  nameCtx: Map<number, { why?: string; variant?: true; override?: MatchOverride }>;
}): Map<number, { note: string; records: NoteRecord[] }> {
  const out = new Map<number, { note: string; records: NoteRecord[] }>();
  const nameAuth = (n: string, a: string | null) => `${n}${a ? ` ${a}` : ""}`;
  const an = (w: string) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
  const what = (r: NoteRecord) => r.status === "accepted" ? "an accepted species" : `${an(r.status)} of ${r.species}`;
  const fromUsage = (id: string | null, role: NoteRecord["role"]): NoteRecord => {
    const u = id ? ctx.usages.get(id) : undefined;
    return { id: id ?? "", name: u?.name ?? "?", authorship: u?.authorship ?? null, status: status(u?.status ?? null), species: null, role };
  };
  const ALSO: Record<string, string> = {
    "CoL duplicate": "a second CoL record for this species",
    "CoL duplicate, respelled": "the same name spelt another way in CoL",
    "CoL duplicate, Red List synonym": "a name the Red List lists as its synonym, which CoL holds as a species",
    "name under another species": "its own name, which CoL also files under another species",
  };
  const alsoRows = new Map<number, LinkRow[]>();
  for (const l of links) if (l.role === "covered" && l.counted) alsoRows.set(l.sis_taxon_id, [...(alsoRows.get(l.sis_taxon_id) ?? []), l]);

  for (const l of links) {
    if (l.role !== "primary") continue;
    const sp = ctx.species.get(l.sis_taxon_id);
    if (!sp) continue;
    const m = ctx.answers.get(l.sis_taxon_id);
    const pickedId = ctx.primary.get(l.sis_taxon_id)?.picked_id;
    const n = ctx.nameCtx.get(l.sis_taxon_id) ?? {};
    const sentences: string[] = [];
    let records: NoteRecord[] = [];

    // The record the link counts through, and CoL's other records with that name.
    const pick: NoteRecord | null = pickedId ? (() => {
      const u = ctx.usages.get(pickedId);
      const sameAsAnswer = m?.matcher_col_id === pickedId;
      return { id: pickedId, name: u?.name ?? m?.matcher_name ?? "?", authorship: u?.authorship ?? m?.matcher_authorship ?? null,
        status: status(u?.status ?? m?.matcher_status ?? null),
        species: [sameAsAnswer ? m?.matcher_accepted_name : undefined, l.col_species_id ? ctx.usages.get(l.col_species_id)?.name : undefined, u?.name].find((x) => !!x) ?? null,
        role: "counted" as const };
    })() : null;
    const same = pick && m ? m.alternatives.filter((a) => a.col_id !== pick.id && a.status !== "MISAPPLIED" && binomialOf(a.name) === binomialOf(pick.name))
      .map((a) => ({ id: a.col_id, name: a.name, authorship: a.authorship, status: status(a.status), species: a.accepted_name ?? a.name, role: "not" as const })) : [];
    const p = pick ? nameAuth(pick.name, pick.authorship) : "";
    const filed = pick && pick.status !== "accepted" ? `, ${an(pick.status)} of ${pick.species}` : "";
    const counted = pick ? `Counted: GBIF's matcher's pick, ${pick.authorship ? `the record by ${pick.authorship}` : "the record with no author"}${filed}.` : "";

    if (!l.col_species_id) {
      const others = alsoRows.get(l.sis_taxon_id) ?? [];
      if (others.length === 0) continue;
      records = others.map((o) => fromUsage(o.col_taxon_id, "also"));
      sentences.push(`No clear CoL match for ${sp.name} itself yet. Counted: records under ${records.map((r) => r.name).join(", ")}, which the Red List lists as ${records.length > 1 ? "synonyms" : "a synonym"}.`);
      out.set(l.sis_taxon_id, { note: sentences.join(" "), records });
      continue;
    }
    if (!pick) continue;
    const speciesCount = new Set([pick, ...same].map((r) => r.species)).size;
    const byRl = [pick, ...same].filter((r) => sp.authority && compareAuthors(sp.authority, r.authorship) === "same");

    if (l.match_reason?.startsWith("flagged: ")) {
      const doubt = l.match_reason.slice("flagged: ".length);
      const homonym = !sp.authority ? "The Red List gives no author to choose between them"
        : byRl.length === 0 ? `The Red List cites ${sp.authority}, and none has that exact citation`
        : byRl.length === 1 ? `The Red List cites ${sp.authority}; the record with that citation is ${what(byRl[0])}`
        : `The Red List cites ${sp.authority}, and ${byRl.length} records have that citation`;
      const synonymRecord = [pick, ...same].find((r) => r.status !== "accepted" && r.species !== r.name);
      sentences.push({
        "homonym the authors don't decide": `CoL has ${same.length + 1} records named ${pick.name}, under ${speciesCount} different species. ${homonym}. ${counted}`,
        "lower confidence": `GBIF's matcher is only ${m?.confidence ?? "?"}% sure of its match: CoL's ${p}${filed}.`,
        "provisional name": `CoL only provisionally accepts ${p}.${same.some((r) => r.status === "accepted") ? " It also holds the name as accepted, so records may be split between the two." : ""}`,
        "synonym by other authors": `The Red List cites ${sp.authority ?? "no author"}; CoL's ${pick.name} is by ${pick.authorship ?? "no author"}${filed}. It may be a different species.`,
        "ambiguous synonym": `CoL marks ${p} as an ambiguous synonym, filed under ${pick.species}.`,
        "accepted and a synonym in CoL": `CoL holds ${pick.name} both as an accepted species and as a synonym of ${synonymRecord?.species ?? "another species"}. ${counted}`,
      }[doubt] ?? `Flagged: ${doubt}.`);
      records = [pick, ...same];
    } else if (n.override) {
      const o = n.override;
      sentences.push(`Decided by ${o.by}${o.date ? ` (${o.date})` : ""}${o.colVersion ? ` against ${o.colVersion}` : ""}: it is CoL's ${p}${filed}.${o.note ? ` ${o.note.replace(/^checks\/fixtures\/matching\.ts: /, "")}${/[.!?]$/.test(o.note) ? "" : "."}` : ""}`);
      records = [pick];
    } else if (n.why === "authors pick it") {
      sentences.push(`CoL has ${same.length + 1} records named ${pick.name}, under ${speciesCount} different species. The Red List cites ${sp.authority}, which matches only ${p}${filed}, so that one counts.`);
      records = [pick, ...same];
    } else if (n.why === "CoL holds it twice") {
      const all = [pick, ...same.map((r) => ({ ...r, role: "also" as const }))];
      sentences.push(`CoL holds ${pick.name} ${all.length === 2 ? "twice" : `${all.length} times`} (${all.map((r) => `${r.authorship ?? "no author"}, ${r.status}`).join("; ")}), all one species, so records under each count.`);
      records = all;
    }
    // Found under a synonym: GBIF files the records under CoL's accepted name (Sorbus greenii → Aria greenii).
    if (sentences.length === 0 && l.verdict === "own" && pick.status !== "accepted") {
      const target = ctx.usages.get(l.col_species_id);
      const accepted = target ? nameAuth(target.name, target.authorship) : pick.species ?? "its accepted name";
      sentences.push(l.col_treatment === "synonym, other spelling"
        ? `CoL lists ${pick.name} as a variant spelling of ${accepted}, so the records count under that name.`
        : `CoL holds ${pick.name} as a synonym of ${accepted}, so GBIF counts its records under ${target?.name ?? "that name"}.`);
      records = [pick, ...(target ? [{ id: target.col_id, name: target.name, authorship: target.authorship, status: status(target.status), species: null, role: "also" as const }] : [])];
    }
    if (n.variant) {
      sentences.unshift(`CoL spells it ${pick.name}, not ${sp.name}: the naming codes treat the two as one name (a Latin ending or transliteration).`);
      if (records.length === 0) records = [pick];
    }

    // What the count includes beyond the record it is linked through.
    // Records already named above (CoL's copies of a duplicate, a homonym's other
    // records) aren't repeated; they are marked as counted too.
    const allAlso = alsoRows.get(l.sis_taxon_id) ?? [];
    records = records.map((r) => (r.role === "not" && allAlso.some((o) => o.col_taxon_id === r.id) ? { ...r, role: "also" as const } : r));
    const named = records.filter((r) => r.role === "also" && allAlso.some((o) => o.col_taxon_id === r.id));
    if (named.length > 0 && !n.why) sentences.push(`Records under ${named.map((r) => nameAuth(r.name, r.authorship)).join(" and ")} count too, as its own name filed elsewhere in CoL.`);
    const also = allAlso.filter((o) => !records.some((r) => r.id === o.col_taxon_id));
    if (also.length > 0) {
      const alsoRecs = also.map((o) => ({ ...fromUsage(o.col_taxon_id, "also" as const), species: null }));
      sentences.push(`Also counts records under ${also.map((o, i) => `${nameAuth(alsoRecs[i].name, alsoRecs[i].authorship)} (${ALSO[o.match_reason ?? ""] ?? "another CoL name"})`).join("; ")}.`);
      if (records.length === 0) records = [pick];
      records = [...records, ...alsoRecs.filter((r) => !records.some((x) => x.id === r.id))];
    }
    if (l.counted && l.verdict === "lumped") {
      const target = ctx.usages.get(l.col_species_id);
      sentences.push(`CoL files ${pick.name} under ${target?.name ?? "a broader species"}, so only records under ${pick.name} count, not the rest of ${target?.name ?? "that species"}.`);
      if (records.length === 0) records = [pick];
    }
    if (sentences.length > 0) out.set(l.sis_taxon_id, { note: sentences.join(" "), records });
  }
  return out;
}
