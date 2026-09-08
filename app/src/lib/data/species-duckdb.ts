/**
 * DuckDB-backed read layer (#261). Queries assessed.parquet / unassessed.parquet
 * — local in dev, R2 (httpfs) in prod — replacing the load-whole-CSV-into-memory
 * path in species-store. Filters translate the taxonomy SpeciesFilter to SQL,
 * faithfully mirroring matchesFilter (incl. the order_name→class_name fallback).
 *
 * Species lists (assessed, optional NE union) + arbitrary-rank filtering. The
 * list carries the denormalized latest_* credit columns (assessors, reviewers,
 * facilitators, contributors, institutions) but NOT the full history array —
 * that's fetched lazily per species (getAssessmentHistory) when a detail panel
 * opens. Search / summaries land in later steps.
 */
import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { NODE_INDEX, getTaxonGroupsForNode, getAncestors, stripNodePrefix } from "@/lib/taxonomy-utils";
import { canonicalizeTaxonId, mapTaxonId } from "@/lib/data/taxonomy-constants";
import { getTaxaSummary, getColRevisions } from "@/lib/data/species-store";
import { isDynamicNodeId, dynamicNodeFilter, buildDynamicNodeId, rankOrderFor, isLiveDrilldownNode, type DynamicRank, type DynamicSegment } from "@/lib/dynamic-taxon";
import { filterToSql, sqlStrList, GENUS_SQL } from "@/lib/taxonomy-sql";
import { sisRowKey, colRowKey, speciesRowKey, type SpeciesRowKey } from "@/lib/species-row-key";
import { COL_DOMESTIC_EXCLUDE_NAMES } from "@/config/col-described-overrides";

const DATA_DIR = path.join(process.cwd(), "data");
// Dev has the parquets on disk; on Vercel they aren't bundled → read from R2.
const USE_R2 = !fs.existsSync(path.join(DATA_DIR, "assessed.parquet"));
// httpfs vendored at build time (scripts/fetch-duckdb-ext.ts) + traced into the
// v2 function (next.config). LOAD by path avoids the cold-start network INSTALL.
const HTTPFS_EXT = path.join(process.cwd(), "duckdb-ext", "httpfs.duckdb_extension");

// Exported for src/lib/data/country-taxa-summary-duckdb.ts, which queries the same
// assessed.parquet over the same cached connection — a second independent connection
// would double the httpfs/R2 setup cost per cold start.
export function parquetUri(name: string): string {
  if (!USE_R2) return path.join(DATA_DIR, name);
  const ts = fs.readFileSync(path.join(process.cwd(), "latest-sync.txt"), "utf-8").trim();
  return `s3://${process.env.R2_DATA_BUCKET_NAME}/syncs/${ts}/${name}`;
}

let connPromise: Promise<DuckDBConnection> | null = null;
export async function getConn(): Promise<DuckDBConnection> {
  if (!connPromise) {
    connPromise = (async () => {
      const inst = await DuckDBInstance.create(":memory:");
      const conn = await inst.connect();
      if (USE_R2) {
        await conn.run(`LOAD '${HTTPFS_EXT}'`);
        await conn.run(`
          SET s3_region='auto';
          SET s3_endpoint='${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com';
          SET s3_url_style='path';
          SET s3_access_key_id='${process.env.R2_ACCESS_KEY_ID}';
          SET s3_secret_access_key='${process.env.R2_SECRET_ACCESS_KEY}';
        `);
      }
      return conn;
    })();
  }
  return connPromise;
}

// The NE de-dup set (assessed col_ids) and the GBIF-by-col_id overlay map are GLOBAL
// (taxon-independent) but were rebuilt on every NE query — and the assessed set was
// scanned twice. Materialize both once per warm container as temp tables; large
// groups (plants ~280k) stop paying for the ~557k-row GBIF aggregation + the 173k
// anti-set on each request. Reset on failure so a transient R2 error can retry.
// Exported for src/lib/data/live-taxa-children.ts, which needs the exact same
// "assessed col_ids" / "CoL-extinct but IUCN-confirmed EX/EW" universe (ne_assessed_
// col_ids / ne_ex_ew_col_ids) for its own colDescribed/colNe counts — reusing these
// avoids building a second, redundant set of identical temp tables on the same
// warm connection.
let neHelpersPromise: Promise<void> | null = null;
export function ensureNeHelpers(conn: DuckDBConnection): Promise<void> {
  if (!neHelpersPromise) {
    neHelpersPromise = (async () => {
      const linkUri = parquetUri("species_link.parquet");
      const unassessedUri = parquetUri("unassessed.parquet");
      const assessedUri = parquetUri("assessed.parquet");
      await conn.run(`CREATE TEMP TABLE ne_assessed_col_ids AS
        SELECT DISTINCT col_id FROM read_parquet('${linkUri}') WHERE src = 'redlist' AND col_id IS NOT NULL`);
      // A species CoL flags extinct still belongs to the "described" universe if
      // IUCN's own linked assessment agrees (EX/EW) — see the matching comment +
      // rationale next to createExEwAssessedTable in scripts/build-taxa-summary.ts.
      // Mirrored here so this runtime species list and the build-time colDescribed/
      // colNe summary numbers never disagree with each other.
      await conn.run(`CREATE TEMP TABLE ne_ex_ew_col_ids AS
        SELECT DISTINCT l.col_id
        FROM read_parquet('${linkUri}') l
        JOIN read_parquet('${assessedUri}') a ON a.id = l.id
        WHERE l.src = 'redlist' AND l.col_id IS NOT NULL AND a.iucn_category IN ('EX', 'EW')`);
      await conn.run(`CREATE TEMP TABLE ne_gbif_by_col AS
        SELECT sl.col_id AS col_id, any_value(un.gbif_species_key) AS gbif_species_key, max(un.gbif_occurrence_count) AS gbif_occurrence_count, any_value(un.countries) AS countries, any_value(un.common_name) AS common_name
        FROM read_parquet('${linkUri}') sl JOIN read_parquet('${unassessedUri}') un ON un.id = sl.id
        WHERE sl.src = 'gbif' AND sl.col_id IS NOT NULL GROUP BY sl.col_id`);
    })().catch((e) => { neHelpersPromise = null; throw e; });
  }
  return neHelpersPromise;
}

// ─── Resolve a taxon identifier to a SQL predicate ──────────────────────────
//
// Parity with /api/redlist/species: a taxonomy node filters by its taxonGroups
// ONLY (drill-down sub-filtering — rodents, etc. — is applied client-side). A
// non-node identifier is the new capability: arbitrary-rank match. Values bind
// as parameters; the '|'-joined string is split in SQL (DuckDB can't bind a raw
// JS array).

export interface WhereParts { clauses: string[]; params: Record<string, string>; }

export function resolveWhere(taxonId: string): WhereParts {
  const id = canonicalizeTaxonId(taxonId);
  if (id === "all") return { clauses: [], params: {} };
  if (NODE_INDEX.has(id)) {
    const groups = getTaxonGroupsForNode(id);
    return { clauses: ["taxon_group = ANY(string_split($g, '|'))"], params: { g: groups.join("|") } };
  }
  // Dynamic (live taxonomic-drilldown) id — not in NODE_INDEX, but a real,
  // unambiguous, rank-disambiguated filter (see dynamic-taxon.ts). Checked
  // before the arbitrary-rank fallback below, which would otherwise compare the
  // whole raw id string (e.g. "mammals~order:rodentia~family:muridae") against
  // class_name/order_name/family and match nothing — filterToSql already
  // inlines its own escaped literals, so this clause needs no bind params.
  if (isDynamicNodeId(id)) {
    const filter = dynamicNodeFilter(id);
    if (filter) return { clauses: [filterToSql(filter)], params: {} };
  }
  // arbitrary rank (e.g. family=turdidae, genus=panthera): match the value at
  // class/order/family/genus. Genus is the odd one out — none of the three parquets
  // this predicate runs against (assessed / unassessed / species) carries a genus
  // column, so it's derived from the first word of scientific_name, exactly as
  // taxonomy-sql.ts's filterToSql and taxonomy-utils.ts's matchesFilter already do
  // for a node's `genera` filter (GENUS_SQL is that shared expression). class_name/
  // order_name/family are pre-lowercased at build time and compare directly;
  // scientific_name isn't, hence GENUS_SQL's own lower().
  return {
    clauses: [`(class_name = $arv OR order_name = $arv OR family = $arv OR ${GENUS_SQL} = $arv)`],
    params: { arv: id.toLowerCase() },
  };
}

// species/ is Hive-partitioned by `taxon_group` (the IUCN Table 1a group, assigned at
// build time from the lineage — see build-backbone's TAXON_GROUP_CASE). So the NE
// universe is filtered with the SAME `whereSql` resolveWhere() builds for the
// assessed/unassessed parquets, and the partition prunes to the queried group(s). No
// separate node→CoL lineage mapping or per-query partition logic is needed.

// ─── SpeciesRow projection ─────────────────────────────────────────────────

export interface PreviousAssessment {
  id: number; year: string; category: string;
  date: string | null; criteria: string | null; assessors: string | null; reviewers: string | null;
  facilitators: string | null; contributors: string | null; institutions: string | null;
}

const ASSESSED_SELECT = `
  id, assessment_id, scientific_name, common_name, family, iucn_category AS category,
  assessment_date, year_published, population_trend, countries, class_name, order_name,
  taxon_group, gbif_species_key, gbif_occurrence_count, gbif_observations_after_assessment_year,
  systems, growth_forms, movement_pattern, possibly_extinct, possibly_extinct_in_the_wild,
  criteria, threat_codes, habitat_codes, latest_assessors, latest_reviewers, latest_facilitators,
  latest_contributors, latest_institutions,
  assessment_count`;

const splitList = (s: unknown): string[] => (typeof s === "string" && s ? s.split(";").filter(Boolean) : []);
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * Assessed rows only — the NE branch of querySpecies builds its own (slimmer) row.
 * `id` here is assessed.parquet's own id column, which IS the SIS taxon id.
 */
