/**
 * trace: why an assessed species is linked as it is, and what its count is made
 * of, read from a build. The whole chain, in the order the sync makes it:
 *
 *   1. the name: GBIF's matcher's answer for the Red List name, with the points
 *      it gave each candidate, and why the sync took that answer, took an
 *      override's instead, or left the species waiting (match-overrides.tsv,
 *      the match queue)
 *   2. the concept: each link row, the CoL taxon and species it names, its
 *      verdict and the reason for it
 *   3. the count: every CoL record whose GBIF records count for it, and the
 *      totals the app shows
 *
 * Usage:  npm run sync:trace -- "Fringilla polatzeki"     (or an SIS id)
 *         PIPELINE_BUILD_DIR=... builds elsewhere; defaults to .sync/
 */
import * as fs from "fs";
import * as path from "path";
import { BUILD_DIR, tables } from "./paths";
import { openDuckDB, rows, lit } from "./sql";
import { readOverrides } from "./link/match-overrides";
import { syncPath } from "../../src/lib/data/sync-layout";

type Score = { name: number | null; authorship: number | null; classification: number | null; rank: number | null; status: number | null; total: number | null } | null;

const points = (s: Score) => s
  ? `name ${s.name ?? "–"}, authorship ${s.authorship ?? "–"}, classification ${s.classification ?? "–"}, rank ${s.rank ?? "–"}, status ${s.status ?? "–"} = ${s.total ?? "–"}`
  : "no points recorded";
const fmt = (n: unknown) => (n === null || n === undefined ? "–" : Number(n).toLocaleString());

