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

/** The maintainer's account: its analytics events are tagged internal. */
const INTERNAL_EMAIL = "shaneweisz@gmail.com";

function isInternalEmail(email: string | null | undefined): boolean {
  return email?.toLowerCase() === INTERNAL_EMAIL;
}
