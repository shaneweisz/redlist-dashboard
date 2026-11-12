/**
 * Which literature source the species table's Literature columns count.
 *
 *   openalex  papers in OpenAlex whose title or abstract names the species. The
 *             default: its New (since the assessment) is the useful signal.
 *   bhl       articles and volumes in the Biodiversity Heritage Library whose
 *             scanned pages name it: mostly historical literature.
 *
 * One source at a time, never summed: the same article is often in both, and a
 * BHL work can be a whole volume rather than a paper. Both count a synonym CoL
 * lists for the species (the sync's paper_counts).
 */

export type LiteratureSource = "openalex" | "bhl";

/**
 * The OpenAlex work types that count as literature, for the sync's counts
 * (scripts/sync/inputs/openalex-snapshot.ts) and the search a count links to.
 * The rest aren't counted: most "dataset" and "other" records are specimens,
 * samples and occurrence downloads registered with DataCite, one per specimen,
 * and would swamp the papers.
 */
export const OPENALEX_LITERATURE_TYPES = ["article", "review", "book", "book-chapter", "dissertation", "preprint", "report",
  "conference-paper", "letter", "data-paper"] as const;

export const LITERATURE_SOURCES: readonly LiteratureSource[] = ["openalex", "bhl"];
export const DEFAULT_LITERATURE_SOURCE: LiteratureSource = "openalex";

/** The URL parameter holding the source; absent means the default. */
export const LITERATURE_PARAM = "lit";

export function parseLiteratureSource(v: string | null | undefined): LiteratureSource {
  return v === "bhl" ? "bhl" : DEFAULT_LITERATURE_SOURCE;
}

export const LITERATURE_SOURCE_LABEL: Record<LiteratureSource, string> = {
  openalex: "OpenAlex",
  bhl: "BHL",
};

export const LITERATURE_SOURCE_HINT: Record<LiteratureSource, string> = {
  openalex: "OpenAlex: papers whose title or abstract names the species (or a synonym CoL lists for it).",
  bhl: "Biodiversity Heritage Library: articles, or whole volumes where BHL hasn't split out articles, whose scanned pages name the species (or a synonym CoL lists for it). Mostly historical literature.",
};

/** A species' literature counts as the lists carry them. */
export interface LiteratureCounts {
  openalex_works?: number | null;
  openalex_works_since_assessment?: number | null;
  bhl_works?: number | null;
  bhl_works_since_assessment?: number | null;
}

/** Works mentioning the species in this source. */
export function literatureWorks(s: LiteratureCounts, source: LiteratureSource): number | null {
  return (source === "bhl" ? s.bhl_works : s.openalex_works) ?? null;
}

/** Works published after the assessment date in this source; null when there is no window. */
export function literatureWorksSinceAssessment(s: LiteratureCounts, source: LiteratureSource): number | null {
  return (source === "bhl" ? s.bhl_works_since_assessment : s.openalex_works_since_assessment) ?? null;
}

/**
 * Where a count links to: the source's own search for the species' name.
 * OpenAlex: works whose title or abstract has the name, of the types counted,
 * not retracted, published from `since` (YYYY-MM-DD) when given. BHL: its page
 * for the name, which can't be narrowed by date, so New has no BHL link.
 *
 * Both search the name alone, while the count also credits the synonyms CoL
 * lists for the species, so the source's number can differ (LITERATURE_LINK_NOTE).
 */
export function literatureSearchUrl(source: LiteratureSource, scientificName: string, since?: string | null): string | null {
  const name = scientificName.trim();
  if (!name) return null;
  if (source === "bhl") return since ? null : `https://www.biodiversitylibrary.org/name/${encodeURIComponent(name.replace(/ /g, "_"))}`;
  const filters = [`title_and_abstract.search:"${name}"`, `type:${OPENALEX_LITERATURE_TYPES.join("|")}`, "is_retracted:false"];
  if (since) filters.push(`from_publication_date:${since}`);
  return `https://openalex.org/works?filter=${encodeURIComponent(filters.join(","))}`;
}

