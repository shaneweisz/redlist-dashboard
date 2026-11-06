// The OAuth providers the sign-in page offers, shared by the button list
// (app/login/SignInForm.tsx) and the server action behind it
// (lib/auth/actions.ts) so the two can't drift apart.

type OAuthProvider = {
  // Supabase's own provider slug, which has to match what's enabled under
  // Authentication → Providers in the Supabase dashboard. Microsoft's is
  // "azure" — named after Azure AD, the former name of Microsoft Entra ID —
  // not "microsoft".
  id: "github" | "google" | "azure";
  label: string;
  // Extra OAuth scopes to request, beyond whatever the provider returns by
  // default. Omitted for providers that need none.
  scopes?: string;
  // Set to keep a provider working while taking its button off the sign-in
  // page. Anyone who already signed in this way keeps their session and their
  // linked identity — only the button goes. See VISIBLE_OAUTH_PROVIDERS.
  hidden?: true;
};

// Every provider the app can complete a sign-in with. `resolveOAuthProvider`
// searches this list, not the visible one, so a hidden provider still works for
// anyone mid-flow or holding a link.
//
// Order matters for the buttons: the first reads as the recommended one, so it
// leads with whichever works for the most people. Google has no gate at all.
// GitHub is a developer account most of this audience won't have, and the few
// people already signed in that way know where to look.
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [
  { id: "google", label: "Google" },
  // Hidden 2026-07-30, not removed. Microsoft is blocked at organisations that
  // disable third-party user consent — Cambridge's tenant answers "Approval
  // required", and iucn.org is on Entra ID too (its DNS carries the
  // enterpriseregistration.windows.net CNAME), so the population this button
  // was added for is the population most likely to hit the wall. The requested
  // permissions are already the floor (User.Read + offline_access), so there is
  // no app-side fix; it's tenant consent policy.
  //
  // The sharper reason for hiding rather than leaving it: range-map access is a
  // hand-inserted user_roles row keyed to one user_id, and Supabase only links
  // identities when the verified email matches. Microsoft is the button most
  // likely to return someone's *work* address when their existing account is a
  // personal Google/GitHub one — silently forking a second, role-less account
  // for a user who already had access.
  //
  // Bring it back when either is true: an IUCN user confirms their tenant
  // permits consent, or the app becomes a verified publisher (which needs an
  // institutional sponsor — Microsoft's business verification wants a legally
  // registered entity, and the app registration must belong to a tenant tied to
  // that organisation's Partner Global Account).
  //
  // Azure only returns an email claim if the email scope is asked for
  // explicitly, and the rest of the app leans on email throughout — it labels
  // the account menu, it's the fallback avatar initial, and it's how an
  // account is looked up to grant the admin role in user_roles. A Microsoft
  // user without one would sign in to a half-broken session.
  { id: "azure", label: "Microsoft", scopes: "email", hidden: true },
  { id: "github", label: "GitHub" },
];

// The providers the sign-in page actually renders a button for.
export const VISIBLE_OAUTH_PROVIDERS: readonly OAuthProvider[] =
  OAUTH_PROVIDERS.filter((provider) => !provider.hidden);

/**
 * Narrow the untrusted `provider` field posted by the sign-in form to one of
 * the providers above, or null.
 *
 * The value is caller-controlled form data that goes straight into a Supabase
 * call which redirects the browser off-site, so it is checked against a fixed
 * list rather than trusted.
 *
 * Deliberately searches OAUTH_PROVIDERS rather than VISIBLE_OAUTH_PROVIDERS:
 * hiding a button shouldn't break a sign-in already in flight, and the check
 * here is about what Supabase has enabled, not about what the page offers.
 */
export function resolveOAuthProvider(value: unknown): OAuthProvider | null {
  return OAUTH_PROVIDERS.find((provider) => provider.id === value) ?? null;
}
