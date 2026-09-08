-- Opt-in consent for PostHog session recording and identified analytics (#524).
--
-- Everything the dashboard records today is anonymous and cookieless
-- (src/components/PostHogProvider.tsx): in-memory persistence, no identifier
-- stored on the device, no identify() call even when signed in. That is
-- precisely why the site has never needed a consent banner.
--
-- Session replay breaks both halves of that: it stores an identifier on the
-- device so a session can be stitched across page loads, and it ties what you
-- did on screen to your account. Under UK GDPR/PECR that needs opt-in consent
-- which is specific, informed, as easy to withdraw as to give, and — the reason
-- this is a table rather than a localStorage flag — demonstrable after the fact.
--
-- One row per user, rewritten in place whenever they change their mind.
-- decided_at and policy_version are what make the row a record of a decision
-- rather than a mere setting.
--
-- NOTE the three-state model this table encodes, which the app leans on:
--   no row          -> never asked; show the prompt
--   consented=false -> asked and declined; stay silent, do not re-prompt
--   consented=true  -> recording allowed
-- Collapsing "never asked" into "false" would make declining meaningless, since
-- the prompt would return on every page load.

create table public.analytics_consent (
  user_id uuid primary key references auth.users (id) on delete cascade,
  consented boolean not null,
  decided_at timestamptz not null default now(),
  -- Which version of /privacy the user was shown when they decided. Consent is
  -- only informed with respect to what it described at the time, so a material
  -- change to that page means bumping ANALYTICS_POLICY_VERSION (see
  -- src/lib/analytics/consent.ts) and asking again, rather than inheriting an
  -- answer someone gave about materially different processing.
  policy_version text not null
);

alter table public.analytics_consent enable row level security;

-- Unlike user_roles — where granting yourself a role is exactly what RLS has to
-- prevent — this data is the user's own to give, inspect and withdraw, so all
-- three verbs are open on their own row and only their own row.
--
-- There is deliberately no delete policy: withdrawing consent updates the row to
-- consented = false rather than removing it, because a deleted row is
-- indistinguishable from "never asked" and would erase the very audit trail the
-- table exists to keep. (The row still disappears with the account itself, via
-- the on delete cascade above.)
create policy "Users can view their own analytics consent"
  on public.analytics_consent for select
  using (auth.uid() = user_id);

create policy "Users can record their own analytics consent"
  on public.analytics_consent for insert
  with check (auth.uid() = user_id);

create policy "Users can change their own analytics consent"
  on public.analytics_consent for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
