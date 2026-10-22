// Public Privacy Policy page. Server component — no auth gate, no
// (app) shell. Accessible to logged-out visitors from the /login
// footer and to signed-in users from Settings.
//
// Content lists the actual processors Diktat uses pre-launch. Any
// change to that list must land in this file in the same PR as the
// code change, and re-run copy-linter + security-reviewer.

import type { Metadata } from 'next';
import Link from 'next/link';

const LAST_UPDATED = '2026-10-22';
const CONTACT = 'CONTACT_EMAIL_PLACEHOLDER';

export const metadata: Metadata = {
  title: 'Privacy Policy — Diktat',
  description: 'What Diktat collects, who processes it, and the rights you have. Short and honest.',
};

export default function PrivacyPage(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10 text-text-primary">
      <nav className="mb-6 text-sm">
        <Link href="/" className="text-text-secondary underline-offset-4 hover:underline">
          ← Back
        </Link>
      </nav>
      <h1 className="font-display text-3xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-text-tertiary">Last updated: {LAST_UPDATED}</p>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Short version</h2>
        <p>
          We collect the minimum we need to run the service. We do not sell or share your personal
          data with third parties for their own marketing. We do not run targeted ads. Arena Points
          have no cash value and Diktat has no wallets or real-money features.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">What we collect</h2>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong className="text-text-primary">Email address</strong> — if you sign in with
            email, to send you a one-time code and keep your account.
          </li>
          <li>
            <strong className="text-text-primary">X profile basics</strong> — if you sign in with X,
            your X user ID, handle, display name, and avatar URL. We do not read your DMs or your
            follower list.
          </li>
          <li>
            <strong className="text-text-primary">Your Diktat handle</strong> — the one you pick,
            tied to your account.
          </li>
          <li>
            <strong className="text-text-primary">Your activity</strong> — stances, votes, debate
            posts, Arena Points history. This is the service.
          </li>
          <li>
            <strong className="text-text-primary">Age-check timestamp</strong> — the date we
            verified you are 18 or older. We never store the date of birth you entered.
          </li>
          <li>
            <strong className="text-text-primary">Basic security and usage logs</strong> — IP
            address, user agent, request timing, for rate limiting and abuse protection. We keep
            these short-term.
          </li>
          <li>
            <strong className="text-text-primary">Bot-check token</strong> — a short-lived token
            from Cloudflare Turnstile when you sign in. We do not store it.
          </li>
        </ul>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">
          Who processes your data
        </h2>
        <p>These processors handle data on our behalf:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong className="text-text-primary">Supabase</strong> — database and sign-in.
          </li>
          <li>
            <strong className="text-text-primary">Vercel</strong> — web hosting.
          </li>
          <li>
            <strong className="text-text-primary">Railway</strong> — API and background workers.
          </li>
          <li>
            <strong className="text-text-primary">Resend</strong> — delivery of sign-in emails.
          </li>
          <li>
            <strong className="text-text-primary">Cloudflare Turnstile</strong> — bot check on
            sign-in.
          </li>
          <li>
            <strong className="text-text-primary">Upstash</strong> — rate limiting and queueing.
          </li>
          <li>
            <strong className="text-text-primary">X / Twitter</strong> — only if you sign in with X.
          </li>
          <li>
            <strong className="text-text-primary">AI providers (Anthropic, Perplexity, xAI)</strong>{' '}
            — for debate scoring and fact-checks. Public content and prompts flow through them. We
            do not send them your email or your sign-in details. If a provider&rsquo;s API key is
            not set, that provider is routed out of every chain and receives nothing.
          </li>
        </ul>
        <p>
          Each processor is bound by its own terms and processes data on our behalf. We review this
          list and keep it current.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">What we do not do</h2>
        <ul className="ml-5 list-disc space-y-1">
          <li>We do not sell your personal data.</li>
          <li>We do not share it with third parties for their marketing.</li>
          <li>We do not run targeted ads.</li>
          <li>We do not offer wallets, tokens, or any real-money features.</li>
          <li>We do not store your date of birth after the age check.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Your rights</h2>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong className="text-text-primary">See your data</strong> — your profile, activity,
            and Arena Points are all visible in the app. Email {CONTACT} for a full copy.
          </li>
          <li>
            <strong className="text-text-primary">Correct your data</strong> — edit your profile
            fields in Settings.
          </li>
          <li>
            <strong className="text-text-primary">Delete your account</strong> — Settings has a
            self-serve &ldquo;Delete my account&rdquo; option. One confirmation and we delete your
            account and your personal data.
          </li>
          <li>
            <strong className="text-text-primary">Ask us a question</strong> — write to {CONTACT}.
          </li>
        </ul>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Retention</h2>
        <ul className="ml-5 list-disc space-y-1">
          <li>Account data is kept for the life of your account.</li>
          <li>
            Accounts blocked at the age check are purged within 7 days (the age-check timestamp is
            the only trace that stays).
          </li>
          <li>Short-term security logs rotate within 30 days.</li>
          <li>
            When you delete your account, we remove your personal data. Arena Points ledger rows
            that keep the economy auditable are anonymized, not erased — your handle and user ID are
            stripped from them.
          </li>
          <li>Backups rotate out within 30 days of a change.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Changes</h2>
        <p>
          We post a new &ldquo;Last updated&rdquo; date here when this policy changes. Material
          changes get a note on the sign-in page.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Contact</h2>
        <p>Privacy questions and data requests: {CONTACT}.</p>
        <p>
          See also our{' '}
          <Link href="/terms" className="text-text-primary underline-offset-4 hover:underline">
            Terms of Service
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
