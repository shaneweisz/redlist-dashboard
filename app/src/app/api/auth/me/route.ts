import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/roles";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return NextResponse.json({
    id: user?.id ?? null,
    email: user?.email ?? null,
    avatarUrl: user?.user_metadata?.avatar_url ?? null,
    canViewRangeMap: await isAdmin(supabase, user?.id),
    internal: isInternalEmail(user?.email),
  });
}

/**
 * Whether this account's analytics should be marked as the dashboard's own
 * traffic. INTERNAL_ANALYTICS_EMAILS is a server-only, comma-separated list, so
 * the addresses stay out of the repo and the client bundle; only the yes/no
 * reaches the browser.
 */
function isInternalEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const internal = (process.env.INTERNAL_ANALYTICS_EMAILS ?? "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return internal.includes(email.toLowerCase());
}
