/**
 * Parse an IUCN assessors/reviewers string into individual names.
 *
 * Format: names are "Lastname, Initials" (e.g. "Smith, J.A.") with optional
 * parenthetical affiliations like "(Chiroptera Red List Authority)".
 *
 * Names are separated by:
 *   - " & " (ampersand)
 *   - ", " followed by an uppercase letter that starts a new last name
 *     (but NOT ", " that introduces initials like ", J.")
 *
 * The heuristic: after a ", ", if the next non-space char is uppercase and
 * the preceding token looks like initials (ends with "." or ")"), it's a
 * new name. Otherwise it's initials belonging to the current name.
 */
/**
 * Known duplicate name mappings: variant → canonical form.
 * "Cox, N." and "Cox, N.A." refer to the same person (Neil Cox).
 */
const CANONICAL_NAMES: Record<string, string> = {
  "Cox, N.": "Cox, N.A.",
};

export function parseAssessors(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];

  // First split on " & "
  const ampersandParts = raw.split(" & ");
  const names: string[] = [];

  for (const part of ampersandParts) {
    // Now we need to split on ", " that separates names (not initials).
    // Strategy: split on ", " then reassemble "Lastname" + ", " + "Initials" pairs.
    const segments = part.split(", ");

    let current = segments[0];
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      // Does this segment look like initials/affiliation belonging to current name?
      // Initials: start with uppercase, are short (≤4 chars without parens), contain dots
      // OR it starts with a '(' (affiliation)
      const isInitialsOrAffiliation =
        seg.startsWith("(") ||
        /^[A-Z]\./.test(seg) ||  // "J." or "J.A." etc.
        /^[A-Z]$/.test(seg);     // single letter like "A"

      if (isInitialsOrAffiliation) {
        // This is part of the current name
        current += ", " + seg;
      } else {
        // This starts a new name — push current and start fresh
        names.push(current.trim());
        current = seg;
      }
    }
    if (current.trim()) {
      names.push(current.trim());
    }
  }

  return names.filter(Boolean).map(n => CANONICAL_NAMES[n] ?? n);
}


/**
 * Institution names that genuinely contain a comma.
 *
 * The Institutions credit line is an ordinary English list — "A, B & C" — so a
 * comma separates institutions. These six are the exception: the comma is part
 * of the name. Without protecting them, "Royal Botanic Gardens, Kew" would split
 * into a "Royal Botanic Gardens" and a "Kew" that don't exist, on the ~3,800
 * species Kew is credited on.
 *
 * Derived from the data, not guessed: a name earns a place here if it appears as
 * a COMPLETE institution somewhere in the corpus (a whole credit line, or the
 * piece after the final " & ") while containing ", ". Exactly six do, out of 155
 * distinct credit lines. parseAssessors.test.ts re-derives this list from
 * assessed.parquet and fails if a later sync introduces a seventh.
 */
export const COMMA_BEARING_INSTITUTIONS: readonly string[] = [
  "Australian Government, Threatened Species Scientific Committee",
  "IUCN SSC Anteater, Sloth and Armadillo Specialist Group",
  "IUCN SSC Bryophyte Specialist Group (mosses, liverworts, and hornworts)",
  "IUCN SSC Stork, Ibis and Spoonbill Specialist Group",
  "Ministerio do Meio Ambiente (MMA), Brazil",
  "Royal Botanic Gardens, Kew",
];

/**
 * Parse an Institutions credit line into individual organisations.
 *
 * These are organisation names, not "Lastname, Initials", so parseAssessors'
 * initials heuristic doesn't apply. The line is a plain English list, joined by
 * ", " with " & " before the last item:
 *
 *   "Centro Nacional de Conservação da Flora (CNCFlora), IUCN SSC Brazil Plant
 *    Red List Authority & Botanic Gardens Conservation International"
 *
 * Both separators have to be honoured. Splitting on " & " alone left every line
 * of three or more institutions as one long pseudo-institution — which is how
 * the same two organisations got counted twice over: that CNCFlora + Brazil RLA
 * pair also appears " & "-joined on its own (195 species), so the chart showed a
 * bar for the pair AND separate bars for each, and no total was right.
 *
 * Longest-match-first against COMMA_BEARING_INSTITUTIONS protects the six names
 * whose own comma would otherwise split them.
 */
/**
 * Index of the next ", " or " & " that actually separates two institutions, or
 * -1 if there is none.
 *
 * Separators inside brackets don't count. One real credit line reads "Addis
 * Ababa University (National Herbarium of Ethiopia, Department of Plant Biology
 * & Biodiversity Management)" — a single university, with a comma AND an
 * ampersand inside the parenthetical naming its department. A depth-blind scan
 * shattered it into three institutions, two of them fragments ending mid-phrase.
 */
function topLevelSeparator(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === "," && /\s/.test(s[i + 1] ?? "")) return i;
      if (c === "&" && /\s/.test(s[i - 1] ?? "") && /\s/.test(s[i + 1] ?? "")) return i - 1;
    }
  }
  return -1;
}

export function parseInstitutions(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];

  // Longest first, so a name that is a prefix of another can't shadow it.
  const protectedNames = [...COMMA_BEARING_INSTITUTIONS].sort((a, b) => b.length - a.length);

  const out: string[] = [];
  let rest = raw.trim();
  // Walk the line left to right, taking either a protected name whole or the
  // text up to the next separator.
  while (rest.length > 0) {
    const match = protectedNames.find((n) => rest.startsWith(n));
    if (match) {
      out.push(match);
      rest = rest.slice(match.length);
    } else {
      const sep = topLevelSeparator(rest);
      if (sep === -1) {
        out.push(rest.trim());
        break;
      }
      out.push(rest.slice(0, sep).trim());
      rest = rest.slice(sep);
    }
    // Drop the separator that follows whatever was just consumed.
    rest = rest.replace(/^(?:,\s*|\s*&\s+)/, "").trim();
  }
  return out.filter(Boolean);
}
