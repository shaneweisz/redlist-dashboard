"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { markInternalTraffic } from "@/lib/analytics/events";

export type Me = {
  id: string | null;
  email: string | null;
  avatarUrl: string | null;
};

const SIGNED_OUT: Me = {
  id: null,
  email: null,
  avatarUrl: null,
};

type MeContextValue = {
  me: Me;
  /** False until /api/auth/me answers, so callers can avoid flashing a
   *  signed-out UI at someone who is in fact signed in. */
  loaded: boolean;
};

const MeContext = createContext<MeContextValue>({
  me: SIGNED_OUT,
  loaded: false,
});

/**
 * One fetch of /api/auth/me for everything that needs to know who is signed in.
 *
 * Introduced for analytics consent, which had two consumers in different parts
 * of the tree that could not be allowed to disagree. That went away with #537;
 * the account menu is the remaining consumer, and this stays as the one place
 * that asks who is signed in.
 *
 * Note that mapping/OccurrenceMapRow.tsx still fetches /api/auth/me itself for
 * its canViewRangeMap check; it is left alone deliberately (rewiring a
 * 6,000-line component is not this change's business).
 */
export function MeProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me>(SIGNED_OUT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : SIGNED_OUT))
      .then((data: Me & { internal?: boolean }) => {
        if (cancelled) return;
        // The dashboard's own maintainer: mark their traffic so usage analysis
        // can exclude it (see INTERNAL_ANALYTICS_EMAILS in /api/auth/me).
        if (data.internal) markInternalTraffic();
        setMe(data);
        setLoaded(true);
      })
      .catch(() => {
        // Network failure: stay signed-out, which is the safe direction — the
        // account menu shows "sign in" rather than a half-rendered identity.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <MeContext.Provider value={{ me, loaded }}>{children}</MeContext.Provider>
  );
}

export function useMe() {
  return useContext(MeContext);
}
