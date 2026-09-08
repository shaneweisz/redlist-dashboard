// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";

Sentry.init({
  dsn: "https://3321a937f74313b1ff02b1ba4e884e27@o4511047063633920.ingest.de.sentry.io/4511047064420432",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  integrations: [
    // Ties the two tools together in both directions: each Sentry issue gains a
    // "PostHog Person URL" tag, plus a "PostHog Recording URL" tag when a replay
    // is actually running, and the error is mirrored into PostHog as an
    // $exception event.
    //
    // The recording tag is consent-gated for free: the integration only adds it
    // when posthog.sessionRecordingStarted() is true, which only happens for a
    // signed-in user who opted in. Everyone else's issues carry just the person
    // URL, built from the throwaway in-memory distinct_id that lasts one page
    // visit and identifies nobody.
    //
    // This is what we get instead of recording the browser console into replays.
    // posthog-js's enable_recording_console_log is all-or-nothing — no level
    // filtering — so switching it on would vacuum up every log line from every
    // dependency, including whatever `.catch(console.error)` prints on a failed
    // fetch of assessor/reviewer names. Sentry already captures errors properly,
    // with stack traces and source maps; this link is the missing half, and it
    // collects nothing we haven't chosen (see components/PostHogProvider.tsx).
    //
    // NOTE the functional form. PostHog's own docstring still shows
    // `new posthog.SentryIntegration(posthog)`, which is the Sentry v7 class
    // shape; @sentry/nextjs is on v10, where integrations are plain objects.
    posthog.sentryIntegration({
      organization: "shane-weisz",
      // The NUMERIC project id, from the DSN's path above — not the
      // "redlist-dashboard" slug used by withSentryConfig in next.config.ts.
      // Only used to build the PostHog -> Sentry deep link.
      projectId: 4511047064420432,
    }),
  ],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
