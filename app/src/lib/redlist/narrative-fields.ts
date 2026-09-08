/**
 * The narrative fields an assessment is written in, and what to call them.
 *
 * Client-safe on purpose, and kept out of `lib/data/narratives-duckdb.ts` for
 * the reason `lib/mapping/nearby-threats.ts` exists: that module reaches DuckDB
 * and node's `fs`, and importing it from a page breaks that page's build with a
 * module-not-found on `fs` and nothing in the message about narratives.
 */
export const NARRATIVE_FIELDS = [
  "rationale",
  "range",
  "population",
  "habitats",
  "threats",
  "measures",
  "use_trade",
  "trend_justification",
  "taxonomic_notes",
] as const;

export type NarrativeField = (typeof NARRATIVE_FIELDS)[number];

/** What each field is called where a reader can see it. */
export const NARRATIVE_LABELS: Record<NarrativeField, string> = {
  rationale: "Rationale",
  range: "Geographic range",
  population: "Population",
  habitats: "Habitat & ecology",
  threats: "Threats",
  measures: "Conservation actions",
  use_trade: "Use & trade",
  trend_justification: "Trend justification",
  taxonomic_notes: "Taxonomic notes",
};
