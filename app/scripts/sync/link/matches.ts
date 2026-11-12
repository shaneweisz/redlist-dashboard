/**
 * matches: one row per assessed species, with GBIF's matcher's answer for its
 * Red List name.
 *
 * Built from: assessments (each species' latest name and lineage),
 * and matching-ws, GBIF's own name matcher, run locally against the XR
 * (inputs/matcher.ts).
 *
 * Columns:
 *   sis_taxon_id
 *   matcher_col_id, matcher_name, matcher_authorship, matcher_rank, matcher_status
 *                  the CoL record the matcher answered with, for the Red List
 *                  name as written (status: ACCEPTED, SYNONYM, AMBIGUOUS_SYNONYM,
 *                  PROVISIONALLY_ACCEPTED, MISAPPLIED, ...): its raw answer,
 *                  before any rule
 *   matcher_accepted_col_id, matcher_accepted_name, matcher_accepted_authorship
 *                  the accepted species a synonym answer leads to, as the
 *                  matcher gives it; empty for an accepted answer
 *   matcher_lineage  the answer's place in CoL: kingdom > phylum > class >
 *                  order > family, as far as CoL ranks it
 *   match_type     exact, variant, fuzzy, higher rank, none
 *   confidence     0-100
 *   matcher_score  why the matcher ranked its answer first, as JSON text: the
 *                  points it gave each part, {name, authorship, classification,
 *                  rank, status, total}, as matching-ws reports them
 *                  (MatchingService at the pinned release; authorship is 0, since
 *                  none is sent). Empty for a fallback to a higher rank the
 *                  matcher didn't score
 *   alternatives   the other CoL records the matcher weighed, as JSON text, each
 *                  with its points in the same form, the accepted species a
 *                  synonym leads to, and its lineage: [{col_id, name, authorship,
 *                  rank, status, confidence, match_type, score, accepted_col_id,
 *                  accepted_name, accepted_authorship, lineage}]
 *   matcher_version, matcher_xr
 *                  what answered: the matching-ws release and the CoL XR its
 *                  index was built from
 *
 * Decisions:
 *   - Each name is asked as GBIF sees most records: the name, with IUCN's
 *     kingdom, phylum, class, order and family as hints, and no authority. The
 *     matcher is the one GBIF files records with, so a name matched here is
 *     where GBIF put that name's records.
 *   - The authority is left out on purpose. Most records carry none, so GBIF
 *     files them on CoL's accepted record; asked with it, the matcher prefers
 *     whichever CoL record has the identical author string, often a provisional
 *     duplicate the records aren't on (Melospiza melodia (Wilson, 1810), not the
 *     accepted "(A. Wilson, 1810)"). Measured on COL26.6 XR: 301 species lost
 *     42.6M records that way, 9 gained 404. The authority is used after the
 *     match instead: accept-match.ts compares it against the alternatives to
 *     tell homonyms apart.
 *   - Nothing here decides anything; assessment-link.ts does.
 *   - Answers are cached by query, matcher version and XR under
 *     ~/.cache/redlist-dashboard/matching/<xr>-<version>/, so a month in which
 *     neither the Red List nor the XR moves asks nothing.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { CACHE_ROOT, output, parquet } from "../paths";
import { type Matcher } from "../inputs/matcher";
import { lit, writeTable, openDuckDB } from "../sql";

const THREADS = 16;

export interface Usage {
  usage_id: string; name: string; authorship: string | null; rank: string | null; status: string | null;
  /** The accepted species a synonym leads to. */
  accepted: { usage_id: string; name: string; authorship: string | null } | null;
  /** kingdom > phylum > class > order > family, as far as CoL ranks it. */
  lineage: string | null;
}
/** The points matching-ws gives a candidate, from its verbose note ("name=110; authorship=0; ...; score=165"). */
export interface Score { name: number | null; authorship: number | null; classification: number | null; rank: number | null; status: number | null; total: number | null }
export interface Answer {
  usage: Usage | null;
  match_type: string | null;
  confidence: number | null;
  score: Score | null;
  alternatives: (Usage & { confidence: number | null; match_type: string | null; score: Score | null })[];
}

