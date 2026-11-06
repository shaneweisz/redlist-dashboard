// Helpers for where sign-in sends the browser: the OAuth callback URL, and the
// in-app page to land on afterwards. Both take untrusted input, so both are
// narrowed here rather than trusted.

/**
 * Narrow an untrusted `?next=` value to a path that can only ever redirect
 * within this site.
 *
 * This matters because the auth callback redirects *relatively* (see
 * app/auth/callback/route.ts): "//evil.com" and "/\evil.com" — which browsers
 * normalise to the same thing — are protocol-relative URLs, so as a bare
 * Location they leave the site entirely. Only a single leading slash is
 * same-origin.
 *
 * Takes `unknown` because one caller is `formData.get("next")`, which is a
 * `File` rather than a string if the field name ever collides with an upload.
 */
export function safeRedirectPath(next: unknown): string {
  if (typeof next !== "string") return "/";
  if (!next || next[0] !== "/" || next[1] === "/" || next[1] === "\\") return "/";
  return next;
}

/**
 * The OAuth `redirectTo` — where the provider sends the browser once the user
 * has approved, i.e. this app's auth callback, carrying the page to land on.
 *
 * `next` is sanitised here *and* again in the callback route, and both are
 * load-bearing: this call keeps an attacker-chosen absolute URL out of the
 * `redirectTo` we hand to Supabase, and the callback's call covers the fact
 * that the value comes back to us over the open internet — the provider echoes
 * whatever query string it was given, and nothing stops someone linking
 * straight at /auth/callback with a `next` of their own.
 *
 * The encoding matters too: `next` is itself a path *with a query string*
 * (the dashboard keeps all of its filter state there), so its `?` and `&` have
 * to be escaped or the callback URL's own parser would truncate it at the
 * first one and split the rest into unrelated params.
 *
 * "/" is left off entirely rather than encoded, so the overwhelmingly common
 * case produces the exact same URL it always has. That matters operationally:
 * Supabase matches `redirectTo` against the Redirect URLs allow-list in its
 * dashboard, so a plain sign-in keeps working even where that list hasn't yet
 * been widened to tolerate the new query param.
 */
export function authCallbackUrl(origin: string, next: unknown): string {
  const path = safeRedirectPath(next);
  const callback = `${origin}/auth/callback`;
  return path === "/" ? callback : `${callback}?next=${encodeURIComponent(path)}`;
}
