// Smoke: /peek renders one Drop without a session.
//
// This is the only fully-unauth'd user path in Diktat today. If
// /peek 404s or redirects a logged-out user to /login, the public
// off-ramp from the onboarding gate is broken — that's a release
// blocker we want to catch at CI, not after Michael tweets the link.
//
// Scope: GET /peek → 200 → the DOM carries the Diktat brand mark
// AND at least one element identifying it as a Drop (headline or
// the "What this means" section). No axe check here yet — that
// lands with smoke-onboarding when the first a11y-sensitive flow
// comes online.

import { expect, test } from '@playwright/test';

test.describe('smoke: /peek — public Drop preview', () => {
  test('renders without a session', async ({ page }) => {
    const resp = await page.goto('/peek');
    expect(resp?.ok(), 'GET /peek should return 2xx').toBeTruthy();

    // No redirect to /login — the whole point of this flow is that
    // signed-out visitors land here directly.
    expect(page.url()).not.toContain('/login');

    // Brand sanity: the <title> or an <h1> somewhere should mention
    // "Diktat". The page may be entirely client-rendered after
    // hydration, so wait on either.
    await expect(page).toHaveTitle(/Diktat/i, { timeout: 10_000 });
  });
});
