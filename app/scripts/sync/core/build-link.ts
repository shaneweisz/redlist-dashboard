/**
 * build-link: which CoL species each assessed species is, decided once.
 *
 * Two steps, kept apart so each can be explained on its own:
 *
 * 1. Name: which CoL usage the Red List name is.
 *      a decision in decisions.tsv, if there is one and it still resolves;
 *      else GBIF's matcher's answer (build-matches.ts), when accept-match.ts
 *      takes it without review;
 *      else nothing yet: the species is queued (build/match-queue.tsv) and
 *      counts no records until someone decides.
 *    The matcher is the one GBIF files occurrence records with, so a name
 *    matched here is where GBIF put that name's records.
 *
 * 2. Concept: what that usage makes the species, by rules that each fit in a
 *    sentence.
 *      - An accepted CoL species is the species (own). One the curated
 *        checklist demotes is followed to the checklist's species.
 *      - A synonym of a species the Red List treats the same way is the
 *        species too, renamed (own); one CoL folds into another species
 *        keeps only the records filed under its own name (lumped), or
 *        nothing if that species is assessed separately (refused). See
 *        species-key.ts' decideKey.
 *      - An ambiguous synonym, a name CoL can't place, keeps only its own records.
 *      - CoL holding one organism twice: both count (twins, covered rows below).
 *      - Never across phyla.
 *      - Every usage counts for one assessed species at most.
 *
 * Output: core/assessment_link.parquet, one primary row per assessed species
 * plus covered rows:
 *   sis_taxon_id, role (primary | covered), col_id (the species it is),
 *   usage_id (where its records start: the species for own, its own usage for
 *   lumped, NULL when nothing counts), verdict, method (what kind of usage the
 *   name is), basis (matcher | decision | rule), decided_by, reason, counted
 * and the species waiting for a person (writeQueue: build/match-queue.tsv).
 *
 * Usage:  npx tsx scripts/sync/core/build-link.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles } from "../../lib/utils";
import { decideKey, sameOrganism, isSeparatelyAssessed, isCoLRespelling, normaliseAuthorship, type Verdict } from "./species-key";
import { speciesNameParts, canonicalEpithet } from "./name-variants";
import { acceptMatch, sameAuthors, type MatchAnswer, type QueueReason } from "./accept-match";
import { readDecisions, resolveDecision, type Candidate, type Decision } from "./decisions";
import { BUILD_DIR, CORE_DIR } from "../paths";
import { lit, rows, writeTable } from "../sql";

const NAME = (col: string) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Ownership order: the more direct the name, the stronger the claim. */
const METHODS = ["accepted", "synonym", "checklist_synonym", "provisional", "ambiguous_synonym",
  "iucn_synonym_covered", "same_name_twin", "duplicate_concept", "checklist_demoted", "same_name_synonym"] as const;

export interface LinkRow {
  sis_taxon_id: number;
  role: "primary" | "covered";
  col_id: string | null;
  usage_id: string | null;
  verdict: Verdict | "duplicate";
  method: string;
  basis: "matcher" | "decision" | "rule" | null;
  decided_by: string | null;
  reason: string;
  counted: boolean;
}

export interface QueueRow {
  sis_taxon_id: number;
  name: string;
  authority: string | null;
  /** undecided: counts nothing yet. proposed: a decision applies, but no person has checked it. stale: a decision no longer resolves. */
  status: "undecided" | "proposed" | "stale";
  reason: string;
  matcher_usage_id: string | null;
  matcher_name: string | null;
  matcher_authorship: string | null;
  match_type: string | null;
  confidence: number | null;
  decided_by: string | null;
}

