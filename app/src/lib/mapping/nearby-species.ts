/**
 * What else has been recorded here, and what it was assessed under.
 *
 * An assessor working one species on the map has a question the map itself
 * can't answer: which other species are known from this spot, and what did
 * their assessors decide was threatening them? A threat is rarely private to a
 * taxon — the dam, the plantation, the road that put the neighbours on the list
 * is very often the same pressure acting on the species being written up. Being
 * shown "twelve of the species recorded within 25 km cite Annual & perennial
 * non-timber crops" is a prompt to go and check, not a finding.
 *
 * Two sources, each doing the part it is authoritative for:
 *
 *   - GBIF answers "what is recorded here", via a radius search faceted by
 *     species. That is the only side that knows about occurrences.
 *   - The Red List parquets answer "and what was it assessed under" — category,
 *     criteria, threat codes. GBIF carries an IUCN category of its own, from a
 *     checklist snapshot it ingests, and it is not necessarily the category this
 *     dashboard holds. So GBIF's is used to *narrow the search* and never to
 *     label anything: every category shown to an assessor is ours.
 *
 * Why narrow on GBIF's category at all, rather than facet everything and filter
 * ours afterwards: a 25 km radius in the tropics holds hundreds of thousands of
 * records across thousands of species, and a facet has a size limit. Spending it
 * on the whole community returns the commonest few hundred — abundant birds and
 * weeds — and a threatened species is by definition not that, so exactly the
 * rows worth seeing are the ones truncation drops. Pre-filtering to GBIF's
 * threatened set spends the entire budget on candidates. The cost is that a
 * species GBIF has a stale category for can be missed; that is the honest
 * trade and NEARBY_STALENESS_NOTE says so in the UI.
 */

import { COL_XR_CHECKLIST_KEY } from "@/lib/gbif";

/** Radii offered in the panel. Beyond ~50 km "near here" stops meaning much. */
export const NEARBY_RADII_KM = [10, 25, 50] as const;
export type NearbyRadiusKm = (typeof NEARBY_RADII_KM)[number];

/**
 * Opens at the tightest radius, because the panel now hangs off a record.
 *
 * "Near this record" is a much narrower claim than "near this map", and the
 * narrow one is both the question being asked and the cheaper answer: a 10 km
 * circle around a collection locality returns a list you can read, where 50 km
 * around a point in a well-collected part of the world hits the facet ceiling
 * and hands back 300 species sorted by how common they are. Widening is one
 * click for when the tight answer is too thin.
 */
export const NEARBY_RADIUS_DEFAULT: NearbyRadiusKm = 10;

/**
 * The categories asked of GBIF: the threatened three, plus Near Threatened.
 *
 * NT earns its place because the threats are the point rather than the ranking
 * — an NT neighbour was assessed against the same pressures and its assessment
 * is just as much a precedent to read.
 */
export const NEARBY_CATEGORIES = ["CR", "EN", "VU", "NT"] as const;

/**
 * How many species the facet may return. GBIF caps facetLimit well above this;
 * the ceiling here is the panel, which stops being readable long before it.
 */
export const NEARBY_FACET_LIMIT = 300;

export const NEARBY_STALENESS_NOTE =
  "Found via GBIF's own Red List categories, which lag this dashboard's; categories and threats shown are from the current assessment.";

/**
 * What "recorded here" does and doesn't mean, said where the numbers are.
 *
 * Every caveat that applies to a GBIF radius search applies to this panel:
 * collecting effort is wildly uneven, a record can be a vagrant, a cultivated
 * plant or a century-old specimen, and absence from the list is not absence
 * from the place.
 */
export const NEARBY_RECORDS_NOTE =
  "GBIF records within the radius — uneven collecting effort, and a record may be a vagrant, cultivated or historical. Nothing here is evidence of absence.";

/**
 * The colour the search radius is drawn in, shared by the circle on the map and
 * the panel that explains it. Distinct from the violet the assessor's own
 * georeference circles use — these two are both rings on the same ground and
 * mean entirely different things.
 */
export const NEARBY_SEARCH_COLOR = "#0ea5e9";

