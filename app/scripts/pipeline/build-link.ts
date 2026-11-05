/**
 * build-link: which CoL species each assessed species is, decided once.
 *
 * Replaces two independent chains that answered the same question: phase 6
 * (each name sent to GBIF's matcher, then key claims, lumped keys and
 * chooseRepresentative) and build-matching (a name match to CoL). GBIF keys
 * are CoL XR ids now, so one match against taxa answers both.
 *
 * Passes, first hit wins, all against usages the curated checklist hasn't
 * demoted:
 *   1 accepted       the species' own name is an accepted CoL species
 *                    (homonyms: same family, then class, then lowest id)
 *   2 synonym        its own name is a CoL synonym, or an XR species the
 *                    checklist demotes. An ambiguous synonym (CoL unsure which
 *                    species the name means) links too, but only ever counts
 *                    the records filed under that name
 *   3-5 variants     the same on the normalised name (Latin terminations:
 *                    Ochotona pallasii / pallasi), refusing an ambiguous key
 *   6 iucn_synonym   one of IUCN's own synonyms is accepted (beats) or a synonym
 *   7 orthographic   a respelling inside the name (Colostygia puengeleri /
 *                    pungeleri), accepted only when the authors agree too
 *                    (sameAuthors).
 *                    This used to be corroborated by GBIF's matcher, which no
 *                    longer finds that moth at all; two weak signals agreeing
 *                    is still the rule (Agrotis sabine / sabura fails both).
 *
 * Each match gets species-key.ts' verdict (decideKey, unchanged):
 *   own      the target is this species, under this name or a rename
 *   lumped   CoL folds it into another species, but its own usage was reached by
 *            its own name, so that usage (and anything under it) is its records
 *   refused  reached only through another name, onto another species
 *
 * Then ownership: a usage counts for one assessed species at most. A second
 * claimant on the same target is a duplicate and counts nothing.
 *
 * Covered rows: an IUCN synonym that is another accepted CoL species (CoL
 * holding one organism twice, Verreauxia / Sasia africana, Hylatomus /
 * Dryocopus pileatus). It is kept out of the Not Evaluated list, and when it is
 * the same organism and nobody else's, its records count too.
 *
 * Output: core/assessment_link.parquet, one primary row per assessed species
 * plus covered rows:
 *   sis_taxon_id, role (primary | covered), col_id (the species it is),
 *   usage_id (where its records start: the species for own, its own usage for
 *   lumped, NULL when nothing counts), verdict, method, reason, counted
 *
 * Usage:  npx tsx scripts/pipeline/build-link.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles } from "../utils";
import { decideKey, sameOrganism, isSeparatelyAssessed, isCoLRespelling, normaliseAuthorship, type Verdict } from "../species-key";
import { speciesNameParts, normalisedKey, orthographicKey, canonicalEpithet } from "../name-variants";
import { CORE_DIR } from "./paths";

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const NAME = (col: string) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;

/** Pass order is priority order. */
const PASSES = ["accepted", "accepted_homonym", "synonym", "checklist_synonym", "ambiguous_synonym",
  "accepted_variant", "synonym_variant", "provisional", "iucn_synonym", "orthographic_variant",
  "iucn_synonym_covered", "same_name_twin", "duplicate_concept", "checklist_demoted", "same_name_synonym"] as const;
type Method = (typeof PASSES)[number];
const VARIANT_METHODS = ["accepted_variant", "synonym_variant", "provisional", "orthographic_variant"] as const;

interface Usage { col_id: string; scientific_name: string; authorship: string | null; status: string; rank: string; parent_id: string | null }

export interface LinkRow {
  sis_taxon_id: number;
  role: "primary" | "covered";
  col_id: string | null;
  usage_id: string | null;
  verdict: Verdict | "duplicate";
  method: string;
  reason: string;
  counted: boolean;
}


/**
 * Do two author citations name the same author? Formats vary too much between
 * IUCN and CoL for equality ("Hook.f." / "Hook.fil.", "A.Shaw" / "Airy Shaw",
 * "Silhavy" / "Šilhavý"), so: some author word in common once diacritics are
 * folded (one may abbreviate the other, "Pit." / "Pitard"), and the same year
 * where both give one. Only ever asked about two spellings of one name.
 */
