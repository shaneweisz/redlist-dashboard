import { describe, it, expect } from "vitest";
import { countryWhere, countriesWhere, scopeWhere, outdatedSql } from "@/lib/data/scoped-taxa-summary-duckdb";
import { claimEligibleSiblingsSql } from "@/lib/taxonomy-sql";
import type { TaxonomyNode } from "@/config/taxonomy-tree";

// Unit tests for the pure SQL-fragment builders in scoped-taxa-summary-duckdb.ts.
// The live DuckDB queries themselves (getScopedTaxaSummary/getScopedChildrenSummaries)
// are verified manually against real data — cross-checked via curl against
// /api/redlist/taxa-summary?country=FR/BR and independently-run raw DuckDB queries,
// including a live claim-tracking case (Indonesia's ssc-fish-groups children summing
// to exactly the ground-truth fish total for that country) — same reasoning
// species-duckdb.test.ts gives for not exercising real parquet reads in CI.

describe("countryWhere", () => {
  it("uppercases the country code", () => {
    expect(countryWhere("fr")).toContain("'FR'");
  });

  it("escapes embedded single quotes", () => {
    expect(countryWhere("o'brien")).toContain("'O''BRIEN'");
  });

  it("checks exact list membership, not substring match", () => {
    const sql = countryWhere("FR");
    expect(sql).toContain("list_contains(string_split(coalesce(countries, ''), ';'), 'FR')");
  });
});

describe("countriesWhere", () => {
  it("matches countryWhere exactly for a single code", () => {
    expect(countriesWhere(["FR"])).toBe(countryWhere("FR"));
  });

  it("ORs multiple codes together — a species matching any one of them counts once, not per-code", () => {
    const sql = countriesWhere(["FR", "DE", "IT"]);
    expect(sql).toBe(`${countryWhere("FR")} OR ${countryWhere("DE")} OR ${countryWhere("IT")}`);
  });

  it("returns a predicate that matches nothing for an empty list", () => {
    expect(countriesWhere([])).toBe("FALSE");
  });
});

describe("outdatedSql", () => {
  it("treats a null assessment_date as outdated", () => {
    expect(outdatedSql("2016-01-01")).toContain("assessment_date IS NULL");
  });

  it("compares against the cutoff date as a DATE, not a TIMESTAMP", () => {
    const sql = outdatedSql("2016-01-01");
    expect(sql).toContain("CAST(assessment_date AS DATE) <= CAST('2016-01-01' AS DATE)");
  });
});

describe("claimEligibleSiblingsSql", () => {
  const node = (id: string, filter: TaxonomyNode["filter"]): TaxonomyNode => ({ id, name: id, filter });

  it("returns null when no sibling is claim-eligible", () => {
    const children = [
      node("a", { taxonGroups: ["fishes"], families: ["labridae"] }),
      node("catchall", { taxonGroups: ["fishes"], excludeClasses: ["chondrichthyes"] }),
    ];
    expect(claimEligibleSiblingsSql(children, 1)).toBeNull();
  });

  it("includes siblings scoped by classNames or orderNames", () => {
    const children = [
      node("primates", { taxonGroups: ["mammals"], orderNames: ["primates"] }),
      node("rodents", { taxonGroups: ["mammals"], classNames: ["mammalia"] }),
      node("catchall", { taxonGroups: ["mammals"], excludeClasses: [] }),
    ];
    const sql = claimEligibleSiblingsSql(children, 2);
    expect(sql).toContain("primates");
    expect(sql).toMatch(/\) OR \(/); // joins multiple siblings with OR
  });

  it("excludes families/genera/speciesNames-scoped siblings from claim eligibility", () => {
    const children = [
      node("pinnipeds", { taxonGroups: ["mammals"], families: ["otariidae"] }),
      node("catchall", { taxonGroups: ["mammals"], excludeClasses: [] }),
    ];
    expect(claimEligibleSiblingsSql(children, 1)).toBeNull();
  });

  it("excludes the node at excludeIdx itself even if it would otherwise be claim-eligible", () => {
    const children = [
      node("primates", { taxonGroups: ["mammals"], orderNames: ["primates"] }),
      node("rodents", { taxonGroups: ["mammals"], orderNames: ["rodentia"] }),
    ];
    const sql = claimEligibleSiblingsSql(children, 0);
    expect(sql).not.toContain("primates");
    expect(sql).toContain("rodentia");
  });
});

describe("scopeWhere", () => {
  it("returns null when nothing is scoped, signalling 'use the precomputed global artifacts'", () => {
    expect(scopeWhere([])).toBeNull();
  });

  it("wraps the countries' OR list in parens so it composes safely with other predicates", () => {
    expect(scopeWhere(["FR"])).toBe(`(${countriesWhere(["FR"])})`);
    expect(scopeWhere(["FR", "DE"])).toBe(`(${countriesWhere(["FR", "DE"])})`);
  });
});
