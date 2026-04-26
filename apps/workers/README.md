# @diktat/workers

Background runners for Diktat. Currently hosts:

- **Privy provisioning listener** (`src/jobs/privy-provision.ts`) — `LISTEN privy_provision` on Postgres. Each notification (one per non-bot signup, emitted by the `handle_new_user` trigger) spawns a Privy custodial-wallet creation and UPDATEs `public.wallets` with the resulting ids. Feature-flagged behind `PRIVY_ENABLED`.
- **AI cost-ledger sink** (`src/redis.ts` → `@diktat/ai-fabric` `setCostSink`) — wires Upstash REST as a fire-and-forget mirror of every `recordSpend()` call. Hydrates the in-memory ledger from Redis on boot so a restarted worker resumes the day's accumulated spend.

Phase 4 will add BullMQ-backed durable queues for battle settlement, X-bot scheduling, and other retry-heavy work. That requires a TCP-form `REDIS_URL` (Upstash exposes this separately from REST). Until then, the workers process is a pg LISTEN loop plus an Upstash REST observability sink.

## Local development

```bash
pnpm install                            # workspace root
pnpm --filter=@diktat/workers dev       # tsx watch src/index.ts
pnpm --filter=@diktat/workers test      # vitest run
pnpm --filter=@diktat/workers typecheck
pnpm --filter=@diktat/workers lint
```

## Required env

Copy `.env.example` to `.env.local` and fill these:

| Var                                 | Why                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                      | Direct Postgres connection used by the LISTEN client. From Supabase → Project Settings → Database → Connection string (URI). |
| `SUPABASE_URL`                      | Service-role client base URL.                                                                                                |
| `SUPABASE_SERVICE_ROLE_KEY`         | Service-role key for the wallet UPDATE.                                                                                      |
| `PRIVY_ENABLED`                     | `true` to enable real wallet creation. Default `false` ships the listener as a no-op.                                        |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Required when the flag is on. The boot path also gates on these being non-empty as defense-in-depth.                         |
| `UPSTASH_REDIS_REST_URL`            | Upstash REST endpoint. Used as the AI cost-ledger sink and (in PR #17) as the matchmaking sorted-set store.                  |
| `UPSTASH_REDIS_REST_TOKEN`          | Bearer token for the Upstash REST client.                                                                                    |

## Listener behaviour

- Idempotent on `user_id`: a duplicate notify is a no-op once `wallets.privy_user_id` is set.
- Retry policy: `[250, 500, 1000, 2000, 4000]` ms backoff around the SDK call. On final failure the handler logs `privy.failed` and returns; one bad signup never kills the loop.
- Reconnect policy: `[1, 2, 4, 8, 16, 30]` s backoff if the pg client errors or disconnects.
- Bot accounts (`auth.users.raw_app_meta_data->>'is_bot' = 'true'`) skip the notify at the trigger level — the listener never sees them.
