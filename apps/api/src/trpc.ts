// tRPC bootstrap. One initTRPC instance, exported building blocks.
// `protectedProcedure` is the canonical authentication gate — it asserts
// `ctx.userId` is set and that the role is `'authenticated'` (Supabase
// stamps `'authenticated'` on signed-in user JWTs; treating any other
// role as authed is wrong).

import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import type { Context } from './context.js';

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

const requireAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.userId || ctx.role !== 'authenticated') {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required.' });
  }
  return next({
    ctx: {
      ...ctx,
      // Narrow types for downstream procedures.
      userId: ctx.userId,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireAuthed);
