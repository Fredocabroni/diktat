# Diktat

A Gen Z political news + debate PWA. "TikTok meets Duolingo meets Reuters raised by Clash Royale."

## Non-negotiables

- Mobile-first PWA, Next.js 15 App Router, TypeScript strict everywhere.
- Custodial wallets hide crypto. Users see USD.
- AP-only prediction markets (Polymarket odds as data feed only).
- Community + AI fact-checks. **Primary sources only — no MSM as truth source.**
- One unified score (Arena Points). 12 tiers.
- Ethical guardrails from `docs/ADDICTION_ARCHITECTURE.md` are absolute.

## Architecture

- Monorepo via Turborepo + pnpm.
- apps: `web`, `api`, `workers`, `bots`
- packages: `ui`, `db`, `ap-engine`, `shared`, `ai-fabric`

## Rules for Claude

- Default model: Opus 4.7 xhigh.
- Enter plan mode for any multi-file change. Get approval before execution unless the scope is clearly a single bounded fix.
- Use the `explore` subagent for any unknown area of the repo.
- Use the `schema-reviewer` subagent before any migration touches.
- Never use sed, heredoc, or shell redirects to edit files. Use the edit tools only.
- Commit in atomic units with conventional commits. Feature branches only. Never push to `main`.
- Session logs via the `session-recap` skill at end of every multi-hour session.
- When touching anything user-facing, run `copy-linter` subagent.
- When designing mechanics, run `addiction-auditor` subagent.

## Deployment

- web → Vercel (auto from `main` via GitHub) — **TODO until VERCEL_TOKEN is added**
- api → Railway — **TODO until RAILWAY_TOKEN is added**
- workers → Railway (separate service) — **TODO**
- bots → Railway (separate service) — **TODO**

## Source-of-truth docs

Pin these in context. Do not re-invent what these already decide:

- `docs/MASTER_PLAN.md`
- `docs/ADDICTION_ARCHITECTURE.md`
- `docs/X_LAUNCH_PLAN.md`
- `docs/TYRION_BUILD_QUEUE.md`

## Taboo

- Never mention bitcoin, ethereum, or general crypto terminology in user-facing copy. Wallet = "Wallet", currency = "USDC" shown as USD, stakes = "AP".
- Never reference mainstream media as a fact source in generated content.
- Never add gambling-tier real-money mechanics. AP only.
- Never instruct a user to close other apps, delete accounts, or override their own decisions.

## TODOs

