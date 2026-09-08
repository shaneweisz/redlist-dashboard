import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The version of /privacy that the current consent ask describes.
 *
 * Bumping this invalidates every stored decision, so everyone is asked again on
 * their next visit and nothing is recorded in the meantime. That is the correct
 * behaviour for a *material* change to what we record — consent is only
 * informed with respect to what it was asked about — but it is a real cost to
 * users, so do not bump it for typos or rewording. Date-stamped rather than
 * numbered so a stored row says when, not just which.
 */
export const ANALYTICS_POLICY_VERSION = "2026-09-08";

/**
 * `null` means "never asked" — distinct from a stored `false` ("asked, and
 * declined"), which is what stops the prompt reappearing forever. See the
 * three-state note in the migration.
 */
export type AnalyticsConsent = boolean | null;

export async function getAnalyticsConsent(
  supabase: SupabaseServerClient,
  userId: string | null | undefined
): Promise<AnalyticsConsent> {
  if (!userId) return null;

  const { data } = await supabase
    .from("analytics_consent")
    .select("consented, policy_version")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return null;

  // A decision taken against an older policy is not informed consent for what
  // the current one describes, so fall back to "never asked" — which both stops
  // recording and re-shows the prompt. Deliberately applied to a stored `false`
  // too: someone who declined an older, narrower ask has not declined this one.
  if (data.policy_version !== ANALYTICS_POLICY_VERSION) return null;

  return data.consented;
}

/**
 * Records a decision, overwriting any previous one. Returns an error message on
 * failure rather than throwing, so the caller can answer the request.
 */
export async function setAnalyticsConsent(
  supabase: SupabaseServerClient,
  userId: string,
  consented: boolean
): Promise<{ error: string | null }> {
  const { error } = await supabase.from("analytics_consent").upsert(
    {
      user_id: userId,
      consented,
      // Explicit rather than leaning on the column default, which only applies
      // on insert — an upsert that updates an existing row would otherwise keep
      // the original timestamp and misdate the decision.
      decided_at: new Date().toISOString(),
      policy_version: ANALYTICS_POLICY_VERSION,
    },
    { onConflict: "user_id" }
  );

  return { error: error?.message ?? null };
}