/** The verbose note's points, or null where the matcher gave none. */
export function parseScore(note: string | undefined | null): Score | null {
  if (!note) return null;
  const num = (k: string) => { const m = note.match(new RegExp(`\\b${k}=(-?\\d+)`)); return m ? Number(m[1]) : null; };
  const s = { name: num("name"), authorship: num("authorship"), classification: num("classification"), rank: num("rank"), status: num("status"), total: num("score") };
  return Object.values(s).every((v) => v === null) ? null : s;
}

// No authority, on purpose (see Decisions). matching-ws reads it only as
// `scientificNameAuthorship`; this once sent `authorship`, which it ignores.
export interface Query { scientificName: string; scientificNameAuthorship?: string; kingdom?: string; phylum?: string; class?: string; order?: string; family?: string }

/** The query for one assessed species: its name, and IUCN's lineage as hints. */
export function matcherQuery(s: { scientific_name: string; authority?: string | null; kingdom_name: string | null; phylum_name: string | null;
  class_name: string | null; order_name: string | null; family: string | null }): Query {
  return { scientificName: s.scientific_name, ...(s.authority ? { scientificNameAuthorship: s.authority } : {}), kingdom: cap(s.kingdom_name),
    phylum: cap(s.phylum_name), class: cap(s.class_name), order: cap(s.order_name), family: cap(s.family) };
}

const cap = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : undefined);

type Raw = Record<string, unknown>;
const LINEAGE = ["KINGDOM", "PHYLUM", "CLASS", "ORDER", "FAMILY"];

/** One candidate as the matcher returns it: its usage, the accepted usage it leads to, and its classification. */
function slim(r: { usage?: Raw; acceptedUsage?: Raw; classification?: { rank?: string; name?: string }[] }): Usage | null {
  const u = r.usage;
  if (!u?.key) return null;
  const a = r.acceptedUsage;
  const lineage = (r.classification ?? []).filter((c) => c.rank && LINEAGE.includes(c.rank)).map((c) => c.name).join(" > ");
  return { usage_id: String(u.key), name: String(u.canonicalName ?? u.name), authorship: (u.authorship as string) || null,
    rank: (u.rank as string) ?? null, status: (u.status as string) ?? null,
    accepted: a?.key && a.key !== u.key ? { usage_id: String(a.key), name: String(a.canonicalName ?? a.name), authorship: (a.authorship as string) || null } : null,
    lineage: lineage || null };
}

