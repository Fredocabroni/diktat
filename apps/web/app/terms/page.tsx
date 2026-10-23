// Public Terms of Service page. Server component — no auth gate, no
// (app) shell. Accessible to logged-out visitors from the /login
// footer and to signed-in users from Settings.
//
// Content is pre-launch and self-attested. Any substantive change
// should bump LAST_UPDATED and re-run copy-linter.

import type { Metadata } from 'next';
import Link from 'next/link';

const LAST_UPDATED = '2026-10-22';
const CONTACT = 'support@diktat.app';

export const metadata: Metadata = {
  title: 'Terms of Service — Diktat',
  description:
    'The rules for using Diktat. US residents 18 and older, civic debate only, no cash value on Arena Points.',
};

export default function TermsPage(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10 text-text-primary">
      <nav className="mb-6 text-sm">
        <Link href="/" className="text-text-secondary underline-offset-4 hover:underline">
          ← Back
        </Link>
      </nav>
      <h1 className="font-display text-3xl font-bold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-text-tertiary">Last updated: {LAST_UPDATED}</p>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Who can use Diktat</h2>
        <p>
          Diktat is available to residents of the United States who are 18 or older. You confirm
          both at sign-in. We compute your age from a date of birth you enter and discard the date
          right after the check.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Your account</h2>
        <p>
          One person, one account. Keep your sign-in method secure. You are responsible for what you
          post from your account.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">
          Rules for what you post
        </h2>
        <p>Do not:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>Harass, threaten, or dox another person.</li>
          <li>Post content that is illegal in the US, promotes violence, or sexualizes minors.</li>
          <li>Impersonate someone else or lie about who you are.</li>
          <li>Spam, run bots, scrape at scale, or try to break our rate limits.</li>
          <li>Share private information about another person without their consent.</li>
        </ul>
        <p>
          We can remove content that breaks these rules and suspend or terminate accounts that
          repeat the behavior.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Reports</h2>
        <p>
          You can report a post from inside the app. We review reports and act when the rules above
          are broken. You can also reach us at {CONTACT}.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Arena Points (AP)</h2>
        <p>
          Arena Points are a score inside Diktat. They have no cash value. You cannot buy, sell,
          trade, or redeem Arena Points. There are no wallets, no tokens, and no real-money features
          in Diktat.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Copyright and DMCA</h2>
        <p>
          If you believe content on Diktat infringes your copyright, send a DMCA notice to {CONTACT}{' '}
          with the work, the URL on Diktat, your contact details, and the statements required by 17
          U.S.C. §512(c)(3).
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Changes</h2>
        <p>
          We will post a new &ldquo;Last updated&rdquo; date here when we change these terms. Keep
          using Diktat after that date and the new terms apply.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-text-secondary">
        <h2 className="font-display text-lg font-semibold text-text-primary">Contact</h2>
        <p>Questions, DMCA notices, and legal process: {CONTACT}.</p>
        <p>
          See also our{' '}
          <Link href="/privacy" className="text-text-primary underline-offset-4 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
