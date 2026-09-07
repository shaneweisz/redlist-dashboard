/**
 * Live, on-demand version of the no-match diagnostic breakdown (see
 * col-breakdown.ts) for dynamic taxonomic-drilldown nodes (dynamic-taxon.ts) —
 * the same "why doesn't this species have a clean 1:1 CoL match" click-through
 * that official/SSC nodes get for free from the precomputed
 * table1a/ssc-group-children-summaries.json, computed here per (rank, value) bucket only
 * when a user actually expands one in the popover (TaxaSummary.tsx's
 * BreakdownList), not eagerly for a whole level.
 *
 * The split_candidates/col_to_assessed temp tables are fully determined by the
 * data sync (never by which taxon/bucket a user is viewing), so
 * scripts/build-taxa-summary.ts precomputes them once at sync time into
 * data/col-split-candidates.parquet / data/col-synonym-assessed.parquet /
 * data/col-to-assessed.parquet — tiny
 * files (~6K / ~173K rows) loaded here directly. This used to instead rebuild
 * both from scratch on the first breakdown request after every cold server
 * start via a full scan + self-join over backbone.parquet (8M rows, ~125MB) —
 * memoized once per warm server connection (mirrors ensureNeHelpers in
 * species-duckdb.ts) so only that first request paid the cost, but that cost
 * was still several seconds of real backbone-scanning work. If the
 * precomputed files are missing (e.g. an older data sync from before this
 * existed), falls back to rebuilding from backbone.parquet directly, same as
 * before. If backbone.parquet itself is unavailable for any reason, degrades
 * gracefully to a breakdown with no noMatchDetails/splitDetails (same
 * fallback scripts/build-taxa-summary.ts's hasBackbone flag already provides)
 * rather than failing the request.
 */
import { getConn, parquetUri, ensureNeHelpers } from "./species-duckdb";
import { ensureVernacularNamesLoaded } from "./vernacular-names";
import {
  computeBreakdownEntry,
  SPLIT_CANDIDATES_SQL,
  SYNONYM_ASSESSED_SQL,
  COL_TO_ASSESSED_SQL,
  backboneHasChecklistColumns,
  type BreakdownEntry,
  type BreakdownQueryContext,
} from "./col-breakdown";
import { dynamicNodeFilter, isDynamicNodeId, dynamicNodeMatchValue, parseDynamicNodeId } from "@/lib/dynamic-taxon";
import { NODE_INDEX } from "@/lib/taxonomy-utils";
import type { NodeFilter } from "@/lib/taxonomy-sql";

// Keep in sync with the same constant in scripts/build-taxa-summary.ts and
// species-duckdb.ts — Homo sapiens, which IUCN omits from its Red List export.
const EXCLUDED_COL_IDS_SQL = `('6MB3T')`;

interface BackboneHelpers {
  hasBackbone: boolean;
  /** See BreakdownQueryContext.hasChecklistColumns — false for a data sync whose
   *  backbone.parquet was built before build-backbone stamped these columns. */
  hasChecklistColumns: boolean;
}
let backboneHelpersPromise: Promise<BackboneHelpers> | null = null;
async function ensureBackboneHelpers(conn: Awaited<ReturnType<typeof getConn>>): Promise<BackboneHelpers> {
  if (!backboneHelpersPromise) {
    backboneHelpersPromise = (async () => {
      await ensureNeHelpers(conn); // ne_assessed_col_ids / ne_ex_ew_col_ids
      try {
        try {
          // Fast path: load the precomputed tables directly — no backbone scan.
          await conn.run(`CREATE TEMP TABLE split_candidates AS SELECT * FROM read_parquet('${parquetUri("col-split-candidates.parquet")}')`);
          // Added after the other two, so a data sync that predates it takes the
          // rebuild path below for all three rather than half-loading.
          await conn.run(`CREATE TEMP TABLE synonym_assessed AS SELECT * FROM read_parquet('${parquetUri("col-synonym-assessed.parquet")}')`);
          await conn.run(`CREATE TEMP TABLE col_to_assessed AS SELECT * FROM read_parquet('${parquetUri("col-to-assessed.parquet")}')`);
        } catch (precomputeError) {
          // Precomputed files missing (e.g. an older data sync from before these
          // existed) — fall back to building them from backbone.parquet directly.
          console.error("live-breakdown: precomputed CoL match helpers unavailable, rebuilding from backbone.parquet:", precomputeError);
          const backbonePath = parquetUri("backbone.parquet");
          const assessedPath = parquetUri("assessed.parquet");
          const linkPath = parquetUri("species_link.parquet");
          await conn.run(`DROP TABLE IF EXISTS split_candidates`);
          await conn.run(SPLIT_CANDIDATES_SQL(backbonePath, assessedPath, "ne_assessed_col_ids"));
          await conn.run(SYNONYM_ASSESSED_SQL(backbonePath, assessedPath, "ne_assessed_col_ids"));
          await conn.run(COL_TO_ASSESSED_SQL(linkPath, assessedPath));
        }
        const hasChecklistColumns = await backboneHasChecklistColumns(conn, parquetUri("backbone.parquet"));
        if (!hasChecklistColumns) {
          console.error("live-breakdown: backbone.parquet predates the checklist columns (in_checklist / checklist_parent_id / checklist_name) — breakdowns will omit CoL rename claims until the next backbone rebuild.");
        }
        return { hasBackbone: true, hasChecklistColumns };
      } catch (e) {
        // backbone.parquet missing/unreadable — degrade to no diagnostic detail
        // rather than fail every breakdown request.
        console.error("live-breakdown: backbone helpers unavailable, degrading:", e);
        return { hasBackbone: false, hasChecklistColumns: false };
      }
    })().catch((e) => { backboneHelpersPromise = null; throw e; });
  }
  return backboneHelpersPromise;
}

