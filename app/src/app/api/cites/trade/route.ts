import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import { normalizeUnit, parseReportedQty, type CompactRecord } from "@/lib/cites-trade";

// NOTE: This hits the CITES Trade DB web interface's JSON endpoint, not an
// official API. It may break if CITES changes their frontend. No stable public
// API exists for this data at present.
const TRADE_API = "https://trade.cites.org/en/cites_trade/shipments";

// Cache for trade summaries (1 hour)
const tradeCache = new Map<string, { data: object; timestamp: number }>();
const CACHE_DURATION = 60 * 60 * 1000;

// CITES entered into force in 1975, so there is no trade data before then.
const FETCH_START_YEAR = 1975;
// The CITES endpoint returns inconsistent / partially-truncated results when a
// single request spans the full history (a 50-year pull for a heavily-traded
// species can silently drop thousands of rows, including whole recent years).
// We therefore fetch in small year-windows and concatenate — each window is
// small enough to return complete, reproducible data.
const FETCH_CHUNK_YEARS = 5;

/** Error that carries the upstream HTTP status so the route can propagate it. */
class CitesTradeError extends Error {
  status: number;
  constructor(status: number) {
    super(`CITES Trade DB error: ${status}`);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


interface TradeRow {
  Year: number;
  "App.": string;
  Taxon: string;
  Importer: string;
  Exporter: string;
  Origin: string | null;
  "Importer reported quantity": string | null;
  "Exporter reported quantity": string | null;
  Term: string;
  Unit: string | null;
  Purpose: string;
  Source: string;
}

/**
 * Compact a comparative-tabulation row. Both parties' quantities are kept, each
 * only when that party reported it: they are separate reports of the same trade
 * and the client reads one or the other, never a mix (see lib/cites-trade.ts).
 */
function toCompact(r: TradeRow): CompactRecord {
  const rec: CompactRecord = {
    y: r.Year,
    s: r.Source || "",
    p: r.Purpose || "",
    t: r.Term || "unspecified",
    u: normalizeUnit(r.Unit),
    e: r.Exporter || "",
    i: r.Importer || "",
    // Origin only carried for a genuine re-export (origin differs from the
    // exporter); otherwise empty to keep the payload small.
    o: r.Origin && r.Origin !== r.Exporter ? r.Origin : "",
  };
  const qe = parseReportedQty(r["Exporter reported quantity"]);
  const qi = parseReportedQty(r["Importer reported quantity"]);
  if (qe !== undefined) rec.qe = qe;
  if (qi !== undefined) rec.qi = qi;
  return rec;
}

/**
 * Fetch one year-window of comparative-tabulation rows for a taxon, with a few
 * retries for transient upstream errors.
 */
async function fetchTradeChunk(
  taxonId: string,
  startYear: number,
  endYear: number
): Promise<TradeRow[]> {
  const params = new URLSearchParams({
    "filters[taxon_concepts_ids][]": taxonId,
    "filters[report_type]": "comptab",
    "filters[time_range_start]": String(startYear),
    "filters[time_range_end]": String(endYear),
    "filters[exporters_ids][]": "all_exp",
    "filters[importers_ids][]": "all_imp",
    "filters[sources_ids][]": "all_sou",
    "filters[purposes_ids][]": "all_pur",
    "filters[terms_ids][]": "all_ter",
    "filters[selection_taxon]": "taxonomic_cascade",
  });
  const url = `${TRADE_API}?${params.toString()}`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    try {
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new CitesTradeError(resp.status);
      const data = await resp.json();
      return (data?.shipment_comptab_export?.rows as TradeRow[]) ?? [];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("CITES Trade DB request failed");
}

/**
 * GET /api/cites/trade?taxon_id=<citesId>
 *
 * Fetches comparative tabulation data from the CITES Trade Database and
 * returns its rows, compacted, with the exporter- and importer-reported
 * quantities kept apart. The client aggregates (lib/cites-trade.ts).
 */
export async function GET(request: NextRequest) {
  const taxonId = request.nextUrl.searchParams.get("taxon_id");

  if (!taxonId || !/^\d+$/.test(taxonId)) {
    return NextResponse.json(
      { error: "taxon_id must be a numeric value" },
      { status: 400 }
    );
  }

  const cacheKey = taxonId;
  const cached = tradeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return NextResponse.json(cached.data, { headers: CACHE_1H });
  }

  try {
    // Fetch the full available history (1975 → present) in small year-windows.
    // The upstream endpoint truncates large single-shot pulls non-determinist-
    // ically, so chunking is what makes the recent years (and the totals)
    // reliable — e.g. Panthera leo back to 1977 with complete recent data.
    const currentYear = new Date().getFullYear();

    const ranges: [number, number][] = [];
    for (let s = FETCH_START_YEAR; s <= currentYear; s += FETCH_CHUNK_YEARS) {
      ranges.push([s, Math.min(s + FETCH_CHUNK_YEARS - 1, currentYear)]);
    }

    const chunks = await Promise.all(
      ranges.map(([a, b]) => fetchTradeChunk(taxonId, a, b))
    );
    const rows: TradeRow[] = chunks.flat();

    if (rows.length === 0) {
      const result = { found: false, taxonId };
      tradeCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return NextResponse.json(result, { headers: CACHE_1H });
    }

    const years = rows.map((r) => r.Year).filter(Boolean);
    const result = {
      found: true,
      taxonId,
      yearRange: [Math.min(...years), Math.max(...years)],
      shipments: rows.map(toCompact),
    };
    tradeCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return NextResponse.json(result, { headers: CACHE_1H });
  } catch (error) {
    console.error("Error fetching CITES trade data:", error);
    const status = error instanceof CitesTradeError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status }
    );
  }
}