async function ask(m: Matcher, q: Query): Promise<Answer> {
  const params = new URLSearchParams({ verbose: "true" });
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${m.url}/v2/species/match?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      type Candidate = Parameters<typeof slim>[0];
      const d = (await res.json()) as Candidate & { diagnostics?: { matchType?: string; confidence?: number; note?: string;
        alternatives?: (Candidate & { diagnostics?: { matchType?: string; confidence?: number; note?: string } })[] } };
      const dg = d.diagnostics ?? {};
      return {
        usage: slim(d), match_type: dg.matchType ?? null, confidence: dg.confidence ?? null, score: parseScore(dg.note),
        alternatives: (dg.alternatives ?? []).flatMap((a) => {
          const u = slim(a);
          return u ? [{ ...u, confidence: a.diagnostics?.confidence ?? null, match_type: a.diagnostics?.matchType ?? null, score: parseScore(a.diagnostics?.note) }] : [];
        }),
      };
    } catch (e) {
      if (attempt >= 5) throw new Error(`matcher: ${q.scientificName}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export async function askMatcher(inputs: { assessments: string; matcher: Matcher }, matchesFile: string): Promise<{ asked: number; cached: number }> {
  const { matcher } = inputs;
  const conn = await openDuckDB();
  const out = output(matchesFile);
  const species = (await conn.runAndReadAll(`
    SELECT sis_taxon_id::INTEGER AS sis, scientific_name, authority, kingdom_name, phylum_name, class_name, order_name, family
    FROM ${parquet(inputs.assessments)} WHERE is_latest ORDER BY sis`)).getRowObjects() as unknown as {
      sis: number; scientific_name: string; authority: string | null; kingdom_name: string | null; phylum_name: string | null;
      class_name: string | null; order_name: string | null; family: string | null }[];

  const cacheDir = path.join(CACHE_ROOT, "matching", `${matcher.datasetKey}-${matcher.version}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  // answers-v3.jsonl: answers with the matcher's points and each candidate's accepted name and lineage
  // (answers.jsonl had neither; answers-scored.jsonl, the points only).
  const cacheFile = path.join(cacheDir, "answers-v3.jsonl");
  const cache = new Map<string, Answer>();
  if (fs.existsSync(cacheFile)) {
    for (const line of fs.readFileSync(cacheFile, "utf-8").split("\n")) {
      if (!line) continue;
      try { const { q, a } = JSON.parse(line); cache.set(q, a); } catch { /* a torn last line from an interrupted run */ }
    }
  }

  const jobs = species.map((s) => {
    const q = matcherQuery(s);
    return { sis: s.sis, q, hash: createHash("sha1").update(JSON.stringify(q)).digest("hex") };
  });
  const missing = [...new Map(jobs.filter((j) => !cache.has(j.hash)).map((j) => [j.hash, j])).values()];
  if (missing.length > 0) {
    const fd = fs.openSync(cacheFile, "a");
    let next = 0, done = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: THREADS }, async () => {
      while (next < missing.length) {
        const j = missing[next++];
        const a = await ask(matcher, j.q);
        cache.set(j.hash, a);
        fs.writeSync(fd, JSON.stringify({ q: j.hash, a }) + "\n");
        if (++done % 20000 === 0) console.log(`   matched ${done.toLocaleString()} of ${missing.length.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
    }));
    fs.closeSync(fd);
  }

  await writeTable(conn, "match_rows", { sis_taxon_id: "INTEGER", answer: "JSON" },
    jobs.map((j) => ({ sis_taxon_id: j.sis, answer: JSON.stringify(cache.get(j.hash)) })));
  // The cache keeps the matcher's own field names; the table uses the sync's.
  const SCORE = `STRUCT(name INTEGER, authorship INTEGER, classification INTEGER, rank INTEGER, status INTEGER, total INTEGER)`;
  const ACC = `STRUCT(usage_id VARCHAR, name VARCHAR, authorship VARCHAR)`;
  const ALT = `STRUCT(usage_id VARCHAR, name VARCHAR, authorship VARCHAR, rank VARCHAR, status VARCHAR, confidence INTEGER, match_type VARCHAR, score ${SCORE},
    accepted ${ACC}, lineage VARCHAR)`;
  await conn.run(`COPY (
    SELECT sis_taxon_id,
           answer->>'$.usage.usage_id' AS matcher_col_id, answer->>'$.usage.name' AS matcher_name,
           answer->>'$.usage.authorship' AS matcher_authorship, answer->>'$.usage.rank' AS matcher_rank,
           answer->>'$.usage.status' AS matcher_status,
           answer->>'$.usage.accepted.usage_id' AS matcher_accepted_col_id, answer->>'$.usage.accepted.name' AS matcher_accepted_name,
           answer->>'$.usage.accepted.authorship' AS matcher_accepted_authorship, answer->>'$.usage.lineage' AS matcher_lineage,
           answer->>'$.match_type' AS match_type,
           (answer->>'$.confidence')::INTEGER AS confidence,
           -- JSON text, not structs: readable in any parquet viewer, and DuckDB still queries it.
           CASE WHEN answer->>'$.score.total' IS NOT NULL THEN to_json(CAST(answer->'$.score' AS ${SCORE}))::VARCHAR END AS matcher_score,
           to_json(list_transform(CAST(answer->'$.alternatives' AS ${ALT}[]), lambda a: {'col_id': a.usage_id, 'name': a.name, 'authorship': a.authorship,
             'rank': a.rank, 'status': a.status, 'confidence': a.confidence, 'match_type': a.match_type, 'score': a.score,
             'accepted_col_id': a.accepted.usage_id, 'accepted_name': a.accepted.name, 'accepted_authorship': a.accepted.authorship, 'lineage': a.lineage}))::VARCHAR AS alternatives,
           ${lit(matcher.version)} AS matcher_version, ${lit(matcher.datasetKey)} AS matcher_xr
    FROM match_rows ORDER BY sis_taxon_id
  ) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);
  return { asked: missing.length, cached: jobs.length - missing.length };
}
