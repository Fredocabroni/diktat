// Behaviour test for the version-skew detector + source-pin tests for
// the notice component and the age-gate page wiring. vitest runs the
// apps/web suite in Node, so the detector (pure) is called directly;
// the React surfaces are asserted via file-text regex.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isVersionSkewError, VERSION_SKEW_COPY } from '../../lib/trpc-errors';

const NOTICE = readFileSync(
  new URL('../../components/VersionSkewNotice.tsx', import.meta.url),
  'utf8',
);
const AGE_PAGE = readFileSync(new URL('../onboard/age/page.tsx', import.meta.url), 'utf8');

describe('isVersionSkewError — detector', () => {
  it('flags TRPC NOT_FOUND (procedure missing on server)', () => {
    const err = { data: { code: 'NOT_FOUND', httpStatus: 404 }, message: 'No procedure found' };
    expect(isVersionSkewError(err)).toBe(true);
  });

  it('flags any 404 httpStatus even without the NOT_FOUND code', () => {
    const err = { data: { httpStatus: 404 }, message: 'Not Found' };
    expect(isVersionSkewError(err)).toBe(true);
  });

  it('flags a transport failure (no response body, TypeError cause)', () => {
    const err = { message: 'Failed to fetch', cause: new TypeError('Failed to fetch') };
    expect(isVersionSkewError(err)).toBe(true);
  });

  it('flags transport failure by message text when cause is absent', () => {
    expect(isVersionSkewError({ message: 'NetworkError when attempting to fetch' })).toBe(true);
    expect(isVersionSkewError({ message: 'Load failed' })).toBe(true);
  });

  it('does NOT flag a BAD_REQUEST (bad DOB — user can correct)', () => {
    const err = {
      data: { code: 'BAD_REQUEST', httpStatus: 400 },
      message: 'invalid birth date',
    };
    expect(isVersionSkewError(err)).toBe(false);
  });

  it('does NOT flag a FORBIDDEN (terminal block)', () => {
    const err = { data: { code: 'FORBIDDEN', httpStatus: 403 }, message: 'blocked' };
    expect(isVersionSkewError(err)).toBe(false);
  });

  it('does NOT flag a 500 (real server error — surface the raw message)', () => {
    const err = { data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 }, message: 'boom' };
    expect(isVersionSkewError(err)).toBe(false);
  });

  it('tolerates nulls / primitives / shapeless inputs', () => {
    expect(isVersionSkewError(null)).toBe(false);
    expect(isVersionSkewError(undefined)).toBe(false);
    expect(isVersionSkewError('string err')).toBe(false);
    expect(isVersionSkewError(42)).toBe(false);
    expect(isVersionSkewError({})).toBe(false);
  });
});

describe('VERSION_SKEW_COPY — civic + calm wording', () => {
  it('leads with a plain statement, not an urgency / scarcity frame', () => {
    expect(VERSION_SKEW_COPY.title).toBe("We're updating.");
  });

  it('tells the user what to do in a time frame they can plan around', () => {
    expect(VERSION_SKEW_COPY.body).toBe('Try again in a few minutes.');
  });

  it('names the retry affordance as a verb', () => {
    expect(VERSION_SKEW_COPY.retry).toBe('Try again');
  });

  it('is free of countdown / FOMO / shame vocabulary', () => {
    const all = Object.values(VERSION_SKEW_COPY).join(' ').toLowerCase();
    for (const banned of ['hurry', 'last chance', 'now or never', 'oops', 'sorry', 'uh oh']) {
      expect(all).not.toContain(banned);
    }
  });
});

describe('VersionSkewNotice — a11y + control contract', () => {
  it('is announced as a status region, not a red alert', () => {
    expect(NOTICE).toMatch(/role="status"/);
    expect(NOTICE).toMatch(/aria-live="polite"/);
  });

  it('renders the copy constants, not inline strings', () => {
    expect(NOTICE).toMatch(/VERSION_SKEW_COPY\.title/);
    expect(NOTICE).toMatch(/VERSION_SKEW_COPY\.body/);
    expect(NOTICE).toMatch(/VERSION_SKEW_COPY\.retry/);
  });

  it('exposes a retry button that self-disables while busy', () => {
    expect(NOTICE).toMatch(/onClick=\{onRetry\}/);
    expect(NOTICE).toMatch(/disabled=\{busy\}/);
    // "Trying…" is the busy label — plain, no spinner lingo.
    expect(NOTICE).toMatch(/busy \? 'Trying…' : VERSION_SKEW_COPY\.retry/);
  });
});

describe('/onboard/age — wires the detector + notice', () => {
  it('imports the detector and the notice', () => {
    expect(AGE_PAGE).toMatch(/import \{ VersionSkewNotice \} from/);
    expect(AGE_PAGE).toMatch(/import \{ isVersionSkewError \} from/);
  });

  it('branches onError on isVersionSkewError before falling back to raw copy', () => {
    expect(AGE_PAGE).toMatch(/if \(isVersionSkewError\(err\)\)\s*\{\s*setShowSkewNotice\(true\)/);
  });

  it('renders the VersionSkewNotice when the skew flag is set', () => {
    expect(AGE_PAGE).toMatch(/\{showSkewNotice \?[\s\S]{0,60}<VersionSkewNotice/);
  });

  it('clears the skew flag on resubmit so the user is never stuck on it', () => {
    expect(AGE_PAGE).toMatch(/setShowSkewNotice\(false\)/);
  });

  it('disables the Continue button while the skew notice is visible', () => {
    // Otherwise double-submit is possible — the Retry button owns the
    // retry path.
    expect(AGE_PAGE).toMatch(/disabled=\{attest\.isPending \|\| showSkewNotice\}/);
  });

  it('hides the red raw-error panel while the skew notice is visible', () => {
    // The two surfaces never render together — a version-skew error is
    // not a user-correctable one, and showing both would conflict.
    expect(AGE_PAGE).toMatch(/error && !showSkewNotice/);
  });
});
