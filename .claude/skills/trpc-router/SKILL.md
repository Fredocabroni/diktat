---
name: trpc-router
description: Use when adding a new tRPC router or extending an existing one in apps/api. Generates router file with Zod input/output schemas, auth middleware wiring, and a Vitest integration test scaffold.
---

# trpc-router

## Procedure

1. **Locate.** Router files live at `apps/api/src/routers/<name>.ts`. Index assembled in `apps/api/src/router.ts`.
2. **Schema first.** Define Zod input + output schemas in the router file. Export them from `packages/shared/src/schemas/<name>.ts` so the web app can reuse them.
3. **Procedure shapes.**
   - `publicProcedure` — no auth required (login, OTP)
   - `protectedProcedure` — requires Supabase session
   - `tieredProcedure(minTier)` — requires user tier ≥ N (e.g. fact-check authorities)
4. **Wire into root.** Update `apps/api/src/router.ts` to import and merge.
5. **Test.** Create `apps/api/src/routers/<name>.test.ts` with happy path + at least one error case (auth missing / invalid input).
6. **Lint + typecheck.** `pnpm turbo lint typecheck --filter=@diktat/api`.
7. **Commit** as `feat(api): add <name> router`.

## Rules
- All inputs + outputs through Zod. No `any`. No `unknown` returned to the client.
- Never log PII (email, IP, JWT) at info level.
- Rate-limit any unauthenticated endpoint.
