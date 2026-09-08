"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useMe } from "./MeProvider";

if (
  typeof window !== "undefined" &&
  process.env.NEXT_PUBLIC_POSTHOG_KEY
) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    // First-party reverse proxy (see next.config.ts rewrites) so ad/tracking
    // blockers can't drop events. ui_host keeps "View in PostHog" links pointing
    // at the real EU dashboard.
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    // In-memory persistence: the distinct_id lives only in JS for the page
    // session — no cookie or localStorage, so no consent banner is needed. We
    // avoid cookieless server-hash mode because it derives identity from the
    // client IP, which our server-side /ingest proxy hides from PostHog.
    //
    // This stays the DEFAULT for everyone, signed in or not. A signed-in user
    // who opts in to session recording (#524) is switched to persistent storage
    // at runtime by ConsentGate below — which is exactly the switch their
    // consent is being asked for, since storing that identifier on the device is
    // the part that needs it under PECR.
    persistence: "memory",
    disable_session_recording: true,
  });
}

/**
 * Session-replay masking, applied only once recording actually starts.
 *
 * Deliberately NOT maskAllInputs. The whole analytical point of #524 is to see
 * where people get stuck — which searches they type, which filters they reach
 * for — and a recording with every input blanked answers none of that. What the
 * user types here is species names and country names, not personal data.
 *
 * The exceptions are pinned down rather than left to chance:
 *  - password inputs stay masked (this app has none — sign-in is OAuth only, so
 *    no password is ever typed on our origin — but the day one appears it must
 *    not depend on someone remembering this file);
 *  - anything marked .ph-mask has its text masked, and .ph-no-capture is
 *    blocked outright, as escape hatches for future UI that shouldn't be seen.
 */
const RECORDING_MASKING = {
  maskAllInputs: false,
  maskInputOptions: { password: true },
  blockSelector: ".ph-no-capture",
};

/**
 * Turns identified analytics and session recording on and off to match the
 * signed-in user's stored consent.
 *
 * Runs on every change of that state, in both directions, because withdrawal
 * has to take effect as immediately as consent does — a toggle that only stops
 * recording after a reload is not "as easy to withdraw as to give".
 */
function ConsentGate() {
  const { me, loaded } = useMe();
  const consented = me.analyticsConsent === true && !!me.id;
  // Whether THIS page load ever turned recording on. Without it the teardown
  // branch below runs on first load for everyone who has not consented — the
  // overwhelmingly common case — and posthog.reset() there swaps the anonymous
  // distinct_id partway through the page, splitting one visitor's events across
  // two ids for no reason. Tearing down is only meaningful after a setup.
  const wasRecording = useRef(false);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    // Until /api/auth/me answers we don't know the stored decision, and the
    // init above has already left us in the safe state. Doing nothing here is
    // what keeps a page load from recording a few hundred ms of someone who
    // never consented.
    if (!loaded) return;

    if (consented) {
      // Persist the distinct_id so a session survives page loads — without this
      // every navigation is a separate one-page replay, which is useless for
      // spotting where someone got confused. This is the storage the consent
      // was for.
      // Masking has to go through set_config: startSessionRecording() only
      // takes sampling/feature-flag overrides, so passing it these silently
      // records unmasked.
      posthog.set_config({
        persistence: "localStorage+cookie",
        session_recording: RECORDING_MASKING,
      });
      // Tie the sessions to the account, so "which searches has a real user
      // made" is answerable rather than a pile of disconnected anonymous ones.
      posthog.identify(me.id!);
      posthog.startSessionRecording();
      wasRecording.current = true;
    } else {
      // Nothing to undo on a fresh, never-consented page load.
      if (!wasRecording.current) return;
      wasRecording.current = false;
      posthog.stopSessionRecording();
      // Order matters: reset() clears the stored id and PostHog's own cookies,
      // so it has to run while the persistent store is still the active one.
      // Flipping to memory first would orphan those values on the device — the
      // opposite of what withdrawing consent is supposed to do.
      posthog.reset();
      posthog.set_config({ persistence: "memory" });
    }
  }, [loaded, consented, me.id]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  return (
    <PHProvider client={posthog}>
      <ConsentGate />
      {children}
    </PHProvider>
  );
}
