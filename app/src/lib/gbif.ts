/**
 * GBIF taxonomy constants, shared by the sync scripts and the runtime API routes.
 *
 * GBIF relaunched gbif.org on 18 June 2026 with the Catalogue of Life Extended
 * Release as its default taxonomy, replacing the GBIF Backbone that had organised
 * occurrence records until then. The backbone was last updated in 2023 and will
 * not be updated again.
 *
 * The two use different key spaces — backbone keys are integers (2434814), CoL
 * keys are alphanumeric ("43MJ7") — and a key from one resolves to nothing in the
 * other. GBIF reports that as an **empty result set, not an error**, so the
 * failure is always silent: counts become 0, links land on "0 records", species
 * quietly vanish from a list.
 *
 * Which is why every request names its checklist explicitly. gbif.org already
 * defaults to CoL while the v1 API still defaults to the backbone; those defaults
 * will converge eventually, and anything leaving `checklistKey` unset is relying
 * on which side of that convergence it happens to run on.
 *
 * See docs/gbif-col-migration.md for how the pipeline moved onto CoL and why
 * GBIF, rather than a local copy of the checklist, is the authority for its keys.
 *
 * @see https://data-blog.gbif.org/post/catalogue-of-life-taxonomic-backbone/
 */

import DERIVED_TAXON_KEYS from "@/config/gbif-taxon-keys.json";
import { mapTaxonId } from "@/lib/data/taxonomy-constants";

/** Catalogue of Life Extended Release — gbif.org's default taxonomy since June 2026. */
export const COL_XR_CHECKLIST_KEY = "7ddf754f-d193-4cc9-b351-99906754a03b";

/** The legacy GBIF Backbone Taxonomy, frozen at 2023. Kept to explain the move. */
export const GBIF_BACKBONE_CHECKLIST_KEY = "d7dddbf4-2cf0-4f39-9b2a-bb099caae36c";

/**
 * The checklist this project's stored `gbif_species_key` values belong to, and
 * therefore the one every query and link must name.
 *
 * Flipping this constant is not by itself a migration — the stored keys have to
 * change with it, or every query asks one taxonomy about another's keys and gets
 * an empty result set back. The pipeline now derives its group keys from CoL
 * (scripts/derive-gbif-taxon-keys.ts) and resolves species keys and names through
 * GBIF against this checklist, so the keys and this constant move together.
 */
export const GBIF_CHECKLIST_KEY = COL_XR_CHECKLIST_KEY;

/**
 * Occurrence types this dashboard counts for animals: georeferenced records
 * representing an observation of a living organism in the wild. Excludes
 * preserved, fossil and living specimens (herbaria, museums, zoos) and material
 * citations.
 */
export const INCLUDED_BASIS_OF_RECORD = [
  "HUMAN_OBSERVATION",
  "MACHINE_OBSERVATION",
  "OCCURRENCE",
  "MATERIAL_SAMPLE",
  "OBSERVATION",
] as const;

/**
 * Plants and fungi count preserved specimens too.
 *
 * A herbarium or fungarium sheet is not a museum curiosity for these kingdoms —
 * it is the primary, and for many species the only, georeferenced record of the
 * taxon, and it is what a Red List assessment is actually written from. Counting
 * only field observations reported Parkinsonia peruviana (a Peruvian tree) as
 * having one georeferenced GBIF record when it has 31 — the other 30 are
 * herbarium sheets. That reads as "almost nothing is known about this species"
 * when what is known simply sits in a different record type.
 *
 * The map's basis-of-record checkboxes have defaulted preserved specimens ON for
 * plants and fungi since they were added; this applies the same rule to the
 * counts behind the map, so the two describe the same records.
 */
export const INCLUDED_BASIS_OF_RECORD_WITH_SPECIMENS = [
  ...INCLUDED_BASIS_OF_RECORD,
  "PRESERVED_SPECIMEN",
] as const;

/** The occurrence types counted for a taxon, per the rule above. */
export function includedBasisOfRecord(includePreservedSpecimens: boolean): readonly string[] {
  return includePreservedSpecimens
    ? INCLUDED_BASIS_OF_RECORD_WITH_SPECIMENS
    : INCLUDED_BASIS_OF_RECORD;
}

/**
 * The GBIF occurrence issues that make `hasGeospatialIssue` true — the ones
 * GBIF distrusts a record's position enough to exclude it over. A record
 * carrying one still has coordinates; GBIF just doesn't trust them, which is
 * exactly what makes it a candidate for manual re-georeferencing rather than
 * something to silently drop.
 *
 * This set has to be exactly GBIF's, because the viewer fetches the two sides
 * of that filter separately and in order — every record `hasGeospatialIssue=false`
 * returns, then the ones it excludes. A code in here that GBIF does not act on
 * puts records the "trusted" query already returned into the flagged bucket,
 * where they get painted as suspect and hidden by a check the assessor never
 * aimed at them.
 *
 * Two used to be in here that GBIF doesn't act on — see GBIF_COORDINATE_NOTES.
 * Membership was checked against the API rather than read off the docs, per
 * code: `issue=<code>&hasGeospatialIssue=false` returns nothing for every code
 * below, and returns records for both of the two.
 *
 * Occurrence records also carry issues with nothing to do with position (fuzzy
 * taxon matches, invalid dates); those are filtered out rather than shipped to
 * the client, since nothing in the occurrence viewer acts on them.
 */
