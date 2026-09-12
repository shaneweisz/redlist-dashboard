/**
 * Talking to GBIF's API like a good citizen.
 *
 * GBIF runs the occurrence API free and unauthenticated for everyone, and asks
 * two things of callers in return: say who you are, and back off when told to.
 * Neither is optional politeness here — this app's requests leave from Vercel's
 * shared egress addresses, so an unidentified caller that retries into a 429 is
 * spending someone else's reputation as well as its own.
 *
 * Identifying ourselves also gives GBIF somewhere to go if we ever do something
 * expensive by accident: a name and a repository in the User-Agent is the
 * difference between a mail asking us to stop and a silent block. The literature
 * adapters have done this from the start (lib/literature/sources/http.ts); this
 * is the same idea for the GBIF routes.
 */

/** Who we are, for anyone reading GBIF's logs. */
export const GBIF_USER_AGENT =
  "RedListDashboard/1.0 (+https://github.com/shaneweisz/redlist-dashboard; mailto:sw984@cam.ac.uk)";

const MAX_RETRIES = 3;
const BACKOFF_MS = 400;

/**
 * One GBIF request, identified and backed off.
 *
 * 429 and 5xx are retried with exponential backoff, and `Retry-After` is
 * obeyed when GBIF sends one — it knows better than our arithmetic does how
 * long it wants to be left alone. Everything else throws immediately; retrying
 * a 400 is just asking the same bad question again.
 *
 * The status goes in the message because `statusText` is empty over HTTP/2,
 * which is what Node's fetch negotiates — an earlier version of this error read
 * "GBIF returned " with nothing after it and hid a 429 completely.
 */
export async function gbifJson(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": GBIF_USER_AGENT },
      cache: "no-store",
    });
    if (response.ok) return response.json();

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) {
      throw new Error(`GBIF returned HTTP ${response.status}`);
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 5_000)
      : 2 ** attempt * BACKOFF_MS;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
