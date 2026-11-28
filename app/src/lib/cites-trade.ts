/**
 * CITES trade rows, read the way the CITES Trade Database guide says to.
 *
 * Source: CITES Secretariat and UNEP-WCMC (2022). A guide to using the CITES
 * Trade Database. Version 9. https://trade.cites.org/cites_trade_guidelines/en-CITES_Trade_Database_Guide.pdf
 *
 * The rules this module enforces, with the guide's section:
 *
 *  - The exporter's and the importer's quantity are two reports of the same
 *    trade and are never added (§3.1). Nor are they mixed: when the two
 *    countries describe one trade differently (another year, term, purpose…),
 *    the comparative tabulation splits it into an exporter-only row and an
 *    importer-only row (FAQ "Why do importer- and exporter-reported data not
 *    always match?"), so "exporter's figure, else the importer's" counts that
 *    trade twice. A view therefore reads ONE reporter's figures throughout.
 *    Exporter-reported is the default: "often more complete" (FAQ "Should I use
 *    importer- or exporter-reported data?").
 *  - A comparative-tabulation row is not a shipment: "One row can represent
 *    any number of shipments" (FAQ). Trade is measured as reported quantity,
 *    not as a count of rows.
 *  - Quantities are only added within one term and unit (FAQ "Is it possible
 *    to combine or compare trade in different units?"), so every quantity
 *    figure is for one commodity (term + unit).
 */

/** Which party's report a view reads. */
export type Reporter = "exporter" | "importer";

/** One comparative-tabulation row, compacted for the client. */
export interface CompactRecord {
  y: number; // year
  s: string; // source code ("" = unspecified)
  p: string; // purpose code ("" = unspecified)
  t: string; // term
  u: string; // unit ("" = number of specimens; see normalizeUnit)
  /** Exporter-reported quantity; absent when the exporter didn't report this row. */
  qe?: number;
  /** Importer-reported quantity; absent when the importer didn't report this row. */
  qi?: number;
  e: string; // exporter ISO2
  i: string; // importer ISO2
  o: string; // origin ISO2 for a re-export ("" when direct trade)
}

/** A reported quantity, or undefined when that party reported nothing. */
export function parseReportedQty(val: string | number | null | undefined): number | undefined {
  if (val == null || val === "") return undefined;
  const n = typeof val === "number" ? val : parseFloat(val);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A unit as the trade data should be read. A blank unit means "number of
 * specimens", and since the May 2021 reporting guidelines that is also
 * reported explicitly (NAR, shown as "Number of specimens"); the guide says to
 * treat the two as one (Annex 2, Table A2.2 and its footnote 13). Both become "".
 */
export function normalizeUnit(unit: string | null | undefined): string {
  const u = (unit ?? "").trim();
  return /^(number of specimens|nar|no\.?)$/i.test(u) ? "" : u;
}

/** The chosen reporter's quantity for a row (undefined: that party didn't report it). */
export function reportedQty(r: CompactRecord, reporter: Reporter): number | undefined {
  return reporter === "exporter" ? r.qe : r.qi;
}

/** Stable key for a commodity (term + unit). */
export function commodityKey(term: string, unit: string): string {
  return `${term}|${unit}`;
}

/** "trophies", "skins (kg)": how a commodity reads after a number. */
export function commodityLabel(term: string, unit: string): string {
  return unit ? `${term} (${unit})` : term;
}

export interface Commodity {
  key: string;
  term: string;
  unit: string;
  /** Rows the reporter reported for this commodity (used only to order the list). */
  rows: number;
  quantity: number;
}

/**
 * Every commodity the reporter reported, with its total quantity. Ordered by
 * how many rows mention it, which is only a "most often traded as" ordering
 * for picking one; quantities in different units are never compared.
 */
export function commodities(rows: CompactRecord[], reporter: Reporter): Commodity[] {
  const map = new Map<string, Commodity>();
  for (const r of rows) {
    const q = reportedQty(r, reporter);
    if (q === undefined) continue;
    const key = commodityKey(r.t, r.u);
    const c = map.get(key) ?? { key, term: r.t, unit: r.u, rows: 0, quantity: 0 };
    c.rows++;
    c.quantity += q;
    map.set(key, c);
  }
  return [...map.values()].sort((a, b) => b.rows - a.rows || b.quantity - a.quantity);
}

export interface Total {
  code: string;
  quantity: number;
}
export interface Flow {
  from: string;
  to: string;
  quantity: number;
}

export interface TradeAggregate {
  /** Total reported quantity. */
  quantity: number;
  byYear: { year: number; quantity: number }[];
  bySource: Total[];
  byPurpose: Total[];
  exporters: Total[];
  importers: Total[];
  flows: Flow[];
  reExports: Flow[];
}

const sortDesc = <T extends { quantity: number }>(xs: T[]) => xs.sort((a, b) => b.quantity - a.quantity);
function add(map: Map<string, number>, key: string, q: number) {
  map.set(key, (map.get(key) ?? 0) + q);
}
const totals = (m: Map<string, number>): Total[] => sortDesc([...m].map(([code, quantity]) => ({ code, quantity })));
const flows = (m: Map<string, number>): Flow[] =>
  sortDesc([...m].map(([k, quantity]) => {
    const [from, to] = k.split("->");
    return { from, to, quantity };
  }));

/**
 * Sum one reporter's quantities for rows of a single commodity. Rows the
 * reporter didn't report are skipped, never filled from the other party.
 */
export function aggregate(rows: CompactRecord[], reporter: Reporter): TradeAggregate {
  let quantity = 0;
  const year = new Map<number, number>();
  const source = new Map<string, number>();
  const purpose = new Map<string, number>();
  const exp = new Map<string, number>();
  const imp = new Map<string, number>();
  const flow = new Map<string, number>();
  const reExport = new Map<string, number>();
  for (const r of rows) {
    const q = reportedQty(r, reporter);
    if (q === undefined) continue;
    quantity += q;
    year.set(r.y, (year.get(r.y) ?? 0) + q);
    add(source, r.s, q);
    add(purpose, r.p, q);
    if (r.e) add(exp, r.e, q);
    if (r.i) add(imp, r.i, q);
    if (r.e && r.i) add(flow, `${r.e}->${r.i}`, q);
    if (r.o && r.e) add(reExport, `${r.o}->${r.e}`, q);
  }
  return {
    quantity,
    byYear: [...year].sort(([a], [b]) => a - b).map(([y, q]) => ({ year: y, quantity: q })),
    bySource: totals(source),
    byPurpose: totals(purpose),
    exporters: totals(exp),
    importers: totals(imp),
    flows: flows(flow),
    reExports: flows(reExport),
  };
}

/** The guide this module follows, for linking from the UI. */
export const CITES_TRADE_GUIDE_URL =
  "https://trade.cites.org/cites_trade_guidelines/en-CITES_Trade_Database_Guide.pdf";
