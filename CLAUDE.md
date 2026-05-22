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

## Build / debugging discipline

Standing rules for diagnosis and debugging work — apply these by default, no reminder needed.

- **Instrument before you spend.** Add logging / visibility _before_ re-running anything that costs AI tokens or real money. Never re-run a failing expensive job blind — make the next run produce evidence.
- **Confirm the hypothesis with evidence before acting on it.** Never apply a fix based on a plausible-but-unconfirmed cause. A cause that "looks obvious" is not a confirmed cause — instrument, observe, _then_ fix. (Phase 3.5 lesson: the reason-cap and `maxTokens`-truncation hypotheses both looked obvious; both were wrong. The real causes — a status-blind HEAD gate, then an Opus 4.7 forced-`tool_choice` bug — only surfaced once the calls were instrumented.)
- **One variable per change.** Change one thing at a time and validate it, so you know what actually worked. Don't bundle a model swap with a prompt tweak with a retry change.
- **Abort-guard on cost.** When a run incurs AI spend, monitor it live, define the abort condition up front, and abort the moment it trips. Track the daily cost-ledger cap — a capped run is acceptable, a blown budget is not.
- **Match loop size to uncertainty.** Tight single-step iterations when guessing or spending real money — show work and checkpoint. Larger autonomous batches when executing a known, validated plan.

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
- **AI cost ledger (Upstash REST sink)** — In-memory ledger in `packages/ai-fabric/src/cost.ts` is the authoritative gate for `assertUnderCap`. The workers-infra PR (GH #15) added a fire-and-forget Upstash **REST** sink (`buildUpstashCostSink` + `setCostSink`) that mirrors per-task and total spend into shared keys (`ai_cost:<utc_day>:total` / `ai_cost:<utc_day>:task:<task>`) with a 2-day TTL. Workers boot hydrates the local ledger from Redis so a restart doesn't reset the day's spend. This is eventually-consistent observability — strict cross-process cap enforcement (every `assertUnderCap` awaiting a Redis check) is deferred to Phase 4 when the AI cost flow becomes load-bearing.
- **Trivia seed — COMPLETE (2026-05-22).** `pnpm --filter=@diktat/workers seed:trivia` generates + verifies trivia for the 10 `MASTER_PLAN` §8 categories. The dev Supabase project holds **184 verified questions across all 10 categories, every category ≥ 15 verified** — battle-flow's "≥ 100 verified rows" prerequisite is cleared. A row is `verified=true` only when the verifier agrees at confidence ≥ 0.75 and the source URL clears the liveness gate. The seed script is idempotent at the category level — it skips any category already at ≥ 15 verified — so re-running is safe and only tops up shortfalls. **Cleanup pending:** ~165 `verified=false` rows accumulated across debug runs; safe to `delete from trivia_questions where verified = false`.
- **Trivia pipeline — Phase 3.5 fixes (branch `feat/phase3-seed-fixes`).** Three fixes landed bringing the seed to completion:
  1. **Status-aware HEAD gate** (`apps/workers/src/jobs/trivia-gen.ts`) — the source-URL liveness probe no longer rejects every non-200. `403/405/429` (CDN bot-blocks on live hosts) and any other non-2xx **advisory-pass** to the verifier; only `404/410` and thrown errors (DNS failure, connection refused, timeout) **reject** as genuinely dead. Every outcome logs `trivia.gen.head_check` with host + status. This recovered the bulk of false rejections — primary-source CDNs (`ucr.fbi.gov`, `supreme.justia.com`, `constitution.congress.gov`) `403` every server-side request shape.
  2. **Verifier routed to Sonnet 4.6** (`packages/ai-fabric/src/routing.ts`, `sourced_factcheck`) — Claude Opus 4.7 returns an empty `{}` tool input on ~35% of forced-`tool_choice` structured-output calls (`stop_reason: tool_use`, output well under the token cap — **not** truncation). Sonnet 4.6 — the generator's model — is reliable on the identical path (0% empty-input across validation). **Treat the empty-`{}` behaviour as a known Opus 4.7 limitation on forced `tool_choice`; revisit the verifier model if that path is fixed.**
  3. **Cost ledger records failed-call spend** (`packages/ai-fabric/src/{cost,fabric}.ts` + `adapters/anthropic.ts`) — a provider call that was billed but then failed downstream (e.g. a structured-output parse error) now stamps its real USD onto the thrown error; the fabric fail path records it via `recordSpend`. Previously such calls recorded `$0`, so the ledger and per-task cap were blind to billed-but-failed spend.
- **Phase 3 queue mechanism (no BullMQ — Path B)** — Phase 3 ships without BullMQ because Upstash REST credentials are wired but the TCP form is not (BullMQ requires `ioredis` over TCP). The mechanisms used in lieu of BullMQ:
  1. **Privy provisioning** (GH #13): a dedicated `pg.Client` does `LISTEN privy_provision` on the channel emitted by the `handle_new_user` trigger. Auto-reconnect on disconnect; in-process exponential backoff (`[250..4000]` ms) around the SDK call. Failures log to console + (eventually) Axiom; **no durable retry** — one bad signup is dropped from the queue after retries exhaust.
  2. **AI cost-ledger sink** (GH #15): fire-and-forget Upstash REST writes from `recordSpend`. Failures swallowed (observability degradation, not budget bypass).
  3. **Matchmaking queue** (PR #17, planned): Upstash sorted sets via REST — `ZADD` on enqueue keyed by user AP, `ZRANGEBYSCORE` for ±200 band scan. Polled every 1s by an in-process loop in the workers process. Stale entries cleaned via key TTL.
  4. **Battle runner** (PR #18, planned): each `live` battle owns a JS interval in the workers process that emits `battle_rounds` rows on a 12-second tick; on the final round the same in-process tick calls `apply_ap_drafts` (migration 0013) inline for atomic settlement. No external queue. **Risks:** if the workers process crashes mid-battle, the battle is orphaned at `status='live'` (acceptable for V1 dev/staging scale; manual reaper or periodic sweep added when needed). Transient `apply_ap_drafts` failures retry 3× inline, then log error and leave the battle `live` for Phase 4 cleanup.
  5. **Live battle updates to client** (PR #18, planned): the web client polls `trpc.battles.getRound` on a 1s interval, with `AbortController` on unmount. Swap to Supabase Realtime in Phase 4 if scale or latency demands it.
- **BullMQ TCP migration (Phase 3.5 / Phase 4 cleanup)** — Verify Upstash exposes a TCP `REDIS_URL` (`rediss://default:<pwd>@<host>:6379` from the Upstash dashboard's "Connect → TCP" tab), confirm `ioredis` connects under TLS from a workers process, then migrate the four queue-shaped flows above (privy retry, matchmaking poll, battle runner, battle settle) from in-process intervals + pg `LISTEN`/`NOTIFY` to BullMQ jobs with durable retry, dead-letter queues, and Axiom-fed dashboards. Schedule before any production-scale load — durable retry must land before the orphaned-battle and dropped-privy risks above hit real users.
- **Upstash token rotation before production** — The `UPSTASH_REDIS_REST_TOKEN` was shared in chat during Phase 3 path-B sign-off; treat it as compromised. Before any `diktat-prod` Supabase project is wired or the first non-test user signs up: rotate the REST token in the Upstash dashboard (Database → Details → REST API → "Rotate REST token"), update `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in `.env.local` and on the workers Railway service env, redeploy workers, and verify boot logs show a clean cost-ledger hydrate. Rotate the TCP credentials at the same time when Phase 3.5 introduces them.
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

## Deferred / Known issues

- **The verifier does not read the cited source.** The `sourced_factcheck` verifier passes the source URL as a plain prompt string; with no `PERPLEXITY_API_KEY` it routes to a Claude model that has no retrieval tool. It is a **from-memory plausibility check**, not a source-grounded one — nothing in the pipeline currently fetches and reads the cited primary source (the HEAD gate only pings it for liveness). **Real source-grounding — wiring Perplexity Sonar, or giving the verifier a retrieval / headless-fetch tool — is a pre-launch requirement** for the "primary sources only — no MSM as truth source" non-negotiable to actually hold.
- **No `safeParse` hardening on structured-output calls.** The Anthropic adapter still uses `schema.parse()`, which throws on any malformed model output — one bad response fails the whole call. `safeParse` + a bounded retry on structured-output calls is deferred: acceptable now that the verifier runs on reliable Sonnet 4.6, but worth landing before structured output is load-bearing at scale.
- **Generator source quality.** The trivia generator (`trivia_gen`) sometimes (a) cites non-primary hosts — e.g. `supreme.justia.com` instead of the primary `supremecourt.gov`; (b) emits dead URLs — observed `fec.gov` / `eac.gov` `404`s; (c) produces ambiguous questions, notably `defense_budget` (conflating "requested" / "enacted" / "authorized" figures — the cause of that category's ~11/20 verifier pass rate). Tighten the generator prompt's source allow-list and question-precision instructions in a future pass.
