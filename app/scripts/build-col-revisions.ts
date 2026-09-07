/**
 * build-col-revisions: the "possible taxonomic revision" flag for the main
 * dashboard → data/col-revisions.json
 *
 * The SSC-group view already flags, per group, which IUCN-assessed species have
 * no clean 1:1 Catalogue of Life match and why (build-taxa-summary.ts →
 * colBreakdown[].noMatchDetails). That diagnostic is computed per breakdown
 * *name*, so it only exists for the static tree's official/SSC nodes — the
 * primary assessed dashboard, which filters an arbitrary species set, has no
 * such lookup.
 *
 * This runs the SAME diagnostic (computeNoMatchDetails, shared with
 * build-taxa-summary via lib/data/col-breakdown) exactly once, unscoped — over
 * every assessed species in every taxon group — and writes a flat sis_taxon_id
 * → flag map the dashboard can load in one request.
 *
 * It also carries the SECOND, independent revision signal: the species CoL has
 * likely split OUT of an assessed one. That reuses split_candidates (the same
 * temp table the SSC view's "Likely split from" note is built from) inverted —
 * assessed parent → the Not Evaluated names carved off it — scoped to exactly
 * the NE universe the group view counts. A species can carry both signals; only
 * ~151 of ~9.7k do.
 *
 * Scope note: unscoped, "classified_elsewhere" (CoL puts this name under a
 * different class/order/family than the *node* being viewed) can't arise —
 * there's no node to disagree with — so the global flag carries the seven
 * reasons that are properties of the species itself.
 *
 * Usage:
 *   npx tsx scripts/build-col-revisions.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR } from "./utils";
import {
  computeNoMatchDetails,
  SPLIT_CANDIDATES_SQL,
  COL_TO_ASSESSED_SQL,
  backboneHasChecklistColumns,
  type BreakdownQueryContext,
  type NoMatchDetail,
} from "../src/lib/data/col-breakdown";
import { SPLIT_REASON, UNFLAGGED_REASONS, GENUS_DIFFERS_REASON, RENAMED_REASON } from "../src/lib/col-revision";
import { orthographicallySame, speciesNameParts, canonicalEpithet } from "./name-variants";

// Keep in sync with build-taxa-summary.ts / species-duckdb.ts.
const EXCLUDED_COL_IDS_SQL = `('6MB3T')`; // Homo sapiens

export interface ColRevisionsFile {
  /** Per-signal counts, so the dashboard can size its chart without walking the
   *  map. These do NOT sum to `total`: a species carrying both a no-match reason
   *  and splits counts in two of them. */
  counts: Record<string, number>;
  /** Distinct species carrying at least one signal. */
  total: number;
  /** sis_taxon_id → the flag, with short keys and absent fields omitted — one
   *  entry per flagged species, so the shipped file stays small.
   *  r = no-match reason (absent on a split-only flag), d = detail (the species
   *  it's lumped with / demoted under), i = that species' own SIS id, dc = that
   *  species' CoL id, c = the CoL id to link to, n = CoL's own accepted name for
   *  that col_id, s = [name, col_id, previous name, previous col_id] of each
   *  species CoL likely split out of this one ("previous" being the old
   *  infraspecific name that now resolves there — the evidence for the split),
   *  lw = the OTHER IUCN assessments sharing this species' CoL record
   *  [name, its own synonym record, IUCN category], ln = CoL's accepted name for
   *  that shared record, an = the accepted name CoL's CURATED release uses for
   *  this species when it differs, ac = that record's CoL id, gd = the
   *  difference is in the genus alone (same epithet, different genus). */
  species: Record<string, { r?: string; d?: string; i?: number; dc?: string; c?: string; n?: string; k?: string;
    s?: [string, string, string, string][]; lw?: [string, string, string][]; ln?: string;
    an?: string; ac?: string; gd?: 1 }>;
}

