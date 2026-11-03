// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { SENTRY_DATA_COLLECTION } from "./src/lib/sentry-data-collection";

Sentry.init({
  dsn: "https://3321a937f74313b1ff02b1ba4e884e27@o4511047063633920.ingest.de.sentry.io/4511047064420432",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,

  dataCollection: SENTRY_DATA_COLLECTION,

});
