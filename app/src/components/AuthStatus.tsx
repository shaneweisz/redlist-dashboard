"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "@/lib/auth/actions";
import { useMe } from "./MeProvider";

export function AuthStatus() {
  // Who is signed in, and whether they have consented to session recording,
  // both come from MeProvider rather than a fetch of our own — the account menu
  // and PostHogProvider have to agree about consent at every instant, and two
  // copies of that state is a recording that outlives the toggle saying it
  // stopped.
  const { me, loaded, setAnalyticsConsent } = useMe();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!loaded) {
    return <span className="w-8 h-8" aria-hidden="true" />;
  }

  if (!me?.email) {
    return (
      // Sign in, remembering where the user was. Everything the dashboard shows
      // — filters, view mode, drill-down — is encoded in the query string, so
      // handing /login the current path+search is what lets the callback put
      // the user back exactly where they were instead of on the home page.
      //
      // Read in the click handler rather than baked into `href` at render time
      // because the dashboard rewrites its own URL with bare
      // history.pushState (hooks/useFilterParams.ts) — no Next.js navigation,
      // so no re-render and nothing for usePathname/useSearchParams to observe.
      // An href computed at render would go stale on the first filter change,
      // which is precisely the state this exists to preserve.
      //
      // The href itself stays a plain "/login", so cmd/middle-click, "copy link
      // address" and a JavaScript-less browser all still reach a working
      // sign-in page — they just fall back to landing on "/" afterwards.
      <a
        href="/login"
        onClick={(e) => {
          // Leave modified clicks (open in new tab/window, download) alone.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          const from = window.location.pathname + window.location.search;
          window.location.href = `/login?next=${encodeURIComponent(from)}`;
        }}
        className="flex items-center justify-center w-8 h-8 rounded-full ring-1 ring-zinc-200 dark:ring-zinc-700 text-zinc-500 dark:text-zinc-400 hover:ring-zinc-300 dark:hover:ring-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
        aria-label="Sign in"
        title="Sign in"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
          />
        </svg>
      </a>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="block rounded-full ring-1 ring-zinc-200 dark:ring-zinc-700 hover:ring-zinc-300 dark:hover:ring-zinc-600 transition-shadow"
        aria-label="Account menu"
        aria-expanded={open}
      >
        {me.avatarUrl ? (
          <img src={me.avatarUrl} alt="" className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 text-sm font-medium uppercase">
            {me.email[0]}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-lg shadow-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 py-1 z-10">
          <p
            className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 truncate bg-zinc-50 dark:bg-zinc-900/40 border-b border-zinc-100 dark:border-zinc-700 cursor-default select-text"
            title={me.email}
          >
            {me.email}
          </p>
          {/* Withdrawal has to be as easy as consent was (UK GDPR Art. 7(3)), so
              the switch lives in the account menu permanently — not only in the
              one-time prompt. It is also the only way back for someone who
              declined, since that prompt never returns. */}
          <label className="flex items-start gap-2 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              // A never-asked (null) state reads as off, which matches what is
              // actually happening: nothing is being recorded.
              checked={me.analyticsConsent === true}
              onChange={(e) => setAnalyticsConsent(e.target.checked)}
            />
            <span>
              Session recording
              <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                Record my screen and searches to improve the site
              </span>
            </span>
          </label>
          <form action={signOut} className="border-t border-zinc-100 dark:border-zinc-700">
            <button
              type="submit"
              className="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