export const LITERATURE_LINK_NOTE = "Search the source for this name. Its count can differ: the count here also includes the synonyms CoL lists for the species.";

// ── The Literature chart and its filters ─────────────────────────────────────
//
// As for GBIF Records: the chart shows one metric of one source at a time (two
// toggles), and each of the four keeps its own bucket selection, so "OpenAlex
// Total 0" and "BHL Total 101+" can hold at once. Independent of the table's
// source toggle, which only sets what is displayed.

export type LiteratureMetric = "total" | "new";
export type LiteratureRangeKey = `${LiteratureMetric}.${LiteratureSource}`;

export const LITERATURE_RANGE_KEYS: readonly LiteratureRangeKey[] = ["total.openalex", "new.openalex", "total.bhl", "new.bhl"];
export const DEFAULT_LITERATURE_CHART_KEY: LiteratureRangeKey = "total.openalex";

/** Each selection's URL parameter. */
export const LITERATURE_RANGE_PARAM: Record<LiteratureRangeKey, string> = {
  "total.openalex": "litTotal",
  "new.openalex": "litNew",
  "total.bhl": "litTotalBhl",
  "new.bhl": "litNewBhl",
};
export const LITERATURE_CHART_PARAM = "litChart";

export type LiteratureRanges = Record<LiteratureRangeKey, Set<string>>;
export const emptyLiteratureRanges = (): LiteratureRanges =>
  Object.fromEntries(LITERATURE_RANGE_KEYS.map((k) => [k, new Set<string>()])) as LiteratureRanges;
export const hasLiteratureRanges = (r: LiteratureRanges): boolean => LITERATURE_RANGE_KEYS.some((k) => r[k].size > 0);

export function parseLiteratureChartKey(v: string | null | undefined): LiteratureRangeKey {
  return (LITERATURE_RANGE_KEYS as readonly string[]).includes(v ?? "") ? (v as LiteratureRangeKey) : DEFAULT_LITERATURE_CHART_KEY;
}
export const literatureKeyParts = (key: LiteratureRangeKey) => {
  const [metric, source] = key.split(".") as [LiteratureMetric, LiteratureSource];
  return { metric, source };
};
export const literatureRangeKeyLabel = (key: LiteratureRangeKey): string => {
  const { metric, source } = literatureKeyParts(key);
  return `${LITERATURE_SOURCE_LABEL[source]} ${metric === "total" ? "Total" : "New"}`;
};

/** Papers per species run smaller than GBIF records, so the buckets do too. */
export const LITERATURE_BUCKETS = ["0", "1-5", "6-20", "21-100", "101-1K", "1K+"] as const;

/** A species' value for a chart key; null where it has none (New with no assessment window). */
export function literatureMetricValue(s: LiteratureCounts, key: LiteratureRangeKey): number | null {
  const { metric, source } = literatureKeyParts(key);
  return metric === "total" ? literatureWorks(s, source) ?? 0 : literatureWorksSinceAssessment(s, source);
}

/** The bucket a value falls in, or null for no value. */
export function literatureBucket(value: number | null): string | null {
  if (value == null) return null;
  if (value === 0) return "0";
  if (value <= 5) return "1-5";
  if (value <= 20) return "6-20";
  if (value <= 100) return "21-100";
  if (value <= 1000) return "101-1K";
  return "1K+";
}

/** Does a species pass every Literature selection (except `skip`, the chart's own)? */
export function matchesLiteratureRanges(s: LiteratureCounts, ranges: LiteratureRanges, skip?: LiteratureRangeKey): boolean {
  for (const key of LITERATURE_RANGE_KEYS) {
    const sel = ranges[key];
    if (key === skip || sel.size === 0) continue;
    const b = literatureBucket(literatureMetricValue(s, key));
    if (b == null || !sel.has(b)) return false;
  }
  return true;
}
