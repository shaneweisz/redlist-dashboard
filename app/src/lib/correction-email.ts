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

export interface BreakdownCorrectionInput {
  /** The node the popover is describing, e.g. "Snake Specialist Group". */
  groupLabel: string;
  /** What the names are — "Family", "Genus", ... */
  rankLabel: string;
  /** The names the dashboard puts in this group, already display-cased. */
  names: string[];
  /** For a catch-all group, which has no list of names: its scope in words. */
  scopeText?: string;
  /** The dashboard URL the reporter was looking at, so we can reproduce it. */
  pageUrl?: string;
}

// Some mail clients (Outlook on Windows among them) silently drop a mailto:
// link longer than ~2,000 characters, so the name list is cut to fit this
// budget for the whole encoded link, and the email says how many it left out.
const MAX_MAILTO_LENGTH = 1900;

const PLURALS: Record<string, string> = { Class: "classes", Order: "orders", Family: "families", Genus: "genera", Species: "species" };

/** "the Snake Specialist Group", but plain "Mammals". */
function groupPhrase(groupLabel: string): string {
  return /(Group|Authority)$/.test(groupLabel) ? `the ${groupLabel}` : groupLabel;
}

export function buildBreakdownCorrectionSubject(groupLabel: string): string {
  return `Suggested correction for ${groupPhrase(groupLabel)}`;
}

export function buildBreakdownCorrectionBody(input: BreakdownCorrectionInput, maxNames = input.names.length): string {
  const { groupLabel, rankLabel, names, scopeText, pageUrl } = input;
  const group = groupPhrase(groupLabel);
  let current: string;
  if (scopeText) {
    current = `According to the dashboard, ${group} covers: ${scopeText}`;
  } else {
    const noun = names.length === 1 ? rankLabel.toLowerCase() : PLURALS[rankLabel] ?? `${rankLabel.toLowerCase()}s`;
    const shown = names.slice(0, maxNames);
    const rest = names.length - shown.length;
    current = `According to the dashboard, ${group} has the following ${names.length} ${noun}: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more (see the page below)` : ""}.`;
  }
  return [
    current,
    "",
    "It should actually be: ",
    "",
    ...(pageUrl ? ["", `Reported from ${pageUrl}`] : []),
  ].join("\n");
}

function toMailto(subject: string, body: string): string {
  // encodeURIComponent, not URLSearchParams: mail clients show a "+" literally
  // rather than reading it as a space.
  return `mailto:${CORRECTIONS_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function buildBreakdownCorrectionMailto(input: BreakdownCorrectionInput): string {
  const subject = buildBreakdownCorrectionSubject(input.groupLabel);
  for (let n = input.names.length; n > 0; n--) {
    const link = toMailto(subject, buildBreakdownCorrectionBody(input, n));
    if (link.length <= MAX_MAILTO_LENGTH) return link;
  }
  return toMailto(subject, buildBreakdownCorrectionBody(input, 0));
}
