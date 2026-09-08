import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/roles";
import { getAnalyticsConsent } from "@/lib/analytics/consent";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return NextResponse.json({
    // The account's own id, used client-side as the PostHog distinct_id once
    // analytics consent is given (components/PostHogProvider.tsx). Deliberately
    // the opaque uuid rather than the email, so the analytics identifier is not
    // itself a piece of contact information.
    id: user?.id ?? null,
    email: user?.email ?? null,
    avatarUrl: user?.user_metadata?.avatar_url ?? null,
    canViewRangeMap: await isAdmin(supabase, user?.id),
    // null = never asked, true = opted in, false = asked and declined (#524).
    analyticsConsent: await getAnalyticsConsent(supabase, user?.id),
  });
}
