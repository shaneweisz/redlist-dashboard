/**
 * GET /api/redlist/credit-candidates — who could assess, review or facilitate a
 * Not-Evaluated species, ranked at every taxonomic granularity at once.
 *
 * One endpoint for all three credit lines (`role=`), replacing the two
 * near-identical {assessor,reviewer}-candidates-by-country routes: they differed
 * only in which column they read, and facilitators would have made a third copy.
 *
 * Scope comes from the TARGET SPECIES' own lineage (its taxon group, class, order,
 * family, genus) rather than from the dashboard's selected taxon — see
 * getCreditCandidates. That is what lets one response carry a ranking at every
 * granularity, and why the selected node (which live drilldown could make an id
 * the static tree has no entry for) does not figure in this query at all.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCreditCandidates } from "@/lib/data/species-store";
import { getCreditSource } from "@/lib/data/species-duckdb";
import { CREDIT_ROLES, type CreditRole, type CandidateRank } from "@/lib/credit-candidates";
import { findNode } from "@/lib/taxonomy-utils";
import { buildDynamicNodeId, dynamicNodeDisplayName } from "@/lib/dynamic-taxon";
import { ensureVernacularNamesLoaded } from "@/lib/data/vernacular-names";
import { CACHE_5M } from "@/lib/cache-headers";

/** "flowering_plants" -> "Flowering Plants", for a group with no tree node. */
const titleCase = (s: string) =>
  s.split(/[_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/**
 * Display label per rank: the taxon group's own name at the top, and the target's
 * scientific name at each rank below — with its common name where one is known.
 *
 * The vernacular lookup lives behind dynamicNodeDisplayName (the hand-curated
 * overrides plus the CoL-derived names), which is keyed by a dynamic node id, so
 * a one-segment id is built to ask it. Only the deepest segment is read, so the
 * root the id is built on doesn't matter.
 */
function rankLabels(
  ranks: CandidateRank[],
  target: { taxonGroup: string; scientificName?: string | null; className?: string | null; orderName?: string | null; family?: string | null },
): Partial<Record<CandidateRank, string>> {
  ensureVernacularNamesLoaded();
  const named = (rank: "class" | "order" | "family" | "genus", value: string | null | undefined) => {
    const v = (value ?? "").trim().toLowerCase();
    return v ? dynamicNodeDisplayName(buildDynamicNodeId(target.taxonGroup, [{ rank, value: v }])) : undefined;
  };
  const labels: Partial<Record<CandidateRank, string>> = {};
  for (const rank of ranks) {
    const label =
      rank === "group" ? (findNode(target.taxonGroup)?.name ?? titleCase(target.taxonGroup))
      : rank === "class" ? named("class", target.className)
      : rank === "order" ? named("order", target.orderName)
      : rank === "family" ? named("family", target.family)
      : named("genus", (target.scientificName ?? "").trim().split(/\s+/)[0]);
    if (label) labels[rank] = label;
  }
  return labels;
}

const isCreditRole = (v: string | null): v is CreditRole =>
  !!v && (CREDIT_ROLES as readonly string[]).includes(v);

export async function handleCandidatesRequest(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const taxonGroup = searchParams.get("taxonGroup");
  const roleParam = searchParams.get("role");
  const countriesParam = searchParams.get("countries") ?? "";

  if (!taxonGroup) {
    return NextResponse.json({ error: "taxonGroup is required" }, { status: 400 });
  }
  if (!isCreditRole(roleParam)) {
    return NextResponse.json(
      { error: `role must be one of ${CREDIT_ROLES.join(", ")}` },
      { status: 400 },
    );
  }
  const role: CreditRole = roleParam;

  const target = {
    taxonGroup,
    scientificName: searchParams.get("scientificName"),
    className: searchParams.get("class"),
    orderName: searchParams.get("order"),
    family: searchParams.get("family"),
  };
  const countries = countriesParam.split(";").filter(Boolean);

  try {
    const source = await getCreditSource(target.taxonGroup);
    const { candidates, ranks, defaultRank } = getCreditCandidates(role, target, countries, source);
    return NextResponse.json(
      { candidates, ranks, defaultRank, labels: rankLabels(ranks, target) },
      { headers: CACHE_5M },
    );
  } catch (error) {
    console.error(`${role} candidates error:`, error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `${role} candidates query failed: ${message}` }, { status: 500 });
  }
}
