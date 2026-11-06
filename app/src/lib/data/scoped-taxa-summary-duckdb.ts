/**
 * Scope-narrowed taxa-summary / node-children-summary, computed LIVE via DuckDB
 * instead of precomputed at sync time (contrast with taxa-summary.json /
 * table1a-children-summaries.json / ssc-group-children-summaries.json, read by species-store.ts).
 *
 * A "scope" here is a WHERE fragment narrowing assessed.parquet to some slice of
 * species that the precomputed artifacts don't cover: currently a set of countries
 * (Country View) and/or a set of realms (Realm View). Both are stored the same way
 * — a semicolon-joined varchar column on assessed.parquet — so they build the same
 * shape of predicate and compose by AND (marine species in Indonesia).
 *
 * Precomputing one file per scope was rejected for countries (~150-200 of them): it
 * would multiply scripts/sync/outputs/build-taxa-summary.ts's runtime ~200x, add a staleness
 * window, and can't compose with other simultaneous filters. Instead this queries the
 * same assessed.parquet species-duckdb.ts already serves /api/redlist/species from,
 * adding the scope predicate to filterToSql()'s taxonomy-node predicate — computed
 * only for the specific scope + node actually requested, not the whole tree upfront.
 * Realm has only three values and so would have been cheap to precompute, but rides
 * the same live path rather than adding a second mechanism for the same job.
 *
 * Deliberately omits GBIF (the gbif totals are zeroes) and
 * Catalogue of Life (col_described, col_ne) fields entirely — neither dataset has a
 * country OR a realm dimension, so there is no valid scoped value to report. (Realm
 * is doubly absent: `systems` is populated only for ASSESSED species — unassessed.parquet
 * has no realm column at all — so a "% of described species assessed" figure can't be
 * computed per realm even in principle. See the taxonomy-tree.ts comment on the fish
 * Red List Authorities for the same blocker.) Callers (the two API routes) must mark
 * their response as scoped so the client knows to hide those columns rather than
 * render a misleading 0/undefined.
 */
import { getConn, parquetUri } from "./species-duckdb";
import { getTaxaSummary, type TaxaSummaryRow, type NodeSummary } from "./species-store";
import { NODE_INDEX } from "@/lib/taxonomy-utils";
import { filterToSql } from "@/lib/taxonomy-sql";
import { outdatedCutoffDate } from "@/lib/outdated";
import { getDataSyncDate } from "@/lib/data-sync-date";
import type { TaxonomyNode } from "@/config/taxonomy-tree";

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

// The three IUCN realms, exactly as assessment_systems spells them in the source
// data (and so exactly as the `systems` column stores them) — the Realm filter
// buttons in RedListView use the same three literals.
export const REALMS = ["Terrestrial", "Freshwater", "Marine"] as const;
export type Realm = (typeof REALMS)[number];

export function isRealm(value: string): value is Realm {
  return (REALMS as readonly string[]).includes(value);
}

// Realm equivalent of countriesWhere — `systems` is the same semicolon-joined
// varchar shape as `countries`, so this is the same OR'd list_contains check, and
// a species assessed as e.g. "Freshwater;Marine" is still counted exactly once by
// the count(*)/GROUP BY below when both realms are selected.
//
// Unlike country codes (an open set — any 2-letter string is a plausible code, so
// countryWhere escapes and passes it through to match nothing if it's bogus), realm
// is a closed set of three known values, so unrecognized input is dropped outright
// rather than escaped into the query. Callers decide scoped-ness from the RAW
// parameter, so ?realm=Lunar still scopes — to FALSE, i.e. no species, which is the
// honest answer — rather than silently falling back to global numbers.
export function systemsWhere(realms: string[]): string {
  const valid = realms.filter(isRealm);
  if (valid.length === 0) return "FALSE"; // nothing selected, or nothing recognized
  return valid
    .map((r) => `list_contains(string_split(coalesce(systems, ''), ';'), '${r}')`)
    .join(" OR ");
}

/**
 * The combined scope predicate for a request: countries AND realms, each of which
 * is itself an OR across its own selected values. Returns null when neither
 * dimension is scoped at all, which is the signal to callers to use the
 * precomputed global artifacts instead of querying at all.
 *
 * AND (not OR) between the two dimensions is what makes them compose the way the
 * rest of the dashboard's filters do: selecting Marine and Indonesia means marine
 * species IN Indonesia, not marine species plus Indonesian ones.
 */
export function scopeWhere(countries: string[], realms: string[]): string | null {
  const clauses: string[] = [];
  if (countries.length > 0) clauses.push(`(${countriesWhere(countries)})`);
  if (realms.length > 0) clauses.push(`(${systemsWhere(realms)})`);
  if (clauses.length === 0) return null;
  return clauses.join(" AND ");
}

// DATE, not TIMESTAMP — isOutdated() compares full elapsed time, but assessment_date
// only ever carries day precision, so truncating the cutoff to a date is equivalent
// and avoids a timezone-sensitive TIMESTAMP comparison.
export function outdatedSql(cutoffIso: string): string {
  return `(assessment_date IS NULL OR CAST(assessment_date AS DATE) <= CAST('${cutoffIso}' AS DATE))`;
}

