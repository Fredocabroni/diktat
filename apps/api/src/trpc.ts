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

// 18+ age-gate middleware. Fires on EVERY procedure but short-circuits
// through queries — only mutations are blocked for unverified/blocked
// users. Rationale:
//   - Queries must stay reachable so the client can observe its own
//     age state (user.me, auth.session, feed.list, …) and render the
//     /not-eligible or /onboard/age redirect.
//   - Mutations are the write surface; blocking them keeps a pre-
//     attested or terminally-blocked account from affecting any
//     economy / content state.
//
// The one exempt mutation is `user.attestAge` itself: blocking it
// would deadlock every unverified user. Path-exemption keeps the
// gate on every other mutation without a per-router opt-in.
//
// Anon callers (`ctx.userId` null) pass through — they haven't
// authed yet. `requireAuthed` catches that case for `protectedProcedure`
// mutations downstream; genuine public mutations (none today) would
// have their own guard.
const requireAgeVerifiedForMutations = t.middleware(async ({ ctx, next, type, path }) => {
  if (type !== 'mutation') return next();
  if (!ctx.userId) return next(); // anon → let requireAuthed throw
  if (path === 'user.attestAge') return next();

  // Age state via the context's lazy, memoised loader. The first
  // mutation on a request pays one `get_user_self()` round-trip; any
  // further mutation (rare in the same request) reads the resolved
  // promise. Queries never trigger a load.
  const status = await ctx.loadAgeStatus();
  if (status === null) return next(); // anon fallthrough
  if (status.kind === 'error') {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Age check failed.',
      cause: new Error(status.code),
    });
  }
  if (status.kind === 'blocked') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This account is not eligible.',
      cause: new Error('age_blocked'),
    });
  }
  if (status.kind === 'unverified' || status.kind === 'no_profile') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Age verification required.',
      cause: new Error(status.kind === 'no_profile' ? 'no_profile_row' : 'age_unverified'),
    });
  }
  return next();
});

export const publicProcedure = t.procedure.use(requireAgeVerifiedForMutations);
export const protectedProcedure = publicProcedure.use(requireAuthed);