- **xAI adapter** — TODO until `XAI_API_KEY` is set in `.env.local`. The adapter compiles + type-checks, but `invoke()` throws `RoutingError`. Routing already filters xAI out of every chain when the env flag is false; the throw is defense-in-depth for misroutes.
- **Perplexity adapter** — same pattern as xAI. TODO until `PERPLEXITY_API_KEY` is set in `.env.local`.
- **Postgres 17 hosted** — `supabase/config.toml` `[db] major_version` is pinned to `17` to match the hosted Supabase project. Local Supabase CLI (if used) must run `>=17`.
- **AI cost ledger** — In-memory ledger in `packages/ai-fabric/src/cost.ts` is the authoritative gate for `assertUnderCap`. PR #14 (workers infra) added a fire-and-forget Upstash REST sink (`buildUpstashCostSink` + `setCostSink`) that mirrors per-task and total spend into shared keys (`ai_cost:<utc_day>:total` / `ai_cost:<utc_day>:task:<task>`) with a 2-day TTL. Workers process hydrates the local ledger from Redis on boot so a restarted worker doesn't reset the day's spend. This is eventually-consistent observability — strict cross-process cap enforcement (every `assertUnderCap` awaiting a Redis check) is deferred to Phase 4 when the AI cost flow becomes load-bearing.
- **Durable retry queue (BullMQ)** — Workers currently use pg `LISTEN`/`NOTIFY` for the privy listener and Upstash REST for the cost sink, neither of which needs a TCP Redis. BullMQ requires `ioredis` over TCP, which Upstash exposes separately from the REST endpoint. Add `REDIS_URL=rediss://default:<pwd>@<host>:6379` from the Upstash dashboard once durable retry queues are needed (battle-settle workers in Phase 4).
- **Axiom logging** — `packages/ai-fabric/src/logging.ts` exposes a `LogSink` interface and a `consoleSink` default. The `axiomSink` is a stub; real Axiom ingest lands in Phase 2 alongside the observability work.
- **Generated Supabase types** — `packages/db/src/types.ts` is regenerated via `supabase gen types typescript --project-id $SUPABASE_PROJECT_REF_DEV` after every schema migration. Re-run after PR #2 lands and `SUPABASE_ACCESS_TOKEN` is available.
- **X OAuth** — TODO until `X_CLIENT_ID` + `X_CLIENT_SECRET` are set in `.env.local`. `supabase/config.toml [auth.external.twitter] enabled = false`; `client_id`/`secret` use `env(...)` refs that resolve to empty strings until the vars land. The `/login` page renders the X OAuth button disabled until then.
- **Privy custodial wallets** — Migration `0009` (PR #13) adds `wallets.privy_user_id`, `wallets.solana_address`, `wallets.evm_address` and rewires `handle_new_user` to `pg_notify('privy_provision', new.id::text)` for non-bot signups. The workers process runs a `LISTEN privy_provision` loop in `apps/workers/src/jobs/privy-provision.ts` that provisions a Solana custodial wallet and UPDATEs the shell row. The SDK call is gated by `PRIVY_ENABLED` (default `false`); when off, the listener logs a skip. Flip the flag once `PRIVY_APP_ID` + `PRIVY_APP_SECRET` are set in `.env.local` (and on Railway for the workers service).
- **Privy SDK enable** — `PRIVY_ENABLED=false` in `.env.example`. The listener + tests are wired and unit-test green. To enable: provision a Privy project, copy app id + secret into `.env.local` (or Railway env), set `PRIVY_ENABLED=true`. The first signup after the flip should populate `wallets.solana_address` within ~30s. The Privy SDK call site in `apps/workers/src/index.ts` (`buildPrivyProvider`) uses `client.walletApi.create({ chainType: 'solana', ownerId })` — verify against the SDK version pinned in `apps/workers/package.json` before enabling, and adjust the adapter if Privy's surface has shifted.
- **Initial 100 AP grant** — `users.current_ap` defaults to 100 (migration 0002). Migration 0007's trigger writes a single `ap_transactions` audit row with `idempotency_key = 'signup_grant:<uuid>'`. The unique index makes double-credit impossible even on duplicate trigger fires.
- **API rate limiting** — `apps/api` does not yet register `@fastify/rate-limit`. Safe for now because no public DNS points at the API. Before Railway exposes a public domain, add: 60 req/min per IP on `/trpc/auth.session`, 10 mutations/min keyed on `ctx.userId` (fallback IP), 600 req/min global ceiling. Also caches (a) the handle-enumeration timing oracle on `updateHandle` and (b) the `verifyJwt` CPU cost on `auth.session`.
- **API cursor clamp + aggregate push-down** — `wallet.transactions` accepts any RFC3339 cursor (no upper bound) and `wallet.ghostEarnings` does an unbounded `select('delta')` then sums client-side. Land before a user can amass >10k transactions: clamp `cursor <= now()`, and push `ghostEarnings` into a PostgREST aggregate or a SECURITY INVOKER SQL function. Both follow-ups from security review on PR #2.
- **Onboarding "look around first" off-ramp** — `apps/web/app/(app)/layout.tsx` hard-redirects un-onboarded users to `/onboard/welcome` with no read-only preview path. Addiction-auditor flagged as §10 (autonomy) softness — not a violation, but the trust-maximizing version offers a public "peek at one Drop without picking a tribe" route. Decide before public launch: ship coercive-but-simple, or budget the read-only preview.
- **Session-length nudge** — `docs/ADDICTION_ARCHITECTURE.md` §12 calls for a "you've been scrolling 30m, take a break?" check. Mount it on the (app) layout when the feed lands in Phase 3.
- **Resend SMTP for Supabase Auth** — `supabase/config.toml [auth.email.smtp]` is wired for Resend on port 465 with `pass = "env(RESEND_API_KEY)"`. Before the next external signup works on hosted Supabase:
  1. Verify the `diktat.app` sender domain in the Resend dashboard (DNS records: SPF/DKIM).
  2. Set `RESEND_API_KEY` on the hosted Supabase project (`Dashboard → Project Settings → Edge Functions → Secrets`, or `supabase secrets set RESEND_API_KEY=... --project-ref $SUPABASE_PROJECT_REF`).
  3. Push the config: `supabase config push --project-ref $SUPABASE_PROJECT_REF`.
  4. In `Authentication → Email Templates → Magic Link`, edit the body to include `{{ .Token }}` so the 6-digit OTP is visible — the default template shows only the link, but `apps/web/app/login/page.tsx` asks the user for the 6-digit code. The link flow still works via `/auth/callback` for users who tap instead of type.
  5. Confirm `SITE_URL` and `ADDITIONAL_REDIRECT_URLS` include the production + preview origins (`https://diktat-web1.vercel.app`, `https://*-diktat.vercel.app`).
- **Font vars owned by next/font** — `packages/ui/src/styles.css` intentionally does NOT declare `--font-sans` or `--font-display`. Those two custom properties are owned by `next/font` in `apps/web/app/layout.tsx`. If a future consumer of `@diktat/ui` wants Inter without next/font, they must redeclare them in their own root stylesheet — do not re-add them to `styles.css` without removing the next/font wiring first, or both declarations collide on source order and the browser falls back to system fonts.
