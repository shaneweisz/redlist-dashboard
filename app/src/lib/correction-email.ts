/**
 * The "Breakdown look wrong? Suggest a correction" link in a # Described Species
 * popover: a prefilled email to the maintainer.
 *
 * The reader most likely to use it is a specialist group member who knows the
 * group's real circumscription, and who is far more likely to have an email
 * client than a GitHub account. A plain mailto: link needs no backend and sends
 * nothing by itself — their mail client opens a draft they edit and send.
 */

export const CORRECTIONS_EMAIL = "sw984@cam.ac.uk";

export interface BreakdownCorrectionRow {
  /** Display name, already resolved (e.g. "Syngnathidae"). */
  name: string;
  /** # Described, per Catalogue of Life. */
  count: number;
  /** Assessed → Total. */
  trueAssessed: number;
  /** Assessed → No 1:1 CoL Match. */
  noMatch: number;
  /** # Not Evaluated. */
  neCount: number;
}

export interface BreakdownCorrectionInput {
  /** The node the popover is describing, e.g. "Seahorses & Pipefishes". */
  groupLabel: string;
  /** What the first column holds — "Family", "Order", ... */
  rankLabel: string;
  rows: BreakdownCorrectionRow[];
  /** The CoL release the numbers came from, e.g. "COL26.6 XR". */
  sourceLabel: string;
  /** The dashboard URL the reporter was looking at, so we can reproduce it. */
  pageUrl?: string;
}

// Some mail clients (Outlook on Windows among them) silently drop a mailto:
// link longer than ~2,000 characters, so the table is cut to fit this budget
// for the whole encoded link, and the email says how many rows it kept.
const MAX_MAILTO_LENGTH = 1900;

export function buildBreakdownCorrectionSubject(groupLabel: string): string {
  return `Described-species breakdown for ${groupLabel} looks wrong`;
}

export function buildBreakdownCorrectionBody(input: BreakdownCorrectionInput, maxRows = input.rows.length): string {
  const { groupLabel, rankLabel, rows, sourceLabel, pageUrl } = input;
  const shown = rows.slice(0, maxRows);
  return [
    `The dashboard breaks down ${groupLabel}'s described species like this (source: ${sourceLabel}):`,
    "",
    `${rankLabel}: described / assessed / no 1:1 CoL match / not evaluated`,
    ...shown.map((r) => `${r.name}: ${r.count} / ${r.trueAssessed} / ${r.noMatch} / ${r.neCount}`),
    ...(rows.length > shown.length ? [`(first ${shown.length} of ${rows.length} rows; the rest are on the page below)`] : []),
    "",
    "I believe it should be:",
    "",
    "[Which groups belong here and which don't, and why. A published circumscription or the specialist group's own scope helps.]",
    "",
    ...(pageUrl ? [`Reported from ${pageUrl}`] : []),
  ].join("\n");
}

function toMailto(subject: string, body: string): string {
  // encodeURIComponent, not URLSearchParams: mail clients show a "+" literally
  // rather than reading it as a space.
  return `mailto:${CORRECTIONS_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function buildBreakdownCorrectionMailto(input: BreakdownCorrectionInput): string {
  const subject = buildBreakdownCorrectionSubject(input.groupLabel);
  for (let n = input.rows.length; n > 0; n--) {
    const link = toMailto(subject, buildBreakdownCorrectionBody(input, n));
    if (link.length <= MAX_MAILTO_LENGTH) return link;
  }
  return toMailto(subject, buildBreakdownCorrectionBody(input, 0));
}
