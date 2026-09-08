import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "How this dashboard uses anonymous, cookieless usage analytics, and the optional session recording signed-in users can opt in to.",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-xl mx-auto px-4 py-12">
      <Link
        href="/"
        className="text-xs text-zinc-400 dark:text-zinc-500 underline hover:text-zinc-600 dark:hover:text-zinc-300"
      >
        ← Back to the dashboard
      </Link>

      <h1 className="mt-6 text-2xl font-semibold text-zinc-800 dark:text-zinc-100">
        Privacy policy
      </h1>

      <div className="mt-4 space-y-4 text-sm text-zinc-600 dark:text-zinc-400">
        <p>
          This dashboard is part of a PhD research project at the University of
          Cambridge, which is the data controller. We collect a small amount of{" "}
          <strong>anonymous usage analytics</strong> to understand how the
          dashboard is used and to improve it, and — only if you choose to sign
          in — the account details described below.
        </p>

        <p>
          <strong>What we collect.</strong> Pages viewed, the referring page,
          and general device information such as browser and screen size, via{" "}
          <a
            href="https://posthog.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            PostHog
          </a>{" "}
          (hosted in the EU). By default this data is not linked to your
          identity, even if you are signed in, and we do <strong>not</strong>{" "}
          use analytics cookies or store any analytics identifier on your
          device &mdash; which is why you see no cookie banner. The one
          exception is session recording, which is off unless you switch it on;
          see below. We also use{" "}
          <a
            href="https://sentry.io"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Sentry
          </a>{" "}
          to record technical error reports so we can fix problems. If you have
          turned session recording on (see below), those error reports are
          linked to your account and to the recording of what you were doing
          when the error happened, so we can see what caused it; if you
          have not, they carry only a temporary id that exists for that
          one visit and identifies nobody.
        </p>

        <p>
          <strong>What stays in your browser.</strong> Some of what you do here
          is remembered on your own device using your browser&rsquo;s local
          storage: species you pin, columns you show or hide in the occurrence
          table, any georeferencing you do, and which view a few charts open in
          (Range vs Year, Assessors vs Reviewers vs Facilitators, Map vs List).
          This never leaves your browser &mdash; it is not sent to us, not
          shared with anyone, and identifies nobody. It exists only because you
          chose those settings, so it does not require a consent banner. Clearing
          your browser data for this site removes all of it.
        </p>

        <p>
          <strong>If you sign in.</strong> Signing in is optional — everything
          the dashboard shows by default is public, and you do not need an
          account to use it. If you do sign in with Google, Microsoft or GitHub,
          we store the email address, name and profile picture that provider
          gives us, so the site can show who you are signed in as and manage
          access to some features. We never receive your password. Accounts are
          handled by{" "}
          <a
            href="https://supabase.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Supabase
          </a>{" "}
          (hosted in the EU), and signing in stores a cookie on your device to
          keep you signed in.
          That cookie is strictly necessary for signing in to work, so it does
          not require a consent banner. To have your account and everything
          stored with it deleted, email{" "}
          <a
            href="mailto:sw984@cam.ac.uk"
            className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            sw984@cam.ac.uk
          </a>
          .
        </p>

        <p>
          <strong>Session recording (optional, off by default).</strong> If you
          are signed in, you can choose to let us record how you use the
          dashboard: the pages you open, the searches and filters you use, and a
          replay of what happened on your screen &mdash; where you moved, clicked
          and scrolled &mdash; linked to your account. We use it only to find
          the places where the dashboard is confusing or broken, and to see
          which features are actually used. This is entirely optional and is{" "}
          <strong>off unless you turn it on</strong>: nothing is recorded until
          you agree, you do not need to agree to use any part of the site, and
          you can switch it off again at any time from the account menu (your
          avatar, top right), which stops recording immediately and removes the
          identifier from your device. Turning it on stores an analytics
          identifier on your device &mdash; the part that needs your permission,
          and the reason we ask. Recordings are held by PostHog in the EU.
          Passwords are never captured. To have past recordings deleted, email{" "}
          <a
            href="mailto:sw984@cam.ac.uk"
            className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            sw984@cam.ac.uk
          </a>
          .
        </p>

        <p>
          <strong>Why.</strong> We process the anonymous analytics under our
          legitimate interest in maintaining and improving a public research
          tool, and &mdash; for account details &mdash; in offering sign-in at
          all. Session recording is different: we rely on your consent, which is
          why it is off until you give it and why withdrawing it takes effect
          straight away. We do not sell any of this data or use it for
          advertising.
        </p>

        <p>
          <strong>Your rights and more information.</strong> You have rights
          over your personal data under UK data protection law. For details, and
          to exercise those rights, see the University of Cambridge{" "}
          <a
            href="https://www.cam.ac.uk/about-this-site/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            privacy policy
          </a>{" "}
          and{" "}
          <a
            href="https://www.information-compliance.admin.cam.ac.uk/data-protection"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            data protection information
          </a>
          . For anything specific to this dashboard, contact{" "}
          <a
            href="mailto:sw984@cam.ac.uk"
            className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            sw984@cam.ac.uk
          </a>
          .
        </p>
      </div>
    </div>
  );
}
