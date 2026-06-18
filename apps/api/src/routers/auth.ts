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

    if (error) {
      // Surface the userId so the client can still render an authed shell;
      // the onboarding redirect just degrades to "fetch on next page".
      return { userId: ctx.userId, onboardedAt: null };
    }

    return {
      userId: ctx.userId,
      onboardedAt: data?.onboarded_at ?? null,
    };
  }),
});
