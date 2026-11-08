/**
 * Scope-narrowed taxa-summary / node-children-summary, computed LIVE via DuckDB
 * instead of precomputed at sync time (contrast with taxa-summary.json /
 * table1a-children-summaries.json / ssc-group-children-summaries.json, read by species-store.ts).
 *
 * A "scope" here is a WHERE fragment narrowing assessed.parquet to some slice of
 * species that the precomputed artifacts don't cover: currently a set of countries
 * (Country View), stored as a semicolon-joined varchar column on assessed.parquet.
 *
 * Precomputing one file per scope was rejected for countries (~150-200 of them): it
 * would multiply scripts/sync/precomputed/summaries.ts's runtime ~200x, add a staleness
 * window, and can't compose with other simultaneous filters. Instead this queries the
 * same assessed.parquet species-duckdb.ts already serves /api/redlist/species from,
 * adding the scope predicate to the node's own (staticNodeSql) — computed
 * only for the specific scope + node actually requested, not the whole tree upfront.
 *
 * Deliberately omits GBIF (the gbif totals are zeroes) and
 * Catalogue of Life (col_described, col_ne) fields entirely — neither dataset has a
 * country dimension, so there is no valid scoped value to report. Callers (the two API routes) must mark
 * their response as scoped so the client knows to hide those columns rather than
 * render a misleading 0/undefined.
 */
import { getConn, parquetUri } from "./species-duckdb";
import { getTaxaSummary, type TaxaSummaryRow, type NodeSummary } from "./species-store";
import { NODE_INDEX, staticNodeSql } from "@/lib/taxonomy-utils";
import { outdatedCutoffDate } from "@/lib/outdated";
import { getDataSyncDate } from "@/lib/data-sync-date";

// list_contains needs an exact-case match; countries are stored upper-case 2-letter
// codes (same convention as the countries= URL filter elsewhere in the app). Exported
// for unit tests (the DuckDB query itself is verified manually against live data —
// see the scoped-taxa-summary-duckdb.test.ts file comment).
export function countryWhere(cc: string): string {
  return `list_contains(string_split(coalesce(countries, ''), ';'), '${cc.toUpperCase().replace(/'/g, "''")}')`;
}

// One or more country codes — a single country, a whole IUCN region, or an
// arbitrary multi-select, all handled identically here: OR'd list_contains
// checks, not a sum of separately-computed per-country totals. This is why
// there's no double-counting risk generalizing from one country to many — each
// species is exactly one row in the underlying table, so count(*)/GROUP BY
// below still counts it once even if it matches several of these codes at
// once (e.g. occurs in both France and Germany within a "Europe" selection).
export function countriesWhere(codes: string[]): string {
  if (codes.length === 0) return "FALSE"; // no countries selected — matches nothing
  return codes.map(countryWhere).join(" OR ");
}

/**
 * The scope predicate for a request: an OR across the selected countries.
 * Returns null when nothing is scoped, which is the signal to callers to use the
 * precomputed global artifacts instead of querying at all.
 */
export function scopeWhere(countries: string[]): string | null {
  return countries.length > 0 ? `(${countriesWhere(countries)})` : null;
}

// DATE, not TIMESTAMP — isOutdated() compares full elapsed time, but assessment_date
// only ever carries day precision, so truncating the cutoff to a date is equivalent
// and avoids a timezone-sensitive TIMESTAMP comparison.
export function outdatedSql(cutoffIso: string): string {
  return `(assessment_date IS NULL OR CAST(assessment_date AS DATE) <= CAST('${cutoffIso}' AS DATE))`;
}

/**
 * Scoped equivalent of getTaxaSummary() — one row per Table 1a taxon_group,
 * mirroring precomputed/summaries.ts's pass 1 (a group is its whole CSV file, no
 * class/order/etc. filter). Always emits a row for every known group (even an
 * all-zero one) so the route's per-node "available" check doesn't wrongly
 * mark a taxon unavailable just because zero of its species fall in this scope —
 * unlike the global case, "0 species here" is a real, valid scoped answer (no
 * marine mosses; no mammals in Antarctica).
 *
 * `where` is a scope predicate from scopeWhere() — see its doc comment for why
 * this is safe from double-counting however many countries it covers.
 */