export async function buildLink(
  conn: DuckDBConnection, coreDir: string, opts: { decisions?: Map<number, Decision> } = {},
): Promise<{ out: string; queue: QueueRow[] }> {
  const taxaFile = lit(path.join(coreDir, "taxa.parquet"));
  const assessments = lit(path.join(coreDir, "assessments.parquet"));
  const matches = lit(path.join(coreDir, "matches.parquet"));
  const out = path.join(coreDir, "assessment_link.parquet");
  const decisions = opts.decisions ?? readDecisions();

  await conn.run(`CREATE OR REPLACE TEMP TABLE redlist_species AS
    SELECT sis_taxon_id::INTEGER AS sis, scientific_name AS name, ${NAME("scientific_name")} AS name_key, authority,
           family, class_name, phylum_name AS phylum, kingdom_name AS kingdom, synonyms
    FROM read_parquet(${assessments}) WHERE is_latest`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE col_usages AS
    SELECT col_id, parent_id, status, rank, scientific_name, authorship, family, class_name, phylum, kingdom, species_id, demoted,
           checklist_parent_id, ${NAME("scientific_name")} AS name_key
    FROM read_parquet(${taxaFile})`);

  // IUCN and CoL name one phylum differently (the brown algae); unknown lineage is no evidence.
  const sameLineage = `(r.kingdom IS NULL OR target.kingdom IS NULL OR (r.kingdom = target.kingdom AND (r.phylum IS NULL OR target.phylum IS NULL
    OR replace(r.phylum, 'heterokontophyta', 'ochrophyta') = target.phylum)))`;

  // ── 1. Name ────────────────────────────────────────────────────────────────
  const answers = new Map((await rows<Omit<MatchAnswer, "alternatives"> & { sis_taxon_id: number; alts: string | null }>(conn, `
    SELECT sis_taxon_id, usage_id, usage_name, usage_authorship, usage_rank, usage_status, match_type, confidence,
           to_json(alternatives)::VARCHAR AS alts
    FROM read_parquet(${matches})`)).map((m) => [m.sis_taxon_id, { ...m, alternatives: (m.alts ? JSON.parse(m.alts) : null) ?? [] } as MatchAnswer]));
  const speciesOf = new Map((await rows<{ col_id: string; species_id: string | null }>(conn, `
    WITH ids AS (SELECT usage_id AS id FROM read_parquet(${matches}) UNION
                 SELECT unnest(list_transform(alternatives, a -> a.usage_id)) FROM read_parquet(${matches}))
    SELECT t.col_id, t.species_id FROM ids JOIN col_usages t ON t.col_id = ids.id`)).map((r) => [r.col_id, r.species_id]));
  const decidedNames = [...new Set([...decisions.values()].flatMap((d) => (d.colName ? [norm(d.colName)] : [])))];
  const candidates = new Map<string, Candidate[]>();
  if (decidedNames.length > 0) {
    await conn.run(`CREATE OR REPLACE TEMP TABLE decided_names AS SELECT unnest([${decidedNames.map(lit).join(", ")}]::VARCHAR[]) AS name_key`);
    for (const c of await rows<Candidate & { name_key: string }>(conn, `
        SELECT t.name_key, t.col_id, t.scientific_name, t.authorship, t.status FROM col_usages t JOIN decided_names USING (name_key) WHERE t.rank = 'species'`)) {
      candidates.set(c.name_key, [...(candidates.get(c.name_key) ?? []), c]);
    }
  }

  const species = await rows<{ sis: number; name: string; authority: string | null }>(conn, `SELECT sis, name, authority FROM redlist_species ORDER BY sis`);
  const picks: { sis: number; usage_id: string; basis: "matcher" | "decision"; by_: string | null }[] = [];
  const queue: QueueRow[] = [];
  const unlinkedReason = new Map<number, string>();
  for (const s of species) {
    const m = answers.get(s.sis);
    const acc = m ? acceptMatch(s, m, (id) => speciesOf.get(id) ?? null) : { accepted: false as const, reason: "no species match" as QueueReason };
    const enqueue = (status: QueueRow["status"], reason: string, by: string | null = null) => queue.push({
      sis_taxon_id: s.sis, name: s.name, authority: s.authority, status, reason,
      matcher_usage_id: m?.usage_id ?? null, matcher_name: m?.usage_name ?? null, matcher_authorship: m?.usage_authorship ?? null,
      match_type: m?.match_type ?? null, confidence: m?.confidence ?? null, decided_by: by,
    });
    const d = decisions.get(s.sis);
    if (d) {
      const res = resolveDecision(d, s.name, d.colName ? candidates.get(norm(d.colName)) ?? [] : []);
      if (res.kind !== "stale") {
        if (!d.reviewed) enqueue("proposed", acc.accepted ? "the matcher would take its answer" : acc.reason, d.by);
        if (res.kind === "usage") picks.push({ sis: s.sis, usage_id: res.colId, basis: "decision", by_: d.by });
        else unlinkedReason.set(s.sis, `not in CoL (decided by ${d.by})`);
        continue;
      }
      // A decision that no longer resolves is asked again; meanwhile the matcher's answer stands if it is certain.
      enqueue("stale", res.why, d.by);
      if (acc.accepted) picks.push({ sis: s.sis, usage_id: m!.usage_id!, basis: "matcher", by_: null });
      else unlinkedReason.set(s.sis, `waiting for a decision: ${res.why}`);
      continue;
    }
    if (acc.accepted) { picks.push({ sis: s.sis, usage_id: m!.usage_id!, basis: "matcher", by_: null }); continue; }
    enqueue("undecided", acc.reason);
    unlinkedReason.set(s.sis, `waiting for a decision: ${acc.reason}`);
  }
  const rlSis = new Set(species.map((s) => s.sis));
  const orphaned = [...decisions.keys()].filter((k) => !rlSis.has(k));
  if (orphaned.length > 0) console.log(`  ${orphaned.length} decisions name species no longer assessed (SIS ${orphaned.slice(0, 5).join(", ")}${orphaned.length > 5 ? ", ..." : ""})`);

  await writeTable(conn, "picks", { sis: "INTEGER", usage_id: "VARCHAR", basis: "VARCHAR", by_: "VARCHAR" }, picks);

  // ── 2. Concept ─────────────────────────────────────────────────────────────
  // The species each usage makes it: itself if accepted, a synonym's species,
  // or a demoted XR species' checklist species when that is an accepted XR
  // species (Pagrus auratus' release parent is an ambiguous synonym in the XR
  // that resolves to Sparus aurata, another fish).
  const primary = await rows<{
    sis: number; name: string; authority: string | null; basis: "matcher" | "decision"; by_: string | null; method: string;
    usage_id: string; usage_name: string; usage_authorship: string | null; usage_status: string;
    usage_parent: string | null; usage_parent_rank: string | null; usage_parent_name: string | null;
    target_id: string | null; target_name: string | null; target_authorship: string | null;
  }>(conn, `
    WITH picked AS (
      SELECT pick.sis, pick.basis, pick.by_, usage.*,
             CASE WHEN usage.demoted THEN 'checklist_synonym' WHEN usage.status = 'accepted' THEN 'accepted'
                  WHEN usage.status = 'provisionally accepted' THEN 'provisional' WHEN usage.status = 'synonym' THEN 'synonym'
                  WHEN usage.status = 'ambiguous synonym' THEN 'ambiguous_synonym' ELSE replace(usage.status, ' ', '_') END AS method,
             CASE WHEN usage.status IN ('accepted', 'provisionally accepted') THEN
                    CASE WHEN usage.demoted AND checklist_parent.status = 'accepted' AND checklist_parent.rank = 'species'
                              AND NOT checklist_parent.demoted THEN checklist_parent.col_id ELSE usage.col_id END
                  WHEN usage.status IN ('synonym', 'ambiguous synonym') THEN usage.species_id END AS target_col_id
      FROM picks pick JOIN col_usages usage ON usage.col_id = pick.usage_id
      LEFT JOIN col_usages checklist_parent ON checklist_parent.col_id = usage.checklist_parent_id)
    SELECT r.sis, r.name, r.authority, picked.basis, picked.by_, picked.method,
           picked.col_id AS usage_id, picked.scientific_name AS usage_name, picked.authorship AS usage_authorship,
           picked.status AS usage_status, picked.parent_id AS usage_parent,
           usage_parent.rank AS usage_parent_rank, usage_parent.scientific_name AS usage_parent_name,
           target.col_id AS target_id, target.scientific_name AS target_name, target.authorship AS target_authorship
    FROM picked JOIN redlist_species r ON r.sis = picked.sis
    LEFT JOIN col_usages target ON target.col_id = picked.target_col_id
    LEFT JOIN col_usages usage_parent ON usage_parent.col_id = picked.parent_id`);

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
    if (!p.target_id || !p.target_name) { unlinkedReason.set(p.sis, `${p.usage_name} leads to no accepted species`); continue; }
    // A decision says the Red List name IS this CoL name, however spelled, so
    // decideKey may be asked about either spelling: the author comparison
    // can't undo what the decision settled.
    const asListed = { scientificName: p.name, authorship: p.authority ?? undefined };
    const asDecided = { scientificName: p.usage_name, authorship: p.usage_authorship ?? undefined };
    const usage = { key: p.usage_id, scientificName: p.usage_name, authorship: p.usage_authorship ?? undefined };
    const target = { key: p.target_id, scientificName: p.target_name, authorship: p.target_authorship ?? undefined };
    // Its own name is a CoL synonym that CoL marks as a respelling of the
    // accepted name (same citation): the same species, whatever the Red List's
    // citation says (Meandrina danae / danai).
    const respelled = p.basis === "matcher" && p.method === "synonym"
      && (ownNameSynonyms.get(`${p.sis}|${p.target_id}`) ?? []).some((u) => isCoLRespelling({ scientificName: u.name, authorship: u.authorship ?? undefined }, target))
      && !isSeparatelyAssessed(p.target_name, p.name, assessedNames);
    const d = p.method === "ambiguous_synonym"
      ? { verdict: "lumped" as const, reason: `CoL lists ${p.usage_name} as an ambiguous synonym of ${p.target_name}; counting only records under this name` }
      : respelled
      ? { verdict: "own" as const, reason: `CoL spells it ${p.target_name} (${p.usage_name} is its orthographic variant, same citation)` }
      : (() => {
          const ask = (sp: typeof asListed) => decideKey({ species: sp, reachedBy: "canonical", usage, acceptedUsage: p.target_id !== p.usage_id ? target : undefined, assessedNames });
          const listed = ask(asListed);
          return p.basis === "decision" && listed.verdict !== "own" ? ask(asDecided) : listed;
        })();
    // A lumped species' records start at its own usage, or at the infraspecific
    // CoL files that synonym under (Fringilla polatzeki → F. teydea polatzeki).
    // Not a nominate infraspecific (Rosa villosa subsp. villosa): that is the
    // species' core, whose records are the accepted species', not this one's.
    const nominate = p.usage_parent_name ? (() => { const w = p.usage_parent_name.toLowerCase().split(/\s+/); return w.length > 2 && w[w.length - 1] === w[1]; })() : false;
    const lumpRoot = p.usage_status === "synonym" && p.usage_parent && p.usage_parent_rank && p.usage_parent_rank !== "species" && p.usage_parent !== p.target_id && !nominate
      ? p.usage_parent : p.usage_id;
    links.push({
      sis_taxon_id: p.sis, role: "primary", col_id: p.target_id,
      usage_id: d.verdict === "own" ? p.target_id : d.verdict === "lumped" ? lumpRoot : null,
      verdict: d.verdict, method: p.method, basis: p.basis, decided_by: p.by_, reason: d.reason, counted: d.verdict === "own" || d.verdict === "lumped",
    });
  }
  const linked = new Set(links.map((l) => l.sis_taxon_id));
  for (const s of species) {
    if (!linked.has(s.sis)) links.push({ sis_taxon_id: s.sis, role: "primary", col_id: null, usage_id: null, verdict: "none", method: "unmatched",
      basis: null, decided_by: null, reason: unlinkedReason.get(s.sis) ?? "no CoL name", counted: false });
  }

  // Covered rows: other CoL species the same organism sits under. Each is kept
  // out of the Not Evaluated list; it counts only where the evidence that it is
  // the same organism is direct:
  //   - one of IUCN's synonyms IS that accepted name (Hylatomus / Dryocopus
  //     pileatus). Reached only through a CoL synonym it stays uncounted: that
  //     two-hop route took Chiococca alba to the snowberry.
  //   - its own name is also a CoL synonym of another accepted species that is
  //     the same organism (Accipiter cirrocephalus -> Tachyspiza cirrocephala)
  //   - the identical name held twice, in one class or under one author
  //     citation (Andoa berthelotiana, accepted and provisionally accepted)
  //   - the same epithet stem and the same dated author citation in one family,
  //     under another genus (Accipiter cirrocephalus / Tachyspiza cirrocephala,
  //     both Vigors, 1825): one bird CoL holds twice
  //   - for a lumped species, every synonym usage with its exact name (Rubus
  //     fruticosus is filed under three parents)
  // What an IUCN synonym can name: an accepted species (kind 0), a strict
  // synonym's species (1), or a demoted XR species' checklist species (2).
  const covered = await rows<{ sis: number; name: string; authority: string | null; target_id: string; target_name: string; target_authorship: string | null; kind: number; src: string }>(conn, `
    WITH offer AS (
      SELECT name_key, col_id AS target_id, 0 AS kind FROM col_usages WHERE rank = 'species' AND status = 'accepted' AND NOT demoted
      UNION ALL
      SELECT name_key, species_id, 1 FROM col_usages WHERE rank = 'species' AND status = 'synonym' AND species_id IS NOT NULL
      UNION ALL
      SELECT t.name_key, CASE WHEN p.status = 'accepted' AND p.rank = 'species' AND NOT p.demoted THEN p.col_id ELSE t.col_id END, 2
      FROM col_usages t LEFT JOIN col_usages p ON p.col_id = t.checklist_parent_id WHERE t.demoted),
    syn AS (SELECT sis, name, authority, kingdom, phylum, ${NAME("s.name")} AS synonym_name_key FROM redlist_species, unnest(synonyms) AS u(s))
    SELECT DISTINCT r.sis, r.name, r.authority, target.col_id AS target_id, target.scientific_name AS target_name, target.authorship AS target_authorship, o.kind, 'iucn' AS src
    FROM syn r JOIN offer o ON o.name_key = r.synonym_name_key JOIN col_usages target ON target.col_id = o.target_id AND ${sameLineage}
    UNION
    SELECT DISTINCT o.sis, r.name, r.authority, t.col_id, t.scientific_name, t.authorship, 0, 'own_name_synonym'
    FROM own_syn o JOIN redlist_species r ON r.sis = o.sis JOIN col_usages t ON t.col_id = o.target_id`);
  const primaryTarget = new Map(links.map((l) => [l.sis_taxon_id, l.col_id]));
  const seenCover = new Set<string>();
  const cover = (row: Omit<LinkRow, "basis" | "decided_by">) => {
    const k = `${row.sis_taxon_id}|${row.col_id}|${row.usage_id}`;
    // The species' own target needs no covered row, except as a second usage a lumped species owns.
    if (seenCover.has(k) || (row.verdict !== "lumped" && primaryTarget.get(row.sis_taxon_id) === row.col_id)) return;
    seenCover.add(k);
    links.push({ ...row, basis: "rule", decided_by: null });
  };
  for (const c of covered) {
    // A shared epithet under another genus is a genus move only if the authors
    // agree too: Himantopus leucocephalus Gould, 1837 is the pied stilt, not the
    // banded stilt Cladorhynchus leucocephalus (Vieillot, 1816), whose IUCN
    // synonyms name it. Where either citation is missing there is nothing to check.
    const otherGenus = c.name.split(" ")[0].toLowerCase() !== c.target_name.split(" ")[0].toLowerCase();
    const authorsAgree = !c.authority || !c.target_authorship || sameAuthors(c.authority, c.target_authorship);
    const same = (c.kind === 0 || c.src === "own_name_synonym")
      && sameOrganism({ scientificName: c.name, authorship: c.authority ?? undefined }, { scientificName: c.target_name, authorship: c.target_authorship ?? undefined })
      && (!otherGenus || authorsAgree)
      && !isSeparatelyAssessed(c.target_name, c.name, assessedNames);
    cover({
      sis_taxon_id: c.sis, role: "covered", col_id: c.target_id, usage_id: same ? c.target_id : null, verdict: same ? "own" : "refused",
      method: "iucn_synonym_covered", reason: same ? `${c.target_name} is the same organism under another accepted name` : `${c.target_name} is named as a synonym; kept out of the Not Evaluated list only`,
      counted: same,
    });
  }

  // Twins and duplicate concepts of each species' own target.
  const accepted = await rows<{ col_id: string; scientific_name: string; authorship: string | null; family: string | null; class_name: string | null }>(conn, `
    SELECT col_id, scientific_name, authorship, family, class_name FROM col_usages
    WHERE rank = 'species' AND status IN ('accepted', 'provisionally accepted') AND NOT demoted`);
  const byId = new Map(accepted.map((x) => [x.col_id, x]));
  // A twin: the identical name (a hybrid sign aside: Utricularia × ochroleuca)
  // in the same class, or with the same author citation (Andoa berthelotiana
  // sits in two moss families, both "(Mont.) Ochyra"; Frullania azorica is
  // accepted in one liverwort family and provisionally in another). Class, not
  // kingdom: Centropogon australis is a plant and a fish.
  const twinName = (n: string) => n.toLowerCase().replace(/\s*×\s*/g, " ").replace(/\s+/g, " ").trim();
  const twinKeys = (x: { scientific_name: string; class_name: string | null; authorship: string | null }) => [
    ...(x.class_name ? [`c|${x.class_name}|${twinName(x.scientific_name)}`] : []),
    ...(x.authorship ? [`a|${normaliseAuthorship(x.authorship)}|${twinName(x.scientific_name)}`] : []),
  ];
  const dupKey = (x: { scientific_name: string; authorship: string | null; family: string | null }) => {
    const p = speciesNameParts(x.scientific_name);
    const year = x.authorship?.match(/\b(1[7-9]\d\d|20\d\d)\b/)?.[1];
    const surname = x.authorship ? normaliseAuthorship(x.authorship).replace(/\b\d{4}\b/g, "").replace(/\b[a-z]\b/g, "").replace(/\s+/g, " ").trim() : "";
    return p && year && surname ? `${x.family}|${canonicalEpithet(p[1])}|${surname}|${year}` : null;
  };
  const twins = new Map<string, string[]>();
  const dups = new Map<string, string[]>();
  for (const x of accepted) {
    for (const t of twinKeys(x)) twins.set(t, [...(twins.get(t) ?? []), x.col_id]);
    const d = dupKey(x); if (d) dups.set(d, [...(dups.get(d) ?? []), x.col_id]);
  }
  const genus = (n: string) => n.split(" ")[0].toLowerCase();
  const listedName = new Map(species.map((s) => [s.sis, norm(s.name)]));
  for (const l of [...links]) {
    if (l.role !== "primary" || l.verdict !== "own" || !l.col_id) continue;
    const t = byId.get(l.col_id);
    if (!t) continue;
    const add = (id: string, method: string, reason: string) => {
      const u = byId.get(id)!;
      // A twin carrying this species' own Red List name is this species, not a
      // separately assessed one (Utricularia ochroleuca, matched to its × twin).
      const ownName = norm(u.scientific_name) === listedName.get(l.sis_taxon_id);
      if (id === t.col_id || (!ownName && isSeparatelyAssessed(u.scientific_name, t.scientific_name, assessedNames))) return;
      cover({ sis_taxon_id: l.sis_taxon_id, role: "covered", col_id: id, usage_id: id, verdict: "own", method, reason, counted: true });
    };
    for (const id of new Set(twinKeys(t).flatMap((k) => twins.get(k) ?? []))) add(id, "same_name_twin", `CoL holds ${t.scientific_name} twice`);
    const dk = dupKey(t);
    for (const id of dk ? dups.get(dk) ?? [] : []) {
      if (genus(byId.get(id)!.scientific_name) !== genus(t.scientific_name)) {
        add(id, "duplicate_concept", `${byId.get(id)!.scientific_name} has the same epithet and author citation (${t.authorship}): one organism held twice`);
      }
    }
  }

  // A checklist demotion followed to the checklist's species: the demoted XR
  // species is where GBIF files the records (Cathormion umbellatum, 200; its
  // checklist species Albizia umbellata has none), and it is on no list.
  const pickedUsage = new Map(primary.map((p) => [p.sis, p]));
  for (const l of [...links]) {
    if (l.role !== "primary" || l.verdict !== "own" || l.method !== "checklist_synonym") continue;
    const p = pickedUsage.get(l.sis_taxon_id);
    if (!p || p.usage_id === p.target_id) continue;
    cover({ sis_taxon_id: l.sis_taxon_id, role: "covered", col_id: p.usage_id, usage_id: p.usage_id, verdict: "own", method: "checklist_demoted",
      reason: `${p.usage_name} is the XR species the checklist folds into ${p.target_name}; GBIF files its records there`, counted: true });
  }

  // A lumped species owns every synonym usage carrying its exact name.
  const sameNameSyn = await rows<{ sis: number; usage: string; target: string }>(conn, `
    SELECT r.sis, t.col_id AS usage, t.species_id AS target FROM redlist_species r
    JOIN col_usages t ON t.name_key = r.name_key AND t.rank = 'species' AND t.status IN ('synonym', 'ambiguous synonym') AND t.species_id IS NOT NULL`);
  const lumpedPrimary = new Map(links.filter((l) => l.role === "primary" && l.verdict === "lumped" && ["synonym", "ambiguous_synonym"].includes(l.method)).map((l) => [l.sis_taxon_id, l]));
  for (const x of sameNameSyn) {
    const l = lumpedPrimary.get(x.sis);
    if (!l || x.usage === l.usage_id) continue;
    cover({ sis_taxon_id: x.sis, role: "covered", col_id: x.target, usage_id: x.usage, verdict: "lumped", method: "same_name_synonym",
      reason: "CoL files this name under more than one species; its records under each are its own", counted: true });
  }

  // Never across phyla, however a row was made: old genus names are homonyms
  // across kingdoms (the surgeonfish Acanthurus lineatus and the crab Hepatus
  // lineatus), and twins and lumps are found by name alone.
  await writeTable(conn, "linked_pairs", { sis: "INTEGER", col_id: "VARCHAR" },
    links.filter((l) => l.col_id).map((l) => ({ sis: l.sis_taxon_id, col_id: l.col_id })));
  const crossing = new Set((await rows<{ k: string }>(conn, `
    SELECT DISTINCT r.sis || '|' || target.col_id AS k FROM linked_pairs i JOIN redlist_species r ON r.sis = i.sis JOIN col_usages target ON target.col_id = i.col_id
    WHERE NOT ${sameLineage}`)).map((x) => x.k));
  for (let i = links.length - 1; i >= 0; i--) {
    const l = links[i];
    if (!l.col_id || !crossing.has(`${l.sis_taxon_id}|${l.col_id}`)) continue;
    if (l.role === "covered") { links.splice(i, 1); continue; }
    Object.assign(l, { col_id: null, usage_id: null, verdict: "none", method: "unmatched", counted: false,
      reason: "the only CoL match is in another phylum" });
  }

  // One owner per usage: primary before covered, own before lumped, the
  // matcher before a decision, the more direct name, then lower SIS id.
  const rank = (l: LinkRow) => [l.role === "primary" ? 0 : 1, l.verdict === "own" ? 0 : 1, l.basis === "decision" ? 1 : 0,
    Math.max(0, (METHODS as readonly string[]).indexOf(l.method)), l.sis_taxon_id];
  const claimants = links.filter((l) => l.counted).sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const owner = new Map<string, number>();
  for (const l of claimants) {
    const prev = owner.get(l.usage_id!);
    if (prev === undefined) { owner.set(l.usage_id!, l.sis_taxon_id); continue; }
    l.counted = false;
    if (l.role === "primary") { l.verdict = "duplicate"; l.reason = `its records belong to SIS ${prev}, matched first`; l.usage_id = null; }
  }

  await writeTable<LinkRow>(conn, "link_rows", { sis_taxon_id: "BIGINT", role: "VARCHAR", col_id: "VARCHAR", usage_id: "VARCHAR",
    verdict: "VARCHAR", method: "VARCHAR", basis: "VARCHAR", decided_by: "VARCHAR", reason: "VARCHAR", counted: "BOOLEAN" }, links);
  fs.mkdirSync(coreDir, { recursive: true });
  await conn.run(`COPY (SELECT * FROM link_rows ORDER BY sis_taxon_id, role DESC, col_id) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);
  return { out, queue };
}

