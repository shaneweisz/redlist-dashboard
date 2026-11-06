"use client";

import { VISIBLE_OAUTH_PROVIDERS } from "@/config/oauth-providers";
import { signInWithOAuth } from "@/lib/auth/actions";

// Each provider's own mark, drawn in its brand colours (GitHub's is
// monochrome by design, so it follows the button's text colour and works in
// both themes). Keyed by provider id and kept for every provider in
// OAUTH_PROVIDERS, including hidden ones, so unhiding is a one-flag change.
const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  github: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23a11.28 11.28 0 013-.405c1.02 0 2.04.135 3 .405 2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  ),
  google: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18A10.99 10.99 0 001 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  ),
  azure: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
    </svg>
  ),
};

/**
 * The sign-in buttons.
 *
 * `next` rides along as a hidden field, taken from this page's own `?next=`
 * rather than from `window`: by the time the form is on screen the browser is
 * on /login, so its current URL is no longer the page worth returning to. The
 * header's sign-in link is what captured that, one navigation earlier
 * (components/AuthStatus.tsx).
 */
export function SignInForm({ next }: { next?: string }) {
  return (
    // One form, one button per provider: the pressed button's
    // name/value is what tells the action which provider to start.
    <form action={signInWithOAuth} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next ?? ""} />
      {VISIBLE_OAUTH_PROVIDERS.map(({ id, label }) => (
        <button
          key={id}
          type="submit"
          name="provider"
          value={id}
          className="relative w-full flex items-center justify-center px-12 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 font-medium hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
        >
          {/* Absolute so the icons line up with each other, while the labels
              stay centred as they were with the single button. */}
          <span className="absolute left-4 flex items-center">{PROVIDER_ICONS[id]}</span>
          Sign in with {label}
        </button>
      ))}
    </form>
  );
}
