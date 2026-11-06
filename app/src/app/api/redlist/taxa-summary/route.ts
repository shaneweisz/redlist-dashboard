import { NextRequest, NextResponse } from "next/server";
import { getTaxaSummary } from "@/lib/data/species-store";
import { getScopedTaxaSummary, scopeWhere } from "@/lib/data/scoped-taxa-summary-duckdb";
import { findNode, getTaxonGroupsForNode } from "@/lib/taxonomy-utils";
import { getView } from "@/config/taxonomy-views";
import { CACHE_1H } from "@/lib/cache-headers";
import { GBIF_RECORDS_PARAM, parseGbifRecordMode } from "@/lib/gbif-records";

interface TaxonSummary {
  id: string;
  name: string;
  color: string;
  estimatedDescribed: number;
  available: boolean;
  totalAssessed: number;
  percentAssessed: number;
  outdated: number;
  percentOutdated: number;
  lastUpdated: string | null;
  byCategory: Record<string, number>;
  totalGbifObservations?: number;
  meanGbifObsPerSpecies?: number;
  medianGbifObsPerSpecies?: number;
  gbifSpeciesCount?: number;
  gbifNeSpeciesCount?: number;
  gbifObsDistribution?: Record<string, number>;
  // Catalogue of Life backbone (#271): extant accepted universe in this group and the
  // not-evaluated slice (universe − assessed). 0 if CoL artifacts aren't present.
  colDescribed?: number;
  colNe?: number;
}

function mergeByCategory(
  rows: Array<{ by_category: Record<string, number> }>
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const row of rows) {
    for (const [cat, count] of Object.entries(row.by_category ?? {})) {
      merged[cat] = (merged[cat] ?? 0) + count;
    }
  }
  return merged;
}