/**
 * The colours picked neighbours' records are drawn in, in the order they are
 * handed out.
 *
 * Chosen against what this map already draws rather than for prettiness. Its
 * own records are grey (#d1d5db/#9ca3af), amber (#fbbf24 — flagged), green
 * (#4ade80 — new since the assessment) and near-black; its layers are violet
 * (georeferences), blue (an imported point file), two pinks (protected areas,
 * forest loss) and sky (the search radius). Every one of those hue families is
 * avoided here, because a neighbour that reads as a flagged record or as one of
 * the assessor's own is worse than one that isn't drawn.
 *
 * The last two are the closest calls and worth knowing about: cyan sits near the
 * radius's sky, and violet near the georeference marker — but the radius is a
 * thin dashed ring and georeferences only appear when the assessor has made
 * some, so neither competes with a dot in practice.
 */
export const NEARBY_PICKED_COLORS = [
  "#0f766e", // teal
  "#a21caf", // fuchsia
  "#4338ca", // indigo
  "#be123c", // rose
  "#0e7490", // cyan
  "#6d28d9", // violet
] as const;

/** How many neighbours can be drawn at once — one per colour, and no more. */
export const NEARBY_MAX_PICKED = NEARBY_PICKED_COLORS.length;

/**
 * How many of a picked species' records to draw.
 *
 * A hundred is enough to show the shape of where a species has been found in a
 * circle this size, and few enough that each cross stays a thing you can aim a
 * click at rather than part of a mass. The panel says when it is showing a
 * sample rather than all of them.
 */
export const NEARBY_POINTS_LIMIT = 100;

/**
 * One drawn record of a picked neighbour.
 *
 * Carries what its tooltip shows, because these are clickable in the same way
 * the map's own records are — a cross you can't interrogate is barely better
 * than no cross.
 */
export interface NearbyPoint {
  gbifID: number;
  lat: number;
  lng: number;
  species: string | null;
  eventDate: string | null;
  year: number | null;
  basis: string | null;
  recordedBy: string | null;
  identifiedBy: string | null;
  locality: string | null;
  countryCode: string | null;
  uncertaintyMetres: number | null;
  catalogNumber: string | null;
  datasetName: string | null;
  /**
   * Photographs the publisher attached, as the map's own records carry them.
   *
   * A neighbour's record answers in the same panel as this map's own, and for
   * a great many records the photograph *is* the evidence — a herbarium sheet,
   * a camera-trap frame. Leaving it out made a neighbour's panel quietly poorer
   * than the one beside it.
   */
  images: { url: string; title?: string; creator?: string; license?: string; rightsHolder?: string }[];
}

/**
 * Order two IUCN threat codes the way the classification is numbered.
 *
 * Segment by segment and numerically. Compared as strings "11.4" sorts before
 * "2.1", and a table that disagrees with the summary above it is worse than an
 * unsorted one. Accepts either spelling — the API writes "2_1_3", people write
 * "2.1.3".
 */
