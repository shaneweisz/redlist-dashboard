"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type Me = {
  id: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** null = never asked, true = opted in, false = asked and declined (#524). */
  analyticsConsent: boolean | null;
};

const SIGNED_OUT: Me = {
  id: null,
  email: null,
  avatarUrl: null,
  analyticsConsent: null,
};

type MeContextValue = {
  me: Me;
  /** False until /api/auth/me answers, so callers can avoid flashing a
   *  signed-out UI at someone who is in fact signed in. */
  loaded: boolean;
  /** Records a consent decision and reflects it locally straight away. */
  setAnalyticsConsent: (consented: boolean) => Promise<void>;
};

const MeContext = createContext<MeContextValue>({
  me: SIGNED_OUT,
  loaded: false,
  setAnalyticsConsent: async () => {},
});

/**
 * One fetch of /api/auth/me for everything that needs to know who is signed in.
 *
 * This exists because analytics consent has two consumers that sit in different
 * parts of the tree and must never disagree: PostHogProvider (which starts or
 * stops session recording) and the account menu (which shows and toggles it). A
 * second, independently-fetched copy of that state is a recording that keeps
 * running after the toggle says it stopped, so they share one.
 *
 * Mounted above PostHogProvider in the root layout. Note that
 * mapping/OccurrenceMapRow.tsx still fetches /api/auth/me itself for its
 * canViewRangeMap check; it is left alone deliberately (it needs no consent
 * state, and rewiring a 6,000-line component is not this change's business).
 */
export function MeProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me>(SIGNED_OUT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : SIGNED_OUT))
      .then((data: Me) => {
        if (cancelled) return;
        setMe(data);
        setLoaded(true);
      })
      .catch(() => {
        // Network failure: stay signed-out, which is also the no-recording
        // state. Failing closed is the only safe direction for consent.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setAnalyticsConsent = useCallback(async (consented: boolean) => {
    // Optimistic: the toggle and the prompt should feel instant, and the
    // consequence of the write failing is that recording reverts on next load —
    // never that we record without a stored decision, because the server is the
    // only thing that decides on a fresh page load.
    setMe((prev) => ({ ...prev, analyticsConsent: consented }));

    try {
      const res = await fetch("/api/analytics/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consented }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      // Roll back to "not recording" rather than to the previous value: if we
      // could not store an opt-in, we have no record of consent, so we must not
      // behave as though we had one.
      setMe((prev) => ({ ...prev, analyticsConsent: consented ? null : prev.analyticsConsent }));
    }
  }, []);

  return (
    <MeContext.Provider value={{ me, loaded, setAnalyticsConsent }}>
      {children}
    </MeContext.Provider>
  );
}

export function useMe() {
  return useContext(MeContext);
}