export function sameAuthors(a: string | null | undefined, b: string | null | undefined): boolean {
  const words = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/[^a-z]+/).filter((w) => w.length >= 2 && !["ex", "in", "et", "de", "van", "von", "fil", "f"].includes(w));
  const year = (s: string) => s.match(/\b(1[7-9]\d\d|20\d\d)\b/)?.[1];
  if (!a || !b) return false;
  const ya = year(a), yb = year(b);
  if (ya && yb && ya !== yb) return false;
  const wb = words(b);
  return words(a).some((x) => wb.some((y) => x === y || (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y))));
}

async function rows<T>(conn: DuckDBConnection, sql: string): Promise<T[]> {
  return (await conn.runAndReadAll(sql)).getRowObjects() as unknown as T[];
}

export async function buildLink(conn: DuckDBConnection, coreDir: string): Promise<string> {
  const taxa = lit(path.join(coreDir, "taxa.parquet"));
  const assessments = lit(path.join(coreDir, "assessments.parquet"));
  const out = path.join(coreDir, "assessment_link.parquet");

  await conn.run(`CREATE OR REPLACE TEMP TABLE rl AS
    SELECT sis_taxon_id::INTEGER AS sis, scientific_name AS name, ${NAME("scientific_name")} AS nm, authority,
           family, class_name, phylum_name AS phylum, kingdom_name AS kingdom, synonyms
    FROM read_parquet(${assessments}) WHERE is_latest`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE tx AS
    SELECT col_id, parent_id, status, rank, scientific_name, authorship, family, class_name, phylum, kingdom, species_id, demoted,
           checklist_parent_id, ${NAME("scientific_name")} AS nm
    FROM read_parquet(${taxa})`);
  // What a CoL usage can be matched to, and the species that makes it.
  //   kind 0: an accepted species (the target is itself)
  //   kind 1: a strict synonym (target: the species it counts towards)
  //   kind 2: an XR species the checklist demotes (target: the checklist's accepted species)
  //   kind 3: an ambiguous synonym: CoL isn't sure which species the name means,
  //           so it can only ever count its own records (see the verdict below)
  await conn.run(`CREATE OR REPLACE TEMP TABLE offer AS
    SELECT nm, col_id AS usage_id, col_id AS target_id, 0 AS kind, family, class_name, phylum, kingdom FROM tx
      WHERE rank = 'species' AND status = 'accepted' AND NOT demoted
    UNION ALL
    SELECT nm, col_id, species_id, 1, family, class_name, phylum, kingdom FROM tx
      WHERE rank = 'species' AND status = 'synonym' AND species_id IS NOT NULL
    UNION ALL
    -- When the release's accepted species isn't in the XR (it holds ~95k usages
    -- the XR lacks), the XR's own record is all there is to link to.
    -- Followed only to an accepted XR species: Pagrus auratus' release parent is
    -- an ambiguous synonym in the XR that resolves to Sparus aurata, another fish.
    SELECT t.nm, t.col_id, CASE WHEN p.status = 'accepted' AND p.rank = 'species' AND NOT p.demoted THEN p.col_id ELSE t.col_id END,
           2, t.family, t.class_name, t.phylum, t.kingdom FROM tx t LEFT JOIN tx p ON p.col_id = t.checklist_parent_id
      WHERE t.demoted
    UNION ALL
    SELECT nm, col_id, species_id, 3, family, class_name, phylum, kingdom FROM tx
      WHERE rank = 'species' AND status = 'ambiguous synonym' AND species_id IS NOT NULL
    UNION ALL
    -- kind 4: provisionally accepted under exactly this name. Ranked above an
    -- ambiguous synonym (kind 3) of the same name, which is CoL saying it can't
    -- place the name at all (Cipangopaludina chinensis is both).
    SELECT nm, col_id, col_id, 4, family, class_name, phylum, kingdom FROM tx
      WHERE rank = 'species' AND status = 'provisionally accepted' AND NOT demoted`);

  // Homonyms: the closest lineage. IUCN's and CoL's classes can differ for the
  // same animal (Actinopterygii / Teleostei), so phylum and kingdom too: the
  // waspfish Centropogon australis went to the plant on id order.
  // Never across phyla. Old genus names are homonyms across kingdoms, so a
  // shared epithet "proved" the surgeonfish Acanthurus lineatus was the crab
  // Hepatus lineatus, and linked the plant Limnophila diffusa to a crane fly.
  // IUCN and CoL name one phylum differently (the brown algae).
  const sameLineage = `(r.kingdom IS NULL OR tt.kingdom IS NULL OR (r.kingdom = tt.kingdom AND (r.phylum IS NULL OR tt.phylum IS NULL
    OR replace(r.phylum, 'heterokontophyta', 'ochrophyta') = tt.phylum)))`;
  const tiebreak = `(CASE WHEN r.family = o.family THEN 5 WHEN r.class_name = o.class_name THEN 4
    WHEN r.phylum = o.phylum THEN 3 WHEN r.kingdom = o.kingdom THEN 2 ELSE 1 END) DESC, o.usage_id`;
  // Passes 1-3 in SQL: every candidate, ranked, so the winner and the covered rows both come from here.
  await conn.run(`CREATE OR REPLACE TEMP TABLE cand AS
    WITH canon AS (
      SELECT r.sis, o.usage_id, o.target_id, o.kind, 'canonical' AS reached_by,
             CASE o.kind WHEN 0 THEN (CASE WHEN count(*) OVER (PARTITION BY r.sis, o.kind) > 1 THEN 'accepted_homonym' ELSE 'accepted' END)
                         WHEN 1 THEN 'synonym' WHEN 2 THEN 'checklist_synonym' WHEN 3 THEN 'ambiguous_synonym' ELSE 'provisional' END AS method,
             -- Among synonyms of one name, the target keeping the species' epithet
             -- (Galium palustre -> Hydrogalium palustre, not H. elongatum).
             row_number() OVER (PARTITION BY r.sis ORDER BY CASE o.kind WHEN 4 THEN 3 WHEN 3 THEN 4 ELSE o.kind END,
               (split_part(tt.nm, ' ', 2) = split_part(r.nm, ' ', 2)) DESC, ${tiebreak}) AS rn
      FROM rl r JOIN offer o ON o.nm = r.nm JOIN tx tt ON tt.col_id = o.target_id AND ${sameLineage}),
    syn AS (
      SELECT r.sis, o.usage_id, o.target_id, o.kind, 'synonym' AS reached_by, 'iucn_synonym' AS method,
             row_number() OVER (PARTITION BY r.sis ORDER BY o.kind, ${tiebreak}) AS rn
      FROM (SELECT sis, family, class_name, phylum, kingdom, ${NAME("s.name")} AS snm FROM rl, unnest(synonyms) AS u(s)) r
      -- Not provisional names (kind 4): those are matched by the species' own name only.
      JOIN offer o ON o.nm = r.snm AND o.kind <> 4 JOIN tx tt ON tt.col_id = o.target_id AND ${sameLineage})
    SELECT * FROM canon UNION ALL SELECT * FROM syn`);

  // Passes 4-7 in TypeScript, where the name rules are unit-tested. Variants of the
  // species' own name run for every species its own name didn't match exactly,
  // and outrank its IUCN synonyms: Sminthopsis fuliginosa is CoL's fuliginosus,
  // not the S. aitkeni one of its synonyms points at. The orthographic pass, the
  // weakest, only runs for species nothing else matched.
  const left = await rows<{ sis: number; name: string; authority: string | null; any_cand: boolean; kingdom: string | null; phylum: string | null }>(conn, `
    SELECT sis, name, authority, sis IN (SELECT sis FROM cand) AS any_cand, kingdom, phylum
    FROM rl WHERE sis NOT IN (SELECT sis FROM cand WHERE reached_by = 'canonical')`);
  const genera = new Set<string>();
  for (const r of left) { const p = speciesNameParts(r.name); if (p) genera.add(p[0]); }
  const pool = genera.size === 0 ? [] : await rows<Usage & { species_id: string | null; demoted: boolean; kingdom: string | null; phylum: string | null }>(conn, `
    SELECT col_id, scientific_name, authorship, status, rank, parent_id, species_id, demoted, kingdom, phylum FROM tx
    WHERE rank = 'species' AND lower(split_part(scientific_name, ' ', 1)) IN (${[...genera].map(lit).join(", ")})`);

  // A spelling can't cross phyla either (see sameLineage); unknown lineage is no evidence.
  const phy = (p: string | null) => p?.replace("heterokontophyta", "ochrophyta") ?? null;
  const usageLineage = new Map(pool.map((u) => [u.col_id, u]));
  const compatible = (r: { kingdom: string | null; phylum: string | null }, usage: string) => {
    const u = usageLineage.get(usage);
    if (!u || !r.kingdom || !u.kingdom) return true;
    return r.kingdom === u.kingdom && (!r.phylum || !u.phylum || phy(r.phylum) === phy(u.phylum));
  };
  type Tier = "accepted_variant" | "synonym_variant" | "provisional";
  const byNorm = new Map<string, Map<Tier, Map<string, string>>>(); // key → tier → usage → target
  const byOrtho = new Map<string, { usage: string; target: string; authorship: string | null }[]>();
  for (const u of pool) {
    let tier: Tier | null = null;
    let target: string | null = null;
    if (u.status === "accepted" && !u.demoted) { tier = "accepted_variant"; target = u.col_id; }
    else if (u.status === "provisionally accepted") { tier = "provisional"; target = u.col_id; }
    else if (u.status === "synonym") { tier = "synonym_variant"; target = u.species_id; }
    if (!tier || !target) continue;
    const nk = normalisedKey(u.scientific_name);
    if (nk) {
      const t = byNorm.get(nk) ?? new Map();
      byNorm.set(nk, t);
      const m = t.get(tier) ?? new Map<string, string>();
      t.set(tier, m);
      m.set(u.col_id, target);
    }
    const ok = orthographicKey(u.scientific_name);
    if (ok && tier !== "provisional") {
      const list = byOrtho.get(ok) ?? [];
      list.push({ usage: u.col_id, target, authorship: u.authorship });
      byOrtho.set(ok, list);
    }
  }
  const extra: { sis: number; usage: string; target: string; method: Method }[] = [];
  const extraCovered: { sis: number; target: string }[] = [];
  const nameOf = new Map(pool.map((u) => [u.col_id, u.scientific_name.toLowerCase()]));
  let ambiguous = 0;
  for (const r of left) {
    const nk = normalisedKey(r.name);
    const tiers = nk ? byNorm.get(nk) : undefined;
    const hit = tiers && (["accepted_variant", "synonym_variant", "provisional"] as Tier[])
      .map((t) => ({ t, m: new Map([...(tiers.get(t) ?? new Map<string, string>())].filter(([u]) => compatible(r, u))) }))
      .find((x) => x.m.size);
    if (hit?.m) {
      // Two records that differ only by a termination are one name: CoL holding a
      // species twice. Refuse rather than hand the assessment to whichever sorts first.
      const targets = [...new Set(hit.m.values())].sort();
      // Unless every one is spelled exactly as the assessed name: then it is one
      // name CoL holds twice (Agrotis kuamauna), not two names to guess between.
      const identical = [...hit.m.keys()].every((u) => nameOf.get(u) === r.name.toLowerCase());
      if (targets.length > 1 && !identical) { ambiguous++; continue; }
      const [usage, target] = [...hit.m.entries()].sort()[0];
      extra.push({ sis: r.sis, usage, target, method: hit.t });
      for (const t of targets) if (t !== target) extraCovered.push({ sis: r.sis, target: t });
      continue;
    }
    if (r.any_cand) continue;
    const ok = orthographicKey(r.name);
    const same = ok ? (byOrtho.get(ok) ?? []).filter((c) => compatible(r, c.usage) && sameAuthors(r.authority, c.authorship)) : [];
    if (new Set(same.map((c) => c.target)).size === 1) {
      extra.push({ sis: r.sis, usage: same[0].usage, target: same[0].target, method: "orthographic_variant" });
    }
  }
  await conn.run(`CREATE OR REPLACE TEMP TABLE extra_covered (sis INTEGER, target VARCHAR)`);
  if (extraCovered.length > 0) {
    await conn.run(`INSERT INTO extra_covered VALUES ${extraCovered.map((e) => `(${e.sis}, ${lit(e.target)})`).join(", ")}`);
  }
  if (extra.length > 0) {
    await conn.run(`INSERT INTO cand SELECT * FROM (VALUES ${extra.map((e) =>
      `(${e.sis}, ${lit(e.usage)}, ${lit(e.target)}, 0, 'canonical', ${lit(e.method)}, 1)`).join(", ")}) v`);
  }

  // The winning candidate per species, and everything decideKey needs about it.
  const primary = await rows<{
    sis: number; name: string; authority: string | null; method: Method; reached_by: "canonical" | "synonym";
    u_id: string; u_name: string; u_auth: string | null; u_status: string; u_parent: string | null; u_parent_rank: string | null; u_parent_name: string | null;
    t_id: string; t_name: string; t_auth: string | null;
  }>(conn, `
    WITH best AS (
      SELECT * FROM cand WHERE rn = 1
      QUALIFY row_number() OVER (PARTITION BY sis ORDER BY
        list_position([${PASSES.map(lit).join(", ")}], method), kind) = 1)
    SELECT r.sis, r.name, r.authority, b.method, b.reached_by,
           u.col_id AS u_id, u.scientific_name AS u_name, u.authorship AS u_auth, u.status AS u_status,
           u.parent_id AS u_parent, up.rank AS u_parent_rank, up.scientific_name AS u_parent_name,
           t.col_id AS t_id, t.scientific_name AS t_name, t.authorship AS t_auth
    FROM best b JOIN rl r ON r.sis = b.sis
    JOIN tx u ON u.col_id = b.usage_id JOIN tx t ON t.col_id = b.target_id
    LEFT JOIN tx up ON up.col_id = u.parent_id`);

  const assessedNames = new Set((await rows<{ nm: string }>(conn, `SELECT nm FROM rl`)).map((r) => r.nm));
  // Every CoL synonym carrying a species' own name, by species and target:
  // CoL can hold the same name several times under different citations
  // (Clithon oualaniensis, three times), and any one may be the respelling.
  const ownNameSynonyms = new Map<string, { name: string; authorship: string | null }[]>();
  for (const r of await rows<{ sis: number; target_id: string; name: string; authorship: string | null }>(conn, `
      SELECT c.sis, c.target_id, u.scientific_name AS name, u.authorship FROM cand c JOIN tx u ON u.col_id = c.usage_id
      WHERE c.reached_by = 'canonical' AND c.kind = 1`)) {
    const k = `${r.sis}|${r.target_id}`;
    ownNameSynonyms.set(k, [...(ownNameSynonyms.get(k) ?? []), { name: r.name, authorship: r.authorship }]);
  }
  const links: LinkRow[] = [];
  for (const p of primary) {
    // A variant pass has already established that the usage is this species' own
    // name differently spelled; decideKey is asked about that spelling, so its
    // author-string comparison doesn't undo what the pass proved.
    const isVariant = (VARIANT_METHODS as readonly string[]).includes(p.method);
    const species = isVariant
      ? { scientificName: p.u_name, authorship: p.u_auth ?? undefined }
      : { scientificName: p.name, authorship: p.authority ?? undefined };
    const usage = { key: p.u_id, scientificName: p.u_name, authorship: p.u_auth ?? undefined };
    const target = { key: p.t_id, scientificName: p.t_name, authorship: p.t_auth ?? undefined };
    // Its own name is a CoL synonym that CoL marks as a respelling of the
    // accepted name (same citation): the same species, whatever the Red List's
    // citation says (Meandrina danae / danai).
    const respelled = p.reached_by === "canonical" && p.method === "synonym"
      && (ownNameSynonyms.get(`${p.sis}|${p.t_id}`) ?? []).some((u) => isCoLRespelling({ scientificName: u.name, authorship: u.authorship ?? undefined }, target))
      && !isSeparatelyAssessed(p.t_name, p.name, assessedNames);
    const d = p.method === "ambiguous_synonym"
      ? { verdict: "lumped" as const, reason: `CoL lists ${p.u_name} as an ambiguous synonym of ${p.t_name}; counting only records under this name` }
      : respelled
      ? { verdict: "own" as const, reason: `CoL spells it ${p.t_name} (${p.u_name} is its orthographic variant, same citation)` }
      : decideKey({ species, reachedBy: p.reached_by, usage, acceptedUsage: p.t_id !== p.u_id ? target : undefined, assessedNames });
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
      verdict: d.verdict, method: p.method, reason: d.reason, counted: d.verdict === "own" || d.verdict === "lumped",
    });
  }
  const linked = new Set(links.map((l) => l.sis_taxon_id));
  for (const r of await rows<{ sis: number }>(conn, `SELECT sis FROM rl`)) {
    if (!linked.has(r.sis)) links.push({ sis_taxon_id: r.sis, role: "primary", col_id: null, usage_id: null, verdict: "none", method: "unmatched", reason: "no CoL name matched", counted: false });
  }

  // Covered rows: other CoL usages the same organism sits under. Each is kept
  // out of the Not Evaluated list; it counts only where the evidence that it is
  // the same organism is direct:
  //   - one of IUCN's synonyms IS that accepted name (Hylatomus / Dryocopus
  //     pileatus). Reached only through a CoL synonym it stays uncounted: that
  //     two-hop route took Chiococca alba to the snowberry.
  //   - its own name is also a CoL synonym of another accepted species that is
  //     the same organism (Accipiter cirrocephalus -> Tachyspiza cirrocephala)
  //   - the identical name held twice, in one family or under one author
  //     citation (Andoa berthelotiana, accepted and provisionally accepted)
  //   - the same epithet stem and the same dated author citation in one family,
  //     under another genus (Accipiter cirrocephalus / Tachyspiza cirrocephala,
  //     both Vigors, 1825): one bird CoL holds twice
  //   - for a lumped species, every synonym usage of the same genus with its
  //     exact name (Rubus fruticosus is filed under three parents)
  const covered = await rows<{ sis: number; name: string; authority: string | null; t_id: string; t_name: string; t_auth: string | null; kind: number; src: string }>(conn, `
    SELECT DISTINCT c.sis, r.name, r.authority, t.col_id AS t_id, t.scientific_name AS t_name, t.authorship AS t_auth, c.kind, 'iucn' AS src
    FROM cand c JOIN rl r ON r.sis = c.sis JOIN tx t ON t.col_id = c.target_id
    WHERE c.method = 'iucn_synonym' AND c.kind IN (0, 1, 2)
    UNION
    SELECT DISTINCT e.sis, r.name, r.authority, t.col_id, t.scientific_name, t.authorship, 0, 'twin'
    FROM extra_covered e JOIN rl r ON r.sis = e.sis JOIN tx t ON t.col_id = e.target
    UNION
    -- Its own name is also a CoL synonym of another accepted species: CoL itself
    -- saying the name belongs there (Accipiter cirrocephalus -> Tachyspiza cirrocephala).
    SELECT DISTINCT c.sis, r.name, r.authority, t.col_id, t.scientific_name, t.authorship, 0, 'own_name_synonym'
    FROM cand c JOIN rl r ON r.sis = c.sis JOIN tx t ON t.col_id = c.target_id
    WHERE c.reached_by = 'canonical' AND c.kind = 1`);
  const primaryTarget = new Map(links.map((l) => [l.sis_taxon_id, l.col_id]));
  const seenCover = new Set<string>();
  const cover = (row: LinkRow) => {
    const k = `${row.sis_taxon_id}|${row.col_id}|${row.usage_id}`;
    // The species' own target needs no covered row, except as a second usage a lumped species owns.
    if (seenCover.has(k) || (row.verdict !== "lumped" && primaryTarget.get(row.sis_taxon_id) === row.col_id)) return;
    seenCover.add(k);
    links.push(row);
  };
  for (const c of covered) {
    // A shared epithet under another genus is a genus move only if the authors
    // agree too: Himantopus leucocephalus Gould, 1837 is the pied stilt, not the
    // banded stilt Cladorhynchus leucocephalus (Vieillot, 1816), whose IUCN
    // synonyms name it. Where either citation is missing there is nothing to check.
    const otherGenus = c.name.split(" ")[0].toLowerCase() !== c.t_name.split(" ")[0].toLowerCase();
    const authorsAgree = !c.authority || !c.t_auth || sameAuthors(c.authority, c.t_auth);
    const same = c.src === "twin" || ((c.kind === 0 || c.src === "own_name_synonym")
      && sameOrganism({ scientificName: c.name, authorship: c.authority ?? undefined }, { scientificName: c.t_name, authorship: c.t_auth ?? undefined })
      && (!otherGenus || authorsAgree)
      && !isSeparatelyAssessed(c.t_name, c.name, assessedNames));
    cover({
      sis_taxon_id: c.sis, role: "covered", col_id: c.t_id, usage_id: same ? c.t_id : null, verdict: same ? "own" : "refused",
      method: "iucn_synonym_covered", reason: same ? `${c.t_name} is the same organism under another accepted name` : `${c.t_name} is named as a synonym; kept out of the Not Evaluated list only`,
      counted: same,
    });
  }

  // Twins and duplicate concepts of each species' own target.
  const species = await rows<{ col_id: string; scientific_name: string; authorship: string | null; family: string | null; class_name: string | null }>(conn, `
    SELECT col_id, scientific_name, authorship, family, class_name FROM tx
    WHERE rank = 'species' AND status IN ('accepted', 'provisionally accepted') AND NOT demoted`);
  const byId = new Map(species.map((x) => [x.col_id, x]));
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
  for (const x of species) {
    for (const t of twinKeys(x)) twins.set(t, [...(twins.get(t) ?? []), x.col_id]);
    const d = dupKey(x); if (d) dups.set(d, [...(dups.get(d) ?? []), x.col_id]);
  }
  const genus = (n: string) => n.split(" ")[0].toLowerCase();
  for (const l of [...links]) {
    if (l.role !== "primary" || l.verdict !== "own" || !l.col_id) continue;
    const t = byId.get(l.col_id);
    if (!t) continue;
    const add = (id: string, method: string, reason: string) => {
      const u = byId.get(id)!;
      if (id === t.col_id || isSeparatelyAssessed(u.scientific_name, t.scientific_name, assessedNames)) return;
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
  for (const l of [...links]) {
    if (l.role !== "primary" || l.verdict !== "own" || l.method !== "checklist_synonym") continue;
    const p = primary.find((x) => x.sis === l.sis_taxon_id);
    if (!p || p.u_id === p.t_id) continue;
    cover({ sis_taxon_id: l.sis_taxon_id, role: "covered", col_id: p.u_id, usage_id: p.u_id, verdict: "own", method: "checklist_demoted",
      reason: `${p.u_name} is the XR species the checklist folds into ${p.t_name}; GBIF files its records there`, counted: true });
  }

  // A lumped species owns every same-genus synonym usage carrying its exact name.
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

  // The same guard over every row, however it was made: a link never crosses
  // phyla (twins, duplicate concepts and lumps are found by name alone).
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

  // One owner per usage: primary before covered, own before lumped, stronger pass, then lower SIS id.
  const rank = (l: LinkRow) => [l.role === "primary" ? 0 : 1, l.verdict === "own" ? 0 : 1,
    Math.max(0, PASSES.indexOf(l.method as Method)), l.sis_taxon_id];
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
    verdict VARCHAR, method VARCHAR, reason VARCHAR, counted BOOLEAN)`);
  const ap = await conn.createAppender("link_rows");
  for (const l of links) {
    ap.appendBigInt(BigInt(l.sis_taxon_id)); ap.appendVarchar(l.role);
    if (l.col_id === null) ap.appendNull(); else ap.appendVarchar(l.col_id);
    if (l.usage_id === null) ap.appendNull(); else ap.appendVarchar(l.usage_id);
    ap.appendVarchar(l.verdict); ap.appendVarchar(l.method); ap.appendVarchar(l.reason); ap.appendBoolean(l.counted);
    ap.endRow();
  }
  ap.closeSync();
  fs.mkdirSync(coreDir, { recursive: true });
  await conn.run(`COPY (SELECT * FROM link_rows ORDER BY sis_taxon_id, role DESC, col_id) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);
  if (ambiguous > 0) console.log(`  ${ambiguous} species left unmatched: their normalised name offers more than one CoL species`);
  return out;
}

export async function run(): Promise<void> {
  const conn = await (await DuckDBInstance.create(":memory:", { threads: "16" })).connect();
  const out = await buildLink(conn, CORE_DIR);
  const summary = await rows<{ role: string; verdict: string; method: string; n: number }>(conn, `
    SELECT role, verdict, method, count(*)::INT AS n FROM read_parquet(${lit(out)}) GROUP BY ALL ORDER BY role DESC, n DESC`);
  console.log(`Wrote ${out}`);
  for (const s of summary) console.log(`  ${s.role.padEnd(8)} ${s.verdict.padEnd(10)} ${s.method.padEnd(22)} ${s.n.toLocaleString()}`);
}

const isDirectRun = process.argv[1]?.endsWith("pipeline/build-link.ts") || process.argv[1]?.endsWith("pipeline/build-link.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((e) => { console.error(e); process.exit(1); });
}
