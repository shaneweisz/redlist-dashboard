/**
 * Live, on-demand version of the no-match diagnostic breakdown (see
 * col-breakdown.ts) for dynamic taxonomic-drilldown nodes (dynamic-taxon.ts) —
 * the same "why doesn't this species have a clean 1:1 CoL match" click-through
 * that official/SSC nodes get for free from the precomputed
 * table1a/ssc-group-children-summaries.json, computed here per (rank, value) bucket only
 * when a user actually expands one in the popover (TaxaSummary.tsx's
 * BreakdownList), not eagerly for a whole level.
 *
 * The split_candidates/synonym_assessed/col_to_assessed temp tables are fully
 * determined by the data sync (never by which taxon/bucket a user is viewing),
 * so scripts/sync/precomputed/summaries.ts precomputes them into
 * data/col-split-candidates.parquet, data/col-synonym-assessed.parquet and
 * data/col-to-assessed.parquet (~6K / ~173K rows), loaded here once per warm
 * server connection. If they can't be read, a breakdown degrades to no
 * noMatchDetails/splitDetails rather than failing the request.
 */
import { getConn, parquetUri, ensureNeHelpers } from "./species-duckdb";
import { ensureVernacularNamesLoaded } from "./vernacular-names";
import {
  computeBreakdownEntry,
  type BreakdownEntry,
  type BreakdownQueryContext,
} from "./col-breakdown";
import { dynamicNodeFilter, isDynamicNodeId, dynamicNodeMatchValue, parseDynamicNodeId } from "@/lib/dynamic-taxon";
import { NODE_INDEX } from "@/lib/taxonomy-utils";
import type { NodeFilter } from "@/lib/taxonomy-sql";

let helpersPromise: Promise<{ hasTaxa: boolean }> | null = null;
async function ensureColMatchHelpers(conn: Awaited<ReturnType<typeof getConn>>): Promise<{ hasTaxa: boolean }> {
  if (!helpersPromise) {
    helpersPromise = (async () => {
      await ensureNeHelpers(conn); // ne_assessed_col_ids
      try {
        await conn.run(`CREATE TEMP TABLE split_candidates AS SELECT * FROM read_parquet('${parquetUri("col-split-candidates.parquet")}')`);
        await conn.run(`CREATE TEMP TABLE synonym_assessed AS SELECT * FROM read_parquet('${parquetUri("col-synonym-assessed.parquet")}')`);
        await conn.run(`CREATE TEMP TABLE col_to_assessed AS SELECT * FROM read_parquet('${parquetUri("col-to-assessed.parquet")}')`);
        return { hasTaxa: true };
      } catch (e) {
        console.error("live-breakdown: CoL match helpers unavailable, degrading:", e);
        return { hasTaxa: false };
      }
    })().catch((e) => { helpersPromise = null; throw e; });
  }
  return helpersPromise;
}

/**
 * Resolves each (rank, name) pair to its Catalogue of Life accepted taxon id via
 * taxa.parquet — the same match rule scripts/sync/precomputed/col-taxon-ids.ts uses to
 * build the precomputed static-tree snapshot (COL_TAXON_IDS in
 * col-taxon-ids.json), just run live for names that snapshot can't cover: a
 * dynamic node's own ancestor chain (e.g. "Genus: Chaetodipus") is reached
 * purely through live order/family/genus enumeration, never referenced by any
 * static SpeciesFilter, so it's never in that build-time snapshot. Cheap point
 * lookups (a handful of names per popover) against a parquet already read
 * elsewhere in this same request (ensureColMatchHelpers).
 */
async function resolveLiveColTaxonIds(
  conn: Awaited<ReturnType<typeof getConn>>,
  taxaPath: string,
  pairs: { rank: string; name: string }[],
): Promise<Record<string, string>> {
  if (!pairs.length) return {};
  const values = pairs.map((p) => `('${p.rank}', '${p.name.toLowerCase().replace(/'/g, "''")}')`).join(", ");
  const rows = await (await conn.run(`
    WITH pairs(rank, name) AS (VALUES ${values})
    SELECT p.rank AS rank, p.name AS name, b.col_id AS col_id
    FROM pairs p
    JOIN read_parquet('${taxaPath}') b ON b.rank = p.rank AND lower(b.scientific_name) = p.name AND b.status = 'accepted'
  `)).getRowObjects();
  const map: Record<string, string> = {};
  for (const r of rows) map[`${r.rank}:${r.name}`] = String(r.col_id);
  return map;
}

/**
 * One breakdown entry for a dynamic node's own (whole) filter — mirrors
 * precomputed/summaries.ts's isExcludeOnlyCatchAll case (a single bucket keyed by
 * the node's own name), since a dynamic node's live-enumerated siblings are
 * already each their own separate node/request, not multiple names under one
 * parent the way a static multi-name SSC group is.
 */
export async function getLiveBreakdown(nodeId: string): Promise<BreakdownEntry | null> {
  const filter: NodeFilter | undefined = isDynamicNodeId(nodeId) ? (dynamicNodeFilter(nodeId) ?? undefined) : NODE_INDEX.get(nodeId)?.filter;
  if (!filter) return null;

  ensureVernacularNamesLoaded();
  const conn = await getConn();
  const { hasTaxa } = await ensureColMatchHelpers(conn);
  const ctx: BreakdownQueryContext = {
    conn,
    speciesGlob: parquetUri("species/**/*.parquet"),
    assessedPath: parquetUri("assessed.parquet"),
    linkPath: parquetUri("assessment_link.parquet"),
    assessedCidsTable: "ne_assessed_col_ids",
    hasTaxa,
    taxaPath: hasTaxa ? parquetUri("taxa.parquet") : undefined,
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
 * (which also runs ensureColMatchHelpers' precomputed-table setup and the much
 * heavier no-match diagnostic joins) — a handful of point lookups against
 * taxa.parquet alone resolves far faster, so the frontend can light up
 * every ancestor-chain link (e.g. the rank/name header shown while the
 * breakdown table is still loading) well before the slower breakdown itself
 * comes back, instead of both arriving together only once the slow query
 * finishes. Degrades to an empty map (unlinked plain text) if taxa.parquet
 * is unavailable.
 */
export async function getLiveColTaxonIds(nodeId: string): Promise<Record<string, string>> {
  if (!isDynamicNodeId(nodeId)) return {};
  const segments = parseDynamicNodeId(nodeId)?.segments ?? [];
  const pairs = segments.filter((s) => s.value !== "").map((s) => ({ rank: s.rank, name: s.value }));
  if (!pairs.length) return {};
  try {
    const conn = await getConn();
    return await resolveLiveColTaxonIds(conn, parquetUri("taxa.parquet"), pairs);
  } catch (e) {
    console.error(`getLiveColTaxonIds: taxa.parquet unavailable for ${nodeId}, degrading:`, e);
    return {};
  }
}
