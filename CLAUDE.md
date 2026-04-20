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
- **AI cost ledger is in-memory** — `packages/ai-fabric/src/cost.ts` keeps the daily ledger in process memory and resets at UTC midnight. This is single-instance only. Move to Upstash Redis in Phase 2 so workers + api + web share one ledger.
- **Axiom logging** — `packages/ai-fabric/src/logging.ts` exposes a `LogSink` interface and a `consoleSink` default. The `axiomSink` is a stub; real Axiom ingest lands in Phase 2 alongside the observability work.
- **Generated Supabase types** — `packages/db/src/types.ts` is regenerated via `supabase gen types typescript --project-id $SUPABASE_PROJECT_REF_DEV` after every schema migration. Re-run after PR #2 lands and `SUPABASE_ACCESS_TOKEN` is available.
- **X OAuth** — TODO until `X_CLIENT_ID` + `X_CLIENT_SECRET` are set in `.env.local`. `supabase/config.toml [auth.external.twitter] enabled = false`; `client_id`/`secret` use `env(...)` refs that resolve to empty strings until the vars land. The `/login` page renders the X OAuth button disabled until then.
- **Privy custodial wallets** — Migration `0007` provisions a `public.wallets` row at signup with `external_wallet_id = null`. Real Privy wallet creation runs server-side and lands in Phase 3 once the SDK + API key are wired. Until then, the wallet exists but holds no on-chain account; `usdc_balance_micro` is decorative.
- **Initial 100 AP grant** — `users.current_ap` defaults to 100 (migration 0002). Migration 0007's trigger writes a single `ap_transactions` audit row with `idempotency_key = 'signup_grant:<uuid>'`. The unique index makes double-credit impossible even on duplicate trigger fires.