/** The queue as the TSV a person works through: by status, then reason, then SIS id. */
export function writeQueue(queue: QueueRow[], file: string): void {
  const cols = Object.keys({ sis_taxon_id: 0, name: 0, authority: 0, status: 0, reason: 0, matcher_usage_id: 0, matcher_name: 0,
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

export async function run(): Promise<void> {
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "16" })).connect();
  const { out, queue } = await buildLink(conn, CORE_DIR);
  writeQueue(queue, path.join(BUILD_DIR, "match-queue.tsv"));
  const summary = await rows<{ role: string; basis: string | null; verdict: string; method: string; n: number }>(conn, `
    SELECT role, basis, verdict, method, count(*)::INT AS n FROM read_parquet(${lit(out)}) GROUP BY ALL ORDER BY role DESC, n DESC`);
  console.log(`Wrote ${out}`);
  for (const s of summary) console.log(`  ${s.role.padEnd(8)} ${(s.basis ?? "-").padEnd(9)} ${s.verdict.padEnd(10)} ${s.method.padEnd(22)} ${s.n.toLocaleString()}`);
  console.log(`Queue (${queue.length.toLocaleString()}):`);
  for (const [k, n] of Object.entries(summariseQueue(queue))) console.log(`  ${String(n).padStart(6)}  ${k}`);
}

const isDirectRun = process.argv[1]?.endsWith("core/build-link.ts") || process.argv[1]?.endsWith("core/build-link.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((e) => { console.error(e); process.exit(1); });
}
