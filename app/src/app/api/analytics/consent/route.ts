import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setAnalyticsConsent } from "@/lib/analytics/consent";

/**
 * Records the signed-in user's decision on session recording (#524).
 *
 * Write-only: the current state is read as part of /api/auth/me, which the
 * client already fetches to render the account menu, so there is no GET here.
 *
 * The user id comes from the session cookie via getUser(), never from the
 * request body — otherwise anyone could record a consent decision on someone
 * else's behalf, which is exactly the claim this table exists to be able to
 * make truthfully.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Consent is only ever asked of signed-in users, so there is nobody to record
  // a decision for here.
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (typeof body?.consented !== "boolean") {
    return NextResponse.json(
      { error: "Expected a boolean `consented`" },
      { status: 400 }
    );
  }

  const { error } = await setAnalyticsConsent(supabase, user.id, body.consented);
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ consented: body.consented });
}
