# Playwright smoke suite

Golden-path smoke-test skeleton. Target wall-clock **< 3 min on CI** so the suite is cheap to run on every PR without becoming the merge-gate bottleneck.

## Running locally

```bash
# one-time install (adds ~300 MB of browsers to the local cache)
pnpm --filter=@diktat/web exec playwright install chromium

# start the dev server in one terminal
pnpm --filter=@diktat/web dev

# run the smoke suite in another terminal
pnpm --filter=@diktat/web exec playwright test
```

## Coverage map

| Spec file                      | Scope                                      | Status  | Auth required   |
| ------------------------------ | ------------------------------------------ | ------- | --------------- |
| `smoke-peek.spec.ts`           | `/peek` renders one Drop without a session | SHIPPED | no              |
| `smoke-login.spec.ts`          | email OTP sign-in flow                     | TODO    | yes (test user) |
| `smoke-onboarding.spec.ts`     | `/onboard/*` tribe-pick + Drop first-vote  | TODO    | yes             |
| `smoke-comments.spec.ts`       | create / like / delete own comment         | TODO    | yes             |
| `smoke-skip-undo.spec.ts`      | skip + undo opinion shift                  | TODO    | yes             |
| `smoke-delete-account.spec.ts` | `/settings` → delete flow                  | TODO    | yes             |

## Authenticated specs — pre-reqs

The TODO specs need a provisioned test user. Minimum:

- `PLAYWRIGHT_TEST_EMAIL` — the test user's email, resolvable through Resend in CI.
- A way to bypass the email-OTP wait. Options (to be picked when the first authenticated spec lands):
  1. Use the dev-only magic-link helper at `/auth/dev-link?email=…` (ships only in non-prod).
  2. Add a scoped `PLAYWRIGHT_OTP_BYPASS_SECRET` env that `Authentication → Email Templates → Magic Link` renders in a `{{ .Token }}` dev template.

## axe a11y

Once the first authenticated spec lands, each spec file imports `@axe-core/playwright` and asserts no serious / critical findings on the key screens. The `/peek` spec intentionally skips axe until the shared helper is in place — one new dependency at a time.

## CI wiring

`.github/workflows/playwright-smoke.yml` runs the suite on PRs that touch `apps/web/**` or carry the `run-playwright` label. The authenticated project only runs when `PLAYWRIGHT_TEST_EMAIL` is set in the repo environment.
