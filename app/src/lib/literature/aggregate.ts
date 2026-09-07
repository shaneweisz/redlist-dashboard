/**
 * Fan out to every literature source, merge what comes back, and cache the
 * result so paging through the timeline costs nothing upstream.
 *
 * Being a good API citizen is the design constraint here:
 *  - one request per source per species, never one per page;
 *  - concurrent requests for the same species share a single in-flight fetch;
 *  - a hard per-source timeout, and failures degrade the source rather than the
 *    response;
 *  - a short TTL when something went wrong, so a transient 429 doesn't freeze a
 *    gap into the cache for hours.
 */

import { generateNameVariants } from "@/lib/nameVariants";
import { dedupeWorks } from "./merge";
import { bhlSource } from "./sources/bhl";
import { coreSource } from "./sources/core";
import { googleBooksSource } from "./sources/google-books";
import { openAlexSource } from "./sources/openalex";
import { redListSource } from "./sources/redlist";
import { zenodoSource } from "./sources/zenodo";
import { SOURCE_TIMEOUT_MS } from "./sources/http";
import type { LiteratureWork, SourceAdapter, SourceReport } from "./types";

/** Every source we know how to query, in the order they're reported to the UI. */
export const SOURCES: SourceAdapter[] = [
  openAlexSource,
  zenodoSource,
  coreSource,
  bhlSource,
  googleBooksSource,
  redListSource,
];

/**
 * How many records to ask each source for. The pool is a "most recent N"
 * window, not the whole corpus: for a heavily-studied species the timeline
 * shows the recent end of it and reports the upstream totals alongside.
 */
export const DEFAULT_PER_SOURCE_LIMIT = 50;

/** Literature accrues slowly; a long TTL is both cheap and polite. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** When a source failed or was throttled, retry sooner. */
const DEGRADED_TTL_MS = 10 * 60 * 1000;
/** Bound the cache so a long-lived instance can't grow without limit. */
const MAX_CACHE_ENTRIES = 300;

export interface LiteraturePool {
  scientificName: string;
  assessmentId: string | null;
  nameVariants: string[];
  works: LiteratureWork[];
  sources: SourceReport[];
  fetchedAt: number;
}

interface CacheEntry {
  pool: LiteraturePool;
  expiresAt: number;
}

const poolCache = new Map<string, CacheEntry>();
/** Concurrent callers for the same species wait on one shared fetch. */
const inFlight = new Map<string, Promise<LiteraturePool>>();

// The assessment id is part of the key because it changes what the Red List
// reference source contributes, not just how the pool is presented.
function cacheKey(
  scientificName: string,
  assessmentId: string | null,
  perSourceLimit: number,
): string {
  return `${scientificName.trim().toLowerCase()}::${assessmentId ?? "-"}::${perSourceLimit}`;
}

/** Exposed for tests; also handy if a source's config changes at runtime. */
export function clearLiteratureCache(): void {
  poolCache.clear();
  inFlight.clear();
}

export async function getLiteraturePool(
  scientificName: string,
  assessmentId: string | null = null,
  perSourceLimit: number = DEFAULT_PER_SOURCE_LIMIT,
): Promise<{ pool: LiteraturePool; cached: boolean }> {
  const key = cacheKey(scientificName, assessmentId, perSourceLimit);

  const hit = poolCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return { pool: hit.pool, cached: true };

  const pending = inFlight.get(key);
  if (pending) return { pool: await pending, cached: true };

  const request = buildPool(scientificName, assessmentId, perSourceLimit)
    .then((pool) => {
      const degraded = pool.sources.some(
        (s) => s.status === "error" || s.status === "rate_limited",
      );
      poolCache.set(key, {
        pool,
        expiresAt: Date.now() + (degraded ? DEGRADED_TTL_MS : CACHE_TTL_MS),
      });
      evictOldest();
      return pool;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return { pool: await request, cached: false };
}

async function buildPool(
  scientificName: string,
  assessmentId: string | null,
  perSourceLimit: number,
): Promise<LiteraturePool> {
  const nameVariants = generateNameVariants(scientificName);

  // Each source runs on its own clock, so a legitimately slow one — BHL
  // searching OCR'd text across scanned books — delays only itself instead of
  // capping the whole fan-out at the fastest common budget.
  const results = await Promise.all(
    SOURCES.map(async (source) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), source.timeoutMs ?? SOURCE_TIMEOUT_MS);
      try {
        const result = await source.fetch({
          scientificName,
          nameVariants,
          assessmentId,
          limit: perSourceLimit,
          signal: controller.signal,
        });
        return { source, result };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const sources: SourceReport[] = results.map(({ source, result }) => ({
    id: source.id,
    label: source.label,
    homepage: source.homepage,
    status: result.status,
    fetched: result.works.length,
    upstreamTotal: result.upstreamTotal,
    note: result.note,
  }));

  return {
    scientificName,
    assessmentId,
    nameVariants,
    works: dedupeWorks(results.map(({ result }) => result.works)),
    sources,
    fetchedAt: Date.now(),
  };
}

function evictOldest(): void {
  if (poolCache.size <= MAX_CACHE_ENTRIES) return;
  // Map preserves insertion order, so the head is the least recently written.
  const excess = poolCache.size - MAX_CACHE_ENTRIES;
  let removed = 0;
  for (const key of poolCache.keys()) {
    poolCache.delete(key);
    if (++removed >= excess) break;
  }
}