export function compareThreatCodes(a: string, b: string): number {
  const parts = (c: string) => c.replace(/_/g, ".").split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The twelve top-level IUCN threat categories.
 *
 * Duplicated from lib/filter-vocab, which cannot cross to the browser (it
 * reaches node's `fs` through vernacular-names). A test pins these against that
 * file's own list, so the copy cannot drift without failing.
 */
export const THREAT_TOP_LEVEL: Record<string, string> = {
  "1": "Development",
  "2": "Agriculture",
  "3": "Energy & Mining",
  "4": "Transport",
  "5": "Harvesting",
  "6": "Disturbance",
  "7": "System modifications",
  "8": "Invasive species",
  "9": "Pollution",
  "10": "Geological events",
  "11": "Climate change",
  "12": "Other",
};

/**
 * The neighbours' records under one click, in draw order and deduped.
 *
 * Records stack: a locality collected from repeatedly puts several dots on the
 * same pixel, and with only the topmost one reachable the rest were invisible.
 * MapLibre hands back every feature under the pointer, so the click can open
 * the whole stack and page through it the way the map's own records do — and it
 * can hand back the same feature twice where tile boundaries overlap, which is
 * what the dedupe is for.
 */
export function groupNearbyFeatures(
  features: readonly { properties?: Record<string, unknown> | null }[],
  pointsByKey: Record<string, { points: NearbyPoint[] }>
): NearbyPoint[] {
  const seen = new Set<number>();
  const group: NearbyPoint[] = [];
  for (const f of features) {
    const i = Number(f.properties?.nearbyIndex);
    const key = String(f.properties?.nearbyKey ?? "");
    const pt = Number.isFinite(i) ? pointsByKey[key]?.points[i] : undefined;
    if (pt && !seen.has(pt.gbifID)) {
      seen.add(pt.gbifID);
      group.push(pt);
    }
  }
  return group;
}

/** Where a picked neighbour's records are, inside the same radius. */
export function nearbyPointsUrl(opts: {
  lat: number;
  lng: number;
  radiusKm: number;
  speciesKey: string;
}): string {
  const params = new URLSearchParams({
    geoDistance: `${opts.lat},${opts.lng},${opts.radiusKm}km`,
    // Same checklist as the facet that produced this key — see nearbyFacetUrl.
    checklistKey: COL_XR_CHECKLIST_KEY,
    taxonKey: opts.speciesKey,
    hasCoordinate: "true",
    hasGeospatialIssue: "false",
    limit: String(NEARBY_POINTS_LIMIT),
  });
  return `https://api.gbif.org/v1/occurrence/search?${params}`;
}

/** One species recorded in the radius, as the panel shows it. */
export interface NearbySpecies {
  gbif_species_key: string;
  scientific_name: string;
  common_name: string | null;
  /** This dashboard's category, not GBIF's. */
  category: string;
  criteria: string | null;
  taxon_group: string;
  class_name: string | null;
  threat_codes: string[];
  /** Year of the assessment, not of its publication. */
  assessment_year: number | null;
  /** The assessment behind it, for fetching what it says about threats. */
  assessment_id: number | null;
  /**
   * The threats its assessment cites, as codes with their labels.
   *
   * Two levels deep — "5.4", not "5.4.1" — because that is the level at which
   * a threat is a thing you recognise ("Fishing & harvesting") rather than a
   * classification leaf, and because a species citing four leaves under one
   * sub-code would otherwise wear four tags saying the same thing. Labelled
   * here, on the server, since the IUCN threat vocabulary lives in
   * lib/filter-vocab, which cannot cross to the browser (see nearby-threats).
   */
  threat_tags: { code: string; label: string }[];
  /** GBIF records for this species inside the radius. */
  records: number;
  sis_taxon_id: number | null;
  /** `species=` param for the dashboard, when the species has a row there. */
  dashboard_row_key: string | null;
}

export interface NearbyResult {
  lat: number;
  lng: number;
  radiusKm: number;
  /** Records in the radius across all taxa, assessed or not — the denominator. */
  totalRecords: number;
  /** Records in the radius belonging to the categories asked for. */
  categoryRecords: number;
  species: NearbySpecies[];
  /** Species GBIF returned that this dashboard's data doesn't carry a row for. */
  unmatched: number;
  /** The facet hit its limit, so the list is the commonest, not all of them. */
  truncated: boolean;
}

/**
 * A GBIF occurrence-search URL for the radius.
 *
 * `checklistKey` is not optional. GBIF's v1 API still defaults to the frozen
 * 2023 backbone while this project's stored keys are Catalogue of Life ones, and
 * a key from one taxonomy resolves to nothing in the other *without an error* —
 * the facet simply comes back in the wrong key space and every join misses. That
 * is not hypothetical: dropped from a first draft of this file, it matched 0 of
 * 205 species. See lib/gbif.ts.
 */
export function nearbyFacetUrl(opts: {
  lat: number;
  lng: number;
  radiusKm: number;
  categories?: readonly string[];
  facetLimit?: number;
}): string {
  const params = new URLSearchParams({
    geoDistance: `${opts.lat},${opts.lng},${opts.radiusKm}km`,
    checklistKey: COL_XR_CHECKLIST_KEY,
    hasCoordinate: "true",
    // Records GBIF itself flags as positionally suspect would put species in a
    // radius they may have no business in, and this panel is entirely about
    // where things are.
    hasGeospatialIssue: "false",
    facet: "speciesKey",
    facetLimit: String(opts.facetLimit ?? NEARBY_FACET_LIMIT),
    // Only the facet is wanted; the records themselves are never read.
    limit: "0",
  });
  for (const c of opts.categories ?? NEARBY_CATEGORIES) {
    params.append("iucnRedListCategory", c);
  }
  return `https://api.gbif.org/v1/occurrence/search?${params}`;
}

/** The same radius on gbif.org, so the assessor can go and look at the records. */
export function nearbyGbifSiteUrl(opts: {
  lat: number;
  lng: number;
  radiusKm: number;
  speciesKey?: string;
}): string {
  const params = new URLSearchParams({
    geoDistance: `${opts.lat},${opts.lng},${opts.radiusKm}km`,
    checklistKey: COL_XR_CHECKLIST_KEY,
    hasCoordinate: "true",
    hasGeospatialIssue: "false",
  });
  if (opts.speciesKey) params.set("taxonKey", opts.speciesKey);
  return `https://www.gbif.org/occurrence/search?${params}`;
}
