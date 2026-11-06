import { NextResponse } from "next/server";
import { safeRedirectPath } from "@/config/public-origin";
import { createClient } from "@/lib/supabase/server";

/**
 * Redirect with a *relative* Location, which the browser resolves against the
 * URL it is already on.
 *
 * Deliberately not `NextResponse.redirect(absoluteUrl)`: the origin of
 * `request.url` is built from the Host header, which a Host-rewriting proxy
 * gets wrong. One used to sit in front of red.cst.cam.ac.uk / en.ki and threw
 * users off their own domain half-way through sign-in (#416). Those domains
 * now redirect to dashforlife.org, but a relative Location still keeps users
 * wherever they started with no host detection at all.
 */
function redirectToPath(path: string) {
  return new NextResponse(null, { status: 302, headers: { Location: path } });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  // `next` is attacker-controllable and a relative Location makes that matter —
  // see safeRedirectPath.
  const next = safeRedirectPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return redirectToPath(next);
    }
  }

  return redirectToPath("/login?error=auth_callback_failed");
}
