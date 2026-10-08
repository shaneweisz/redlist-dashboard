/**
 * taxaScopeSql turns a `taxa=` URL token into a predicate over assessed.parquet.
 *
 * It is the whole of what "filter the narrative search by taxonomic group"
 * means server-side (#565), and the failure that matters is silent: a token the
 * resolver doesn't recognize must narrow to nothing, never widen to everything
 * — a search that quietly ignores its own filter looks exactly like a search
 * that honoured it. So these pin the shape of each resolution path, and that
 * only an explicitly-empty scope returns null.
 */
import { describe, it, expect } from "vitest";
import { taxaScopeSql } from "@/lib/taxa-scope-sql";

describe("taxaScopeSql", () => {
  it("scopes nothing for an absent, blank or all-groups token", () => {
    expect(taxaScopeSql(undefined)).toBeNull();
    expect(taxaScopeSql(null)).toBeNull();
    expect(taxaScopeSql("   ")).toBeNull();
    expect(taxaScopeSql("all")).toBeNull();
  });

  it("scopes a display root to its taxon group", () => {
    expect(taxaScopeSql("mammals")).toContain("taxon_group IN ('mammals')");
  });

  it("scopes a sub-group token to the sub-group, not just its root", () => {
    // corals is a child of the Invertebrates virtual root (inv-corals) — the
    // root alone would match every invertebrate, which is the bug this exists
    // to avoid: resolveWhere() deliberately stops at the root because the
    // dashboard refines client-side, and a search page has nothing to refine.
    const sql = taxaScopeSql("corals");
    expect(sql).toContain("taxon_group IN ('corals')");
    expect(sql).not.toContain("'insects'");
  });

  it("scopes a live-drilldown token to its whole rank chain", () => {
    // The token from the issue: Flowering Plants → Dioscoreales → Dioscoreaceae.
    const sql = taxaScopeSql("flowering_plants~dioscoreales~dioscoreaceae");
    expect(sql).toContain("taxon_group IN ('flowering_plants')");
    expect(sql).toContain("'dioscoreales'");
    expect(sql).toContain("coalesce(lower(family), '') IN ('dioscoreaceae')");
  });

  it("falls back to an arbitrary-rank match for a name outside the tree", () => {
    const sql = taxaScopeSql("panthera");
    expect(sql).toContain("coalesce(lower(class_name), '') = 'panthera'");
    expect(sql).toContain("coalesce(lower(order_name), '') = 'panthera'");
    expect(sql).toContain("coalesce(lower(family), '') = 'panthera'");
    // A genus has no column of its own in any of the parquets — it is the first
    // word of the scientific name, as everywhere else in the app.
    expect(sql).toContain("split_part(scientific_name, ' ', 1)");
  });

  it("escapes a token rather than letting it become SQL", () => {
    const sql = taxaScopeSql("o'brien") ?? "";
    expect(sql).toContain("'o''brien'");
    expect(sql).not.toContain("= 'o'brien'");
  });
});
