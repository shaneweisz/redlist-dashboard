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
