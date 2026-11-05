/**
 * build-search-index: the two name-sorted indexes the search bar reads — one over
 * species names, one over higher-rank taxon names — so a typeahead prefix query prunes
 * to a row group or two instead of scanning both species parquets end to end.
 *
 * assessed.parquet and unassessed.parquet are written ORDER BY class_name, order_name,
 * family (they're browse-ordered, which is what the species LISTS want), so a name
 * predicate can't prune a single row group: names are scattered across all of them. The
 * search hot path therefore read ~25MB off R2 per keystroke — ~2.2s per uncached query
 * in production, and the reason species-duckdb materializes search_idx in memory at all.
 *
 * This is the same trick synonym-index.parquet already uses (sorted by name, prefix-range
 * query, ~1 row group read) applied to the fast path. Sorted by name_lo, so:
 *
 *   WHERE name_lo >= 'panth' AND name_lo < 'panth' || chr(1114111)
 *
 * touches one row group. ROW_GROUP_SIZE is tuned for that read rather than left at the
 * default: 20k rows puts ~0.97MB in a group (103 of them), so a prefix query pulls about
 * a megabyte where the old path pulled ~25MB — and unlike the in-memory index it needs no
 * warm container to be fast. Measured locally: 9-13ms per query.
 *
 * One row per SEARCHABLE NAME, not per species — a species contributes its scientific
 * name, its common name, and its epithet, so "panthera", "lion" and "leo" all reach
 * Panthera leo by prefix. name_kind carries which, because the dropdown's ranking is
 * defined in those terms (exact common name > common-name prefix > scientific prefix).
 *
 * Rows carry the whole SearchResult payload, including the col_id the NE list keys on —
 * so a hit needs no join back to the species parquets and no species_link lookup, which
 * on the old path was another R2 read per search.
 *
 * Covers the fast path only (assessed ∪ GBIF-observed). The CoL-only and synonym tiers
 * are reached solely when nothing here matches, and they already have their own answer:
 * synonym-index.parquet is name-sorted, and species-duckdb primes both at warm-up.
 *
 * The second output, rank-index.parquet, is the same idea for the "Browse Felidae →"
 * suggestions: the DISTINCT class/order/family/genus names, pre-aggregated to ONE ROW
 * PER NAME and sorted, so suggestTaxa is a pruned range read rather than eight DISTINCT
 * scans of both parquets. Pre-aggregating here rather than at query time is also what
 * makes the answer deterministic — see the comment on the struct min below.
 *
 * Input: data/assessed.parquet, data/unassessed.parquet, data/species_link.parquet.
 * Output: data/name-index.parquet, data/rank-index.parquet.
 *
 *   npx tsx scripts/sync/outputs/build-search-index.ts
 */
import * as fs from "fs";
import * as path from "path";
import { inatKingdomSql } from "../inputs/fetch-inat-vernaculars";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR } from "../../lib/utils";
import { syncPath } from "../../../src/lib/data/sync-layout";

/** Ranks in the order suggestTaxa prefers them; the index is the priority it sorts on.
 *  Mirrors SUGGEST_RANKS in src/lib/data/species-duckdb.ts — keep the two in step. */
const SUGGEST_RANKS = ["class", "order", "family", "genus"] as const;

/** What each rank matches on. Mirrors RANK_TO_MATCH_SQL in species-duckdb.ts. */
const RANK_TO_MATCH_SQL: Record<(typeof SUGGEST_RANKS)[number], string> = {
  class: "class_name", order: "order_name", family: "family",
  genus: "lower(split_part(scientific_name, ' ', 1))",
};

/** Ranking tiers, mirrored by searchSpecies' ORDER BY. Keep the two in step. */
export const NAME_KIND = { scientific: 0, common: 1, epithet: 2, commonWord: 3, altCommon: 4, altCommonWord: 5 } as const;

/**
 * @param coreDir where the vernacular parquets are (the sync's core/); given, they are required
 * @param inatNames iNaturalist's names (inputs/inat.ts); given, required
 */