export async function run(): Promise<void> {
  const link = path.join(DATA_DIR, "species_link.parquet");
  const assessedPath = path.join(DATA_DIR, "assessed.parquet");
  const speciesGlob = path.join(DATA_DIR, "species", "**", "*.parquet");
  const backbonePath = path.join(DATA_DIR, "backbone.parquet");
  const outPath = path.join(DATA_DIR, "col-revisions.json");

  if (!fs.existsSync(path.join(DATA_DIR, "species")) || !fs.existsSync(link)) {
    console.log("  CoL revisions: species/ or species_link.parquet missing — skipping.");
    return;
  }

  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(
    `CREATE TEMP TABLE assessed_cids AS SELECT DISTINCT col_id FROM read_parquet('${link}') WHERE src = 'redlist' AND col_id IS NOT NULL`
  );
  // Same "extant, or CoL-extinct but IUCN-confirmed EX/EW" universe every other
  // CoL count uses — see build-taxa-summary.ts's createExEwAssessedTable.
  await conn.run(`
    CREATE TEMP TABLE ex_ew_assessed AS
      SELECT DISTINCT l.col_id
      FROM read_parquet('${link}') l
      JOIN read_parquet('${assessedPath}') a ON a.id = l.id
      WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND a.iucn_category IN ('EX', 'EW')`);
  const universeSql = `(extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ex_ew_assessed))`;

  const hasBackbone = fs.existsSync(backbonePath);
  if (hasBackbone) {
    // The infraspecific/provisional reasons need these; without backbone.parquet
    // they collapse into the blanket "missing_from_backbone".
    await conn.run(SPLIT_CANDIDATES_SQL(backbonePath, assessedPath, "assessed_cids"));
    await conn.run(COL_TO_ASSESSED_SQL(link, assessedPath));
  } else {
    console.log("  CoL revisions: backbone.parquet missing — infraspecific/provisional reasons unavailable.");
  }

  const ctx: BreakdownQueryContext = {
    conn, speciesGlob, assessedPath, linkPath: link,
    universeSql, assessedCidsTable: "assessed_cids",
    excludedColIdsSql: EXCLUDED_COL_IDS_SQL, hasBackbone, backbonePath,
    // Always true in the real pipeline (the sync rebuilds the backbone whenever it
    // lacks these columns — see sync.ts) — probed rather than assumed so a
    // hand-run against an older data dir degrades instead of throwing a Binder Error.
    hasChecklistColumns: hasBackbone && (await backboneHasChecklistColumns(conn, backbonePath)),
  };

  const started = Date.now();
  const details: NoMatchDetail[] = await computeNoMatchDetails(ctx, "true", "true");

  const counts: Record<string, number> = {};
  const species: ColRevisionsFile["species"] = {};
  // A reason the dashboard doesn't flag is still diagnosed (and still reported by
  // the SSC group view, which reads the same classifier) — it just doesn't earn a
  // flag or a bar here. See UNFLAGGED_REASONS for why extinct_unconfirmed doesn't.
  const unflagged = new Set<string>(UNFLAGGED_REASONS);
  for (const d of details) {
    if (unflagged.has(d.reason)) continue;
    counts[d.reason] = (counts[d.reason] ?? 0) + 1;
    species[String(d.id)] = {
      r: d.reason,
      ...(d.detail != null ? { d: d.detail } : {}),
      ...(d.detailId != null ? { i: d.detailId } : {}),
      ...(d.detailColId != null ? { dc: d.detailColId } : {}),
      ...(d.rank != null ? { k: d.rank } : {}),
      ...(d.colId != null ? { c: d.colId } : {}),
      // CoL's accepted name is only worth shipping when it says something the
      // other fields don't — otherwise it's the same string twice per entry.
      ...(d.colName != null && d.colName !== d.name && d.colName !== d.detail ? { n: d.colName } : {}),
    };
  }

  // Second signal: the Not Evaluated species CoL has likely split OUT of an
  // assessed one — split_candidates read the other way round. Scoped to exactly
  // the NE universe the SSC view counts (in_base, extant-or-EX/EW, not already
  // assessed, not excluded), so a name here is one the dashboard's Not Evaluated
  // list actually shows. Ordered by name for a file that's stable across re-runs.
  //
  // A split-only species usually has a perfectly clean CoL match, so it has no
  // NoMatchDetail and no col_id from the diagnostic above — the join to
  // species_link supplies its own CoL record for the flag to link to.
  let splitParents = 0;
  if (hasBackbone) {
    // The evidence behind every split: CoL keeps the old infraspecific name as a
    // synonym when one is promoted, so "which accepted species does the name
    // 'Vallonia costata var. montana' resolve to today" IS the signal. Same
    // resolution (including the autonym hop) as SPLIT_CANDIDATES_SQL, kept here
    // rather than added to that shared table so the committed
    // col-split-candidates.parquet keeps its current shape.
    await conn.run(`
      CREATE TEMP TABLE split_evidence AS
      SELECT b.col_id AS syn_col_id,
             b.scientific_name AS syn_name,
             b.authorship AS syn_authorship,
             lower(split_part(b.scientific_name, ' ', 1) || ' ' || split_part(b.scientific_name, ' ', 2)) AS binomial,
             CASE WHEN p.rank = 'species' THEN p.col_id
                  WHEN p.rank IN ('subspecies', 'infraspecific name', 'variety')
                       AND p.status IN ('accepted', 'provisionally accepted') THEN p.parent_id
             END AS target_col_id
      FROM read_parquet('${backbonePath}') b
      JOIN read_parquet('${backbonePath}') p ON p.col_id = b.parent_id
      WHERE b.status = 'synonym' AND b.rank IN ('subspecies', 'infraspecific name', 'variety')`);

    const splitRows = await (await conn.run(`
      WITH ne AS (
        SELECT col_id, scientific_name FROM read_parquet('${speciesGlob}', hive_partitioning=true)
        WHERE in_base AND ${universeSql} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL}
          AND col_id NOT IN (SELECT col_id FROM assessed_cids)
      ),
      parent_col AS (
        SELECT l.id AS id, any_value(l.col_id) AS col_id
        FROM read_parquet('${link}') l
        WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND l.match_method != 'iucn_synonym_covered'
        GROUP BY l.id
      ),
      -- One split-off species per row, with the oldest-sorting synonym that
      -- points at it as the evidence. More than one can back a split (26% of
      -- pairs); one is enough to make the inference checkable by hand.
      pairs AS (
        SELECT sc.parent_id AS parent_id, ne.scientific_name AS ne_name, ne.col_id AS ne_col_id,
               min_by(ev.syn_name, ev.syn_name) AS prev_name,
               min_by(ev.syn_col_id, ev.syn_name) AS prev_col_id,
               min_by(ev.syn_authorship, ev.syn_name) AS prev_authorship
        FROM split_candidates sc
        JOIN ne ON ne.col_id = sc.ne_col_id
        LEFT JOIN split_evidence ev
          ON ev.target_col_id = sc.ne_col_id AND ev.binomial = lower(sc.parent_name)
        WHERE sc.rn = 1
        GROUP BY 1, 2, 3
      )
      SELECT p.parent_id AS parent_id,
             list(struct_pack(name := p.ne_name, col_id := p.ne_col_id, prev_name := p.prev_name,
                              prev_col_id := p.prev_col_id, prev_authorship := p.prev_authorship)
                  ORDER BY p.ne_name) AS ne_names,
             any_value(pc.col_id) AS parent_col_id
      FROM pairs p
      LEFT JOIN parent_col pc ON pc.id = p.parent_id
      GROUP BY p.parent_id ORDER BY p.parent_id`)).getRowObjects();

    const unwrap = (v: unknown): Record<string, unknown>[] => {
      // A LIST arrives as { items: [...] } and each STRUCT as { entries: {...} }.
      const raw = v as { items?: unknown[] } | unknown[] | null;
      const items = (Array.isArray(raw) ? raw : raw?.items ?? []) as { entries?: Record<string, unknown> }[];
      return items.map((it) => it?.entries ?? {});
    };
    // CoL writes authorship separately; the tooltip wants the name exactly as CoL
    // prints it — full binomial included, so it reads as a name someone can search
    // for rather than a bare epithet.
    const full = (name: unknown, authorship: unknown) =>
      `${String(name ?? "")}${authorship ? ` ${String(authorship)}` : ""}`.trim();

    for (const r of splitRows) {
      const id = String(r.parent_id);
      const names = unwrap(r.ne_names)
        .map((e) => [String(e.name ?? ""), String(e.col_id ?? ""), full(e.prev_name, e.prev_authorship), String(e.prev_col_id ?? "")] as [string, string, string, string])
        .filter(([n]) => n.length > 0);
      if (names.length === 0) continue;
      splitParents++;
      const entry = species[id] ?? {};
      entry.s = names;
      if (entry.c == null && r.parent_col_id != null) entry.c = String(r.parent_col_id);
      species[id] = entry;
    }
    counts[SPLIT_REASON] = splitParents;
  } else {
    console.log("  CoL revisions: backbone.parquet missing — split signal unavailable.");
  }

  // The other side of a lump: IUCN assesses several species that CoL files as
  // one. The classifier already names the single assessment that won the
  // accepted-name tie-break; this collects the WHOLE group, so the tooltip can
  // say how many assessments describe one CoL species and name them all —
  // 1,836 CoL records carry more than one assessment, and one carries 15.
  //
  // Each member's own synonym record under the shared species is the checkable
  // evidence, exactly as the old infraspecific name is for a split: CoL's page
  // for the accepted species lists it. 62% of members have one; the rest are
  // linked to the shared record instead.
  if (Object.keys(species).length) {
    const lumpRows = await (await conn.run(`
      WITH members AS (
        SELECT l.col_id AS col_id, a.id AS id, a.scientific_name AS name, a.iucn_category AS category
        FROM read_parquet('${link}') l
        JOIN read_parquet('${assessedPath}') a ON a.id = l.id
        WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND l.match_method != 'iucn_synonym_covered'
      ),
      groups AS (SELECT col_id FROM members GROUP BY col_id HAVING count(*) > 1),
      pairs AS (
        SELECT me.id AS id, me.col_id AS col_id, other.name AS other_name, other.category AS other_category,
               syn.col_id AS other_syn_col_id
        FROM members me
        JOIN groups g ON g.col_id = me.col_id
        JOIN members other ON other.col_id = me.col_id AND other.id != me.id
        LEFT JOIN read_parquet('${backbonePath}') syn
          ON lower(syn.scientific_name) = lower(other.name) AND syn.status = 'synonym' AND syn.parent_id = me.col_id
      )
      SELECT p.id AS id,
             any_value(p.col_id) AS shared_col_id,
             any_value(acc.scientific_name) AS accepted_name,
             list(struct_pack(name := p.other_name, col_id := p.other_syn_col_id,
                              category := p.other_category) ORDER BY p.other_name) AS others
      FROM pairs p
      LEFT JOIN read_parquet('${speciesGlob}', hive_partitioning=true) acc ON acc.col_id = p.col_id
      GROUP BY p.id ORDER BY p.id`)).getRowObjects();

    let lumped = 0;
    for (const r of lumpRows) {
      // EVERY assessment sharing the record, not just the ones the classifier
      // called "lumped". Which one it calls that is an accepted-name tie-break:
      // CoL's 347N2 is both Dasycercus cristicauda (EX) and Dasycercus hillieri
      // (LC), and only hillieri was flagged because it matched by synonym. Both
      // assessments describe what CoL counts as one species, so both say so.
      const entry = species[String(r.id)] ?? {};
      const raw = r.others as { items?: unknown[] } | unknown[] | null;
      const items = (Array.isArray(raw) ? raw : raw?.items ?? []) as { entries?: Record<string, unknown> }[];
      const others = items
        .map((it) => [String(it?.entries?.name ?? ""), String(it?.entries?.col_id ?? ""), String(it?.entries?.category ?? "")] as [string, string, string])
        .filter(([n]) => n.length > 0);
      if (!others.length) continue;
      entry.lw = others;
      if (r.accepted_name != null) entry.ln = String(r.accepted_name);
      // The shared record — every member's link target, and the one the
      // assessment that WON the tie-break never had, since it has no no-match
      // detail to have carried it.
      if (entry.c == null && r.shared_col_id != null) entry.c = String(r.shared_col_id);
      // "lumped" is now a signal derived from the group (see revisionReasons),
      // not a per-species reason, so drop the classifier's own label and the
      // winner-specific fields it came with. Anything else it diagnosed stays.
      if (entry.r === "lumped") { delete entry.r; delete entry.d; delete entry.i; delete entry.dc; delete entry.n; }
      species[String(r.id)] = entry;
      lumped++;
    }
    counts["lumped"] = lumped;
    console.log(`  CoL revisions: ${lumped} assessments share a CoL record with another`);
  }

  // ---------------------------------------------------------------------------
  // Signal 4: the accepted name CoL's CURATED release uses is a different name.
  //
  // Measured against the release itself, not inferred from a failed match — the
  // assessment's own CoL record is fine, which is why nothing else on the card
  // catches these. Two ways the release can disagree with IUCN's name: it
  // accepts the matched record under another spelling (checklist_name), or it
  // files that name as a synonym of a different accepted species.
  //
  // Three exclusions, each removing a case where "a different name" would be
  // false rather than merely uninteresting:
  //  - more than one accepted name (4,446): CoL genuinely has no single answer,
  //    and picking one would be us adjudicating. Refused, not guessed.
  //  - the matched record is below species rank: CoL's accepted species is then
  //    its parent, which the `infraspecific` bar already reports.
  //  - names differing only in spelling: one name under ICZN 58 / ICN 53.3
  //    (terminations) and ICZN 32.5.2 / ICN 60 (orthography), so reporting it as
  //    a different name is simply wrong.
  if (hasBackbone) {
    const renameRows = (await conn.runAndReadAll(`
      WITH linked AS (
        SELECT a.id, a.scientific_name AS iucn, b.col_id, b.in_checklist,
               b.checklist_parent_id,
               coalesce(b.checklist_name, b.scientific_name) AS self_name
        FROM read_parquet('${assessedPath}') a
        JOIN read_parquet('${link}') l ON l.sis_taxon_id = a.id AND l.src = 'redlist'
        JOIN read_parquet('${backbonePath}') b ON b.col_id = l.col_id
        WHERE b.rank = 'species'
      ),
      resolved AS (
        SELECT k.id, k.iucn,
               CASE WHEN k.checklist_parent_id IS NOT NULL THEN p.col_id ELSE k.col_id END AS acc_id,
               CASE WHEN k.checklist_parent_id IS NOT NULL
                    THEN coalesce(p.checklist_name, p.scientific_name) ELSE k.self_name END AS acc_name,
               CASE WHEN k.checklist_parent_id IS NOT NULL THEN p.in_checklist ELSE k.in_checklist END AS acc_in_checklist
        FROM linked k
        LEFT JOIN read_parquet('${backbonePath}') p ON p.col_id = k.checklist_parent_id
      )
      SELECT id, any_value(iucn) AS name, any_value(acc_name) AS acc_name, any_value(acc_id) AS acc_id
      FROM resolved
      WHERE acc_in_checklist AND acc_name IS NOT NULL
      GROUP BY id
      HAVING count(DISTINCT acc_id) = 1
         AND lower(any_value(acc_name)) <> lower(any_value(iucn))
      ORDER BY id`)).getRowObjects();

    let genusDiffers = 0, renamed = 0, variantOnly = 0, alsoLumped = 0;
    for (const r of renameRows) {
      const iucn = String(r.name), acc = String(r.acc_name);
      // The full orthographic rule, not just terminations. "CoL accepts a
      // different name" has to be FALSE of a name CoL merely spells differently
      // — Colostygia puengeleri / pungeleri is one name under ICZN 32.5.2.1, and
      // reporting it as a different name would be exactly the error this bar was
      // built to avoid. Using the looser rule here reports FEWER differences,
      // which is the safe direction for a claim about someone else's data.
      if (orthographicallySame(iucn, acc)) { variantOnly++; continue; }
      const mine = speciesNameParts(iucn), theirs = speciesNameParts(acc);
      // A genus transfer keeps the epithet and changes the genus — canonically,
      // since the epithet's ending usually shifts to agree with the new genus
      // (Anolis wattsi -> Norops wattsii). Anything else is a different name.
      const isGenusMove = mine != null && theirs != null
        && mine[0] !== theirs[0] && canonicalEpithet(mine[1]) === canonicalEpithet(theirs[1]);
      const entry = species[String(r.id)] ?? {};
      // The lump bar already says this, with more: it names the other
      // assessments sharing the record and their categories. 2,209 of the 2,218
      // lumped-and-renamed species resolve to exactly the lump's own accepted
      // name, so a second bar would restate one fact and inflate the count.
      // Dropped entirely rather than silenced, because a bar that returns a row
      // whose tooltip never explains it is the worse failure.
      if (entry.lw?.length && entry.ln != null && entry.ln.toLowerCase() === acc.toLowerCase()) {
        alsoLumped++;
        continue;
      }
      entry.an = acc;
      if (r.acc_id != null) entry.ac = String(r.acc_id);
      // Where the flag points when this is the ONLY signal (7,915 species): the
      // record CoL accepts. Without it the flag has no link target and no
      // provenance block, so the reader is told CoL disagrees and given no way
      // to check who said so.
      if (entry.c == null && r.acc_id != null) entry.c = String(r.acc_id);
      if (isGenusMove) entry.gd = 1;
      species[String(r.id)] = entry;
      if (isGenusMove) genusDiffers++; else renamed++;
    }
    counts[GENUS_DIFFERS_REASON] = genusDiffers;
    counts[RENAMED_REASON] = renamed;
    console.log(`  CoL revisions: ${genusDiffers + renamed} assessments have a different accepted name in the release ` +
      `(${genusDiffers} differ in genus alone, ${renamed} in the epithet; ${variantOnly} excluded as one name spelled two ways, ` +
      `${alsoLumped} as already carried by the lump bar)`);
  }

  const out: ColRevisionsFile = { counts, total: Object.keys(species).length, species };
  fs.writeFileSync(outPath, JSON.stringify(out));
  const kb = Math.round(fs.statSync(outPath).size / 1024);
  const noMatchFlagged = details.filter((d) => !unflagged.has(d.reason) && d.reason !== "lumped").length;
  const skipped = details.filter((d) => unflagged.has(d.reason)).length;
  console.log(`  CoL revisions: ${out.total} flagged species (${noMatchFlagged} no-match, ${splitParents} with splits) → ${outPath} (${kb} KB, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (skipped) console.log(`    (${skipped} diagnosed but not flagged: ${UNFLAGGED_REASONS.join(", ")} — see col-revision.ts)`);
  for (const [reason, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`    ${reason.padEnd(24)} ${n}`);
}

const isDirectRun = process.argv[1]?.endsWith("build-col-revisions.ts") || process.argv[1]?.endsWith("build-col-revisions.js");
if (isDirectRun) {
  loadEnvFiles();
  console.log("build-col-revisions: assessed.parquet + CoL backbone → col-revisions.json");
  console.log("=".repeat(50));
  run().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
}