export async function GET(request: NextRequest) {
  try {
    // Scoped rows (by country and/or realm) carry zeroed estimatedDescribed/gbif*/col*
    // fields — neither dimension exists in that data, see scoped-taxa-summary-duckdb.ts's
    // doc comment. `scoped` tells the client to hide those columns outright
    // rather than render a misleading 0 — TaxaSummary.tsx must gate on this flag,
    // not on a field being present/absent, since every field is still populated.
    // Both params take one or more comma-separated values — a single country, a
    // whole region's worth, or an arbitrary multi-select all arrive the same way
    // here — and the two compose (?country=ID&realm=Marine is marine species in
    // Indonesia, not the union of the two).
    const countries = request.nextUrl.searchParams.get("country")?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];
    const realms = request.nextUrl.searchParams.get("realm")?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
    // Which GBIF records the gbif* totals count (src/lib/gbif-records.ts).
    const mode = parseGbifRecordMode(request.nextUrl.searchParams.get(GBIF_RECORDS_PARAM));
    const where = scopeWhere(countries, realms);
    const data = where ? await getScopedTaxaSummary(where) : getTaxaSummary();
    const scoped = where !== null;
    const rowsByGroup = new Map(
      data.map((row) => [row.table1a_taxon_group, row])
    );

    const isTable1a = request.nextUrl.searchParams.get("table1a") === "true";

    if (isTable1a) {
      // Return data structured by Table 1a sections from the view config
      const view = getView("table1a");
      const sections = (view.sections ?? []).map((section) => ({
        title: section.title,
        rows: section.nodeIds.map((nodeId) => {
          const node = findNode(nodeId);
          const taxonGroups = getTaxonGroupsForNode(nodeId);
          // For multi-group nodes, merge
          const matchedRows = taxonGroups
            .map((g) => rowsByGroup.get(g))
            .filter(Boolean) as typeof data;
          const totalAssessed = matchedRows.reduce(
            (sum, r) => sum + Number(r.total_assessed ?? 0), 0
          );
          const outdated = matchedRows.reduce(
            (sum, r) => sum + Number(r.outdated ?? 0), 0
          );
          const gbifSpeciesCount = matchedRows.reduce(
            (sum, r) => sum + Number(r.gbif?.[mode]?.species_count ?? 0), 0
          );
          const gbifNeSpeciesCount = matchedRows.reduce(
            (sum, r) => sum + Number(r.gbif?.[mode]?.ne_species_count ?? 0), 0
          );
          const totalGbifObservations = matchedRows.reduce(
            (sum, r) => sum + Number(r.gbif?.[mode]?.records ?? 0), 0
          );
          const colDescribed = matchedRows.reduce((sum, r) => sum + Number(r.col_described ?? 0), 0);
          const colNe = matchedRows.reduce((sum, r) => sum + Number(r.col_ne ?? 0), 0);
          const estimatedDescribed = node?.estimatedDescribed ?? 0;
          return {
            group: nodeId,
            name: node?.name ?? nodeId,
            estimatedDescribed,
            totalAssessed,
            percentAssessed: estimatedDescribed > 0 ? (totalAssessed / estimatedDescribed) * 100 : 0,
            outdated,
            percentOutdated: totalAssessed > 0 ? (outdated / totalAssessed) * 100 : 0,
            byCategory: matchedRows.length > 0 ? mergeByCategory(matchedRows.map((r) => ({ by_category: r.by_category ?? {} }))) : {},
            gbifSpeciesCount,
            gbifNeSpeciesCount,
            colDescribed,
            colNe,
            totalGbifObservations,
            meanGbifObsPerSpecies: gbifSpeciesCount > 0 ? totalGbifObservations / gbifSpeciesCount : undefined,
            medianGbifObsPerSpecies: matchedRows.length === 1 && matchedRows[0].gbif?.[mode]?.median != null
              ? Number(matchedRows[0].gbif[mode].median)
              : undefined,
          };
        }),
      }));
      return NextResponse.json({ sections, scoped }, { headers: CACHE_1H });
    }

    // Default view: use the 8-taxa view from taxonomy tree
    const defaultView = getView("default");
    const allNode = findNode("all");

    const taxa: TaxonSummary[] = [
      // "all" row first
      ...(allNode ? [{
        id: "all",
        name: allNode.name,
        color: allNode.color ?? "#dc2626",
        estimatedDescribed: allNode.estimatedDescribed ?? 0,
        available: true,
        totalAssessed: 0, // Will be computed below
        percentAssessed: 0,
        outdated: 0,
        percentOutdated: 0,
        lastUpdated: null,
        byCategory: {} as Record<string, number>,
      }] : []),
      // Per-taxon rows
      ...defaultView.roots.map((nodeId) => {
        const node = findNode(nodeId);
        if (!node) {
          return {
            id: nodeId,
            name: nodeId,
            color: "#78716c",
            estimatedDescribed: 0,
            available: false,
            totalAssessed: 0,
            percentAssessed: 0,
            outdated: 0,
            percentOutdated: 0,
            lastUpdated: null,
            byCategory: {},
          };
        }

        const groups = getTaxonGroupsForNode(nodeId);
        const matchedRows = groups
          .map((g) => rowsByGroup.get(g))
          .filter(Boolean) as typeof data;

        const available = matchedRows.length > 0;

        const totalAssessed = matchedRows.reduce(
          (sum, r) => sum + Number(r.total_assessed ?? 0), 0
        );
        const outdated = matchedRows.reduce(
          (sum, r) => sum + Number(r.outdated ?? 0), 0
        );
        const byCategory = mergeByCategory(
          matchedRows.map((r) => ({ by_category: r.by_category ?? {} }))
        );
        const totalGbifObservations = matchedRows.reduce(
          (sum, r) => sum + Number(r.gbif?.[mode]?.records ?? 0), 0
        );
        const gbifSpeciesCount = matchedRows.reduce(
          (sum, r) => sum + Number(r.gbif?.[mode]?.species_count ?? 0), 0
        );
        const gbifNeSpeciesCount = matchedRows.reduce(
          (sum, r) => sum + Number(r.gbif?.[mode]?.ne_species_count ?? 0), 0
        );
        const colDescribed = matchedRows.reduce((sum, r) => sum + Number(r.col_described ?? 0), 0);
        const colNe = matchedRows.reduce((sum, r) => sum + Number(r.col_ne ?? 0), 0);
        const meanGbifObsPerSpecies =
          gbifSpeciesCount > 0 ? totalGbifObservations / gbifSpeciesCount : undefined;

        const medianGbifObsPerSpecies =
          matchedRows.length === 1 && matchedRows[0].gbif?.[mode]?.median != null
            ? Number(matchedRows[0].gbif[mode].median)
            : undefined;

        const estimatedDescribed = node.estimatedDescribed ?? 0;

        return {
          id: nodeId,
          name: node.name,
          color: node.color ?? "#78716c",
          estimatedDescribed,
          available,
          totalAssessed,
          percentAssessed:
            estimatedDescribed > 0
              ? (totalAssessed / estimatedDescribed) * 100
              : 0,
          outdated,
          percentOutdated:
            totalAssessed > 0 ? (outdated / totalAssessed) * 100 : 0,
          lastUpdated: null,
          byCategory,
          totalGbifObservations: available ? totalGbifObservations : undefined,
          meanGbifObsPerSpecies: available ? meanGbifObsPerSpecies : undefined,
          medianGbifObsPerSpecies: available ? medianGbifObsPerSpecies : undefined,
          gbifSpeciesCount: available ? gbifSpeciesCount : undefined,
          gbifNeSpeciesCount: available ? gbifNeSpeciesCount : undefined,
          colDescribed: available ? colDescribed : undefined,
          colNe: available ? colNe : undefined,
        };
      }),
    ];

    // Populate the "all" row by summing per-taxon data
    const allEntry = taxa.find((t) => t.id === "all");
    if (allEntry) {
      const perTaxonRows = taxa.filter((t) => t.id !== "all");
      allEntry.totalAssessed = perTaxonRows.reduce((s, t) => s + t.totalAssessed, 0);
      allEntry.outdated = perTaxonRows.reduce((s, t) => s + t.outdated, 0);
      allEntry.percentAssessed = allEntry.estimatedDescribed > 0
        ? (allEntry.totalAssessed / allEntry.estimatedDescribed) * 100
        : 0;
      allEntry.percentOutdated = allEntry.totalAssessed > 0
        ? (allEntry.outdated / allEntry.totalAssessed) * 100
        : 0;
      allEntry.byCategory = mergeByCategory(
        perTaxonRows.map((t) => ({ by_category: t.byCategory }))
      );
      const totalGbif = perTaxonRows.reduce((s, t) => s + (t.totalGbifObservations ?? 0), 0);
      const gbifCount = perTaxonRows.reduce((s, t) => s + (t.gbifSpeciesCount ?? 0), 0);
      const gbifNeCount = perTaxonRows.reduce((s, t) => s + (t.gbifNeSpeciesCount ?? 0), 0);
      allEntry.totalGbifObservations = totalGbif;
      allEntry.gbifSpeciesCount = gbifCount;
      allEntry.gbifNeSpeciesCount = gbifNeCount;
      allEntry.meanGbifObsPerSpecies = gbifCount > 0 ? totalGbif / gbifCount : undefined;
      allEntry.colDescribed = perTaxonRows.reduce((s, t) => s + (t.colDescribed ?? 0), 0);
      allEntry.colNe = perTaxonRows.reduce((s, t) => s + (t.colNe ?? 0), 0);
    }

    return NextResponse.json({ taxa, scoped }, { headers: CACHE_1H });
  } catch (error) {
    console.error("Taxa summary error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Taxa summary failed: ${message}` },
      { status: 500 }
    );
  }
}