/**
 * Resolves each (rank, name) pair to its Catalogue of Life accepted taxon id via
 * backbone.parquet — the same match rule scripts/build-col-taxon-ids.ts uses to
 * build the precomputed static-tree snapshot (COL_TAXON_IDS in
 * col-taxon-ids.json), just run live for names that snapshot can't cover: a
 * dynamic node's own ancestor chain (e.g. "Genus: Chaetodipus") is reached
 * purely through live order/family/genus enumeration, never referenced by any
 * static SpeciesFilter, so it's never in that build-time snapshot. Cheap point
 * lookups (a handful of names per popover) against a parquet already read
 * elsewhere in this same request (ensureBackboneHelpers).
 */
async function resolveLiveColTaxonIds(
  conn: Awaited<ReturnType<typeof getConn>>,
  backbonePath: string,
  pairs: { rank: string; name: string }[],
): Promise<Record<string, string>> {
  if (!pairs.length) return {};
  const values = pairs.map((p) => `('${p.rank}', '${p.name.toLowerCase().replace(/'/g, "''")}')`).join(", ");
  const rows = await (await conn.run(`
    WITH pairs(rank, name) AS (VALUES ${values})
    SELECT p.rank AS rank, p.name AS name, b.col_id AS col_id
    FROM pairs p
    JOIN read_parquet('${backbonePath}') b ON b.rank = p.rank AND lower(b.scientific_name) = p.name AND b.status = 'accepted'
  `)).getRowObjects();
  const map: Record<string, string> = {};
  for (const r of rows) map[`${r.rank}:${r.name}`] = String(r.col_id);
  return map;
}

/**
 * One breakdown entry for a dynamic node's own (whole) filter — mirrors
 * build-taxa-summary.ts's isExcludeOnlyCatchAll case (a single bucket keyed by
 * the node's own name), since a dynamic node's live-enumerated siblings are
 * already each their own separate node/request, not multiple names under one
 * parent the way a static multi-name SSC group is.
 */
export async function getLiveBreakdown(nodeId: string): Promise<BreakdownEntry | null> {
  const filter: NodeFilter | undefined = isDynamicNodeId(nodeId) ? (dynamicNodeFilter(nodeId) ?? undefined) : NODE_INDEX.get(nodeId)?.filter;
  if (!filter) return null;

  ensureVernacularNamesLoaded();
  const conn = await getConn();
  const { hasBackbone, hasChecklistColumns } = await ensureBackboneHelpers(conn);
  const ctx: BreakdownQueryContext = {
    conn,
    speciesGlob: parquetUri("species/**/*.parquet"),
    assessedPath: parquetUri("assessed.parquet"),
    linkPath: parquetUri("species_link.parquet"),
    universeSql: `(extinct IS NOT TRUE OR col_id IN (SELECT col_id FROM ne_ex_ew_col_ids))`,
    assessedCidsTable: "ne_assessed_col_ids",
    excludedColIdsSql: EXCLUDED_COL_IDS_SQL,
    hasBackbone,
    hasChecklistColumns,
    backbonePath: hasBackbone ? parquetUri("backbone.parquet") : undefined,
  };
  // The raw matchable scientific value (e.g. "muridae"), NOT dynamicNodeDisplayName's
  // "Scientific name (Common name)" string — this becomes BreakdownEntry.name, which
  // the client's matchesBreakdownName compares case-insensitively against a species
  // row's own family/order_name/etc. column (TaxaSummary.tsx's SpeciesListPanel).
  // Passing the display string there was a real bug: for any bucket with a known
  // common name, "muridae (mice)" never equals a row's family "muridae", so the
  // breakdown's species-list click-through silently returned zero species.
  const name = isDynamicNodeId(nodeId) ? dynamicNodeMatchValue(nodeId) : (NODE_INDEX.get(nodeId)?.name ?? nodeId);
  return computeBreakdownEntry(ctx, name, filter, isDynamicNodeId(nodeId) ? undefined : nodeId);
}

/**
 * CoL taxon ids for every real (non-Unclassified) segment of a dynamic node's
 * own ancestor chain (e.g. "rodentia"/"heteromyidae"/"chaetodipus"), resolved
 * live via resolveLiveColTaxonIds. Deliberately separate from getLiveBreakdown
 * (which also runs ensureBackboneHelpers' precomputed-table setup and the much
 * heavier no-match diagnostic joins) — a handful of point lookups against
 * backbone.parquet alone resolves far faster, so the frontend can light up
 * every ancestor-chain link (e.g. the rank/name header shown while the
 * breakdown table is still loading) well before the slower breakdown itself
 * comes back, instead of both arriving together only once the slow query
 * finishes. Degrades to an empty map (unlinked plain text) if backbone.parquet
 * is unavailable, same as every other backbone-dependent fallback in this file.
 */
export async function getLiveColTaxonIds(nodeId: string): Promise<Record<string, string>> {
  if (!isDynamicNodeId(nodeId)) return {};
  const segments = parseDynamicNodeId(nodeId)?.segments ?? [];
  const pairs = segments.filter((s) => s.value !== "").map((s) => ({ rank: s.rank, name: s.value }));
  if (!pairs.length) return {};
  try {
    const conn = await getConn();
    return await resolveLiveColTaxonIds(conn, parquetUri("backbone.parquet"), pairs);
  } catch (e) {
    console.error(`getLiveColTaxonIds: backbone.parquet unavailable for ${nodeId}, degrading:`, e);
    return {};
  }
}