export const GBIF_GEOSPATIAL_ISSUES = new Set([
  "ZERO_COORDINATE",
  "COORDINATE_INVALID",
  "COORDINATE_OUT_OF_RANGE",
  "COORDINATE_REPROJECTION_FAILED",
  "COUNTRY_COORDINATE_MISMATCH",
  "CONTINENT_COORDINATE_MISMATCH",
  "PRESUMED_NEGATED_LATITUDE",
  "PRESUMED_NEGATED_LONGITUDE",
  "PRESUMED_SWAPPED_COORDINATE",
]);

/**
 * Position-related issues GBIF reports but does not exclude a record over: an
 * unparseable datum string (GBIF reads the coordinates as WGS84 and says so),
 * and a reprojection that moved the point further than expected.
 *
 * Shown in the record list's Flags column, because they are worth knowing when
 * you are reading a locality — but not treated as GBIF flagging the record,
 * because GBIF didn't. Seven of the cheetah's first page carried the datum one
 * and were being hidden as flagged while sitting in the trusted set.
 */
export const GBIF_COORDINATE_NOTES = new Set([
  "GEODETIC_DATUM_INVALID",
  "COORDINATE_REPROJECTION_SUSPICIOUS",
]);

/** Human-readable label for a GBIF issue code, e.g. "Country coordinate mismatch". */
export function formatGbifIssue(issue: string): string {
  const words = issue.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Catalogue of Life kingdom key for Animalia — the taxa config carries N/P/F/C. */
const COL_KINGDOM_ANIMALIA = "N";

/**
 * Whether a kingdom's counts include preserved specimens, for the sync scripts,
 * which query GBIF per Table 1a group and know the kingdom each one sits in.
 *
 * Everything except Animalia: Plantae and Fungi for the reason above, and
 * Chromista because the only Chromista group here is brown algae, which the
 * dashboard files under fungi and which are likewise known mostly from
 * collected, preserved material.
 */
export function kingdomCountsPreservedSpecimens(colKingdomKey: string): boolean {
  return colKingdomKey !== COL_KINGDOM_ANIMALIA;
}

/**
 * The same rule expressed over a Table 1a taxon group (`flowering_plants`,
 * `mushrooms`…) or a dashboard taxon id (`plantae`), for the runtime, which
 * knows a species' group rather than its kingdom. Kept in step with
 * kingdomCountsPreservedSpecimens by a test over every group.
 */
export function taxonGroupCountsPreservedSpecimens(taxonGroup: string | undefined): boolean {
  if (!taxonGroup) return false;
  const taxonId = mapTaxonId(taxonGroup);
  return taxonId === "plantae" || taxonId === "fungi";
}

/**
 * Base parameters shared by every GBIF occurrence query and outbound link, so a
 * count shown here and the search a user lands on describe the same records.
 *
 * `includePreservedSpecimens` follows the taxon: pass it wherever the caller
 * knows which group the query is about, or the link next to a plant's count will
 * land on a search that excludes most of what the count included.
 */
export function gbifOccurrenceParams(
  extra: Record<string, string> = {},
  { includePreservedSpecimens = false }: { includePreservedSpecimens?: boolean } = {},
): URLSearchParams {
  const params = new URLSearchParams({
    checklistKey: GBIF_CHECKLIST_KEY,
    hasCoordinate: "true",
    hasGeospatialIssue: "false",
    ...extra,
  });
  includedBasisOfRecord(includePreservedSpecimens).forEach((b) =>
    params.append("basisOfRecord", b),
  );
  return params;
}

/**
 * The GBIF taxon keys making up a dashboard-level group (mammals, invertebrates…).
 *
 * Read from the generated config rather than kept alongside it. This file used to
 * carry its own parallel list of backbone keys, and when the pipeline moved to
 * Catalogue of Life that list stayed behind — so country statistics went on
 * sending integer class keys while naming the CoL checklist, and GBIF answered
 * every one of them with an empty result set. One source, derived from the Red
 * List group definitions, is the only arrangement that cannot drift.
 *
 * Dashboard groups are coarser than the Table 1a groups the config is keyed by
 * (everything from beetles to corals rolls up into "invertebrates"), so the keys
 * of every constituent group are unioned via the same mapping the rest of the app
 * uses.
 */
export function gbifTaxonKeysForGroup(taxonId: string): string[] {
  const keys = new Set<string>();
  for (const [group, entries] of Object.entries(DERIVED_TAXON_KEYS)) {
    if (mapTaxonId(group) !== taxonId) continue;
    for (const entry of entries) {
      if (entry.taxonKey) keys.add(entry.taxonKey);
    }
  }
  return [...keys];
}
