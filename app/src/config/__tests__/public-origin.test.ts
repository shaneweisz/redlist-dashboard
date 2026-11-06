import { describe, expect, it } from "vitest";
import { authCallbackUrl, safeRedirectPath } from "../public-origin";

describe("safeRedirectPath", () => {
  it("passes through a normal in-app path, query and fragment included", () => {
    expect(safeRedirectPath("/mapping/2435099?tab=gbif#top")).toBe("/mapping/2435099?tab=gbif#top");
  });

  it("rejects protocol-relative and absolute URLs that would leave the site", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/");
    // Browsers normalise backslashes to slashes, so this is "//evil.com" too.
    expect(safeRedirectPath("/\\evil.com")).toBe("/");
    expect(safeRedirectPath("https://evil.com")).toBe("/");
  });

  it("defaults to the home page when absent or empty", () => {
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath("")).toBe("/");
  });

  it("defaults to the home page for a non-string form value", () => {
    // FormData.get returns a File when the field name collides with an upload.
    expect(safeRedirectPath(new Blob())).toBe("/");
  });
});

describe("authCallbackUrl", () => {
  const ORIGIN = "https://dashforlife.org";

  it("leaves the callback URL untouched when there is nothing to return to", () => {
    // Byte-identical to the pre-`next` URL, so a plain sign-in doesn't depend
    // on Supabase's Redirect URLs allow-list having been widened.
    expect(authCallbackUrl(ORIGIN, null)).toBe("https://dashforlife.org/auth/callback");
    expect(authCallbackUrl(ORIGIN, "/")).toBe("https://dashforlife.org/auth/callback");
  });

  it("encodes a filtered dashboard URL so its own query string survives", () => {
    // Unencoded, the `?` and `&` would be read as part of the callback URL's
    // query string rather than as part of `next`'s.
    expect(authCallbackUrl(ORIGIN, "/?taxa=birds&categories=CR,EN")).toBe(
      "https://dashforlife.org/auth/callback?next=%2F%3Ftaxa%3Dbirds%26categories%3DCR%2CEN"
    );
  });

  it("survives the round trip back through the callback route", () => {
    const cases = [
      "/?taxa=mammals&categories=CR,EN&years=11-20+years&search=shrew",
      "/?layout=country&country=ZA&view=new-assessments",
      "/narrative-search?taxa=birds&q=fire",
      "/mapping/2435099?tab=gbif#top",
    ];
    for (const path of cases) {
      const url = new URL(authCallbackUrl(ORIGIN, path));
      // What app/auth/callback/route.ts does with the request it receives.
      expect(safeRedirectPath(url.searchParams.get("next"))).toBe(path);
    }
  });

  it("never lets an off-site redirect into the redirectTo", () => {
    expect(authCallbackUrl(ORIGIN, "https://evil.com")).toBe(
      "https://dashforlife.org/auth/callback"
    );
    expect(authCallbackUrl(ORIGIN, "//evil.com")).toBe("https://dashforlife.org/auth/callback");
    expect(authCallbackUrl(ORIGIN, "/\\evil.com")).toBe("https://dashforlife.org/auth/callback");
    expect(authCallbackUrl(ORIGIN, new Blob())).toBe("https://dashforlife.org/auth/callback");
  });

  it("builds on whichever origin the browser actually reported", () => {
    expect(authCallbackUrl("http://localhost:3000", "/?taxa=birds")).toBe(
      "http://localhost:3000/auth/callback?next=%2F%3Ftaxa%3Dbirds"
    );
  });
});
