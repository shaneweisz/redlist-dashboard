/**
 * Polite HTTP for the literature source adapters.
 *
 * All of these APIs are free and mostly unauthenticated, and several of them
 * (OpenAlex, Europe PMC, Semantic Scholar) explicitly ask callers to identify
 * themselves and to back off when told to. So: one identifying User-Agent, a
 * contact address, a hard timeout so a stalled source can't pin a Vercel
 * function open, and a 429/503 path that reports "rate limited" instead of
 * hammering the endpoint with retries.
 */

import type { SourceResult, SourceStatus } from "../types";

/** Contact address sent to APIs that ask for one (OpenAlex's "polite pool"). */
export const CONTACT_EMAIL = "sw984@cam.ac.uk";

export const USER_AGENT =
  `RedListDashboard/1.0 (+https://github.com/shaneweisz/redlist-dashboard; mailto:${CONTACT_EMAIL})`;

/**
 * Default per-source budget. Sources run in parallel, each on its own clock,
 * so one slow source delays only itself.
 *
 * Two sources need more and say so via `SourceAdapter.timeoutMs`: BHL is
 * searching OCR'd text across scanned books and measured 8.5s on a cold query,
 * and Semantic Scholar's authenticated endpoint measured 4-8s. At a flat 8s
 * both timed out often enough to be effectively absent from the timeline.
 */
export const SOURCE_TIMEOUT_MS = 8_000;

/**
 * Serialises calls so they go out at least `minIntervalMs` apart.
 *
 * Semantic Scholar issues keys with an explicit "1 request per second,
 * cumulative across all endpoints" ceiling and asks callers to stay under it.
 * Nothing else here needs one: every other source is called at most once per
 * species per six hours.
 *
 * This is per-process, so it holds within a server instance rather than across
 * a horizontally-scaled deployment - combined with the six-hour pool cache,
 * that keeps us comfortably inside the limit in practice.
 */
export class MinIntervalLimiter {
  /** Epoch ms at which the next call may go out. */
  private nextSlot = 0;

  constructor(private readonly minIntervalMs: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    const wait = slot - now;
    if (wait <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted while waiting for a rate-limit slot", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, wait);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export class SourceHttpError extends Error {
  constructor(
    readonly status: SourceStatus,
    message: string,
  ) {
    super(message);
    this.name = "SourceHttpError";
  }
}

/**
 * GET some JSON, mapping transport-level outcomes onto `SourceStatus`.
 * Throws `SourceHttpError` so each adapter's `catch` can report a status
 * without re-deriving it.
 */
export async function fetchJson<T>(
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
): Promise<T> {
  const response = await fetch(url, {
    signal: init.signal,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...init.headers },
  });

  if (response.status === 429 || response.status === 503) {
    throw new SourceHttpError("rate_limited", `HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new SourceHttpError("error", `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Uniform failure shape, so a broken source degrades instead of 500-ing. */
export function failed(error: unknown): SourceResult {
  if (error instanceof SourceHttpError) {
    return { status: error.status, works: [], upstreamTotal: null, note: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  // AbortError is what a blown `SOURCE_TIMEOUT_MS` budget looks like.
  const isAbort = error instanceof Error && error.name === "AbortError";
  return {
    status: "error",
    works: [],
    upstreamTotal: null,
    note: isAbort ? "Timed out" : message,
  };
}

/** A source we can't query because its API key isn't configured. */
export function unconfigured(envVar: string): SourceResult {
  return {
    status: "unconfigured",
    works: [],
    upstreamTotal: null,
    note: `Set ${envVar} to enable this source`,
  };
}

/** `"a" OR "b" OR "c"` — the phrase-OR syntax Europe PMC, CORE and Google Books share. */
export function quotedOrQuery(variants: string[]): string {
  return variants.map((v) => `"${v}"`).join(" OR ");
}
