/**
 * Reasons: the explanations a difference against the baseline may have.
 *
 * Every difference between a new sync and the one production serves must be
 * explained. A rule names the explanation and states, as SQL, which
 * differences it covers. The predicate sees the diff row as `d` (kind, key,
 * field, change, before, after, delta) and may join the fact tables of either
 * side (`b.<kind>`, `a.<kind>`) and `snapshots` (b, a: each side's GBIF
 * snapshot date).
 *
 * Rules run in order and the first match wins, so put narrow, specific rules
 * (a named bug fix) before broad ones (snapshot age). A rule must be narrow
 * enough that it can't hide a regression: "count changed" is not a reason,
 * "count moved by less than the records GBIF added since the baseline" is.
 *
 * A change expected to move numbers (a new Red List or CoL release, a fix)
 * adds its rule here, with the evidence for it in its commit message.
 */

import type { FactKind } from "./facts";

export interface ReasonRule {
  code: string;
  description: string;
  kinds?: FactKind[];
  fields?: string[];
  changes?: ("changed" | "added" | "removed")[];
  /** SQL predicate over `d`. */
  where: string;
}

export const REASONS: ReasonRule[] = [
  {
    code: "newer_gbif_snapshot",
    description: "The two syncs counted different monthly GBIF snapshots, and the figure rose, or fell by no more than 5%: records are added every month, and a few are deleted or re-identified.",
    kinds: ["assessed", "ne", "groups", "nodes"],
    fields: ["gbif_georeferenced_records_count", "gbif_all_records_count", "gbif_georeferenced_records_since_assessment",
      "gbif_all_records_since_assessment", "gbif_georeferenced_species_count", "gbif_georeferenced_ne_species_count",
      "gbif_georeferenced_records", "gbif_georeferenced_median", "gbif_all_species_count", "gbif_all_ne_species_count",
      "gbif_all_records", "gbif_all_median", "gbif_ne_species_georeferenced", "gbif_ne_species_all"],
    where: `(SELECT b IS DISTINCT FROM a FROM snapshots) AND d.delta IS NOT NULL
            AND (d.delta >= 0 OR -d.delta <= 0.05 * d.before::DOUBLE)`,
  },
  {
    code: "outdated_as_of_a_later_sync_date",
    description: "'Outdated' is as of the sync date, and this sync is later than the baseline's, so more species have crossed the 10-year line.",
    kinds: ["groups", "nodes", "countries"], fields: ["outdated"],
    where: `d.delta > 0`,
  },
];
