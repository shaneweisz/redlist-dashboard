/**
 * Single source of truth for turning a /browse + MCP query (`BrowseInput`) into
 * the interactive dashboard URL that reproduces the SAME species set.
 *
 * The MCP tools and the /browse route answer from `runBrowseQuery`; this builds
 * the `/?…` link a human opens to verify that answer in the dashboard. To make
 * "the agent and the human see the same view" a guarantee rather than a hope,
 * every filter maps to a dashboard URL param that feeds the *same* filter
 * predicate the dashboard already runs (see useFilterParams.parseParams +
 * RedListView). It resolves values the same way runBrowseQuery does (via the
 * shared filter-vocab resolvers), so the two can't drift.
 *
 * Mapping notes (where the two vocabularies differ):
 *  - `region` → expanded to its `countries` (the dashboard stores a region AS its
 *    country set and re-derives the region chip), so it's lossless.
 *  - `outdated`, `minObs`/`maxObs`, `minAssessmentYear`/`maxAssessmentYear`,
 *    `minDescribedYear`/`maxDescribedYear` → emitted as exact URL params. The
 *    dashboard's on-screen charts use coarse buckets; these URL-only params feed
 *    the exact same numeric/`isOutdated` predicate so the result is identical.
 *  - taxa are emitted as a single flat token list (`taxa=corals,felidae`); the
 *    dashboard's parseParams expands each token to its display-root + sub-group
 *    (corals → invertebrates + inv-corals) — see taxonomy-utils. A scientific-rank
 *    taxon (`felidae`, `panthera`) has no node and is matched by class/order/family/genus.
 *  - `assessors`/`reviewers`/`facilitators`/`contributors`/`institutions`: both surfaces
 *    case-insensitively SUBSTRING-match the
 *    name (the dashboard predicate mirrors /browse), so a partial name selects the
 *    same species set in each.
 */
import type { BrowseInput } from "@/lib/browse-query";
import { applySharedFilters, emitSharedParams } from "@/lib/shared-filters";
import type { SpeciesFilterCriteria } from "@/lib/species-filter";
import { resolveTaxa, resolveCountries } from "@/lib/filter-vocab";
import { resolveRegions } from "@/lib/regions";
import { taxaUrlToken } from "@/lib/taxonomy-utils";
import { prettifyQs } from "@/lib/query-string";

const arr = (a?: string[]) => (a ?? []).map((s) => s.trim()).filter(Boolean);

/**
 * Build the dashboard query string (`?…`, or `""` when nothing resolved) that
 * reproduces `input`'s species set in the interactive dashboard at `/`.
 */
export function browseInputToDashboardQuery(input: BrowseInput): string {
  const p = new URLSearchParams();

  if (input.search && input.search.trim()) {
    // Species lookup → name search (substring on scientific/common name).
    p.set("search", input.search.trim());
  }

  // A single flat `taxa` token list (e.g. corals, felidae); the dashboard's
  // parseParams expands each token to its display-root + sub-group as needed.
  //
  // resolveTaxa returns INTERNAL node ids, which for a live-drilldown node spell out
  // the virtual-root prefix and every rank label (`pl-flowering_plants~order:
  // dioscoreales~family:dioscoreaceae`). Emitting those raw still resolves — the
  // reader accepts both spellings — but this is the link /browse and /api/mcp hand
  // back to a person or an agent, i.e. the most-shared URL the app produces, so it
  // should be the same short form the address bar shows rather than the long one.
  const taxaIds = resolveTaxa(arr(input.taxa)).ids;
  if (taxaIds.length) p.set("taxa", taxaIds.map(taxaUrlToken).join(","));

  // Categorical filters (categories, threats, systems, trends, movement,
  // growthForms, endemic) — resolved + emitted by the shared registry,
  // so the URL keys here can't drift from the MCP schema or the predicate.
  const criteria: SpeciesFilterCriteria = {};
  applySharedFilters(input, criteria);
  emitSharedParams(criteria, p);

  // The dashboard's Threats chart defaults to a threatened-only (CR/EN/VU) scope,
  // which also narrows a threat SELECTION (see RedListView's matchesThreatFilter).
  // /browse and MCP have no such scope — `threats` there is a plain code match over
  // every species — so a link carrying threats has to opt out of it explicitly, or
  // the dashboard would silently show a smaller set than the answer it links from.
  // Someone who wants the reliable-only view flips the card's dropdown themselves.
  if (p.get("threats")) p.set("threatsScope", "all");

  // Countries + region (region expands to its country set — lossless).
  const countries = new Set<string>([
    ...resolveCountries(arr(input.countries)).codes,
    ...resolveRegions(arr(input.region)).codes,
  ]);
  if (countries.size) p.set("countries", [...countries].join(","));

  const assessors = arr(input.assessors);
  if (assessors.length) p.set("assessors", assessors.join("|"));
  const reviewers = arr(input.reviewers);
  if (reviewers.length) p.set("reviewers", reviewers.join("|"));
  const facilitators = arr(input.facilitators);
  if (facilitators.length) p.set("facilitators", facilitators.join("|"));
  const contributors = arr(input.contributors);
  if (contributors.length) p.set("contributors", contributors.join("|"));
  const institutions = arr(input.institutions);
  if (institutions.length) p.set("institutions", institutions.join("|"));

  // Exact numeric / outdated params (URL-only; feed the same predicate the
  // dashboard runs, so the result matches the bucket-free /browse query).
  if (input.outdated === "yes" || input.outdated === "no") p.set("outdated", input.outdated);
  if (input.minObs != null) p.set("minObs", String(input.minObs));
  if (input.maxObs != null) p.set("maxObs", String(input.maxObs));
  if (input.records === "georeferenced") p.set("records", "georeferenced");
  if (input.minAssessmentYear != null) p.set("minAssessmentYear", String(input.minAssessmentYear));
  if (input.maxAssessmentYear != null) p.set("maxAssessmentYear", String(input.maxAssessmentYear));
  if (input.minDescribedYear != null) p.set("minDescribedYear", String(input.minDescribedYear));
  if (input.maxDescribedYear != null) p.set("maxDescribedYear", String(input.maxDescribedYear));

  const qs = prettifyQs(p.toString());
  return qs ? `?${qs}` : "";
}

/** Absolute dashboard URL for `input`, given the request origin (e.g. https://host). */
export function browseInputToDashboardUrl(origin: string, input: BrowseInput): string {
  return `${origin}/${browseInputToDashboardQuery(input)}`;
}
