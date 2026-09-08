"use client";

import Link from "next/link";
import { useMe } from "./MeProvider";

/**
 * The one-time ask for session-recording consent (#524).
 *
 * Shown only to signed-in users who have never answered — `analyticsConsent`
 * being null rather than false. Declining stores false, which is what keeps this
 * from becoming a banner that nags on every visit; the decision stays reversible
 * from the account menu either way.
 *
 * Notes on the wording and shape, which are load-bearing rather than cosmetic:
 *  - Neither button is pre-selected or visually pushed as the default. Consent
 *    has to be freely given, and a greyed-out "No thanks" next to a bright
 *    "Allow" is a nudge that undermines that.
 *  - It says what is recorded in plain terms and links the full policy, because
 *    consent has to be informed by more than the word "analytics".
 *  - Dismissing it is not an option: there is no × that leaves the question
 *    unanswered, because "no answer" and "no" must not be silently conflated.
 *    Declining is one click and is the same size as accepting.
 */
export function AnalyticsConsentPrompt() {
  const { me, loaded, setAnalyticsConsent } = useMe();

  if (!loaded || !me.email || me.analyticsConsent !== null) return null;

  return (
    <div
      role="dialog"
      aria-labelledby="analytics-consent-heading"
      className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg p-4"
    >
      <h2
        id="analytics-consent-heading"
        className="text-sm font-semibold text-zinc-800 dark:text-zinc-100"
      >
        Help us improve the dashboard?
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
        With your permission we&rsquo;ll record how you use this site &mdash; the
        pages, searches and filters you use, and a replay of your screen &mdash;
        and link it to your account, so we can see where the dashboard is
        confusing and fix it. You can turn this off at any time from the account
        menu.{" "}
        <Link
          href="/privacy"
          className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Privacy policy
        </Link>
        .
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setAnalyticsConsent(true)}
          className="flex-1 px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-600 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => setAnalyticsConsent(false)}
          className="flex-1 px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-600 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
        >
          No thanks
        </button>
      </div>
    </div>
  );
}
