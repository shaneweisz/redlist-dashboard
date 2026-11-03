// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { SENTRY_DATA_COLLECTION } from "@/lib/sentry-data-collection";
import posthog from "posthog-js";

Sentry.init({
  dsn: "https://3321a937f74313b1ff02b1ba4e884e27@o4511047063633920.ingest.de.sentry.io/4511047064420432",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,
  dataCollection: SENTRY_DATA_COLLECTION,

  integrations: [
    // Ties the two tools together in both directions: each Sentry issue gains a
    // "PostHog Person URL" tag, and the error is mirrored into PostHog as an
    // $exception event.
    //
    // The integration also adds a "PostHog Recording URL" tag when a replay is
    // running. Since #537 removed session recording none ever is, so that tag
    // simply never appears — the issues carry just the person URL, built from
    // the throwaway in-memory distinct_id that lasts one page visit and
    // identifies nobody.
    //
    // NOTE the functional form. PostHog's own docstring still shows
    // `new posthog.SentryIntegration(posthog)`, which is the Sentry v7 class
    // shape; @sentry/nextjs is on v11, where integrations are plain objects.
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
