/**
 * build-link: which CoL species each assessed species is, decided once.
 *
 * Two steps, kept apart so each can be explained on its own:
 *
 * 1. Name: which CoL usage the Red List name is.
 *      a decision in decisions.tsv, if there is one and it still resolves;
 *      else GBIF's matcher's answer (build-matches.ts), when accept-match.ts
 *      takes it without review;
 *      else nothing yet: the species is queued (core/match_queue.parquet) and
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
 * and core/match_queue.parquet, the species waiting for a person.
 *
 * Usage:  npx tsx scripts/pipeline/build-link.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles } from "../utils";
import { decideKey, sameOrganism, isSeparatelyAssessed, isCoLRespelling, normaliseAuthorship, type Verdict } from "../species-key";
import { speciesNameParts, canonicalEpithet } from "../name-variants";
import { acceptMatch, sameAuthors, type MatchAnswer, type QueueReason } from "./accept-match";
import { readDecisions, resolveDecision, type Candidate, type Decision } from "./decisions";
import { CORE_DIR } from "./paths";

export { sameAuthors };

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
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

async function rows<T>(conn: DuckDBConnection, sql: string): Promise<T[]> {
  return (await conn.runAndReadAll(sql)).getRowObjects() as unknown as T[];
}

export async function buildLink(
  conn: DuckDBConnection, coreDir: string, opts: { decisions?: Map<number, Decision> } = {},
): Promise<{ out: string; queue: QueueRow[] }> {
  const taxa = lit(path.join(coreDir, "taxa.parquet"));
  const assessments = lit(path.join(coreDir, "assessments.parquet"));
  const matches = lit(path.join(coreDir, "matches.parquet"));
  const out = path.join(coreDir, "assessment_link.parquet");
  const decisions = opts.decisions ?? readDecisions();

  await conn.run(`CREATE OR REPLACE TEMP TABLE rl AS
    SELECT sis_taxon_id::INTEGER AS sis, scientific_name AS name, ${NAME("scientific_name")} AS nm, authority,
           family, class_name, phylum_name AS phylum, kingdom_name AS kingdom, synonyms
    FROM read_parquet(${assessments}) WHERE is_latest`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE tx AS
    SELECT col_id, parent_id, status, rank, scientific_name, authorship, family, class_name, phylum, kingdom, species_id, demoted,
           checklist_parent_id, ${NAME("scientific_name")} AS nm
    FROM read_parquet(${taxa})`);

  // IUCN and CoL name one phylum differently (the brown algae); unknown lineage is no evidence.
  const sameLineage = `(r.kingdom IS NULL OR tt.kingdom IS NULL OR (r.kingdom = tt.kingdom AND (r.phylum IS NULL OR tt.phylum IS NULL
    OR replace(r.phylum, 'heterokontophyta', 'ochrophyta') = tt.phylum)))`;

  // ── 1. Name ────────────────────────────────────────────────────────────────
  const answers = new Map((await rows<Omit<MatchAnswer, "alternatives"> & { sis_taxon_id: number; alts: string | null }>(conn, `
    SELECT sis_taxon_id, usage_id, usage_name, usage_authorship, usage_rank, usage_status, match_type, confidence,
           to_json(alternatives)::VARCHAR AS alts
    FROM read_parquet(${matches})`)).map((m) => [m.sis_taxon_id, { ...m, alternatives: (m.alts ? JSON.parse(m.alts) : null) ?? [] } as MatchAnswer]));
  const speciesOf = new Map((await rows<{ col_id: string; species_id: string | null }>(conn, `
    WITH ids AS (SELECT usage_id AS id FROM read_parquet(${matches}) UNION
                 SELECT unnest(list_transform(alternatives, a -> a.usage_id)) FROM read_parquet(${matches}))
    SELECT t.col_id, t.species_id FROM ids JOIN tx t ON t.col_id = ids.id`)).map((r) => [r.col_id, r.species_id]));
  const decidedNames = [...new Set([...decisions.values()].flatMap((d) => (d.colName ? [norm(d.colName)] : [])))];
  const candidates = new Map<string, Candidate[]>();
  if (decidedNames.length > 0) {
    await conn.run(`CREATE OR REPLACE TEMP TABLE decided_names AS SELECT unnest([${decidedNames.map(lit).join(", ")}]::VARCHAR[]) AS nm`);
    for (const c of await rows<Candidate & { nm: string }>(conn, `
        SELECT t.nm, t.col_id, t.scientific_name, t.authorship, t.status FROM tx t JOIN decided_names USING (nm) WHERE t.rank = 'species'`)) {
      candidates.set(c.nm, [...(candidates.get(c.nm) ?? []), c]);
    }
  }

  const species = await rows<{ sis: number; name: string; authority: string | null }>(conn, `SELECT sis, name, authority FROM rl ORDER BY sis`);
  const picks: { sis: number; usage: string; basis: "matcher" | "decision"; by: string | null }[] = [];
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
        if (res.kind === "usage") picks.push({ sis: s.sis, usage: res.colId, basis: "decision", by: d.by });
        else unlinkedReason.set(s.sis, `not in CoL (decided by ${d.by})`);
        continue;
      }
      // A decision that no longer resolves is asked again; meanwhile the matcher's answer stands if it is certain.
      enqueue("stale", res.why, d.by);
      if (acc.accepted) picks.push({ sis: s.sis, usage: m!.usage_id!, basis: "matcher", by: null });
      else unlinkedReason.set(s.sis, `waiting for a decision: ${res.why}`);
      continue;
    }
    if (acc.accepted) { picks.push({ sis: s.sis, usage: m!.usage_id!, basis: "matcher", by: null }); continue; }
    enqueue("undecided", acc.reason);
    unlinkedReason.set(s.sis, `waiting for a decision: ${acc.reason}`);
  }
  const rlSis = new Set(species.map((s) => s.sis));
  const orphaned = [...decisions.keys()].filter((k) => !rlSis.has(k));
  if (orphaned.length > 0) console.log(`  ${orphaned.length} decisions name species no longer assessed (SIS ${orphaned.slice(0, 5).join(", ")}${orphaned.length > 5 ? ", ..." : ""})`);

  await conn.run(`CREATE OR REPLACE TEMP TABLE picks (sis INTEGER, usage_id VARCHAR, basis VARCHAR, by_ VARCHAR)`);
  const pickAp = await conn.createAppender("picks");
  for (const p of picks) {
    pickAp.appendInteger(p.sis); pickAp.appendVarchar(p.usage); pickAp.appendVarchar(p.basis);
    if (p.by === null) pickAp.appendNull(); else pickAp.appendVarchar(p.by);
    pickAp.endRow();
  }
  pickAp.closeSync();

  // ── 2. Concept ─────────────────────────────────────────────────────────────
  // The species each usage makes it: itself if accepted, a synonym's species,
  // or a demoted XR species' checklist species when that is an accepted XR
  // species (Pagrus auratus' release parent is an ambiguous synonym in the XR
  // that resolves to Sparus aurata, another fish).
  const primary = await rows<{
    sis: number; name: string; authority: string | null; basis: "matcher" | "decision"; by_: string | null; method: string;
    u_id: string; u_name: string; u_auth: string | null; u_status: string; u_parent: string | null; u_parent_rank: string | null; u_parent_name: string | null;
    t_id: string | null; t_name: string | null; t_auth: string | null;
  }>(conn, `
    WITH p AS (
      SELECT p.sis, p.basis, p.by_, u.*,
             CASE WHEN u.demoted THEN 'checklist_synonym' WHEN u.status = 'accepted' THEN 'accepted'
                  WHEN u.status = 'provisionally accepted' THEN 'provisional' WHEN u.status = 'synonym' THEN 'synonym'
                  WHEN u.status = 'ambiguous synonym' THEN 'ambiguous_synonym' ELSE replace(u.status, ' ', '_') END AS method,
             CASE WHEN u.status IN ('accepted', 'provisionally accepted') THEN
                    CASE WHEN u.demoted AND cp.status = 'accepted' AND cp.rank = 'species' AND NOT cp.demoted THEN cp.col_id ELSE u.col_id END
                  WHEN u.status IN ('synonym', 'ambiguous synonym') THEN u.species_id END AS target
      FROM picks p JOIN tx u ON u.col_id = p.usage_id LEFT JOIN tx cp ON cp.col_id = u.checklist_parent_id)
    SELECT r.sis, r.name, r.authority, p.basis, p.by_, p.method,
           p.col_id AS u_id, p.scientific_name AS u_name, p.authorship AS u_auth, p.status AS u_status,
           p.parent_id AS u_parent, up.rank AS u_parent_rank, up.scientific_name AS u_parent_name,
           tt.col_id AS t_id, tt.scientific_name AS t_name, tt.authorship AS t_auth
    FROM p JOIN rl r ON r.sis = p.sis LEFT JOIN tx tt ON tt.col_id = p.target LEFT JOIN tx up ON up.col_id = p.parent_id`);

  const assessedNames = new Set((await rows<{ nm: string }>(conn, `SELECT nm FROM rl`)).map((r) => r.nm));
  // Every CoL synonym carrying a species' own name, with the species it leads
  // to: CoL can hold one name several times under different citations
  // (Clithon oualaniensis, three times), and any one may be the respelling.
  await conn.run(`CREATE OR REPLACE TEMP TABLE own_syn AS
    SELECT r.sis, tt.col_id AS target_id, u.scientific_name AS name, u.authorship
    FROM rl r JOIN tx u ON u.nm = r.nm AND u.rank = 'species' AND u.status = 'synonym' AND u.species_id IS NOT NULL
    JOIN tx tt ON tt.col_id = u.species_id AND ${sameLineage}`);
  const ownNameSynonyms = new Map<string, { name: string; authorship: string | null }[]>();
  for (const r of await rows<{ sis: number; target_id: string; name: string; authorship: string | null }>(conn, `SELECT * FROM own_syn`)) {
    const k = `${r.sis}|${r.target_id}`;
    ownNameSynonyms.set(k, [...(ownNameSynonyms.get(k) ?? []), { name: r.name, authorship: r.authorship }]);
  }

  const links: LinkRow[] = [];
  for (const p of primary) {
    if (!p.t_id || !p.t_name) { unlinkedReason.set(p.sis, `${p.u_name} leads to no accepted species`); continue; }
    // A decision says the Red List name IS this CoL name, however spelled, so
    // decideKey may be asked about either spelling: the author comparison
    // can't undo what the decision settled.
    const asListed = { scientificName: p.name, authorship: p.authority ?? undefined };
    const asDecided = { scientificName: p.u_name, authorship: p.u_auth ?? undefined };
    const usage = { key: p.u_id, scientificName: p.u_name, authorship: p.u_auth ?? undefined };
    const target = { key: p.t_id, scientificName: p.t_name, authorship: p.t_auth ?? undefined };
    // Its own name is a CoL synonym that CoL marks as a respelling of the
    // accepted name (same citation): the same species, whatever the Red List's
    // citation says (Meandrina danae / danai).
    const respelled = p.basis === "matcher" && p.method === "synonym"
      && (ownNameSynonyms.get(`${p.sis}|${p.t_id}`) ?? []).some((u) => isCoLRespelling({ scientificName: u.name, authorship: u.authorship ?? undefined }, target))
      && !isSeparatelyAssessed(p.t_name, p.name, assessedNames);
    const d = p.method === "ambiguous_synonym"
      ? { verdict: "lumped" as const, reason: `CoL lists ${p.u_name} as an ambiguous synonym of ${p.t_name}; counting only records under this name` }
      : respelled
      ? { verdict: "own" as const, reason: `CoL spells it ${p.t_name} (${p.u_name} is its orthographic variant, same citation)` }
      : (() => {
          const ask = (sp: typeof asListed) => decideKey({ species: sp, reachedBy: "canonical", usage, acceptedUsage: p.t_id !== p.u_id ? target : undefined, assessedNames });
          const listed = ask(asListed);
          return p.basis === "decision" && listed.verdict !== "own" ? ask(asDecided) : listed;
        })();
    // A lumped species' records start at its own usage, or at the infraspecific
    // CoL files that synonym under (Fringilla polatzeki → F. teydea polatzeki).
    // Not a nominate infraspecific (Rosa villosa subsp. villosa): that is the
    // species' core, whose records are the accepted species', not this one's.
    const nominate = p.u_parent_name ? (() => { const w = p.u_parent_name.toLowerCase().split(/\s+/); return w.length > 2 && w[w.length - 1] === w[1]; })() : false;
    const lumpRoot = p.u_status === "synonym" && p.u_parent && p.u_parent_rank && p.u_parent_rank !== "species" && p.u_parent !== p.t_id && !nominate
      ? p.u_parent : p.u_id;
    links.push({
      sis_taxon_id: p.sis, role: "primary", col_id: p.t_id,
      usage_id: d.verdict === "own" ? p.t_id : d.verdict === "lumped" ? lumpRoot : null,
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
  const covered = await rows<{ sis: number; name: string; authority: string | null; t_id: string; t_name: string; t_auth: string | null; kind: number; src: string }>(conn, `
    WITH offer AS (
      SELECT nm, col_id AS target_id, 0 AS kind FROM tx WHERE rank = 'species' AND status = 'accepted' AND NOT demoted
      UNION ALL
      SELECT nm, species_id, 1 FROM tx WHERE rank = 'species' AND status = 'synonym' AND species_id IS NOT NULL
      UNION ALL
      SELECT t.nm, CASE WHEN p.status = 'accepted' AND p.rank = 'species' AND NOT p.demoted THEN p.col_id ELSE t.col_id END, 2
      FROM tx t LEFT JOIN tx p ON p.col_id = t.checklist_parent_id WHERE t.demoted),
    syn AS (SELECT sis, name, authority, kingdom, phylum, ${NAME("s.name")} AS snm FROM rl, unnest(synonyms) AS u(s))
    SELECT DISTINCT r.sis, r.name, r.authority, tt.col_id AS t_id, tt.scientific_name AS t_name, tt.authorship AS t_auth, o.kind, 'iucn' AS src
    FROM syn r JOIN offer o ON o.nm = r.snm JOIN tx tt ON tt.col_id = o.target_id AND ${sameLineage}
    UNION
    SELECT DISTINCT o.sis, r.name, r.authority, t.col_id, t.scientific_name, t.authorship, 0, 'own_name_synonym'
    FROM own_syn o JOIN rl r ON r.sis = o.sis JOIN tx t ON t.col_id = o.target_id`);
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
    const otherGenus = c.name.split(" ")[0].toLowerCase() !== c.t_name.split(" ")[0].toLowerCase();
    const authorsAgree = !c.authority || !c.t_auth || sameAuthors(c.authority, c.t_auth);
    const same = (c.kind === 0 || c.src === "own_name_synonym")
      && sameOrganism({ scientificName: c.name, authorship: c.authority ?? undefined }, { scientificName: c.t_name, authorship: c.t_auth ?? undefined })
      && (!otherGenus || authorsAgree)
      && !isSeparatelyAssessed(c.t_name, c.name, assessedNames);
    cover({
      sis_taxon_id: c.sis, role: "covered", col_id: c.t_id, usage_id: same ? c.t_id : null, verdict: same ? "own" : "refused",
      method: "iucn_synonym_covered", reason: same ? `${c.t_name} is the same organism under another accepted name` : `${c.t_name} is named as a synonym; kept out of the Not Evaluated list only`,
      counted: same,
    });
  }

  // Twins and duplicate concepts of each species' own target.
  const accepted = await rows<{ col_id: string; scientific_name: string; authorship: string | null; family: string | null; class_name: string | null }>(conn, `
    SELECT col_id, scientific_name, authorship, family, class_name FROM tx
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
    if (!p || p.u_id === p.t_id) continue;
    cover({ sis_taxon_id: l.sis_taxon_id, role: "covered", col_id: p.u_id, usage_id: p.u_id, verdict: "own", method: "checklist_demoted",
      reason: `${p.u_name} is the XR species the checklist folds into ${p.t_name}; GBIF files its records there`, counted: true });
  }

  // A lumped species owns every synonym usage carrying its exact name.
  const sameNameSyn = await rows<{ sis: number; usage: string; target: string }>(conn, `
    SELECT r.sis, t.col_id AS usage, t.species_id AS target FROM rl r
    JOIN tx t ON t.nm = r.nm AND t.rank = 'species' AND t.status IN ('synonym', 'ambiguous synonym') AND t.species_id IS NOT NULL`);
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
  await conn.run(`CREATE OR REPLACE TEMP TABLE linked_pairs (sis INTEGER, col_id VARCHAR)`);
  const pairAp = await conn.createAppender("linked_pairs");
  for (const l of links) if (l.col_id) { pairAp.appendInteger(l.sis_taxon_id); pairAp.appendVarchar(l.col_id); pairAp.endRow(); }
  pairAp.closeSync();
  const crossing = new Set((await rows<{ k: string }>(conn, `
    SELECT DISTINCT r.sis || '|' || tt.col_id AS k FROM linked_pairs i JOIN rl r ON r.sis = i.sis JOIN tx tt ON tt.col_id = i.col_id
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

  await conn.run(`CREATE OR REPLACE TEMP TABLE link_rows (sis_taxon_id BIGINT, role VARCHAR, col_id VARCHAR, usage_id VARCHAR,
    verdict VARCHAR, method VARCHAR, basis VARCHAR, decided_by VARCHAR, reason VARCHAR, counted BOOLEAN)`);
  const ap = await conn.createAppender("link_rows");
  const opt = (v: string | null) => (v === null ? ap.appendNull() : ap.appendVarchar(v));
  for (const l of links) {
    ap.appendBigInt(BigInt(l.sis_taxon_id)); ap.appendVarchar(l.role); opt(l.col_id); opt(l.usage_id);
    ap.appendVarchar(l.verdict); ap.appendVarchar(l.method); opt(l.basis); opt(l.decided_by); ap.appendVarchar(l.reason); ap.appendBoolean(l.counted);
    ap.endRow();
  }
  ap.closeSync();
  fs.mkdirSync(coreDir, { recursive: true });
  await conn.run(`COPY (SELECT * FROM link_rows ORDER BY sis_taxon_id, role DESC, col_id) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);

  await conn.run(`CREATE OR REPLACE TEMP TABLE queue_rows (sis_taxon_id BIGINT, name VARCHAR, authority VARCHAR, status VARCHAR, reason VARCHAR,
    matcher_usage_id VARCHAR, matcher_name VARCHAR, matcher_authorship VARCHAR, match_type VARCHAR, confidence INTEGER, decided_by VARCHAR)`);
  const qa = await conn.createAppender("queue_rows");
  const qopt = (v: string | null) => (v === null ? qa.appendNull() : qa.appendVarchar(v));
  for (const q of queue) {
    qa.appendBigInt(BigInt(q.sis_taxon_id)); qa.appendVarchar(q.name); qopt(q.authority); qa.appendVarchar(q.status); qa.appendVarchar(q.reason);
    qopt(q.matcher_usage_id); qopt(q.matcher_name); qopt(q.matcher_authorship); qopt(q.match_type);
    if (q.confidence === null) qa.appendNull(); else qa.appendInteger(q.confidence);
    qopt(q.decided_by);
    qa.endRow();
  }
  qa.closeSync();
  await conn.run(`COPY (SELECT * FROM queue_rows ORDER BY status, reason, sis_taxon_id) TO ${lit(path.join(coreDir, "match_queue.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);
  return { out, queue };
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
  const summary = await rows<{ role: string; basis: string | null; verdict: string; method: string; n: number }>(conn, `
    SELECT role, basis, verdict, method, count(*)::INT AS n FROM read_parquet(${lit(out)}) GROUP BY ALL ORDER BY role DESC, n DESC`);
  console.log(`Wrote ${out}`);
  for (const s of summary) console.log(`  ${s.role.padEnd(8)} ${(s.basis ?? "-").padEnd(9)} ${s.verdict.padEnd(10)} ${s.method.padEnd(22)} ${s.n.toLocaleString()}`);
  console.log(`Queue (${queue.length.toLocaleString()}):`);
  for (const [k, n] of Object.entries(summariseQueue(queue))) console.log(`  ${String(n).padStart(6)}  ${k}`);
}

const isDirectRun = process.argv[1]?.endsWith("pipeline/build-link.ts") || process.argv[1]?.endsWith("pipeline/build-link.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((e) => { console.error(e); process.exit(1); });
}
