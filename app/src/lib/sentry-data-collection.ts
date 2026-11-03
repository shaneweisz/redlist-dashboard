import type * as Sentry from "@sentry/nextjs";

/**
 * What Sentry may collect, shared by the server, edge and browser inits so
 * they can't drift apart.
 *
 * Sentry 11 replaced `sendDefaultPii` with `dataCollection` and, left unset,
 * now collects user info, cookies and full request/response bodies by default.
 * That would include the Supabase session cookie and goes against keeping
 * telemetry anonymous (#545), so this is Sentry's own documented block for
 * keeping v10's defaults — see "If you want to keep the v10 default behavior"
 * in getsentry/sentry-javascript MIGRATION.md — plus `mcp`, which would
 * otherwise fall back to `genAI` but is spelled out so nothing is implied.
 */
const SENSITIVE_KEYS = ["forwarded", "-ip", "remote-", "via", "-user"];

export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: SENSITIVE_KEYS },
    response: { deny: SENSITIVE_KEYS },
  },
  httpBodies: [],
  urlQueryParams: { deny: SENSITIVE_KEYS },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
} satisfies NonNullable<NonNullable<Parameters<typeof Sentry.init>[0]>["dataCollection"]>;