export interface RealmStats {
  realm: Realm;
  /** Assessed species whose `systems` includes this realm. */
  species: number;
  /** ...of which are due a reassessment (the same >10yr cutoff the rest of the app uses). */
  outdated: number;
}

export interface RealmStatsResponse {
  realms: RealmStats[];
  /** Every assessed species, counted once — the denominator the bars' shares use. */
  totalAssessed: number;
}

/**
 * Per-realm totals across all assessed species — the Realm view's landing chart.
 * The country equivalent (getCountryStats) reads a precomputed JSON because there
 * are ~200 countries and the landing map needs every one of them; realm has three
 * values and one GROUP BY answers all of them at once, so this stays live rather
 * than adding a fourth build artifact to the monthly sync that could drift.
 *
 * A species assessed as e.g. "Freshwater;Marine" counts once toward BOTH realms
 * here — that's what the unnest does, and it's the honest reading of a bar that
 * says "N marine species assessed". It does mean the three bars sum to more than
 * totalAssessed (1,877 species are in two realms or three), and so that their
 * shares of it sum to more than 100% — which is why totalAssessed is returned
 * explicitly as the denominator rather than left to be inferred by summing the
 * bars, and why the chart says so on its face.
 */
export async function getRealmStats(): Promise<RealmStatsResponse> {
  const conn = await getConn();
  const cutoff = outdatedCutoffDate(getDataSyncDate()).toISOString().slice(0, 10);
  const assessedUri = parquetUri("assessed.parquet");
  // The unnest has to happen in a subquery: DuckDB can't GROUP BY an UNNEST
  // directly ("Binder Error: Cannot group on an UNNEST or UNLIST clause").
  const rows = (await conn.runAndReadAll(
    `SELECT realm, count(*) AS n,
            sum(CASE WHEN ${outdatedSql(cutoff)} THEN 1 ELSE 0 END) AS n_outdated
     FROM (
       SELECT unnest(string_split(systems, ';')) AS realm, assessment_date
       FROM '${assessedUri}'
       WHERE systems IS NOT NULL AND systems <> ''
     )
     GROUP BY realm`
  )).getRowObjects();

  const byRealm = new Map(rows.map((r) => [String(r.realm), r]));
  // Driven off REALMS, not off the query results, so a card is always emitted for
  // each of the three (a realm with no assessments at all is a real 0, not a
  // missing card) and any unexpected value in the column is ignored rather than
  // rendered as a fourth card.
  const realms = REALMS.map((realm) => {
    const row = byRealm.get(realm);
    return {
      realm,
      species: row ? Number(row.n) : 0,
      outdated: row ? Number(row.n_outdated) : 0,
    };
  });

  // Separate query, not a sum of the above: the unnest counts a multi-realm
  // species once per realm, so summing `realms` would overcount the total.
  const totalRow = (await conn.runAndReadAll(
    `SELECT count(*) AS n FROM '${assessedUri}'`
  )).getRowObjects();

  return { realms, totalAssessed: Number(totalRow[0]?.n ?? 0) };
}

/**
 * Scoped equivalent of getTaxaSummary() — one row per Table 1a taxon_group,
 * mirroring build-taxa-summary.ts's pass 1 (a group is its whole CSV file, no
 * class/order/etc. filter). Always emits a row for every known group (even an
 * all-zero one) so the route's per-node "available" check doesn't wrongly
 * mark a taxon unavailable just because zero of its species fall in this scope —
 * unlike the global case, "0 species here" is a real, valid scoped answer (no
 * marine mosses; no mammals in Antarctica).
 *
 * `where` is a scope predicate from scopeWhere() — see its doc comment for why
 * this is safe from double-counting however many countries/realms it covers.
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

// Non-catch-all children whose filter defines classNames/orderNames "claim" their
// matching rows away from a catch-all sibling (excludeClasses-bearing child) — see
// computeChildrenSummaries' claim-tracking in build-taxa-summary.ts, which this
// mirrors. families/genera/speciesNames-scoped siblings are deliberately NOT
// claim-eligible (matching that function exactly). Exported for unit tests.
export function claimEligibleSiblingsSql(children: TaxonomyNode[], excludeIdx: number): string | null {
  const clauses = children
    .filter((c, i) => i !== excludeIdx && (c.filter.classNames?.length || c.filter.orderNames?.length))
    .map((c) => filterToSql(c.filter));
  return clauses.length ? clauses.map((c) => `(${c})`).join(" OR ") : null;
}

/**
 * Scoped equivalent of getPrecomputedChildrenSummaries(parentNodeId) — one
 * NodeSummary per child of the given parent, mirroring build-taxa-summary.ts's pass
 * 2 (computeChildrenSummaries), including its catch-all claim-tracking, but computed
 * on demand for just this one parent instead of the whole tree.
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
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    let childWhere = filterToSql(child.filter);
    if (child.filter.excludeClasses?.length) {
      const claimed = claimEligibleSiblingsSql(children, i);
      if (claimed) childWhere = `(${childWhere}) AND NOT (${claimed})`;
    }
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