export async function run(opts: { dataDir?: string; coreDir?: string; inatNames?: string } = {}): Promise<void> {
  const dir = opts.dataDir || DATA_DIR;
  for (const f of [opts.coreDir && path.join(opts.coreDir, "species-vernacular-names.parquet"), opts.inatNames]) {
    if (f && !fs.existsSync(f)) throw new Error(`build-search-index: ${f} is missing; every alternative common name would silently stop matching`);
  }
  const assessed = path.join(dir, syncPath("assessed.parquet"));
  const ne = path.join(dir, syncPath("ne.parquet"));
  const link = path.join(dir, syncPath("species_link.parquet"));
  for (const f of [assessed, ne, link]) {
    if (!fs.existsSync(f)) throw new Error(`build-search-index: ${f} not found (run build-parquet + build-matching first)`);
  }
  const out = path.join(dir, syncPath("name-index.parquet"));

  const conn = await (await DuckDBInstance.create(":memory:")).connect();

  // The per-species payload, unioned once and then exploded into name rows below.
  // col_id is NULL for assessed rows on purpose: their row key is the SIS id, and
  // searchSpecies keys them that way (see species_key in SearchResult).
  await conn.run(`
    CREATE TEMP TABLE species AS
      SELECT a.id, a.scientific_name, a.common_name, a.taxon_group, a.iucn_category AS category,
             a.gbif_species_key, a.gbif_occurrence_count,
             a.assessment_id, CAST(a.assessment_date AS VARCHAR) AS assessment_date,
             a.countries, a.class_name, a.order_name, a.family,
             true AS assessed, CAST(NULL AS VARCHAR) AS col_id, ra.col_id AS name_col_id
      FROM read_parquet('${assessed}') a
      LEFT JOIN (
        -- The primary link only: a covered row names another concept the species
        -- is kept out of the NE list under, not the species itself.
        SELECT id, any_value(col_id) AS col_id FROM read_parquet('${link}')
        WHERE src = 'redlist' AND col_id IS NOT NULL AND match_method <> 'iucn_synonym_covered' GROUP BY 1
      ) ra ON ra.id = a.id
      UNION ALL
      -- Not Evaluated species GBIF has records for, keyed by col_id (also their GBIF key).
      SELECT NULL::BIGINT, u.scientific_name, u.common_name, u.taxon_group, u.iucn_category,
             u.gbif_species_key, u.gbif_occurrence_count,
             NULL, NULL,
             u.countries, u.class_name, u.order_name, u.family,
             false, u.col_id, u.col_id
      FROM read_parquet('${ne}') u`);

  const payload = `id, scientific_name, common_name, taxon_group, category, gbif_species_key,
    gbif_occurrence_count, assessment_id, assessment_date, countries,
    class_name, order_name, family, assessed, col_id`;

  // Every other English common name CoL gives the species (build-vernaculars), so
  // "baobab" finds Adansonia digitata through "African baobab" even though its display
  // name is a different one — and an assessed species with no IUCN common name is still
  // findable by its CoL names. Absent on syncs built before that file existed.
  const altNames = path.join(opts.coreDir ?? dir, "species-vernacular-names.parquet");
  // …and every English name iNaturalist gives it (fetch-inat-vernaculars), matched by
  // scientific name within a kingdom. One row per (species, name, case-insensitive).
  const inatNames = opts.inatNames ?? path.join(dir, "inat-vernaculars.parquet");
  const sources = [
    fs.existsSync(altNames)
      ? `SELECT s.*, v.name AS alt_name FROM species s JOIN read_parquet('${altNames}') v ON v.col_id = s.name_col_id`
      : null,
    fs.existsSync(inatNames)
      ? `SELECT s.*, n.name AS alt_name FROM species s
         JOIN (SELECT scientific_name, kingdom, unnest(names) AS name FROM read_parquet('${inatNames}')) n
           ON n.scientific_name = s.scientific_name AND n.kingdom = ${inatKingdomSql("s.taxon_group")}`
      : null,
  ].filter(Boolean);
  await conn.run(sources.length
    ? `CREATE TEMP TABLE alt_names AS
         SELECT * EXCLUDE (k) FROM (
           -- One row per species and name. A species is its SIS id when assessed, its
           -- col_id when not: id alone is NULL for every NE row, which once put all NE
           -- species sharing a name ("A bird flea") in one partition, and kept one.
           SELECT *, row_number() OVER (PARTITION BY assessed, coalesce(CAST(id AS VARCHAR), col_id), lower(alt_name) ORDER BY alt_name) AS k
           FROM (${sources.join(" UNION ALL ")})
           WHERE lower(alt_name) <> lower(coalesce(common_name, ''))
         ) WHERE k = 1`
    : `CREATE TEMP TABLE alt_names AS SELECT *, CAST(NULL AS VARCHAR) AS alt_name FROM species WHERE false`);

  await conn.run(`
    COPY (
      -- rank_name is the common name a row is RANKED by: the display one, except on a row
      -- reached through an alternative name, which ranks by the name it actually matched
      -- (so "monkeybread" exactly matching an alternative name ranks as an exact match).
      SELECT name_lo, matched_name, name_kind, rank_name, ${payload} FROM (
        -- Scientific name.
        SELECT lower(scientific_name) AS name_lo, scientific_name AS matched_name,
               ${NAME_KIND.scientific} AS name_kind, common_name AS rank_name, ${payload}
        FROM species WHERE scientific_name IS NOT NULL AND scientific_name <> ''
        UNION ALL
        -- Common name. Stored '' rather than NULL when absent (see build-parquet).
        SELECT lower(common_name), common_name, ${NAME_KIND.common}, common_name, ${payload}
        FROM species WHERE nullif(common_name, '') IS NOT NULL
        UNION ALL
        -- Specific epithet, so the half of a binomial people actually remember ("leo",
        -- "tigris") is a prefix hit rather than an interior substring only the slow tier
        -- could find. Monomials contribute nothing here — their epithet row would just
        -- duplicate the scientific-name row.
        SELECT lower(split_part(scientific_name, ' ', 2)), scientific_name, ${NAME_KIND.epithet}, common_name, ${payload}
        FROM species
        WHERE scientific_name LIKE '% %' AND nullif(split_part(scientific_name, ' ', 2), '') IS NOT NULL
        UNION ALL
        -- Every word of a multi-word common name after the first, which is the one case a
        -- prefix index would otherwise lose to the old substring scan: "elephant" has to
        -- find African Elephant, and "eagle" Steller's Sea Eagle. Ranked below the tiers
        -- above (see name_kind), so a real prefix hit is never displaced by a word match.
        SELECT lower(w.word), s.common_name, ${NAME_KIND.commonWord}, s.common_name, ${payload}
        FROM species s, unnest(string_split(s.common_name, ' ')) WITH ORDINALITY AS w(word, pos)
        WHERE nullif(s.common_name, '') IS NOT NULL AND w.pos > 1 AND nullif(w.word, '') IS NOT NULL
        UNION ALL
        -- Each alternative common name, and each of its later words — the same two
        -- treatments the display name gets above.
        SELECT lower(alt_name), alt_name, ${NAME_KIND.altCommon}, alt_name, ${payload}
        FROM alt_names
        UNION ALL
        SELECT lower(w.word), a.alt_name, ${NAME_KIND.altCommonWord}, a.alt_name, ${payload}
        FROM alt_names a, unnest(string_split(a.alt_name, ' ')) WITH ORDINALITY AS w(word, pos)
        WHERE w.pos > 1 AND nullif(w.word, '') IS NOT NULL
      )
      ORDER BY name_lo
    ) TO '${out}' (FORMAT parquet, COMPRESSION ZSTD, ROW_GROUP_SIZE 20000)`);

  const q = async (sql: string) => (await (await conn.run(sql)).getRowObjects());
  const n = (await q(`SELECT count(*) n, count(DISTINCT name_lo) d FROM read_parquet('${out}')`))[0];
  const bytes = fs.statSync(out).size;
  console.log(`Wrote ${Number(n.n).toLocaleString()} name rows (${Number(n.d).toLocaleString()} distinct names, ` +
    `${(bytes / 1048576).toFixed(1)} MB) → ${out}`);

  await buildRankIndex(conn, dir);
}