export function toSpeciesRow(r: Record<string, unknown>) {
  const sisTaxonId = Number(r.id);
  const taxonGroup = String(r.taxon_group);
  // Possible-taxonomic-revision flag: null for the ~94% of assessed species CoL
  // neither disagrees with nor has split anything out of. A precomputed in-memory
  // lookup (getColRevisions), not a parquet join — it's one small file read once
  // per process, and stamping it here means every consumer of a species row
  // (list, filter chart, detail panel) sees the same flag without its own fetch.
  const colRevision = getColRevisions().get(sisTaxonId) ?? null;
  return {
    // Namespaced row key — see lib/species-row-key. Assessed species always have a
    // SIS id, so this branch is always `sis-…`; NE rows get `col-…` in querySpecies.
    species_key: sisRowKey(sisTaxonId),
    sis_taxon_id: sisTaxonId,
    col_id: (r.col_id as string) ?? null, // CoL id — set on NE rows (assessed resolve via sis)
    assessment_id: num(r.assessment_id),
    scientific_name: r.scientific_name ?? "",
    common_name: r.common_name ?? null,
    family: r.family ?? null,
    category: r.category ?? "",
    assessment_date: r.assessment_date ?? null,
    year_published: r.year_published ?? "",
    population_trend: r.population_trend ?? null,
    countries: splitList(r.countries),
    class_name: r.class_name ?? null,
    order_name: r.order_name ?? null,
    taxon_group: taxonGroup,
    taxon_id: mapTaxonId(taxonGroup),
    // Species description year from CoL (NE rows only; null for assessed species,
    // whose parquet has no such column). Coalesced upstream from the author-year
    // columns with a cited-reference-year fallback — see build-backbone.
    described_year: num(r.described_year),
    gbif_species_key: str(r.gbif_species_key),
    gbif_occurrence_count: num(r.gbif_occurrence_count),
    gbif_observations_after_assessment_year: num(r.gbif_observations_after_assessment_year),
    // Latest (most recent) assessment's credits, denormalized into
    // assessed.parquet — the list view's credit filters read these.
    latest_assessors: (r.latest_assessors as string) ?? null,
    latest_reviewers: (r.latest_reviewers as string) ?? null,
    latest_facilitators: (r.latest_facilitators as string) ?? null,
    latest_contributors: (r.latest_contributors as string) ?? null,
    latest_institutions: (r.latest_institutions as string) ?? null,
    // Full history is fetched lazily (getAssessmentHistory) when a detail panel
    // opens; the species list no longer carries it (≈40% smaller payload).
    previous_assessments: [] as PreviousAssessment[],
    systems: splitList(r.systems),
    growth_forms: splitList(r.growth_forms),
    movement_pattern: r.movement_pattern ?? null,
    possibly_extinct: Boolean(r.possibly_extinct),
    possibly_extinct_in_the_wild: Boolean(r.possibly_extinct_in_the_wild),
    criteria: r.criteria ?? null,
    threat_codes: splitList(r.threat_codes),
    habitat_codes: splitList(r.habitat_codes),
    // Possible taxonomic revision — see lib/col-revision.ts. null = neither
    // signal applies.
    col_revision: colRevision,
    // Count of distinct assessment years on record (>=2 means reassessed at
    // least once). null for NE rows, which have no assessment history.
    assessment_count: num(r.assessment_count),
  };
}

// CoL species deliberately kept out of the universe (analogous to the domesticated-GBIF
// exclusion). Homo sapiens — IUCN omits humans from its Red List export, so it would
// otherwise surface as "not evaluated". Keep in sync with build-taxa-summary.
const EXCLUDED_COL_IDS_SQL = `('6MB3T')`; // Homo sapiens

// Domestic/feral forms (dog, cat, cattle, etc.) excluded from the NE universe here too —
// each has a wild-form sibling species already counted separately (see
// COL_DOMESTIC_EXCLUDE_NAMES's doc comment), so counting the domestic form as "Not
// Evaluated" as well would double up. Matches build-taxa-summary.ts's colCountsByGroup,
// whose precomputed col_ne this live count must agree with (#397 — Mammals showed 530
// live vs. 520 precomputed, a gap of exactly these 10 names). Node-scoped queries that
// go through filterToSql already exclude the wider COL_EXCLUDE_ALL_NODES (this list plus
// the Bison SG name overrides) via whereSql, making this redundant-but-harmless for them;
// this is the only exclusion applied for the taxon_group-partition fast path (top-level
// taxa like "mammals"), which bypasses filterToSql entirely.
const NOT_DOMESTIC_SQL = `coalesce(lower(scientific_name), '') NOT IN (${sqlStrList(COL_DOMESTIC_EXCLUDE_NAMES)})`;

// Cap on how many Not-Evaluated species one query may return. A giant aggregate
// (insects ~935k, invertebrates ~1.3M) can't be serialized in one response (it 500s /
// times out), so a taxon over the cap returns no rows with tooLarge=true and the UI
// prompts a drill-down instead. Also read by nodeIdForSpecies, which uses it to decide
// whether a group's own node can list a search result at all.
const NE_CAP = 400_000;

