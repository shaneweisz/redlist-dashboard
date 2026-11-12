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

/** What a count's link opens, per source. */
export const LITERATURE_LINK_NOTE: Record<LiteratureSource, string> = {
  openalex: "Open the works counted here on OpenAlex (the 100 most recent, where there are more). OpenAlex may have merged or re-typed a few since the sync.",
  bhl: "Open BHL's page for this name. It lists books and journals by title, not the articles counted here, so its numbers differ.",
};

/** The most works one link lists: OpenAlex takes at most 100 values in one filter. */
export const OPENALEX_LINK_MAX_WORKS = 100;

/** OpenAlex filtered to these works (their numeric ids: W123 → 123). */
export function openAlexWorksUrl(works: readonly (number | bigint)[]): string {
  const ids = works.slice(0, OPENALEX_LINK_MAX_WORKS).map((w) => `W${w}`).join("|");
  return `https://openalex.org/works?filter=${encodeURIComponent(`openalex:${ids}`)}`;
}

/**
 * The link for a species' OpenAlex count: the app's route, which opens OpenAlex
 * filtered to the works counted (from `since`, YYYY-MM-DD, for New). `name` is
 * its fallback, should the works not be readable.
 */
export function literatureLinkHref(species: { sis_taxon_id?: number | null; col_id?: string | null; scientific_name: string }, since?: string | null): string | null {
  const p = new URLSearchParams();
  if (species.sis_taxon_id != null) p.set("sis", String(species.sis_taxon_id));
  else if (species.col_id) p.set("col", species.col_id);
  else return null;
  p.set("name", species.scientific_name);
  if (since) p.set("since", since);
  return `/api/literature-link?${p}`;
}
