// Source-pin tests for the self-serve account deletion UI. The copy
// invariants are addiction-audit grade — a future edit that
// introduces "are you sure?" / "we'll miss you" / shame vocabulary
// must fail CI, not production.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const COMPONENT = readFileSync(
  new URL('../../components/settings/DeleteAccount.tsx', import.meta.url),
  'utf8',
);
const SETTINGS = readFileSync(
  new URL('../(app)/settings/notifications/page.tsx', import.meta.url),
  'utf8',
);

describe('DeleteAccount — operator contract', () => {
  it('mounts on the Settings page', () => {
    expect(SETTINGS).toMatch(/import \{ DeleteAccount \} from/);
    expect(SETTINGS).toMatch(/<DeleteAccount \/>/);
  });

  it('uses the trpc.user.deleteAccount mutation', () => {
    expect(COMPONENT).toMatch(/trpc\.user\.deleteAccount\.useMutation/);
  });

  it('signs out and routes to /login on success', () => {
    expect(COMPONENT).toMatch(/supabase\.auth\.signOut\(\)/);
    expect(COMPONENT).toMatch(/window\.location\.href = '\/login'/);
  });

  it('uses one confirmation (two-step: idle → confirm), not a dark-pattern "are you sure?" modal', () => {
    // Phase union: idle → confirm → deleting plus three terminal
    // branches the server-side gates can land on (error, recent_auth,
    // blocked). No "are you sure?" nag step.
    expect(COMPONENT).toMatch(
      /type Phase = 'idle' \| 'confirm' \| 'deleting' \| 'error' \| 'recent_auth' \| 'blocked'/,
    );
  });

  it('on recent_auth_required: shows a re-sign-in CTA (not a toast + retry loop)', () => {
    expect(COMPONENT).toMatch(/>Sign in again to delete your account\.</);
    expect(COMPONENT).toMatch(/data-component="DeleteAccount\.RecentAuth\.ReSignIn"/);
  });

  it('on FORBIDDEN (in-battle or in-matchmaking): shows a factual blocker, no coercion', () => {
    expect(COMPONENT).toMatch(/data-component="DeleteAccount\.Blocked"/);
    expect(COMPONENT).toMatch(
      /Finish your current battle or leave the matchmaking queue, then try again\./,
    );
  });

  it('offers a Cancel escape on the confirmation step (no coercion)', () => {
    expect(COMPONENT).toMatch(/data-component="DeleteAccount\.Confirm\.Cancel"/);
    expect(COMPONENT).toMatch(/onClick=\{\(\) => setPhase\('idle'\)\}/);
  });
});

describe('DeleteAccount — copy invariants', () => {
  it('states the destructive outcome plainly, with no guilt vocabulary', () => {
    expect(COMPONENT).toMatch(/This permanently deletes your account/);
    expect(COMPONENT).toMatch(/Not reversible\./);
  });

  it('explains ledger anonymization honestly', () => {
    expect(COMPONENT).toMatch(
      /Arena Points history is kept[\s\S]{0,40}anonymously for ledger[\s\S]{0,20}integrity/,
    );
  });

  it('is free of coercion / guilt / FOMO / shame vocabulary (in rendered JSX, not comments)', () => {
    // Trim the file to the first `return (` block onward — comments
    // may discuss these phrases as explicit non-goals, which must
    // not falsify the test.
    const firstReturn = COMPONENT.indexOf('return (');
    const jsx = COMPONENT.slice(firstReturn);
    const forbidden = [
      /we(?:'| wi)ll miss you/i,
      /are you sure/i,
      /think again/i,
      /sorry to see/i,
      /come back/i,
      /final chance/i,
      /last warning/i,
    ];
    for (const re of forbidden) {
      expect(jsx).not.toMatch(re);
    }
  });

  it("the Delete button label is a plain verb, not 'Delete Forever' or 'Yes, delete'", () => {
    // Formatter wraps the label onto its own line — allow whitespace.
    expect(COMPONENT).toMatch(/>\s*Delete\s*<\/button>/);
    expect(COMPONENT).toMatch(/'Delete my account'/);
  });
});