export async function trace(query: string, buildDir = BUILD_DIR): Promise<string> {
  const T = tables(buildDir);
  for (const f of [T.assessments, T.matches, T.link, T.taxa, T.usageOwner, T.occurrences]) {
    if (!fs.existsSync(f)) throw new Error(`trace: ${f} is missing; run npm run sync first`);
  }
  const conn = await openDuckDB();
  const pq = (f: string) => `read_parquet(${lit(f)})`;
  const out: string[] = [];
  const say = (s = "") => out.push(s);

  const bySis = /^\d+$/.test(query.trim());
  const sp = await rows<{ sis: number; name: string; authority: string | null; category: string | null; family: string | null; class_name: string | null }>(conn, `
    SELECT sis_taxon_id::BIGINT AS sis, scientific_name AS name, authority, category, family, class_name FROM ${pq(T.assessments)}
    WHERE is_latest AND ${bySis ? `sis_taxon_id = ${Number(query)}` : `lower(scientific_name) = lower(${lit(query.trim())})`}`);
  if (sp.length === 0) return `No assessed species ${bySis ? "with SIS" : "named"} ${query} in ${buildDir}.`;
  const s = sp[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, "publish", syncPath("sync.json")), "utf-8"));
  say(`${s.name}${s.authority ? ` ${s.authority}` : ""}: SIS ${s.sis}, ${s.category ?? "?"} (${s.family?.toLowerCase() ?? "?"}, ${s.class_name?.toLowerCase() ?? "?"})`);
  say(`Releases: ${manifest.redlist?.database ?? "?"} · ${manifest.col?.xr?.alias ?? "?"} (${manifest.col?.xr?.key ?? "?"}) · snapshot ${manifest.gbif?.snapshot ?? "?"}`);

  // ── 1. The name
  say(); say("1. The name");
  const [m] = await rows<{ matcher_col_id: string | null; matcher_name: string | null; matcher_authorship: string | null; matcher_rank: string | null;
    matcher_status: string | null; match_type: string | null; confidence: number | null; score: string | null; alts: string | null }>(conn, `
    SELECT matcher_col_id, matcher_name, matcher_authorship, matcher_rank, matcher_status, match_type, confidence, to_json(matcher_score)::VARCHAR AS score,
           to_json(alternatives)::VARCHAR AS alts FROM ${pq(T.matches)} WHERE sis_taxon_id = ${s.sis}`);
  if (!m || !m.matcher_col_id) {
    say(`  The matcher found no CoL record (${m?.match_type ?? "not asked"}).`);
  } else {
    say(`  The matcher answered: ${m.matcher_name} ${m.matcher_authorship ?? ""} [${m.matcher_col_id}, ${m.matcher_status?.toLowerCase()} ${m.matcher_rank?.toLowerCase()}], ${m.match_type}, ${m.confidence}% sure`);
    const score = (m.score ? JSON.parse(m.score) : null) as Score;
    say(`    points: ${score ? points(score) : m.match_type === "HIGHERRANK" ? "none: a fallback to a higher rank, which the matcher doesn't score" : "none recorded"}`);
    const alts = (m.alts ? JSON.parse(m.alts) : []) as { col_id: string; name: string; authorship: string | null; status: string | null; rank: string | null; score: Score }[];
    if (alts.length) {
      say(`  Other candidates it weighed:`);
      for (const a of alts.slice(0, 8)) say(`    ${a.name} ${a.authorship ?? ""} [${a.col_id}, ${a.status?.toLowerCase()} ${a.rank?.toLowerCase()}]: ${points(a.score)}`);
      if (alts.length > 8) say(`    … and ${alts.length - 8} more`);
    }
  }
  const o = readOverrides().get(s.sis);
  if (o) say(`  Override (match-overrides.tsv): ${o.colName ?? "not in CoL"} ${o.colAuthorship ?? ""}, by ${o.by}${o.reviewed ? ", reviewed" : ""}, against ${o.redlistVersion ?? "?"} × ${o.colVersion ?? "?"}: ${o.note}`);
  const queue = fs.existsSync(T.matchQueue) ? fs.readFileSync(T.matchQueue, "utf-8").split("\n").find((l) => l.startsWith(`${s.sis}\t`)) : undefined;
  if (queue) { const f = queue.split("\t"); say(`  In the match queue: ${f[3]}, ${f[4]}`); }

  // ── 2. The concept
  say(); say("2. The concept");
  const links = await rows<{ role: string; verdict: string; method: string; basis: string | null; name_reason: string | null; reason: string; counted: boolean;
    taxon: string | null; taxon_rank: string | null; taxon_status: string | null; species: string | null; col_taxon_id: string | null; col_species_id: string | null }>(conn, `
    SELECT l.role, l.verdict, l.method, l.basis, l.name_reason, l.reason, l.counted, l.col_taxon_id, l.col_species_id,
           t.scientific_name || coalesce(' ' || t.authorship, '') AS taxon, t.rank AS taxon_rank, t.status AS taxon_status,
           c.scientific_name || coalesce(' ' || c.authorship, '') AS species
    FROM ${pq(T.link)} l LEFT JOIN ${pq(T.taxa)} t ON t.col_id = l.col_taxon_id LEFT JOIN ${pq(T.taxa)} c ON c.col_id = l.col_species_id
    WHERE l.sis_taxon_id = ${s.sis} ORDER BY l.role DESC, l.counted DESC, l.col_species_id`);
  for (const l of links) {
    if (l.role === "primary" && l.name_reason) say(`  Why this name: ${l.name_reason}`);
    const where = !l.col_species_id ? "no CoL species"
      : l.col_taxon_id && l.col_taxon_id !== l.col_species_id ? `CoL taxon ${l.taxon} [${l.col_taxon_id}, ${l.taxon_status} ${l.taxon_rank}], in species ${l.species} [${l.col_species_id}]`
      : `CoL species ${l.species} [${l.col_species_id}]`;
    say(`  ${l.role.padEnd(8)} ${where}`);
    say(`           ${l.verdict}, ${l.method}${l.basis ? `, by ${l.basis}` : ""}, ${l.counted ? "counted" : "not counted"}: ${l.reason}`);
  }

  // ── 3. The count
  say(); say("3. The count");
  const owned = await rows<{ record: string; col_id: string; rank: string; status: string; georef: number | null; total: number | null }>(conn, `
    SELECT t.scientific_name || coalesce(' ' || t.authorship, '') AS record, t.col_id, t.rank, t.status,
           sum(o.n) FILTER (o.georef) AS georef, sum(o.n) AS total
    FROM ${pq(T.usageOwner)} w JOIN ${pq(T.taxa)} t ON t.col_id = w.usage_key LEFT JOIN ${pq(T.occurrences)} o ON o.usage_key = w.usage_key
    WHERE w.sis_taxon_id = ${s.sis} GROUP BY ALL ORDER BY total DESC NULLS LAST`);
  if (owned.length === 0) say(`  No CoL record's records count for it.`);
  for (const r of owned.slice(0, 15)) say(`  ${r.record} [${r.col_id}, ${r.status} ${r.rank}]: ${fmt(r.total)} records, ${fmt(r.georef)} georeferenced`);
  if (owned.length > 15) say(`  … and ${owned.length - 15} more CoL records`);
  const [a] = await rows<{ total: number | null; georef: number | null; key: string | null; note: string | null }>(conn, `
    SELECT gbif_all_records_count AS total, gbif_georeferenced_records_count AS georef, gbif_species_key AS key, count_note AS note
    FROM ${pq(T.assessed)} WHERE id = ${s.sis}`);
  if (a) say(`  The app shows ${a.note === "unlinked" ? "a dash (waiting for a decision)" : `${fmt(a.total)} records, ${fmt(a.georef)} georeferenced`}; GBIF key ${a.key ?? "none"}.`);
  return out.join("\n");
}

const isDirectRun = process.argv[1]?.endsWith("sync/trace.ts") || process.argv[1]?.endsWith("sync/trace.js");
if (isDirectRun) {
  const q = process.argv.slice(2).join(" ").trim();
  if (!q) { console.error('Usage: npm run sync:trace -- "<Red List name or SIS id>"'); process.exit(1); }
  trace(q).then((s) => console.log(s)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
