/**
 * Reads a build into select.ts's inputs (docs/specs/matching.md, "Inputs"), and
 * runs every species: selectAll(). `npm run sync:select` prints the result.
 *
 * Read from the build: sources/assessments.parquet (is_latest), sources/taxa.parquet,
 * sources/occurrences.parquet and link/matches.parquet; and seeds/decisions.tsv.
 */

import * as path from "path";
import { type DuckDBConnection } from "@duckdb/node-api";
import { lit, openDuckDB, rows, writeTable } from "../sql";
import { tables, parquet, BUILD_DIR } from "../paths";
import { orthographicKey, sameNameKey } from "./name-rules";
import { readVerdicts, readDecisions, type JudgeVerdict, type Decision } from "./decisions";
import { selectEvery, type ColRecord, type ColSpecies, type Release, type Selection, type SpeciesInput } from "./select";

/** taxa's status and rank in the matcher's forms (synonym → SYNONYM, provisionally accepted → PROVISIONALLY_ACCEPTED). */
export const matcherForm = (s: string | null) => (s ?? "").toUpperCase().replace(/ /g, "_");

interface TaxaRow { col_id: string; scientific_name: string; authorship: string | null; rank: string; status: string;
  sp_id: string | null; sp_name: string | null; sp_authorship: string | null; sp_class: string | null; sp_kingdom: string | null; sp_phylum: string | null }

const TAXA_COLUMNS = `t.col_id, t.scientific_name, t.authorship, t.rank, t.status,
  s.col_id AS sp_id, s.scientific_name AS sp_name, s.authorship AS sp_authorship, s.class_name AS sp_class, s.kingdom AS sp_kingdom, s.phylum AS sp_phylum`;

const toRecord = (t: TaxaRow, classification: number | null = null): ColRecord => ({
  id: t.col_id, name: t.scientific_name, authorship: t.authorship, rank: matcherForm(t.rank), status: matcherForm(t.status), classification,
  species: t.sp_id ? { id: t.sp_id, name: t.sp_name!, authorship: t.sp_authorship, class: t.sp_class, kingdom: t.sp_kingdom, phylum: t.sp_phylum } as ColSpecies : null,
});

export interface Inputs {
  species: SpeciesInput[];
  release: Omit<Release, "wholeBySteps">;
  decisions: Map<number, Decision>;
  /** seeds/judge-verdicts.tsv. */
  verdicts: Map<number, JudgeVerdict>;
}

