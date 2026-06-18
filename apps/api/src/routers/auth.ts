// Auth router. One query — `session` — used by the web client at first
// render to decide routing (signed-out → /login; signed-in but
// !onboardedAt → /onboard/welcome; otherwise feed). Returning
// onboardedAt here lets the root layout avoid a separate user.me fetch.

import { publicProcedure, router } from '../trpc.js';

export const authRouter = router({
  session: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.userId) return null;

    // Routes through SECURITY DEFINER `get_user_self()` (migration
    // 20260618120000). `onboarded_at` is a private column and is
    // unreachable via direct PostgREST SELECT as `authenticated` —
    // the RPC is the only path. Same self-lock as the original
    // .eq('id', ctx.userId) shape.
    const { data, error } = await ctx.db.rpc('get_user_self').maybeSingle();

    // NULL CONTRACT (PR #44 round-2 security-reviewer LOW-2):
    // `onboardedAt: null` means "not yet onboarded OR onboarding
    // status unknown" — the client must treat both cases the same
    // way (redirect to /onboard/welcome). Do NOT carry a separate
    // "unknown" sentinel through this route; the layout's RPC path
    // already implements retry-then-error, so by the time this
    // null reaches a client renderer, the right behaviour is the
    // same as a fresh signup.
    if (error) {
      return { userId: ctx.userId, onboardedAt: null };
    }

    return {
      userId: ctx.userId,
      onboardedAt: data?.onboarded_at ?? null,
    };
  }),
});
