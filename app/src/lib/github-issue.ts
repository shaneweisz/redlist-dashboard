export const GITHUB_REPO_URL = "https://github.com/shaneweisz/redlist-dashboard";

// The handle a draft opens by greeting, so filing one notifies him directly
// rather than relying on repo-watching. Must stay the exact GitHub login —
// "@Shane" is a different account and would notify a stranger.
const MAINTAINER_HANDLE = "@shaneweisz";

/**
 * Prefilled GitHub "new issue" links — the dashboard's way of handing someone a
 * draft they can edit and submit themselves.
 *
 * Deliberately plain links with the body in the query string, not API calls: no
 * token to hold, no auth to build, no endpoint that can be spammed, and the
 * reporter reviews and edits the text on GitHub before anything is submitted.
 */

/**
 * The general "something to say" draft, from the site footer.
 *
 * Opens by @-mentioning the maintainer: a new issue in your own repo only
 * notifies you if you're watching it, and a mention is what actually reaches
 * someone. It's a greeting in a draft the reporter can edit, not a hidden
 * trick — they see exactly who they're about to notify.
 *
 * Past the greeting it stays a prompt rather than a form. The footer link is
 * offered for questions, feedback and feature requests alike, so anything more
 * specific would be putting words in the reporter's mouth. No title is prefilled
 * either: an empty one leaves GitHub's own placeholder showing and its submit
 * button disabled until they write one, which is better than a vague "Feedback"
 * they have to clear first.
 */
export function buildGeneralIssueUrl({ pageUrl, repoUrl }: { pageUrl?: string; repoUrl?: string } = {}): string {
  const body = [
    `Hi ${MAINTAINER_HANDLE}, I've got some feedback and/or a feature request about the dashboard.`,
    "",
    "<!-- A question, something that looks wrong, or a feature you'd like —",
    "     a sentence is plenty. -->",
    "",
    ...(pageUrl ? ["", "---", "", `From ${pageUrl}`] : []),
  ].join("\n");
  return `${repoUrl ?? GITHUB_REPO_URL}/issues/new?${new URLSearchParams({ body }).toString()}`;
}
