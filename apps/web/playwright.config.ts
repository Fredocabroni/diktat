// Playwright smoke-suite config.
//
// Scope: the thinnest possible golden-path coverage — one test per
// user-visible flow that would make the app unusable if it broke.
// Target wall-clock < 3 min on CI so the suite is cheap to run on
// every PR and doesn't become the merge-gate bottleneck.
//
// Coverage targets (file-per-flow in ./e2e/):
//   - smoke-peek.spec.ts        — /peek renders one Drop without a session
//   - smoke-login.spec.ts       — TODO: email OTP path, see ./e2e/README.md
//   - smoke-onboarding.spec.ts  — TODO: tribe pick + Drop first-vote
//   - smoke-comments.spec.ts    — TODO: create / like / delete own comment
//   - smoke-skip-undo.spec.ts   — TODO: skip + undo opinion shift
//   - smoke-delete-account.spec.ts — TODO: /settings → delete flow
//
// The TODO flows need a provisioned test user — scaffolded in the
// README; they run behind a `smoke-authenticated` project tag so the
// unauth'd flows can CI by themselves without an auth secret.

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Run each file in isolation so a flaky test doesn't bleed state.
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'smoke-unauthenticated',
      testMatch: /smoke-(peek)\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      // Behind an env guard because the authenticated flows need a
      // provisioned test user secret (PLAYWRIGHT_TEST_EMAIL +
      // PLAYWRIGHT_TEST_OTP_BYPASS_SECRET). CI only runs this project
      // when those secrets are available.
      name: 'smoke-authenticated',
      testMatch: /smoke-(login|onboarding|comments|skip-undo|delete-account)\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
  ],
});
