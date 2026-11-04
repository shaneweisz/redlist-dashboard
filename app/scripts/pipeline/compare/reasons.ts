/**
 * Reasons: the explanations a difference against the baseline may have.
 *
 * Every difference between a new sync and the one production serves must be
 * explained. A rule names the explanation and states, as SQL, which
 * differences it covers. The predicate sees the diff row as `d` (kind, key,
 * field, change, before, after, delta) and may join the fact tables of either
 * side (`b.<kind>`, `a.<kind>`) or any table the pipeline left in the session.
 *
 * Rules run in order and the first match wins, so put narrow, specific rules
 * (a named bug fix) before broad ones (snapshot age). A rule must be narrow
 * enough that it can't hide a regression: "count changed" is not a reason,
 * "count moved by less than the records GBIF added since the baseline" is.
 *
 * Each commit of the rewrite that is expected to move numbers adds its rules
 * here, with the evidence for them in its commit message.
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

export const REASONS: ReasonRule[] = [];