/** Everything select() reads, from the build's tables. */
export async function loadInputs(t = tables(), decisions = readDecisions(), conn?: DuckDBConnection,
  /** Further names whose CoL records to load (the judge's facts: the Red List names and the answers'). */
  extraNames: string[] = []): Promise<Inputs> {
  conn ??= await openDuckDB();
  const taxa = parquet(t.taxa);

  // Species, with their synonyms and the synonyms' authors.
  const species = await rows<{ sis: number; name: string; authority: string | null; kingdom: string | null; phylum: string | null;
    synonyms: string | null; matcher: string | null }>(conn, `
    SELECT sis_taxon_id::INTEGER AS sis, scientific_name AS name, authority, kingdom_name AS kingdom, phylum_name AS phylum,
           to_json(synonyms)::VARCHAR AS synonyms
    FROM ${parquet(t.assessments)} WHERE is_latest ORDER BY sis`);

  // The matcher's answers, and every record they name.
  const matches = new Map((await rows<{ sis_taxon_id: number; matcher_col_id: string | null; matcher_name: string | null; matcher_authorship: string | null;
    matcher_rank: string | null; matcher_status: string | null; match_type: string | null; matcher_score: string | null; alternatives: string | null }>(conn, `
    SELECT sis_taxon_id, matcher_col_id, matcher_name, matcher_authorship, matcher_rank, matcher_status, match_type, matcher_score, alternatives FROM ${parquet(t.matches)}`)).map((m) => [m.sis_taxon_id, m]));
  await conn.run(`CREATE OR REPLACE TEMP TABLE named_ids AS
    SELECT matcher_col_id AS id FROM ${parquet(t.matches)} WHERE matcher_col_id IS NOT NULL
    UNION SELECT unnest(json_extract_string(alternatives, '$[*].col_id')) FROM ${parquet(t.matches)}
    ${[...decisions.values()].flatMap((d) => d.rows.flatMap((r) => (r.id ? [`UNION SELECT ${lit(r.id)}`] : []))).join(" ")}`);
  const byId = new Map((await rows<TaxaRow>(conn, `
    SELECT ${TAXA_COLUMNS} FROM named_ids n JOIN ${taxa} t ON t.col_id = n.id LEFT JOIN ${taxa} s ON s.col_id = t.species_id`))
    .map((r) => [r.col_id, r]));

  // CoL records with a synonym's (or a decision's) name: the same name, or orthographicallySame.
  const parsed = species.map((s) => ({ ...s, synonyms: (JSON.parse(s.synonyms ?? "[]") as { name: string; authors?: string[] | null }[]) }));
  const wanted = new Set<string>(), wantedKeys = new Set<string>();
  const want = (n: string) => { wanted.add(sameNameKey(n)); const k = orthographicKey(n); if (k) wantedKeys.add(k); };
  for (const s of parsed) for (const y of s.synonyms) want(y.name);
  for (const d of decisions.values()) for (const r of d.rows) if (r.name) want(r.name);
  for (const n of extraNames) want(n);
  // Names whose orthographic key is wanted: every species-rank name, keyed here, as the key is name-rules.ts's.
  const names = new Set<string>(wanted);
  const nameKeys = await rows<{ name: string }>(conn, `SELECT DISTINCT scientific_name AS name FROM ${taxa} WHERE rank = 'species'`);
  const keyOf = new Map<string, string[]>();
  for (const { name } of nameKeys) {
    const k = orthographicKey(name);
    if (k && wantedKeys.has(k)) { names.add(sameNameKey(name)); (keyOf.get(k) ?? keyOf.set(k, []).get(k)!).push(sameNameKey(name)); }
  }
  await writeTable(conn, "wanted_names", { name_key: "VARCHAR" }, [...names].map((name_key) => ({ name_key })));
  const pool = await rows<TaxaRow & { name_key: string }>(conn, `
    SELECT ${TAXA_COLUMNS}, w.name_key FROM ${taxa} t
    JOIN wanted_names w ON w.name_key = trim(regexp_replace(lower(replace(t.scientific_name, '×', '')), '\\s+', ' ', 'g'))
    LEFT JOIN ${taxa} s ON s.col_id = t.species_id WHERE t.rank = 'species'`);
  const byNameKey = new Map<string, ColRecord[]>();
  for (const r of pool) {
    const k = sameNameKey(r.scientific_name);
    (byNameKey.get(k) ?? byNameKey.set(k, []).get(k)!).push(toRecord(r));
  }
  const recordsNamed = (name: string): ColRecord[] => {
    const out = new Map<string, ColRecord>();
    for (const r of byNameKey.get(sameNameKey(name)) ?? []) out.set(r.id, r);
    const k = orthographicKey(name);
    for (const n of k ? keyOf.get(k) ?? [] : []) for (const r of byNameKey.get(n) ?? []) out.set(r.id, r);
    return [...out.values()];
  };

  // Occurrences under each pool record, and under the species each leads to: its own and three levels below it.
  // (The species' counts are for the judge, which compares what answers count; the rules read only records'.)
  const rootIds = new Set(pool.flatMap((r) => (r.sp_id ? [r.col_id, r.sp_id] : [r.col_id])));
  await writeTable(conn, "pool_ids", { id: "VARCHAR" }, [...rootIds].map((id) => ({ id })));
  const occurrences = new Map((await rows<{ id: string; n: number }>(conn, `
    WITH RECURSIVE down(root, id, depth) AS (
      SELECT id, id, 0 FROM pool_ids
      UNION ALL SELECT d.root, t.col_id, d.depth + 1 FROM down d JOIN ${taxa} t ON t.parent_id = d.id WHERE d.depth < 3),
    occ AS (SELECT usage_key, sum(n) AS n FROM ${parquet(t.occurrences)} WHERE usage_key IN (SELECT id FROM down) GROUP BY 1)
    SELECT d.root AS id, sum(o.n)::BIGINT AS n FROM (SELECT DISTINCT root, id FROM down) d JOIN occ o ON o.usage_key = d.id GROUP BY 1`))
    .map((r) => [r.id, Number(r.n)]));

  const classification = (score: string | null | undefined) => {
    if (!score) return null;
    const c = (typeof score === "string" ? JSON.parse(score) : score)?.classification;
    return typeof c === "number" ? c : null;
  };
  // A matcher's record as the matcher gave it (name, authorship, rank, status), with the species taxa says it leads to.
  type Said = { col_id: string; name: string | null; authorship: string | null; rank: string | null; status: string | null; score?: unknown };
  const rec = (a: Said | null) => {
    const r = a?.col_id ? byId.get(a.col_id) : undefined;
    if (!a || !r) return null;
    const base = toRecord(r, classification(typeof a.score === "string" ? a.score : JSON.stringify(a.score ?? {})));
    return { ...base, name: a.name ?? base.name, authorship: a.authorship ?? null, rank: a.rank ?? base.rank, status: a.status ?? base.status };
  };
  const input: SpeciesInput[] = parsed.map((s) => {
    const m = matches.get(s.sis);
    const alternatives = m?.alternatives ? (JSON.parse(m.alternatives) as Said[]) : [];
    return {
      sis: s.sis, name: s.name, authority: s.authority, kingdom: s.kingdom, phylum: s.phylum,
      synonyms: s.synonyms.map((y) => ({ name: y.name, authors: [...new Set((y.authors ?? []).map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean))] })),
      match: m ? {
        matchType: m.match_type, answerName: m.matcher_name,
        answer: m.matcher_col_id ? rec({ col_id: m.matcher_col_id, name: m.matcher_name, authorship: m.matcher_authorship, rank: m.matcher_rank,
          status: m.matcher_status, score: m.matcher_score }) : null,
        alternatives: alternatives.flatMap((a) => { const r = rec(a); return r ? [r] : []; }),
      } : null,
    };
  });

  const assessedNames = new Set(species.map((s) => sameNameKey(s.name)));
  return {
    species: input, decisions, verdicts: readVerdicts(),
    release: {
      assessedNames, recordsNamed,
      occurrencesUnder: (id) => occurrences.get(id) ?? 0,
      byId: (id) => { const r = byId.get(id); return r ? toRecord(r) : undefined; },
    },
  };
}

/** Every species' selection, from the build in `buildDir`. */
export async function selectAll(buildDir = BUILD_DIR): Promise<{ selections: Selection[]; inputs: Inputs }> {
  const inputs = await loadInputs(tables(buildDir));
  return { selections: selectEvery(inputs.species, inputs.release, inputs.decisions, inputs.verdicts), inputs };
}

/** What `npm run sync:select` prints for one species. */
export const selectionJson = (s: Selection) => ({
  sis_taxon_id: s.sis, step: s.step, reason: s.reason, doubts: s.doubts,
  selected: s.selected.map((x) => ({ id: x.record.id, relation: x.relation, relation_step: x.relationStep, basis: x.basis })),
});

if (require.main === module) {
  const i = process.argv.indexOf("--build");
  const dir = i > 0 ? path.resolve(process.argv[i + 1]) : BUILD_DIR;
  selectAll(dir).then(({ selections }) => {
    process.stdout.write("[\n" + selections.map((s) => JSON.stringify(selectionJson(s))).join(",\n") + "\n]\n");
  }).catch((e) => { console.error(e); process.exit(1); });
}