// Per-taxon_group not-evaluated counts from the precomputed taxa-summary (in memory),
// used to decide tooLarge instantly without scanning species/ on R2.
let neByGroupCache: Map<string, number> | null = null;
function neByGroup(): Map<string, number> {
  if (neByGroupCache) return neByGroupCache;
  const m = new Map<string, number>();
  for (const row of getTaxaSummary()) m.set(row.table1a_taxon_group, Number(row.col_ne ?? 0));
  neByGroupCache = m;
  return m;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function querySpecies(opts: {
  taxon: string;
  includeNE?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ species: ReturnType<typeof toSpeciesRow>[]; truncated: boolean; tooLarge: boolean; neTotal: number | null }> {
  const conn = await getConn();
  const where = resolveWhere(opts.taxon);
  const whereSql = where.clauses.length ? `WHERE ${where.clauses.join(" AND ")}` : "";
  const assessedUri = parquetUri("assessed.parquet");
  // Cap the Not-Evaluated additions: a giant aggregate (insects ~1M, invertebrates
  // ~1.3M) can't be serialized in one response (it 500s / times out). Return up to
  // NE_CAP, flag `truncated`, and report `neTotal` so the UI can say "showing N of M
  // — drill into a sub-group". Every species stays reachable via its leaf node.
  // The NE list is never partially truncated now: a group over the cap returns no rows
  // with tooLarge=true (UI prompts a drill-down); groups under the cap load in full.
  const truncated = false;
  let tooLarge = false;
  let neTotal: number | null = null;

  // Fast tooLarge path: decide from the precomputed per-group col_ne (in memory) before any
  // R2 work, so the drill-down prompt for a giant aggregate (insects, invertebrates) is
  // instant instead of waiting on a ~2M-row count + the cold ensureNeHelpers build. The
  // per-group sum is an upper bound for any sub-group, so it never falsely blocks a
  // manageable one (only the two aggregates exceed the cap). Best-effort: if taxa-summary
  // isn't bundled in this function, fall through to the live count below (still correct).
  if (opts.includeNE) {
    try {
      const groups = getTaxonGroupsForNode(canonicalizeTaxonId(opts.taxon));
      const neEstimate = groups.reduce((sum, g) => sum + (neByGroup().get(g) ?? 0), 0);
      if (neEstimate > NE_CAP) {
        return { species: [], truncated, tooLarge: true, neTotal: neEstimate };
      }
    } catch {
      // taxa-summary unavailable — the live count in the NE branch still enforces the cap.
    }
  }

  // No history join — the list carries only the latest credits
  // (denormalized columns). The full per-species history array is fetched lazily
  // via getAssessmentHistory when a detail panel opens. This reads a single file
  // and drops ≈40% of the payload (history was ~half the bytes for large taxa).
  const assessedSql = `SELECT ${ASSESSED_SELECT} FROM '${assessedUri}' a ${whereSql}`;
  const rows = (await conn.runAndReadAll(assessedSql, where.params)).getRowObjects();

  let result = rows.map(toSpeciesRow);

  // Not-Evaluated species (#271, Phase 3): on an NE fetch, add every species under
  // this taxon that is NOT IUCN-assessed — keyed by CoL `col_id`, not by name. Name
  // de-duping double-counted: IUCN assesses Hipposideros X while CoL's accepted name
  // is Doryrhina X (a genus reassignment), so the same animal showed once as assessed
  // and again as "new". species_link bridges both names to one col_id, so de-duping by
  // col_id collapses them. Two parts: (A) the CoL extant universe under the taxon minus
  // already-assessed col_ids, with GBIF occurrences overlaid; (B) GBIF-observed species
  // not represented in that universe (orphans). Safety-capped.
  if (opts.includeNE && whereSql) {
    const taxonId = canonicalizeTaxonId(opts.taxon);
    // Build (once per warm container) the global de-dup set + GBIF overlay map.
    await ensureNeHelpers(conn);
    const assessedColIds = "(SELECT col_id FROM ne_assessed_col_ids)"; // assessed col_ids (de-dup key)
    const speciesUri = parquetUri("species/**/*.parquet");

    // The NE list IS the CoL extant universe under the taxon, not already assessed
    // (minus the small EXCLUDED_COL_IDS denylist). species/ is partitioned by taxon_group,
    // so the SAME `whereSql` used for the assessed parquet filters + prunes it.
    const univFilter = `${whereSql} AND in_base AND (extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ne_ex_ew_col_ids)) AND col_id NOT IN ${assessedColIds} AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL} AND ${NOT_DOMESTIC_SQL}`;

    // Count first (cheap). A giant aggregate (insects ~935k, invertebrates ~1.3M) exceeds
    // the cap — serializing it is a 250MB+ payload the browser can't load. Flag `tooLarge`
    // and return no rows so the UI prompts a drill-down into a sub-group instead. Every
    // group under the cap (beetles ~262k and smaller) loads in full (never truncated).
    const univCount = Number((await conn.runAndReadAll(
      `SELECT count(*) AS c FROM read_parquet('${speciesUri}', hive_partitioning=true) ${univFilter}`,
      where.params)).getRowObjects()[0].c);
    if (univCount > NE_CAP) {
      tooLarge = true;
      neTotal = univCount;
    } else {
      // GBIF orphans (species GBIF knows but CoL's Base universe doesn't) were dropped: the
      // NE list equals the col_ne count exactly and excludes fossils CoL keeps out of the
      // universe (woolly mammoth in_base=false; American mastodon CoL-unmatched).
      const univSql = `
        SELECT u.col_id, u.scientific_name, u.class_name, u.order_name, u.family, u.taxon_group, u.described_year,
               g.gbif_species_key, g.gbif_occurrence_count, g.countries, g.common_name
        FROM (
          SELECT col_id, scientific_name, class_name, order_name, family, taxon_group, described_year
          FROM read_parquet('${speciesUri}', hive_partitioning=true) ${univFilter}
        ) u
        LEFT JOIN ne_gbif_by_col g ON g.col_id = u.col_id`;
      const univRows = (await conn.runAndReadAll(univSql, where.params)).getRowObjects();
      for (const r of univRows) {
        // Slim NE row — only the 13 populated fields. The other 16 (assessment-only:
        // assessment_id/date, trend, criteria, threats, systems, assessors, …) are always
        // null/empty/false for NE, so omitting them ~halves the payload + server
        // serialization (beetles ~262k rows: 178MB → ~90MB). The client handles their
        // absence exactly as the nulls it receives today (audited: every access is
        // optional-chained, falsy-checked, or NE-skipped).
        //
        // The row key is the CoL id itself (`col-…`). This list IS the CoL universe —
        // one row per col_id by construction, so the id it keys on is the id it was
        // selected by, and it identifies the same species no matter which query
        // produced the row. That last property is load-bearing and used not to hold:
        // when the key was a per-query decrementing counter, a species fetched once
        // under "Mammals" and again scoped to "Rodentia" got a different key each time
        // (every query restarted from -2,000,000,000) while two unrelated species could
        // collide on one — and RedListView's speciesDetails cache, keyed on it and never
        // revalidated, then rendered the second species under the first's cached photo
        // and common name (a Giraffe thumbnail on Fictidomys parvidens, after drilling
        // from Mammals into Rodentia). Hashing col_id fixed that; using col_id directly
        // makes it true by construction.
        //
        // taxon_group is the REAL CoL group (sub-group filter), taxon_id forced to the
        // requested taxon (top-level filter); GBIF key/count/countries/common_name
        // overlaid when the species is GBIF-observed.
        result.push({
          species_key: colRowKey(String(r.col_id)),
          sis_taxon_id: null,
          col_id: (r.col_id as string) ?? null,
          scientific_name: r.scientific_name ?? "",
          common_name: r.common_name ?? null,
          family: r.family ?? null,
          category: "NE",
          countries: splitList(r.countries),
          class_name: r.class_name ?? null,
          order_name: r.order_name ?? null,
          taxon_group: String(r.taxon_group),
          taxon_id: taxonId,
          described_year: num(r.described_year),
          gbif_species_key: str(r.gbif_species_key),
          gbif_occurrence_count: num(r.gbif_occurrence_count),
        } as unknown as ReturnType<typeof toSpeciesRow>);
      }
    }
  }

  if (opts.offset) result = result.slice(opts.offset);
  if (opts.limit != null) result = result.slice(0, opts.limit);
  return { species: result, truncated, tooLarge, neTotal };
}

// ─── Cross-taxa search ──────────────────────────────────────────────────────

export interface SearchResult {
  /**
   * The row key this result selects in the species table (see lib/species-row-key).
   * Null when the species has neither identity the table can address — a GBIF-observed
   * species with no CoL link (~9.2k of them). Those still search, and still open their
   * own /mapping page; they just can't be pointed at a row, because the NE list is the
   * CoL universe and they aren't in it.
   */
  species_key: SpeciesRowKey | null;
  sis_taxon_id: number | null;
  col_id: string | null;
  scientific_name: string;
  common_name: string | null;
  taxon_id: string;
  taxon_group: string;
  category: string;
  gbif_species_key: string | null;
  // Carried so the single-species preview the dashboard renders from this result (before
  // — or instead of — the taxon's own list arriving) shows the species' real occurrence
  // count rather than a blank cell.
  gbif_occurrence_count: number | null;
  assessment_id: number | null;
  assessment_date: string | null;
  countries: string[];
  class_name: string | null;
  order_name: string | null;
  family: string | null;
  // The taxonomy node this species should be browsed in — the sub-group the dashboard
  // selects alongside taxon_id, so the view opens on the species' own lineage rather than
  // the whole top-level taxon. See nodeIdForSpecies.
  node_id: string | null;
  // Set when the result was matched via a synonym (the old name the user typed) rather than
  // its accepted name — the dropdown shows "(syn. <name>)". scientific_name is the accepted name.
  matched_synonym?: string | null;
}

interface Lineage { class_name?: string | null; order_name?: string | null; family?: string | null }

// The node a search result should open in — the deepest one the species demonstrably
// belongs to, down to its family. Selecting that instead of the bare top-level taxon is
// what puts the species' whole lineage on screen (Invertebrates → Insects → Lepidoptera →
// Nymphalidae), since the taxa table renders the ancestor chain of whatever is selected.
//
// findViewLeafForGroup gives the group's own "By Taxon" container node (Arachnids, Velvet
// Worms, Mammals…), never a Specialist Group; below that, a dynamic drilldown id names the
// class/order/family the species sits in. Every rank above the deepest segment has to be
// present in the id — dynamicNodeAncestors/nextDynamicRank read depth positionally — so a
// gap in the lineage forces a choice, and the two cases want opposite answers:
//
//   • Optional depth (the group's own node is loadable). Stop at the last CONTIGUOUS known
//     rank. A velvet worm has no order in CoL, so drilling to its family would render
//     "Velvet Worms → Unclassified Order → Peripatidae" — a worse landing spot than the
//     Velvet Worms node it would otherwise get. Better to show less than to show a hole.
//   • Required depth (the group's own node is over NE_CAP — Insects, ~935k NE — so the
//     view can only offer the "too many to load at once" prompt there, #453). Then a gap
//     is worth wearing: fill it with "", the same Unclassified-bucket convention
//     resolveTaxonSuggestionNode uses, and reach a node that can actually list the species.
//
// genus is never enumerated: the species itself is the target, so a genus node buys nothing
// over its family while being one more level to climb out of. (That's the only reason left —
// resolveWhere's arbitrary-rank branch and suggestTaxa both handle genus now; this is a
// deliberate landing-spot choice, not a capability gap.)
export function nodeIdForSpecies(taxonGroup: string, lineage: Lineage): string | null {
  const leafRoot = findViewLeafForGroup(taxonGroup);
  if (!leafRoot) return null;
  // A root with no live drilldown has no dynamic ids to offer — its own node is the answer.
  if (!isLiveDrilldownNode(leafRoot)) return leafRoot;

  const valueFor: Partial<Record<DynamicSegment["rank"], string | null | undefined>> = {
    class: lineage.class_name, order: lineage.order_name, family: lineage.family,
  };
  const ranks = rankOrderFor(leafRoot).filter((r) => r !== "genus");
  const idFor = (depth: number) => buildDynamicNodeId(leafRoot, ranks.slice(0, depth).map((rank) => ({
    rank, value: (valueFor[rank] ?? "").toLowerCase(),
  })));

  let contiguous = 0;
  while (contiguous < ranks.length && valueFor[ranks[contiguous]]) contiguous++;
  if (contiguous > 0) return idFor(contiguous);

  // Nothing known from the top rank down. Fall back to the group's own node unless it's
  // unlistable, in which case take the deepest known rank with the gaps coalesced.
  const rootNe = getTaxonGroupsForNode(leafRoot).reduce((sum, g) => sum + (neByGroup().get(g) ?? 0), 0);
  if (rootNe <= NE_CAP) return leafRoot;
  let deepest = -1;
  ranks.forEach((r, i) => { if (valueFor[r]) deepest = i; });
  return deepest === -1 ? leafRoot : idFor(deepest + 1);
}

/**
 * CoL ids for GBIF species keys, via species_link — the bridge build-matching writes.
 *
 * The search fast path reads unassessed.parquet, which is one row per GBIF species
 * key and carries no col_id; the NE list it has to agree with is one row per col_id.
 * The two grains genuinely differ (3,756 col_ids have more than one GBIF key), so a
 * search hit's row key has to come from the link table rather than from its GBIF key.
 * Assuming key == col_id would be wrong for ~4.3k species even though it holds for
 * 99.4% of them.
 *
 * Batched by the keys actually matched (a handful per search), so this reads two
 * columns of species_link filtered to those keys rather than scanning it whole.
 */
async function colIdsForGbifKeys(conn: DuckDBConnection, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  const list = keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",");
  const rows = (await conn.runAndReadAll(
    `SELECT gbif_species_key, col_id FROM read_parquet('${parquetUri("species_link.parquet")}')
     WHERE src = 'gbif' AND col_id IS NOT NULL AND gbif_species_key IN (${list})`, {})).getRowObjects();
  for (const r of rows) out.set(String(r.gbif_species_key), String(r.col_id));
  return out;
}

// ─── The search hot path's in-memory index ──────────────────────────────────
//
// Every keystroke past the debounce is a fresh serverless request, and each one used
// to re-scan the name columns of assessed+unassessed straight off R2 — ~25MB pulled
// and decompressed per request, with no pruning possible (a substring ILIKE can't use
// row-group statistics, and both parquets are written ORDER BY class_name, order_name,
// family, so names are scattered across every row group anyway — see build-parquet).
// Measured against production: ~2.2s per uncached query, essentially all of it this
// scan, with searchSpecies and suggestTaxa serialized behind one another on the shared
// connection. A cold no-match, which falls through to species/** and synonym-index,
// measured 13.7s.
//
// The data is immutable for the life of the deploy (latest-sync.txt is repo-tracked, so
// a new sync IS a new deploy), so the scan is the same work every time. Materialize it
// once per warm container instead: ~1.9s and ~220MB to build, after which a search is a
// memory scan — measured 17ms for the species query and 3ms for the rank suggestions.
// /api/search/warm (called on page load) triggers the build so the first real keystroke
// finds it ready.
//
// Deliberately best-effort: if the build fails (memory pressure being the plausible
// cause), searchSource/rankSource fall back to reading the parquets exactly as before,
// so search degrades to its old latency rather than breaking. Reset on failure so a
// transient R2 error can retry, matching ensureNeHelpers.
//
// The projections are shared with the fallback path, so the temp table and the parquets
// present an identical schema and one query text works against either.
const searchProj = (src: string, assessed: boolean) => `
  SELECT id, scientific_name, common_name,
         lower(scientific_name) AS sn_lo, lower(common_name) AS cn_lo,
         taxon_group, iucn_category AS category, gbif_species_key, gbif_occurrence_count,
         ${assessed ? "assessment_id, CAST(assessment_date AS VARCHAR) AS assessment_date" : "NULL AS assessment_id, NULL AS assessment_date"},
         countries, class_name, order_name, family, ${assessed} AS assessed
  FROM '${parquetUri(src)}'`;

// One DISTINCT (name, rank-priority, taxon_group) triple per rank value, which is all
// suggestTaxa's prefix match needs — 116k rows, a rounding error next to search_idx.
// Only reached when rank-index.parquet isn't in the sync prefix; the aggregation that
// consumes it then reproduces what that file bakes in at build time.
const rankProj = (src: string) => SUGGEST_RANKS.map((rank, rp) => `
  SELECT DISTINCT ${RANK_TO_MATCH_SQL[rank]} AS name, ${rp} AS rp, taxon_group
  FROM '${parquetUri(src)}'
  WHERE ${rank === "genus" ? "scientific_name IS NOT NULL" : `${RANK_TO_MATCH_SQL[rank]} IS NOT NULL`}`
).join(" UNION ALL ");

let searchTablesPromise: Promise<void> | null = null;
export function ensureSearchTables(conn: DuckDBConnection): Promise<void> {
  if (!searchTablesPromise) {
    searchTablesPromise = (async () => {
      await conn.run(`CREATE TEMP TABLE search_idx AS
        ${searchProj("assessed.parquet", true)} UNION ALL ${searchProj("unassessed.parquet", false)}`);
      await conn.run(`CREATE TEMP TABLE rank_idx AS
        SELECT DISTINCT * FROM (${rankProj("assessed.parquet")} UNION ALL ${rankProj("unassessed.parquet")})`);
    })().catch((e) => { searchTablesPromise = null; throw e; });
  }
  return searchTablesPromise;
}

/** The materialized index when it's available, else the parquets inline (same schema). */
async function searchSource(conn: DuckDBConnection): Promise<string> {
  try {
    await ensureSearchTables(conn);
    return "search_idx";
  } catch (e) {
    console.error("search_idx unavailable, falling back to parquet scan:", e);
    return `(${searchProj("assessed.parquet", true)} UNION ALL ${searchProj("unassessed.parquet", false)})`;
  }
}

/** As searchSource, for the rank-name suggestions. */
async function rankSource(conn: DuckDBConnection): Promise<string> {
  try {
    await ensureSearchTables(conn);
    return "rank_idx";
  } catch {
    return `(${rankProj("assessed.parquet")} UNION ALL ${rankProj("unassessed.parquet")})`;
  }
}

/** A search hit's parquet/temp-table row → the shape the dropdown renders. */
function toSearchResult(r: Record<string, unknown>, colIdOverride: string | null): SearchResult {
  const tg = String(r.taxon_group);
  const lineage = { class_name: str(r.class_name), order_name: str(r.order_name), family: str(r.family) };
  // assessed.parquet's id column IS the SIS taxon id; unassessed.parquet's is an
  // internal build-time key that never leaves the pipeline (see build-parquet).
  const sisTaxonId = r.assessed ? Number(r.id) : null;
  const colId = r.assessed ? null : colIdOverride;
  // Both views browse via the top-level taxon, plus the sub-group node the species
  // itself sits in — see nodeIdForSpecies.
  return {
    species_key: sisTaxonId != null ? sisRowKey(sisTaxonId) : colId ? colRowKey(colId) : null,
    sis_taxon_id: sisTaxonId,
    col_id: colId,
    scientific_name: String(r.scientific_name ?? ""),
    common_name: (r.common_name as string) ?? null,
    taxon_id: mapTaxonId(tg),
    taxon_group: tg,
    category: String(r.category ?? ""),
    gbif_species_key: str(r.gbif_species_key),
    gbif_occurrence_count: num(r.gbif_occurrence_count),
    assessment_id: num(r.assessment_id),
    assessment_date: (r.assessment_date as string) ?? null,
    countries: splitList(r.countries),
    ...lineage,
    node_id: nodeIdForSpecies(tg, lineage),
  };
}

// One entry per species, in the order the hits arrived. unassessed.parquet is one row per
// GBIF species key, and CoL lumps some of those: 3,756 col_ids carry more than one key, so
// a name like Abutilon halophilum matched twice (keys VLWL9 and 8N4F) and listed twice in
// the dropdown — two rows that now resolve to the same species and would select the same
// table row. The NE list already shows one row per col_id (ne_gbif_by_col groups by it), so
// collapsing here is what makes search agree with the list it selects into. Keep the
// best-observed key of the group, which is the most useful one to preview from; ties keep
// the first, which is the better-ranked one. The name index adds a second way to arrive at
// the same species (a hit on its scientific name AND its epithet, say), and this collapses
// that too. Null keys are never collapsed — those species have no shared identity to merge on.
function dedupeByRowKey(hits: SearchResult[]): SearchResult[] {
  const bestByKey = new Map<string, SearchResult>();
  for (const r of hits) {
    if (!r.species_key) continue;
    const prev = bestByKey.get(r.species_key);
    if (!prev || (r.gbif_occurrence_count ?? -1) > (prev.gbif_occurrence_count ?? -1)) {
      bestByKey.set(r.species_key, r);
    }
  }
  return hits.filter((r) => !r.species_key || bestByKey.get(r.species_key) === r);
}

// Tier 0: prefix hits from the name-sorted index (scripts/build-search-index.ts).
//
// name-index.parquet is one row per searchable name — scientific name, common name,
// epithet, and each word of a multi-word common name — sorted by that name, so this
// range predicate prunes to the row group or two the prefix falls in (~1MB read of a
// ~97MB file) instead of scanning both species parquets whole. It carries the full
// SearchResult payload including col_id, so a hit needs no second read of any kind.
//
// This is what makes a *cold* container fast: unlike the substring tier below it needs
// no materialized table, so it answers in ~10ms whether or not warm-up has finished.
//
// Ranking is the substring tier's ORDER BY verbatim — see the comment on it below.
//
// Returns [] (never throws) when the index isn't in this sync prefix — an older sync
// still searches, just via the tiers below.
async function prefixSearch(conn: DuckDBConnection, q: string, lim: number): Promise<SearchResult[]> {
  try {
    const rows = (await conn.runAndReadAll(
      `SELECT * FROM read_parquet('${parquetUri("name-index.parquet")}')
       WHERE name_lo >= $q AND name_lo < $q || chr(1114111)
       -- Character-for-character the substring tier's ORDER BY, evaluated against the
       -- same two names (the index carries both), so a hit ranks exactly where it would
       -- have. Not a tier ladder over name_kind: these are three INDEPENDENT booleans,
       -- and the third one reorders inside the second — a species matching on both its
       -- common and scientific name outranks one matching only its common name. Ranking
       -- off name_kind instead put Elephant Trunk Snake above Elephant's Foot for
       -- "elephant", which is the old order inverted.
       ORDER BY (lower(common_name) = $q) DESC,
                (lower(common_name) LIKE $q || '%') DESC,
                (lower(scientific_name) LIKE $q || '%') DESC,
                lower(scientific_name)
       -- Over-fetched: several name rows can collapse to one species below.
       LIMIT ${lim * 3 + 5}`, { q })).getRowObjects();
    return dedupeByRowKey(rows.map((r) => toSearchResult(r, str(r.col_id)))).slice(0, lim);
  } catch {
    return [];
  }
}

// Substring search over the materialized index above (which replaced the in-memory
// search-index.json, then the per-request parquet scan). Ranking mirrors the old JSON
// path: exact common-name > common-name prefix > scientific prefix > alpha.
//
// Tiered, cheapest first, each tier gated on every tier above it finding nothing at all:
// prefix hits (one pruned range read) → substring hits (the in-memory index) → the CoL
// universe (species/) → synonyms. The gate is what keeps a precise query like "Panthera
// leo" from ever touching the heavy tiers.
export async function searchSpecies(query: string, limit = 10): Promise<SearchResult[]> {
  if (query.length < 2) return [];
  const conn = await getConn();
  const lim = Math.min(Math.max(limit, 1), 50);

  const prefixHits = await prefixSearch(conn, query.toLowerCase(), lim);
  if (prefixHits.length > 0) return prefixHits;

  // sn_lo/cn_lo are lowercased once at build time, so the match is a plain LIKE against
  // an already-lowercased $q rather than a per-row ILIKE case-fold.
  const sql = `
    SELECT * FROM ${await searchSource(conn)}
    WHERE sn_lo LIKE '%' || $q || '%'
       OR (cn_lo IS NOT NULL AND cn_lo LIKE '%' || $q || '%')
    ORDER BY (cn_lo = $q) DESC,
             (cn_lo LIKE $q || '%') DESC,
             (sn_lo LIKE $q || '%') DESC,
             sn_lo
    LIMIT ${lim}`;
  const rows = (await conn.runAndReadAll(sql, { q: query.toLowerCase() })).getRowObjects();
  // An unassessed hit is keyed by the col_id its GBIF key links to, which is what the
  // NE list keys its rows on — resolved for the whole page of hits in one lookup.
  const neKeys = rows.filter((r) => !r.assessed).map((r) => str(r.gbif_species_key)).filter((k): k is string => !!k);
  const colIdByGbifKey = await colIdsForGbifKeys(conn, neKeys);
  const fast = dedupeByRowKey(rows.map((r) =>
    toSearchResult(r, colIdByGbifKey.get(str(r.gbif_species_key) ?? "") ?? null)));

  // Return as soon as the direct search finds anything. The CoL-only and synonym tiers
  // below each full-scan a large parquet over R2 (species/ ~36MB, synonym-index ~82MB)
  // with no pruning — 13.7s measured on a cold function. They exist to *answer* queries
  // the direct search can't (an old/synonym name, or a CoL-only species), not to pad
  // results, so only run them when everything above came up empty.
  if (fast.length > 0) return fast;

  // CoL-only fallback: universe species (species/) that are neither IUCN-assessed nor
  // GBIF-observed. species/ has no common name and can't partition-prune on name, so this
  // full-scans the name column — gated above on the direct search returning nothing, so it
  // holds ALL assessed+GBIF matches (none), and any species/ match is genuinely CoL-only
  // (name-dedup suffices, no species_link anti-join needed). Render as NE → leaf taxon.
  const seen = new Set(fast.map((r) => r.scientific_name.toLowerCase()));
  const colSql = `
    SELECT col_id, scientific_name, taxon_group, class_name, order_name, family
    FROM read_parquet('${parquetUri("species/**/*.parquet")}', hive_partitioning=true)
    WHERE scientific_name ILIKE '%' || $q || '%' AND in_base AND extinct IS NOT TRUE
      AND col_id NOT IN ${EXCLUDED_COL_IDS_SQL}
    ORDER BY (lower(scientific_name) LIKE $q || '%') DESC, lower(scientific_name)
    LIMIT ${(lim - fast.length) * 3 + 5}`;
  const colRows = (await conn.runAndReadAll(colSql, { q: query.toLowerCase() })).getRowObjects();
  for (const r of colRows) {
    const name = String(r.scientific_name ?? "");
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const tg = String(r.taxon_group);
    const lineage = { class_name: str(r.class_name), order_name: str(r.order_name), family: str(r.family) };
    fast.push({
      species_key: colRowKey(String(r.col_id)),
      sis_taxon_id: null,
      col_id: String(r.col_id),
      scientific_name: name,
      common_name: null,
      taxon_id: mapTaxonId(tg),
      taxon_group: tg,
      category: "NE",
      gbif_species_key: null,
      gbif_occurrence_count: null,
      assessment_id: null,
      assessment_date: null,
      countries: [],
      ...lineage,
      node_id: nodeIdForSpecies(tg, lineage),
    });
    if (fast.length >= lim) break;
  }
  if (fast.length >= lim) return fast;

  // Synonym tier: resolve an old/synonym name to its accepted species via synonym-index.parquet
  // (name-sorted → prefix-range prunes to ~1 row group). Reached only when the direct search
  // found nothing (gated above). The accepted species routes like a direct hit — assessed →
  // reassessments (sis id), NE → new-assessments/its own node — and carries the matched synonym
  // for the UI. Graceful no-op if the index isn't in this sync prefix.
  const synUri = parquetUri("synonym-index.parquet");
  const synLo = `'${query.toLowerCase().replace(/'/g, "''")}'`;
  const need = lim - fast.length;
  const synCols = `synonym_name, accepted_name, accepted_col_id, taxon_group, sis_id, category`;
  try {
    let synRows = (await conn.runAndReadAll(
      `SELECT ${synCols} FROM read_parquet('${synUri}')
       WHERE synonym_name_lower >= ${synLo} AND synonym_name_lower < ${synLo} || chr(1114111)
       ORDER BY synonym_name_lower LIMIT ${need * 3 + 5}`, {})).getRowObjects();
    // Substring backstop (the query appears mid-name, not as a prefix) full-scans the whole
    // 77MB index over R2 with no pruning, so only fall back to it when the prefix-range found
    // nothing at all — not merely when it returned fewer than `need`.
    if (synRows.length === 0) {
      synRows = (await conn.runAndReadAll(
        `SELECT ${synCols} FROM read_parquet('${synUri}')
         WHERE synonym_name_lower LIKE '%' || ${synLo} || '%' AND synonym_name_lower NOT LIKE ${synLo} || '%'
         ORDER BY synonym_name_lower LIMIT ${need * 3 + 5}`, {})).getRowObjects();
    }
    // synonym-index.parquet carries no lineage columns, so NE hits get theirs (and with it
    // their node_id) from one follow-up lookup below rather than a per-row query.
    const needLineage: { result: SearchResult; colId: string }[] = [];
    for (const r of synRows) {
      const accName = String(r.accepted_name ?? "");
      if (seen.has(accName.toLowerCase())) continue; // accepted already listed (direct hit, or another synonym of it)
      seen.add(accName.toLowerCase());
      const tg = String(r.taxon_group);
      const cat = String(r.category ?? "NE");
      const sis = r.sis_id == null ? null : Number(r.sis_id);
      const colId = r.accepted_col_id == null ? null : String(r.accepted_col_id);
      const result: SearchResult = {
        species_key: sis != null ? sisRowKey(sis) : colId ? colRowKey(colId) : null,
        sis_taxon_id: sis,
        col_id: colId,
        scientific_name: accName,
        common_name: null,
        taxon_id: mapTaxonId(tg),
        taxon_group: tg,
        category: cat,
        gbif_species_key: null,
        gbif_occurrence_count: null,
        assessment_id: null,
        assessment_date: null,
        countries: [],
        class_name: null,
        order_name: null,
        family: null,
        node_id: nodeIdForSpecies(tg, {}),
        matched_synonym: String(r.synonym_name ?? ""),
      };
      fast.push(result);
      if (cat === "NE" && r.accepted_col_id != null) {
        needLineage.push({ result, colId: String(r.accepted_col_id) });
      }
      if (fast.length >= lim) break;
    }
    if (needLineage.length > 0) {
      // Exact col_id match, partition-pruned to the hits' own taxon_groups — cheap next to
      // the index scan that got us here. Best-effort: a miss just leaves the group-level
      // node_id already set above.
      const lineageRows = (await conn.runAndReadAll(
        `SELECT col_id, class_name, order_name, family
         FROM read_parquet('${parquetUri("species/**/*.parquet")}', hive_partitioning=true)
         WHERE taxon_group = ANY(string_split($tg, '|')) AND col_id = ANY(string_split($ids, '|'))`,
        { tg: needLineage.map((n) => n.result.taxon_group).join("|"),
          ids: needLineage.map((n) => n.colId).join("|") })).getRowObjects();
      const byColId = new Map(lineageRows.map((r) => [String(r.col_id), r]));
      for (const { result, colId } of needLineage) {
        const row = byColId.get(colId);
        if (!row) continue;
        result.class_name = str(row.class_name);
        result.order_name = str(row.order_name);
        result.family = str(row.family);
        result.node_id = nodeIdForSpecies(result.taxon_group, result);
      }
    }
  } catch { /* synonym index not in this sync prefix — skip */ }
  return fast;
}

// ─── Catalogue of Life: synonyms for a species ──────────────────────────────

export interface SpeciesSynonyms {
  col_id: string | null;
  accepted_name: string | null;
  accepted_authorship: string | null;
  synonyms: { name: string; authorship: string | null; status: string }[];
}

// Synonyms (+ accepted name/authorship) for one species, for the detail panel's CoL tab.
// Resolve the CoL col_id from either the col_id (NE rows carry it) or the sis id (assessed,
// via species_link), then one scan of backbone for `col_id = c` (the accepted) OR
// `parent_id = c` (its synonyms). backbone isn't indexed on these, so it full-scans — fine
// for a deliberate, cached detail-tab open (not the search hot path).
/**
 * One species by its GBIF/CoL key, with just what the standalone occurrence
 * page needs to render — name, taxon group, and the assessment context the map
 * colours and filters by. Deliberately narrow: that page exists to load fast,
 * and the dashboard's own species query reads far more than it needs.
 *
 * `assessed` distinguishes a real Red List assessment from an unassessed
 * species: the countries on an unassessed row are derived from GBIF, so they
 * must not be presented as an IUCN native range.
 */
export async function getSpeciesByGbifKey(gbifSpeciesKey: string): Promise<{
  scientific_name: string;
  common_name: string | null;
  taxon_group: string;
  category: string;
  gbif_species_key: string;
  assessment_id: number | null;
  assessment_date: string | null;
  sis_taxon_id: number | null;
  criteria: string | null;
  countries: string[];
  assessed: boolean;
  /** Taxonomic node this species sits under, as the dashboard's `taxa` URL
   *  token — the Not Evaluated view can't list anything without one. */
  node_id: string | null;
  /**
   * The dashboard's row key for this species, for its `species=` URL param —
   * `sis-<id>` when assessed, `col-<id>` when not. See lib/species-row-key.ts,
   * which owns what a row key is; this only supplies the two identities.
   */
  dashboard_row_key: SpeciesRowKey | null;
} | null> {
  const conn = await getConn();
  // sis_taxon_id isn't a column: assessed rows carry it as their positive `id`,
  // while unassessed rows get a synthetic negative one (see toSpeciesRow).
  const proj = (src: string, assessed: boolean) => `
    SELECT id, scientific_name, common_name, taxon_group, iucn_category AS category, gbif_species_key,
           class_name, order_name, family,
           ${assessed
             ? "assessment_id, CAST(assessment_date AS VARCHAR) AS assessment_date, criteria"
             : "NULL AS assessment_id, NULL AS assessment_date, NULL AS criteria"},
           countries, ${assessed} AS assessed
    FROM '${parquetUri(src)}'
    WHERE gbif_species_key = $key`;
  const sql = `${proj("assessed.parquet", true)} UNION ALL ${proj("unassessed.parquet", false)} LIMIT 1`;
  const rows = (await conn.runAndReadAll(sql, { key: gbifSpeciesKey })).getRowObjects();
  const r = rows[0];
  if (!r) return null;
  const sisTaxonId = Number(r.id) > 0 ? Number(r.id) : null;
  const colId = sisTaxonId
    ? null
    : (await colIdsForGbifKeys(conn, [str(r.gbif_species_key) ?? gbifSpeciesKey])).get(
        str(r.gbif_species_key) ?? gbifSpeciesKey
      ) ?? null;
  return {
    scientific_name: String(r.scientific_name ?? ""),
    common_name: (r.common_name as string) ?? null,
    taxon_group: String(r.taxon_group ?? ""),
    category: String(r.category ?? ""),
    gbif_species_key: str(r.gbif_species_key) ?? gbifSpeciesKey,
    assessment_id: num(r.assessment_id),
    assessment_date: (r.assessment_date as string) ?? null,
    sis_taxon_id: sisTaxonId,
    criteria: (r.criteria as string) ?? null,
    countries: splitList(r.countries),
    assessed: !!r.assessed,
    // Built by the one helper that decides what a row key is, rather than
    // derived here. The CoL id comes from species_link rather than from the
    // GBIF key: unassessed.parquet is one row per GBIF key and the NE list is
    // one row per col_id, and 3,756 col_ids carry more than one GBIF key, so
    // assuming they're the same value is wrong for ~4.3k species.
    dashboard_row_key: speciesRowKey({ sis_taxon_id: sisTaxonId, col_id: colId }),
    node_id: nodeIdForSpecies(String(r.taxon_group ?? ""), {
      class_name: str(r.class_name),
      order_name: str(r.order_name),
      family: str(r.family),
    }),
  };
}

/**
 * The assessed species behind a batch of GBIF keys, for the map's "recorded
 * nearby" panel — one scan for the whole facet rather than a request each.
 *
 * Assessed rows only. The panel exists to put one assessment's threats beside
 * another's, and an unassessed neighbour has none to offer; it would also have
 * no category to sort by and nothing to link to.
 *
 * Keys GBIF knows and this data doesn't are simply absent from the result. The
 * caller counts them (as `unmatched`) rather than treating the gap as an error:
 * GBIF indexes occurrences well beyond what the Red List has assessed, so a
 * miss is the normal case, not a fault.
 */
export async function getAssessedByGbifKeys(keys: readonly string[]): Promise<
  {
    gbif_species_key: string;
    scientific_name: string;
    common_name: string | null;
    taxon_group: string;
    class_name: string | null;
    category: string;
    criteria: string | null;
    threat_codes: string[];
    /** Year of the assessment itself, not of its publication — the same field
     *  the dashboard's "outdated" test reads (species-filter.ts). */
    assessment_year: number | null;
    /** The assessment behind the row, so its narrative can be fetched. */
    assessment_id: number | null;
    sis_taxon_id: number | null;
    dashboard_row_key: SpeciesRowKey | null;
  }[]
> {
  if (!keys.length) return [];
  const conn = await getConn();
  const list = keys.map((k) => `'${String(k).replace(/'/g, "''")}'`).join(",");
  const rows = (
    await conn.runAndReadAll(`
      SELECT id, gbif_species_key, scientific_name, common_name, taxon_group,
             class_name, iucn_category AS category, criteria, threat_codes,
             assessment_id, CAST(assessment_date AS VARCHAR) AS assessment_date
      FROM '${parquetUri("assessed.parquet")}'
      WHERE gbif_species_key IN (${list})`)
  ).getRowObjects();
  return rows.map((r) => {
    const sisTaxonId = Number(r.id) > 0 ? Number(r.id) : null;
    return {
      gbif_species_key: str(r.gbif_species_key) ?? "",
      scientific_name: String(r.scientific_name ?? ""),
      common_name: (r.common_name as string) ?? null,
      taxon_group: String(r.taxon_group ?? ""),
      class_name: str(r.class_name),
      category: String(r.category ?? ""),
      criteria: (r.criteria as string) ?? null,
      // ";"-separated in the parquet, written by fetch-redlist-species.
      threat_codes: String(r.threat_codes ?? "").split(";").filter(Boolean),
      // Free to carry: the row is already being read, so this is two more
      // columns off the same scan rather than another query.
      assessment_year: yearOf(r.assessment_date as string | null),
      assessment_id: num(r.assessment_id),
      sis_taxon_id: sisTaxonId,
      // Assessed rows always have a SIS id, so the col_id half of a row key is
      // never needed here — which is what keeps this to a single scan.
      dashboard_row_key: speciesRowKey({ sis_taxon_id: sisTaxonId, col_id: null }),
    };
  });
}

/** Leading year of an ISO-ish date, or null. */
function yearOf(date: string | null): number | null {
  const y = date ? parseInt(date.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) ? y : null;
}

export async function getSynonyms(opts: { col?: string | null; sis?: number | null }): Promise<SpeciesSynonyms> {
  const conn = await getConn();
  let colId = opts.col ?? null;
  if (!colId && opts.sis != null) {
    const linkUri = parquetUri("species_link.parquet");
    const r = (await conn.runAndReadAll(
      `SELECT col_id FROM read_parquet('${linkUri}') WHERE src='redlist' AND id=$id AND col_id IS NOT NULL LIMIT 1`,
      { id: opts.sis })).getRowObjects();
    colId = r.length ? String(r[0].col_id) : null;
  }
  if (!colId) return { col_id: null, accepted_name: null, accepted_authorship: null, synonyms: [] };

  const bbUri = parquetUri("backbone.parquet");
  const rows = (await conn.runAndReadAll(
    `SELECT col_id, scientific_name, authorship, status FROM read_parquet('${bbUri}')
     WHERE col_id=$c OR parent_id=$c`, { c: colId })).getRowObjects();
  let accepted_name: string | null = null, accepted_authorship: string | null = null;
  const synonyms: SpeciesSynonyms["synonyms"] = [];
  for (const r of rows) {
    if (String(r.col_id) === colId) {
      accepted_name = String(r.scientific_name ?? "");
      accepted_authorship = (r.authorship as string) ?? null;
    } else if (r.status === "synonym" || r.status === "ambiguous synonym") {
      synonyms.push({ name: String(r.scientific_name ?? ""), authorship: (r.authorship as string) ?? null, status: String(r.status) });
    }
  }
  synonyms.sort((a, b) => a.name.localeCompare(b.name));
  return { col_id: colId, accepted_name, accepted_authorship, synonyms };
}

// The fallback tiers searchSpecies reaches only when nothing matched — species/**
// (a hive glob over many files) and synonym-index.parquet (~82MB, and the substring
// backstop can't prune it). Nothing about them can be usefully materialized: measured
// at ~590MB of temp table for the pair, an order of magnitude worse than search_idx
// buys. What made them hurt was paying the *first* read per container: a cold no-match
// measured 13.7s in production, while every later one on that same instance was 2.2s,
// because DuckDB's external file cache had the footers and the glob listing by then.
//
// So prime rather than materialize: run each tier's query once for a string no name can
// contain, which walks exactly the paths a real no-match walks and leaves the file cache
// populated, at zero steady memory. Errors are swallowed — this is pure warm-up, and a
// sync prefix without a synonym index is already a supported state (see searchSpecies).
let primePromise: Promise<void> | null = null;
function primeFallbackTiers(conn: DuckDBConnection): Promise<void> {
  if (!primePromise) {
    primePromise = (async () => {
      const NO_MATCH = "zzq~unmatchable~qzz";
      await conn.run(`SELECT col_id FROM read_parquet('${parquetUri("species/**/*.parquet")}', hive_partitioning=true)
        WHERE scientific_name ILIKE '%${NO_MATCH}%' AND in_base AND extinct IS NOT TRUE LIMIT 1`).catch(() => {});
      await conn.run(`SELECT synonym_name FROM read_parquet('${parquetUri("synonym-index.parquet")}')
        WHERE synonym_name_lower LIKE '%${NO_MATCH}%' LIMIT 1`).catch(() => {});
    })();
  }
  return primePromise;
}

// Prime the cached connection (httpfs load + S3 config), build the in-memory search
// index, and walk the no-match fallback tiers once, so no user request pays any of it.
// Called by /api/search/warm on page load; the route awaits it but nothing waits on the
// route, and a search arriving mid-warm just awaits the same ensureSearchTables promise
// rather than starting a second build.
export async function warmConnection(): Promise<void> {
  const conn = await getConn();
  await conn.run("SELECT 1");
  await ensureSearchTables(conn);
  await primeFallbackTiers(conn);
}

// Lazy per-species assessment history (index 0 = latest), fetched when a detail
// panel opens. assessments.parquet is sorted by sis_taxon_id, so this prunes to
// a single row group.
export async function getAssessmentHistory(sisTaxonId: number): Promise<PreviousAssessment[]> {
  const conn = await getConn();
  // SELECT * rather than naming `criteria` explicitly: assessments.parquet is
  // rebuilt by a separate scheduled sync (scripts/build-parquet.ts), not by this
  // deploy, so there's a window where the deployed code expects a column the
  // currently-synced parquet doesn't have yet. Naming it would throw a DuckDB
  // Binder Error for every request in that window — this deploy's whole history
  // fetch failing (not just criteria) until the next sync catches up. `pa.criteria`
  // below is simply undefined/null on old data instead.
  const sql = `
    SELECT *
    FROM '${parquetUri("assessments.parquet")}'
    WHERE sis_taxon_id = $id
    ORDER BY seq`;
  const rows = (await conn.runAndReadAll(sql, { id: sisTaxonId })).getRowObjects();
  return rows.map((pa) => ({
    id: Number(pa.id),
    year: String(pa.year ?? ""),
    category: String(pa.category ?? ""),
    date: (pa.date as string) ?? null,
    criteria: (pa.criteria as string) ?? null,
    assessors: (pa.assessors as string) ?? null,
    reviewers: (pa.reviewers as string) ?? null,
    facilitators: (pa.facilitators as string) ?? null,
    contributors: (pa.contributors as string) ?? null,
    institutions: (pa.institutions as string) ?? null,
  }));
}

// ─── CoL backbone: arbitrary-rank species listing (#271, Phase 3) ────────────

export interface BackboneSpecies { col_id: string; scientific_name: string; }

// All CoL accepted species under any taxon, matched at ANY rank (kingdom →
// genus) against the denormalized lineage — e.g. ?taxon=Felidae lists every cat
// species in the tree of life, most of them Not Evaluated. The hand-curated tree
// can only drill into predefined nodes; this works for any taxon CoL knows.
// (Uses the denormalized lineage columns, not the parent_id chain — the raw CoL
// parent tree skips/collapses ranks, so lineage is the reliable basis.)
export async function getSpeciesUnder(taxon: string, limit = 50): Promise<{
  taxon: string; matched_rank: string | null; total: number; sample: BackboneSpecies[];
}> {
  const conn = await getConn();
  const sp = `read_parquet('${parquetUri("species/**/*.parquet")}', hive_partitioning=true)`;
  const t = taxon.toLowerCase();
  // Arbitrary-rank lineage match over the extant universe. species/ is partitioned by
  // taxon_group, not by clade, so an arbitrary rank can't prune — it full-scans. (This
  // is a power-user endpoint not wired into the UI; the hot path is querySpecies.)
  const where = `$t IN (kingdom, phylum, class_name, order_name, family, genus) AND in_base AND extinct IS NOT TRUE`;
  const params: Record<string, string> = { t };
  const lim = Math.min(Math.max(limit, 1), 200);
  const head = (await conn.runAndReadAll(
    `SELECT count(*) AS total,
            min(CASE WHEN genus=$t THEN 'genus' WHEN family=$t THEN 'family' WHEN order_name=$t THEN 'order'
                     WHEN class_name=$t THEN 'class' WHEN phylum=$t THEN 'phylum' WHEN kingdom=$t THEN 'kingdom' END) AS matched_rank
     FROM ${sp} WHERE ${where}`, params,
  )).getRowObjects();
  const total = Number(head[0].total);
  if (total === 0) return { taxon, matched_rank: null, total: 0, sample: [] };
  const rows = (await conn.runAndReadAll(
    `SELECT col_id, scientific_name FROM ${sp} WHERE ${where} ORDER BY scientific_name LIMIT ${lim}`, params,
  )).getRowObjects();
  return {
    taxon, matched_rank: (head[0].matched_rank as string) ?? null, total,
    sample: rows.map((r) => ({ col_id: String(r.col_id), scientific_name: String(r.scientific_name) })),
  };
}

// ─── Higher-rank taxon suggestions (search-bar autocomplete) ─────────────────

export interface TaxonSuggestion {
  /** Prettified display name, e.g. "Felidae". */
  name: string;
  /** Rank the query matched at — the same four ranks the live drilldown enumerates
   *  (dynamic-taxon.ts's DynamicRank), so every suggestion names a taxon a user could
   *  also have reached by clicking down the tree. */
  rank: DynamicRank;
  /** Lowercased token to pass as ?taxa= (what resolveWhere/querySpecies match on) —
   * kept as the fallback when nodeId can't be resolved. */
  taxon: string;
  /** A curated by-taxon node id or a synthetic dynamic drilldown id (e.g.
   * "reptiles~order:squamata", or a multi-segment "crustaceans~class:malacostraca~
   * order:isopoda") this rank+value resolves to, or null if neither — in which case
   * the caller falls back to the old bare `taxon` browse. Resolving to a real node
   * means the caller can select it as a sub-group (selectedSubgroups) instead of an
   * arbitrary ?taxa= token, so TaxaSummary's ancestor-breadcrumb rows and the
   * per-taxon stat card both pick it up for free (see resolveTaxonSuggestionNode).
   * Deliberately never an SSC Specialist Group node — those are a second, independent
   * lens over the same species (see taxonomy-tree.ts's "SSC SPECIALIST GROUPS"
   * section) reachable only via SSC groups mode, not a substitute for the plain
   * by-taxon node a tree-click would reach. */
  nodeId: string | null;
}

// SSC Specialist Group nodes (taxonomy-tree.ts's "ssc-groups"/"ssc-reptile-groups"/etc.
// containers and their children) all use the "ssc-" id prefix by convention; the
// ancestor-chain check is a defensive backstop in case a future group's id doesn't
// follow it. suggestTaxa must never resolve a search hit to one of these — see
// TaxonSuggestion.nodeId's doc comment.
function isSscGroupNode(id: string): boolean {
  if (id.startsWith("ssc-")) return true;
  return getAncestors(id).some((a) => a.startsWith("ssc-"));
}

// rank+value → a curated by-taxon node whose filter is EXACTLY that one class/order/family
// dimension (a single value, no other filters/exclusions), excluding SSC Specialist Group
// nodes — the same node a user reaches by clicking through the default tree, so a search
// jump to it gets full ancestor breadcrumbs and curated labels for free. Mirrors
// findViewLeafForGroup's single-dimension-match pattern below.
//
// Deliberately NOT extended to genus when genus search was added: every single-genus node
// in the tree today is an SSC Specialist Group (African Elephant → genera:["loxodonta"],
// Anoline Lizard → genera:["anolis"], …), which TaxonSuggestion.nodeId must never resolve
// to. The `f.genera` guard below already skips them; a genus match therefore always takes
// the dynamic-drilldown path in resolveTaxonSuggestionNode, landing on the same
// "…~family:felidae~genus:panthera" node a tree drill-down reaches.
const RANK_VALUE_TO_NODE: Map<string, string> = (() => {
  const m = new Map<string, string>();
  const DIMS = ["classNames", "orderNames", "families"] as const;
  for (const [id, node] of NODE_INDEX) {
    if (isSscGroupNode(id)) continue;
    const f = node.filter;
    const dims = DIMS.filter((k) => f[k]?.length);
    if (dims.length !== 1 || f[dims[0]]!.length !== 1) continue;
    if (f.excludeClasses || f.excludeOrders || f.excludeFamilies || f.genera || f.excludeGenera ||
        f.speciesNames || f.excludeSpeciesNames || f.extraSpeciesNames) continue;
    const rank = dims[0] === "classNames" ? "class" : dims[0] === "orderNames" ? "order" : "family";
    const key = `${rank}:${f[dims[0]]![0]}`;
    if (!m.has(key)) m.set(key, id);
  }
  return m;
})();

// What each rank matches on in assessed/unassessed.parquet. class/order/family are real
// columns (pre-lowercased at build time); genus has no column of its own and is derived
// from scientific_name — see GENUS_SQL.
const RANK_TO_MATCH_SQL: Record<DynamicRank, string> = {
  class: "class_name", order: "order_name", family: "family", genus: GENUS_SQL,
};

// Same single-dimension-match search as GROUP_TO_LEAF_NODE above, but prefers a group's
// "inv-"/"pl-"/"fu-"-prefixed virtual-duplicate id over its bare one when both exist for
// the same taxonGroup (insects/molluscs/crustaceans/etc. — see dynamic-taxon.ts's
// DYNAMIC_DRILLDOWN_ROOTS comment). The prefixed id is the one actually nested under
// invertebrates/plantae/fungi in the default "By Taxon" view that TaxaSummary's
// ancestor-breadcrumb rendering and this search feature both operate within; the bare id
// is Table1a mode's separate flat id, whose own ancestor is "all" directly (not
// invertebrates/plantae/fungi) — a dynamic id built off it resolves to the right species
// (taxonGroups is identical either way) but its ancestor chain doesn't match the id
// TaxaSummary's precomputed children-summaries use for that group, so the breadcrumb row
// fails to find its own data and renders a zeroed placeholder (confirmed via a live repro:
// searching "isopoda" showed "Crustaceans 0 assessed" instead of the real ~3,410 — the
// exact bug class collapseTaxaToTokens's isDynamicNodeId check fixed elsewhere in this
// file's git history). GROUP_TO_LEAF_NODE itself must stay bare-preferring: its other
// callers (querySpecies's search-result rows) set a plain ?taxa= root with no sub-group,
// where the bare Table1a id is exactly right and no breadcrumb is ever attempted.
//
// Unlike GROUP_TO_LEAF_NODE, this is a function (not a precomputed map): a group
// doesn't always have its own single-taxonGroup leaf node (Insects has none — its 8
// Table 1a groups, beetles/butterflies/etc., only ever appear together under one
// umbrella node with taxonGroups: ALL_INSECT_GROUPS; the per-order split is live-only),
// so this also has to fall back to the smallest umbrella node whose taxonGroups
// includes the target group. A first-match memo (like GROUP_TO_LEAF_NODE's) would
// silently return whichever node NODE_INDEX iteration happened to visit first — for
// Insects that was briefly "ssc-dung-beetle" (an SSC node scoped to just Coleoptera
// genera, but nothing here checked `genera`/`speciesNames`/etc., only the class/
// order/family dimensions RANK_VALUE_TO_NODE cares about) before this was rewritten
// to scan every candidate and pick deliberately, not first-found. Memoized (NODE_INDEX
// is built once at import time and never changes) since this can run once per
// suggestion per search request.
const viewLeafForGroupCache = new Map<string, string | null>();
function findViewLeafForGroup(taxonGroup: string): string | null {
  const cached = viewLeafForGroupCache.get(taxonGroup);
  if (cached !== undefined) return cached;
  let best: { id: string; size: number } | null = null;
  for (const [id, node] of NODE_INDEX) {
    if (isSscGroupNode(id)) continue;
    const f = node.filter;
    if (!f.taxonGroups.includes(taxonGroup)) continue;
    // Only a node with NO OTHER filter dimension at all qualifies — anything else is
    // a curated sub-split of the group (a static family/order node, or a Specialist
    // Group carved out some other way, e.g. by genera/speciesNames), not the group's
    // own top-level container.
    if (f.classNames || f.orderNames || f.families || f.genera || f.excludeClasses ||
        f.excludeOrders || f.excludeFamilies || f.excludeGenera || f.speciesNames ||
        f.excludeSpeciesNames || f.extraSpeciesNames) continue;
    const size = f.taxonGroups.length;
    const prefersOverBest = !best || size < best.size ||
      (size === best.size && stripNodePrefix(id) !== id && stripNodePrefix(best.id) === best.id);
    if (prefersOverBest) best = { id, size };
  }
  const result = best?.id ?? null;
  viewLeafForGroupCache.set(taxonGroup, result);
  return result;
}

// Resolves a suggestTaxa match to a real node: a curated by-taxon node if one matches
// exactly (never an SSC Specialist Group node — see isSscGroupNode), else a dynamic
// drilldown id built against the taxon group's leaf display node (its "By Taxon"-view
// variant — see findViewLeafForGroup). A dynamic id needs every rank from the root's
// first live-enumerable level down to the matched one, in order (e.g. Isopoda is an
// "order" match, but Crustaceans drills class-first, so the id needs a class:<value>
// segment before order:isopoda) — dynamicNodeFilter ANDs each segment's field
// independently, so a single skip-ahead segment would still filter species correctly,
// but would leave nextDynamicRank/dynamicNodeAncestors reading the wrong depth for
// further expansion and ancestor rows. The extra rank value(s) come from one small
// lookup against a representative row (cheap: at most 2 columns, exact-match on already-
// warm parquets, LIMIT 1). Falls back to null (old bare ?taxa= browse) only if the root
// isn't live-drillable at all, or an ancestor rank's lookup comes back empty.
async function resolveTaxonSuggestionNode(
  conn: DuckDBConnection, rank: DynamicRank, value: string, taxonGroup: string,
  // The representative row's lineage when the suggestion came from rank-index.parquet,
  // which bakes it in at build time (chosen by the same struct min that picks the taxon
  // group, so the two always agree). null on the fallback path, which looks it up below.
  lineage: Lineage | null,
): Promise<string | null> {
  const staticHit = RANK_VALUE_TO_NODE.get(`${rank}:${value}`);
  if (staticHit) return staticHit;
  const leafRoot = findViewLeafForGroup(taxonGroup);
  if (!leafRoot) return null;
  const order = rankOrderFor(leafRoot);
  const idx = order.indexOf(rank);
  if (idx === -1) return null;
  const segments: DynamicSegment[] = [];
  if (idx > 0) {
    const priorRanks = order.slice(0, idx);
    // genus is always last in rankOrderFor's list, so it can't actually appear among the
    // prior ranks today; mapping it to null rather than assuming that keeps the lookup
    // from being a load-bearing assumption.
    const fromLineage = (r: DynamicRank) =>
      r === "class" ? lineage?.class_name : r === "order" ? lineage?.order_name : r === "family" ? lineage?.family : null;

    let values: (string | null | undefined)[];
    if (lineage) {
      values = priorRanks.map(fromLineage);
    } else {
      // Fallback path only. Aliased positionally (r0, r1, …) rather than read back by
      // column name: genus's "column" is an expression, not a name, so a raw projection
      // would have nothing stable to index the result row by. Reads the materialized
      // search index rather than the parquets — this runs once per suggestion, so on the
      // parquet path a single search paid up to three more unpruned R2 scans.
      const selects = priorRanks.map((r, i) => `${RANK_TO_MATCH_SQL[r]} AS r${i}`).join(", ");
      const matchSql = RANK_TO_MATCH_SQL[rank];
      const sql = `SELECT ${selects} FROM ${await searchSource(conn)}
        WHERE ${matchSql} = $v AND taxon_group = $tg LIMIT 1`;
      const rows = (await conn.runAndReadAll(sql, { v: value, tg: taxonGroup })).getRowObjects();
      if (rows.length === 0) return null;
      values = priorRanks.map((_, i) => rows[0][`r${i}`] as string | null);
    }
    priorRanks.forEach((r, i) => {
      // Coalesce a null ancestor rank to "" — the Unclassified bucket for that rank,
      // same convention filterToSql/matchesFilter already use, not an error case.
      const v = values[i];
      segments.push({ rank: r, value: v == null ? "" : String(v).toLowerCase() });
    });
  }
  segments.push({ rank, value });
  return buildDynamicNodeId(leafRoot, segments);
}

// Ranks in the order suggestTaxa prefers them, and the priority integer the SQL below
// dedupes/sorts on. Genus is last for both reasons: it's the finest rank, and (unlike
// the other three) its name universe is enormous — a two-letter prefix matches thousands
// of genera, so without an explicit tier it would crowd the higher ranks out of a
// three-slot dropdown purely on the "shortest name wins" tie-break (typing "chi" would
// surface a handful of 4-letter genera instead of Chiroptera).
const SUGGEST_RANKS: DynamicRank[] = ["class", "order", "family", "genus"];

// Recognize a taxon (class / order / family / genus) the user is typing, so the search
// bar can offer "Browse Felidae → " above the species hits. All four are ranks
// resolveWhere()'s arbitrary-rank branch matches on AND the live drilldown enumerates,
// so every suggestion lands on a view that can actually list species. Prefix-matches the
// DISTINCT rank names in the assessed ∪ unassessed parquets (already warm in the search
// hot path; class/order/family are pre-lowercased at build time, genus is derived from
// scientific_name via GENUS_SQL), so it never full-scans species/. A rank with zero
// assessed and zero GBIF-observed species won't surface — acceptable: those are exactly
// the taxa a user wouldn't browse to, and the direct species/synonym search still
// answers by name.
export async function suggestTaxa(query: string, limit = 3): Promise<TaxonSuggestion[]> {
  if (query.length < 2) return [];
  const conn = await getConn();
  const q = query.toLowerCase();
  const lim = Math.min(Math.max(limit, 1), 10);
  const genusRp = SUGGEST_RANKS.indexOf("genus");
  // Exact match first, then shortest (closest) name, then alphabetical — per tier, so
  // the JS merge below can hand the genus tier its own reserved slot. QUALIFY caps each
  // tier at `lim` rows, so a flood of genus prefix matches never has to be materialized
  // or shipped back.
  const order = `(name = $q) DESC, length(name), name`;
  const tail = `
    QUALIFY row_number() OVER (PARTITION BY rp = ${genusRp} ORDER BY ${order}) <= ${lim}
    ORDER BY rp = ${genusRp}, ${order}`;

  // rank-index.parquet is one row per name, sorted by it, so this is a pruned range read
  // of a ~1MB file — no GROUP BY, and no materialized table needed, which is what makes
  // the taxon half of the dropdown fast on a cold container too. It also carries the
  // lineage resolveTaxonSuggestionNode would otherwise have to look up per suggestion.
  // Falls back to the scanned/materialized rank names when the sync predates the index.
  let rows: Record<string, unknown>[] | null = null;
  try {
    rows = (await conn.runAndReadAll(
      `SELECT name, rp, taxon_group, class_name, order_name, family, true AS has_lineage
       FROM read_parquet('${parquetUri("rank-index.parquet")}')
       WHERE name >= $q AND name < $q || chr(1114111)${tail}`, { q })).getRowObjects();
  } catch { /* not in this sync prefix — fall through */ }

  if (!rows) {
    // Same answer the pre-aggregation above bakes in, computed on the fly: min() of a
    // STRUCT compares field by field in declaration order, so the coarsest rank wins and
    // an equal-rank tie goes to the alphabetically first taxon group. The arg_min(
    // taxon_group, rp) this replaced left that tie to parallel aggregation order, which
    // varied BETWEEN RUNS on identical data — the genus "×" is in both mosses and
    // flowering plants, and two identical searches could offer to browse it in either.
    rows = (await conn.runAndReadAll(
      `SELECT name, rp, taxon_group, NULL AS class_name, NULL AS order_name, NULL AS family,
              false AS has_lineage FROM (
         SELECT name, (min(s)).rp AS rp, (min(s)).tg AS taxon_group
         FROM (SELECT name, {'rp': rp, 'tg': taxon_group} AS s
               FROM ${await rankSource(conn)} WHERE name LIKE $q || '%')
         GROUP BY name
       )${tail}`, { q })).getRowObjects();
  }

  // One slot is reserved for the best genus hit whenever there is one — so searching a
  // genus that shares a prefix with its own family ("urs" → Ursidae + Ursus) shows both,
  // and neither tier can shut the other out. Genus expands to fill whatever the higher
  // ranks leave unused (a bare genus query like "panthera" matches nothing else, and
  // gets the whole dropdown).
  const higher = rows.filter((r) => Number(r.rp) !== SUGGEST_RANKS.indexOf("genus"));
  const genus = rows.filter((r) => Number(r.rp) === SUGGEST_RANKS.indexOf("genus"));
  const genusSlots = genus.length === 0 ? 0 : Math.max(1, lim - higher.length);
  const chosen = [...higher.slice(0, lim - genusSlots), ...genus.slice(0, genusSlots)];
  // An exact match is what the user typed — it leads regardless of rank. Array.sort is
  // stable, so everything else keeps the tier order above.
  chosen.sort((a, b) => Number(String(b.name) === q) - Number(String(a.name) === q));

  return Promise.all(chosen.map(async (r) => {
    const name = String(r.name);
    const rank = SUGGEST_RANKS[Number(r.rp)];
    return {
      name: name.charAt(0).toUpperCase() + name.slice(1),
      rank,
      taxon: name,
      // rank-index.parquet rows carry the lineage; fallback rows don't and pass null, so
      // the lookup still runs. Flagged explicitly rather than inferred from the columns
      // being null — a taxon with no class/order/family at all is a real, indexed row.
      nodeId: await resolveTaxonSuggestionNode(conn, rank, name, String(r.taxon_group),
        r.has_lineage ? { class_name: str(r.class_name), order_name: str(r.order_name), family: str(r.family) } : null),
    };
  }));
}
