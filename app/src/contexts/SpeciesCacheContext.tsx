"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Sentry from "@sentry/nextjs";
import { shouldSkipRequest, toCacheEntry, type SpeciesCacheEntry } from "./species-cache-logic";
import { speciesEntryFromFiles } from "@/lib/species-lists/loader";

export type { SpeciesCacheEntry };

interface SpeciesCacheValue {
  entries: Record<string, SpeciesCacheEntry>;
  loadingUrls: Set<string>;
  errors: Record<string, string>;
  // Idempotent: fetches `url` at most once, no matter how many callers request it
  // concurrently (e.g. two compare-mode panels both selecting "Birds") — later
  // callers for an already-cached or in-flight url are a no-op.
  request: (url: string) => void;
}

const SpeciesCacheContext = createContext<SpeciesCacheValue | null>(null);

/**
 * Shared species-fetch cache, keyed by the exact request URL (so e.g.
 * `?taxon=birds` and `?taxon=birds&category=NE` are naturally distinct entries).
 * Wrap one or more RedListView instances in a single provider to have them share
 * fetches — the single-dashboard page wraps exactly one instance (no behavior
 * change from today), compare mode wraps two so picking the same taxon on both
 * sides only fetches it once.
 */
export function SpeciesCacheProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, SpeciesCacheEntry>>({});
  const [loadingUrls, setLoadingUrls] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Tracks in-flight requests so concurrent callers (e.g. both panels mounting at
  // once) dedupe even before the first `entries` update lands.
  const inFlightRef = useRef<Set<string>>(new Set());
  // One AbortController per in-flight url, aborted on provider unmount — so
  // navigating away (e.g. leaving /compare) actually cancels in-flight
  // requests instead of letting them complete for a component tree that's
  // gone, and their completion doesn't call setState on an unmounted provider.
  const abortControllersRef = useRef<Record<string, AbortController>>({});
  useEffect(() => {
    return () => {
      Object.values(abortControllersRef.current).forEach(c => c.abort());
      abortControllersRef.current = {};
    };
  }, []);

  const request = useCallback((url: string) => {
    if (shouldSkipRequest(url, entries, inFlightRef.current)) return;
    inFlightRef.current.add(url);
    const controller = new AbortController();
    abortControllersRef.current[url] = controller;
    setLoadingUrls(prev => new Set(prev).add(url));
    const fromRoute = () => fetch(url, { signal: controller.signal })
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Species API returned ${res.status}`);
        }
        return toCacheEntry(await res.json());
      });
    // The pre-built per-group files answer almost every request (lib/species-lists);
    // null means they can't (no files for this deployment, or an arbitrary-rank taxon)
    // and a failed file load falls back too — reported, since no server log sees it.
    speciesEntryFromFiles(url)
      .catch(err => {
        Sentry.captureException(err, { tags: { feature: "species-lists" }, extra: { url } });
        return null;
      })
      .then(entry => entry ?? fromRoute())
      .then(entry => {
        if (controller.signal.aborted) return; // provider unmounted; nothing left to update
        setEntries(prev => ({ ...prev, [url]: entry }));
      })
      .catch(err => {
        if (controller.signal.aborted) return; // provider unmounted; nothing left to update
        setErrors(prev => ({ ...prev, [url]: err instanceof Error ? err.message : "Unknown error" }));
      })
      .finally(() => {
        inFlightRef.current.delete(url);
        delete abortControllersRef.current[url];
        if (controller.signal.aborted) return;
        setLoadingUrls(prev => {
          const next = new Set(prev);
          next.delete(url);
          return next;
        });
      });
  // `request`'s identity legitimately changes whenever `entries` does — reading
  // `entries` fresh here (rather than via a ref kept "in sync" by a separate
  // effect) matters: a ref updated in its own useEffect lags one commit behind
  // whichever consumer effect's `cache.entries` change triggered it, so a
  // component whose own fetch just resolved could re-run its request effect
  // before the ref catches up and re-fire a request for the url it just
  // received (confirmed by hand — this actually happened). Consumers avoid
  // over-triggering not by making `request` stable, but by depending on
  // `cache.entries`/`cache.request` specifically rather than the whole cache
  // object (see RedListView.tsx) — those two only change together with
  // `entries`, never independently on a loadingUrls/errors-only update.
  }, [entries]);

  const value = useMemo<SpeciesCacheValue>(
    () => ({ entries, loadingUrls, errors, request }),
    [entries, loadingUrls, errors, request]
  );

  return <SpeciesCacheContext.Provider value={value}>{children}</SpeciesCacheContext.Provider>;
}

export function useSpeciesCache(): SpeciesCacheValue {
  const ctx = useContext(SpeciesCacheContext);
  if (!ctx) throw new Error("useSpeciesCache must be used within a SpeciesCacheProvider");
  return ctx;
}
