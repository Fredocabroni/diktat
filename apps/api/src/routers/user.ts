// User router. Reads the caller's profile + tier + streak in one round
// trip; updates the handle. RLS enforces self-only access on every read
// and write, so the router only needs to validate input shape.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { Database } from '@diktat/db';

import { protectedProcedure, router } from '../trpc.js';

type Json = Database['public']['Tables']['users']['Row']['notification_preferences'];

// Handles are stored citext UNIQUE in public.users. Lowercase, alphanumeric
// + underscore, 3–24 chars. Reserve room for civic-themed prefixes without
// running into Twitter's 15-char ceiling for cross-posts.
const handleSchema = z
  .string()
  .min(3, 'Handle must be at least 3 characters.')
  .max(24, 'Handle must be 24 characters or fewer.')
  .regex(/^[a-z0-9_]+$/i, 'Use letters, numbers, and underscores only.')
  .transform((s) => s.toLowerCase());

// IANA timezone. Validated against the runtime's tz database -- this returns
// the same authoritative list Postgres' tz catalog uses, so the value stored
// here will always resolve under `now() at time zone users.timezone` in the
// scheduler's per-user sweeps. Falls back to a known-good set if the runtime
// lacks `supportedValuesOf` (older Node) -- belt and suspenders.
const supportedTimezones = ((): ReadonlySet<string> => {
  const intlNs = Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] };
  if (typeof intlNs.supportedValuesOf === 'function') {
    return new Set(intlNs.supportedValuesOf('timeZone'));
  }
  return new Set([
    'UTC',
    'America/New_York',
    'America/Los_Angeles',
    'America/Chicago',
    'Europe/London',
  ]);
})();

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => supportedTimezones.has(tz), {
    message: 'Unknown IANA timezone.',
  });

export const userRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    // public.users is column-grant-restricted to a public subset for
    // authenticated PostgREST callers (migration 20260618120000); the
    // private columns this surface needs — `onboarded_at` and
    // `notification_preferences` — are reachable only via the
    // `get_user_self` SECURITY DEFINER RPC, which is locked to
    // auth.uid() inside the function body. `tiers` (read-all) and
    // `streaks` (self-only via RLS) keep coming through PostgREST
    // because their column grants landed in 20260617160000.
    // `returns public.users` (non-setof composite) means the RPC's data
    // is the row directly — not an array, no `.maybeSingle()` needed.
    const { data: userRow, error: userErr } = await ctx.db.rpc('get_user_self');

    if (userErr) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load profile.',
        cause: userErr,
      });
    }
    if (!userRow) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
    }

    const [tierRes, streakRes] = await Promise.all([
      ctx.db
        .from('tiers')
        .select('id, name, payout_eligible, floor_protected')
        .eq('id', userRow.tier_id)
        .maybeSingle(),
      ctx.db
        .from('streaks')
        .select('current_length, longest_length, last_action_date, freeze_tokens')
        .eq('user_id', userRow.id)
        .maybeSingle(),
    ]);

    if (tierRes.error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load profile.',
        cause: tierRes.error,
      });
    }
    if (streakRes.error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load profile.',
        cause: streakRes.error,
      });
    }

    // Match the existing user.me return shape so the client surface is
    // unchanged: the joined `tiers` / `streaks` objects sit alongside
    // the users columns (subset the original PostgREST select projected).
    return {
      id: userRow.id,
      handle: userRow.handle,
      display_name: userRow.display_name,
      avatar_url: userRow.avatar_url,
      current_ap: userRow.current_ap,
      tier_id: userRow.tier_id,
      onboarded_at: userRow.onboarded_at,
      notification_preferences: userRow.notification_preferences,
      tiers: tierRes.data,
      streaks: streakRes.data,
    };
  }),

  updateHandle: protectedProcedure
    .input(z.object({ handle: handleSchema }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from('users')
        .update({ handle: input.handle })
        .eq('id', ctx.userId)
        .select('id, handle')
        .maybeSingle();

      if (error) {
        // 23505 = unique_violation on the citext UNIQUE handle index.
        if (error.code === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That handle is already taken.',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update handle.',
          cause: error,
        });
      }
      if (!data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
      }

      return data;
    }),

  completeOnboarding: protectedProcedure.mutation(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from('users')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', ctx.userId)
      .select('id, onboarded_at')
      .maybeSingle();

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to complete onboarding.',
        cause: error,
      });
    }
    if (!data) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
    }
    return data;
  }),

  // Update notification preferences. Per-notification-type granularity —
  // V1 ships exactly one key (`streak_risk_push`); future types add their
  // own keys without schema churn. Default-on policy: absent key = enabled,
  // explicit `false` opts out. Read-modify-write preserves any keys this
  // caller didn't pass (race-tolerant: last-write-wins for settings-toggle
  // traffic is acceptable; the window is microseconds).
  updateNotificationPreferences: protectedProcedure
    .input(
      z.object({
        streakRiskPush: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: existing, error: readErr } = await ctx.db
        .from('users')
        .select('notification_preferences')
        .eq('id', ctx.userId)
        .maybeSingle();
      if (readErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read notification preferences.',
          cause: readErr,
        });
      }
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
      }
      const current = (existing.notification_preferences ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...current };
      if (input.streakRiskPush !== undefined) {
        next.streak_risk_push = input.streakRiskPush;
      }

      const { data, error } = await ctx.db
        .from('users')
        .update({ notification_preferences: next as Json })
        .eq('id', ctx.userId)
        .select('id, notification_preferences')
        .maybeSingle();

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update notification preferences.',
          cause: error,
        });
      }
      if (!data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
      }
      return data;
    }),

  // Store the caller's IANA timezone. The Phase 4 scheduler's per-user-local
  // sweeps (streak lock at local midnight, evening risk-push window) compute
  // `now() at time zone users.timezone` -- so this column must be a valid
  // IANA name. Validate against the runtime's tz database
  // (Intl.supportedValuesOf('timeZone')) before writing.
  setTimezone: protectedProcedure
    .input(z.object({ timezone: timezoneSchema }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from('users')
        .update({ timezone: input.timezone })
        .eq('id', ctx.userId)
        .select('id, timezone')
        .maybeSingle();

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update timezone.',
          cause: error,
        });
      }
      if (!data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
      }
      return data;
    }),
});
