import { describe, it, expect } from "vitest";
import { buildGeneralIssueUrl, GITHUB_REPO_URL } from "@/lib/github-issue";

describe("buildGeneralIssueUrl", () => {
  it("points at the repo's new-issue form", () => {
    const url = new URL(buildGeneralIssueUrl());
    expect(url.origin + url.pathname).toBe(`${GITHUB_REPO_URL}/issues/new`);
  });

  // An empty title leaves GitHub's placeholder showing and its submit button
  // disabled until the reporter writes one — better than a vague prefilled
  // "Feedback" they have to clear first.
  it("prefills no title, so GitHub asks for one", () => {
    expect(new URL(buildGeneralIssueUrl()).searchParams.get("title")).toBeNull();
  });

  // A new issue in your own repo only notifies you if you're watching it; the
  // @-mention is what actually reaches the maintainer.
  it("opens by mentioning the maintainer, by exact GitHub login", () => {
    const body = new URL(buildGeneralIssueUrl()).searchParams.get("body")!;
    expect(body.split("\n")[0]).toBe(
      "Hi @shaneweisz, I've got some feedback and/or a feature request about the dashboard."
    );
  });

  it("prefills a greeting and a prompt, but no words in the reporter's mouth", () => {
    const body = new URL(buildGeneralIssueUrl()).searchParams.get("body")!;
    expect(body).toContain("a sentence is plenty");
    // Nothing beyond the greeting line and the commented-out prompt.
    const visible = body.replace(/<!--[\s\S]*?-->/g, "").split("\n").filter((l) => l.trim());
    expect(visible).toHaveLength(1);
  });

  it("records the page the reader was on when given one", () => {
    const body = new URL(buildGeneralIssueUrl({ pageUrl: "https://www.dashforlife.org/?systems=Marine" })).searchParams.get("body")!;
    expect(body).toContain("From https://www.dashforlife.org/?systems=Marine");
  });

  // The footer server-renders, so the href is built without a URL and only the
  // click handler supplies one — the no-URL form must stand on its own.
  it("omits the provenance footer entirely with no page URL", () => {
    expect(new URL(buildGeneralIssueUrl()).searchParams.get("body")).not.toContain("From ");
  });
});