/**
 * rank-index.parquet: the class/order/family/genus names the search bar offers as
 * "Browse Felidae →", one row per NAME, sorted by it.
 *
 * Pre-aggregated here rather than grouped at query time, which does two things:
 *
 *  1. suggestTaxa becomes a prefix-range read of a ~2MB file instead of eight DISTINCT
 *     scans of both species parquets — so, like name-index.parquet, it's fast on a cold
 *     container with nothing materialized.
 *
 *  2. It fixes a real nondeterminism. A name can occur in several taxon groups (the
 *     genus "×" is in mosses AND flowering plants), and the old query resolved that with
 *     arg_min(taxon_group, rp), whose tie-break among equal rp is arbitrary — parallel
 *     aggregation order, so it genuinely varied BETWEEN RUNS on identical data: two
 *     identical searches could offer to browse the same name in different taxa. Taking
 *     min() of a STRUCT instead compares field by field, in declaration order — coarsest
 *     rank, then alphabetically first taxon group — so the winner is total and stable.
 *     The lineage columns ride along in the same struct, which keeps them consistent
 *     with the group that won (and saves resolveTaxonSuggestionNode its own lookup).
 */
async function buildRankIndex(conn: DuckDBConnection, dir: string): Promise<void> {
  const out = path.join(dir, syncPath("rank-index.parquet"));
  const part = (src: string) => SUGGEST_RANKS.map((rank, rp) => `
    SELECT ${RANK_TO_MATCH_SQL[rank]} AS name, ${rp} AS rp, taxon_group, class_name, order_name, family
    FROM read_parquet('${path.join(dir, syncPath(src))}')
    WHERE ${rank === "genus" ? "scientific_name IS NOT NULL" : `${RANK_TO_MATCH_SQL[rank]} IS NOT NULL`}`
  ).join(" UNION ALL ");

  await conn.run(`
    CREATE TEMP TABLE rank_sci AS
      SELECT name, (min(s)).rp AS rp, (min(s)).tg AS taxon_group,
             (min(s)).cls AS class_name, (min(s)).ord AS order_name, (min(s)).fam AS family
      FROM (
        SELECT name, {'rp': rp, 'tg': taxon_group, 'cls': class_name, 'ord': order_name, 'fam': family} AS s
        FROM (${part("assessed.parquet")} UNION ALL ${part("ne.parquet")})
      )
      WHERE name <> ''
      GROUP BY name`);

  // Common names of the ranks themselves (vernacular-names.json: "adansonia" →
  // "Baobabs", "felidae" → "Cats"), so "baobab" offers "Browse Adansonia (Baobabs)".
  // Each becomes its own searchable row pointing at its taxon; every row also carries
  // the common name for display. A common name that is itself some taxon's scientific
  // name is left out (the scientific row wins), and one shared by several taxa goes to
  // the coarsest rank, then the alphabetically first taxon — the same struct-min rule.
  const vernFile = path.join(dir, syncPath("vernacular-names.json"));
  const vern: Record<string, string> = fs.existsSync(vernFile) ? JSON.parse(fs.readFileSync(vernFile, "utf-8")) : {};
  const tmp = path.join(dir, ".rank-vernaculars.ndjson");
  fs.writeFileSync(tmp, Object.entries(vern).map(([sci, common]) => JSON.stringify({ sci, common })).join("\n"));
  await conn.run(`CREATE TEMP TABLE rank_vern AS SELECT * FROM read_json('${tmp}', format='newline_delimited', columns={sci: 'VARCHAR', common: 'VARCHAR'})`);
  fs.rmSync(tmp);

  await conn.run(`
    COPY (
      SELECT r.name, r.rp, r.taxon_group, r.class_name, r.order_name, r.family,
             r.name AS taxon, v.common
      FROM rank_sci r LEFT JOIN rank_vern v ON v.sci = r.name
      UNION ALL
      SELECT name, (min(s)).rp, (min(s)).tg, (min(s)).cls, (min(s)).ord, (min(s)).fam, (min(s)).taxon, (min(s)).common
      FROM (
        SELECT lower(v.common) AS name,
               {'rp': r.rp, 'tg': r.taxon_group, 'taxon': r.name, 'cls': r.class_name, 'ord': r.order_name,
                'fam': r.family, 'common': v.common} AS s
        FROM rank_vern v JOIN rank_sci r ON r.name = v.sci
        WHERE lower(v.common) NOT IN (SELECT name FROM rank_sci)
      )
      GROUP BY name
      ORDER BY name
    ) TO '${out}' (FORMAT parquet, COMPRESSION ZSTD, ROW_GROUP_SIZE 20000)`);

  const rows = await (await conn.run(`SELECT count(*) n FROM read_parquet('${out}')`)).getRowObjects();
  console.log(`Wrote ${Number(rows[0].n).toLocaleString()} rank names (${(fs.statSync(out).size / 1048576).toFixed(1)} MB) → ${out}`);
}

const isDirectRun = process.argv[1]?.endsWith("outputs/build-search-index.ts") || process.argv[1]?.endsWith("outputs/build-search-index.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((e) => { console.error(e); process.exit(1); });
}
