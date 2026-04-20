// Auth router. One query — `session` — used by the web client at first
// render to decide routing (signed-out → /login; signed-in but
// !onboardedAt → /onboard/welcome; otherwise feed). Returning
// onboardedAt here lets the root layout avoid a separate user.me fetch.

import { publicProcedure, router } from '../trpc.js';

export const authRouter = router({
  session: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.userId) return null;

    const { data, error } = await ctx.db
      .from('users')
      .select('id, onboarded_at')
      .eq('id', ctx.userId)
      .maybeSingle();

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