export async function getScopedTaxaSummary(where: string): Promise<TaxaSummaryRow[]> {
  const conn = await getConn();
  const cutoff = outdatedCutoffDate(getDataSyncDate()).toISOString().slice(0, 10);
  const assessedUri = parquetUri("assessed.parquet");
  const rows = (await conn.runAndReadAll(
    `SELECT taxon_group, iucn_category AS category, count(*) AS n,
            sum(CASE WHEN ${outdatedSql(cutoff)} THEN 1 ELSE 0 END) AS n_outdated
     FROM '${assessedUri}'
     WHERE ${where}
     GROUP BY taxon_group, iucn_category`
  )).getRowObjects();

  const byGroup = new Map<string, TaxaSummaryRow>();
  const allGroupIds = getTaxaSummary().map((r) => r.table1a_taxon_group);
  for (const group of allGroupIds) {
    byGroup.set(group, {
      table1a_taxon_group: group,
      total_assessed: 0,
      outdated: 0,
      by_category: {},
      gbif: {
        georeferenced: { species_count: 0, ne_species_count: 0, records: 0, median: null },
        all: { species_count: 0, ne_species_count: 0, records: 0, median: null },
      },
    });
  }
  for (const r of rows) {
    const group = String(r.taxon_group);
    const row = byGroup.get(group);
    if (!row) continue; // taxon_group not in the current taxa-summary — ignore (shouldn't happen)
    const n = Number(r.n);
    const cat = (r.category as string) || "DD";
    row.total_assessed += n;
    row.outdated += Number(r.n_outdated);
    row.by_category[cat] = (row.by_category[cat] ?? 0) + n;
  }
  return [...byGroup.values()];
}

/**
 * Scoped equivalent of getPrecomputedChildrenSummaries(parentNodeId) — one
 * NodeSummary per child of the given parent, holding the same species the
 * precomputed summaries count (a Specialist Group's from the sync, an IUCN
 * group's by taxon_group: staticNodeSql), computed on demand for just this one
 * parent instead of the whole tree.
 *
 * `where` is a scope predicate — see getScopedTaxaSummary's doc comment.
 */
export async function getScopedChildrenSummaries(where: string, parentNodeId: string): Promise<NodeSummary[]> {
  const parent = NODE_INDEX.get(parentNodeId);
  if (!parent?.children?.length) return [];
  const conn = await getConn();
  const cutoff = outdatedCutoffDate(getDataSyncDate()).toISOString().slice(0, 10);
  const assessedUri = parquetUri("assessed.parquet");
  const children = parent.children;

  const summaries: NodeSummary[] = [];
  for (const child of children) {
    const childWhere = staticNodeSql(child.id);
    const rows = (await conn.runAndReadAll(
      `SELECT iucn_category AS category, count(*) AS n,
              sum(CASE WHEN ${outdatedSql(cutoff)} THEN 1 ELSE 0 END) AS n_outdated
       FROM '${assessedUri}'
       WHERE (${childWhere}) AND (${where})
       GROUP BY iucn_category`
    )).getRowObjects();

    let totalAssessed = 0;
    let outdated = 0;
    const byCategory: Record<string, number> = {};
    for (const r of rows) {
      const n = Number(r.n);
      totalAssessed += n;
      outdated += Number(r.n_outdated);
      const cat = r.category as string | null;
      if (cat) byCategory[cat] = (byCategory[cat] ?? 0) + n;
    }
    // estimatedDescribed/gbifNeSpeciesCount: no valid scoped value (see file
    // doc comment) — 0 here, not undefined, since NodeSummary requires a number;
    // callers must consult the response's `scoped` flag to know to hide them.
    summaries.push({
      id: child.id,
      name: child.name,
      estimatedDescribed: 0,
      totalAssessed,
      outdated,
      gbifNeSpecies: { georeferenced: 0, all: 0 },
      byCategory,
    });
  }
  return summaries;
}
