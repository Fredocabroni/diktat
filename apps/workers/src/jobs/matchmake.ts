// Matchmaking polling loop. Phase 3 / Path B — Upstash sorted sets via
// REST instead of BullMQ. Single-instance workers process; no
// distributed-locking needed.
//
// Queue layout
//   `mm:trivia:queue`              — sorted set, member=user_id, score=current_ap
//   `mm:trivia:meta:<user_id>`     — JSON {ap, joinedAtMs, mode}, 10-min TTL
//   `mm:trivia:matched:<user_id>`  — JSON {battleId, role}, 5-min TTL — set by
//                                     the matchmaker on a successful match;
//                                     the API `getStatus` reads this to tell
//                                     the user "you're in battle X".
//
// Match band by wait time:
//   wait <  15 s → ±200 AP (per ADDICTION_ARCHITECTURE.md §4)
//   wait 15-30 s → linearly ramp 200 → 400
//   wait >  30 s → eligible for bot fallback (always within ±200 of target)
//
// Atomicity: ZREM both users before any DB write. If ZREM returns 0 the
// user was already matched in a prior tick or cancelled; abort the
// match. Single-instance assumption keeps this safe; Phase 3.5 BullMQ
// migration adds proper distributed locks.

import type { ServiceClient } from '../supabase.js';
import type { Logger } from '../logger.js';

export interface UpstashLike {
  zadd(key: string, score_member: { score: number; member: string }): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zscore(key: string, member: string): Promise<number | null>;
  zrange(
    key: string,
    start: number,
    stop: number,
    opts?: { withScores?: boolean },
  ): Promise<string[] | (string | number)[]>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  get(key: string): Promise<unknown | null>;
  del(...keys: string[]): Promise<number>;
}

export type MatchMode = 'trivia' | 'open_debate';
/** Modes the matchmaker scans on each tick. */
export const MATCH_MODES: ReadonlyArray<MatchMode> = ['trivia', 'open_debate'];

export interface MatchmakingDeps {
  readonly redis: UpstashLike;
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  readonly now?: () => number;
}

const META_TTL_S = 600; // 10 min — generous so a slow tab catch-up still finds itself queued
const MATCHED_TTL_S = 300; // 5 min — long enough for the client to navigate to /battles/:id
const BAND_BASE_AP = 200;
const BAND_MAX_AP = 400;
const BAND_RAMP_START_MS = 15_000;
const BAND_RAMP_END_MS = 30_000;
const BOT_ELIGIBLE_AFTER_MS = 30_000;

function queueKey(mode: MatchMode): string {
  return `mm:${mode}:queue`;
}
function metaKey(mode: MatchMode, userId: string): string {
  return `mm:${mode}:meta:${userId}`;
}
function matchedKey(mode: MatchMode, userId: string): string {
  return `mm:${mode}:matched:${userId}`;
}

export interface QueueMeta {
  readonly ap: number;
  readonly joinedAtMs: number;
  readonly mode: MatchMode;
  /** Required for open_debate: the news_topic to debate. Seeker's topic wins. */
  readonly topicId?: string;
}

export interface MatchedRecord {
  readonly battleId: string;
  readonly role: 'human' | 'practice';
  readonly opponentIsBot: boolean;
}

/**
 * Add the caller to the queue. Idempotent: re-enqueueing overwrites
 * the user's score + meta (refreshes the AP snapshot if it shifted
 * since last attempt).
 */
export async function enqueueUser(opts: {
  userId: string;
  ap: number;
  mode: MatchMode;
  /** Required for mode='open_debate' (which news_topic to debate). */
  topicId?: string;
  redis: UpstashLike;
  now?: () => number;
}): Promise<void> {
  const now = opts.now ?? Date.now;
  const meta: QueueMeta = {
    ap: opts.ap,
    joinedAtMs: now(),
    mode: opts.mode,
    ...(opts.topicId ? { topicId: opts.topicId } : {}),
  };
  await opts.redis.zadd(queueKey(opts.mode), { score: opts.ap, member: opts.userId });
  await opts.redis.set(metaKey(opts.mode, opts.userId), JSON.stringify(meta), {
    ex: META_TTL_S,
  });
}

export async function cancelUser(opts: {
  userId: string;
  mode: MatchMode;
  redis: UpstashLike;
}): Promise<{ removed: boolean }> {
  const removed = await opts.redis.zrem(queueKey(opts.mode), opts.userId);
  await opts.redis.del(metaKey(opts.mode, opts.userId));
  return { removed: removed > 0 };
}

export interface UserStatus {
  status: 'idle' | 'waiting' | 'matched';
  battleId?: string;
  opponentIsBot?: boolean;
  joinedAtMs?: number;
}

export async function getUserStatus(opts: {
  userId: string;
  mode: MatchMode;
  redis: UpstashLike;
}): Promise<UserStatus> {
  const matchedRaw = await opts.redis.get(matchedKey(opts.mode, opts.userId));
  if (matchedRaw !== null && matchedRaw !== undefined) {
    const matched = parseJson<MatchedRecord>(matchedRaw);
    if (matched) {
      return {
        status: 'matched',
        battleId: matched.battleId,
        opponentIsBot: matched.opponentIsBot,
      };
    }
  }
  const score = await opts.redis.zscore(queueKey(opts.mode), opts.userId);
  if (score !== null && score !== undefined) {
    const metaRaw = await opts.redis.get(metaKey(opts.mode, opts.userId));
    const meta = parseJson<QueueMeta>(metaRaw);
    return {
      status: 'waiting',
      ...(meta ? { joinedAtMs: meta.joinedAtMs } : {}),
    };
  }
  return { status: 'idle' };
}

interface QueueEntry {
  userId: string;
  ap: number;
  joinedAtMs: number;
  topicId?: string;
}

export interface TickResult {
  scanned: number;
  matchesCreated: number;
  botFallbacks: number;
  errors: number;
}

export interface TickOpts {
  /** Match mode for this pass. Defaults to 'trivia'. */
  readonly mode?: MatchMode;
}

/**
 * One pass through the queue for a single mode. Pairs the oldest waiting
 * human with the closest human in band; if no human is in band and the user
 * has been waiting >30s, falls back to a bot -- but only for mode='trivia'.
 * Open debate is human-vs-human only in V1 (bot rhetorical arguments are a
 * separate content pipeline, deferred). Call once per mode each tick.
 */
export async function runMatchmakingTick(
  deps: MatchmakingDeps,
  opts: TickOpts = {},
): Promise<TickResult> {
  const now = deps.now ?? Date.now;
  const mode: MatchMode = opts.mode ?? 'trivia';
  const allowBotFallback = mode === 'trivia';

  const entries = await fetchQueue(deps, mode);
  entries.sort((a, b) => a.joinedAtMs - b.joinedAtMs);

  const matchedSet = new Set<string>();
  let matchesCreated = 0;
  let botFallbacks = 0;
  let errors = 0;

  for (const seeker of entries) {
    if (matchedSet.has(seeker.userId)) continue;
    const waitMs = now() - seeker.joinedAtMs;
    const band = bandForWait(waitMs);

    const partner = entries.find(
      (other) =>
        other.userId !== seeker.userId &&
        !matchedSet.has(other.userId) &&
        Math.abs(other.ap - seeker.ap) <= band,
    );

    if (partner) {
      try {
        await createBattle(deps, mode, seeker, partner, false);
        matchedSet.add(seeker.userId);
        matchedSet.add(partner.userId);
        matchesCreated += 1;
      } catch (err) {
        deps.logger.error({
          event: 'matchmake.create_failed',
          message: err instanceof Error ? err.message : String(err),
          mode,
          seeker: seeker.userId,
          partner: partner.userId,
        });
        errors += 1;
      }
      continue;
    }

    if (allowBotFallback && waitMs >= BOT_ELIGIBLE_AFTER_MS) {
      try {
        const bot = await pickBotInBand(deps, seeker.ap);
        if (bot) {
          await createBattle(deps, mode, seeker, { userId: bot.userId, ap: bot.ap }, true);
          matchedSet.add(seeker.userId);
          matchesCreated += 1;
          botFallbacks += 1;
        }
      } catch (err) {
        deps.logger.error({
          event: 'matchmake.bot_fallback_failed',
          message: err instanceof Error ? err.message : String(err),
          mode,
          seeker: seeker.userId,
        });
        errors += 1;
      }
    }
  }

  if (matchesCreated > 0 || entries.length > 0) {
    deps.logger.info({
      event: 'matchmake.tick',
      mode,
      scanned: entries.length,
      matchesCreated,
      botFallbacks,
      errors,
    });
  }

  return { scanned: entries.length, matchesCreated, botFallbacks, errors };
}

function bandForWait(waitMs: number): number {
  if (waitMs <= BAND_RAMP_START_MS) return BAND_BASE_AP;
  if (waitMs >= BAND_RAMP_END_MS) return BAND_MAX_AP;
  const t = (waitMs - BAND_RAMP_START_MS) / (BAND_RAMP_END_MS - BAND_RAMP_START_MS);
  return Math.round(BAND_BASE_AP + (BAND_MAX_AP - BAND_BASE_AP) * t);
}

async function fetchQueue(deps: MatchmakingDeps, mode: MatchMode): Promise<QueueEntry[]> {
  const raw = (await deps.redis.zrange(queueKey(mode), 0, -1, {
    withScores: true,
  })) as (string | number)[];
  const entries: QueueEntry[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const member = raw[i];
    const score = raw[i + 1];
    if (typeof member !== 'string' || typeof score !== 'number') continue;
    const meta = parseJson<QueueMeta>(await deps.redis.get(metaKey(mode, member)));
    entries.push({
      userId: member,
      ap: score,
      joinedAtMs: meta?.joinedAtMs ?? Date.now(),
      ...(meta?.topicId ? { topicId: meta.topicId } : {}),
    });
  }
  return entries;
}

async function pickBotInBand(
  deps: MatchmakingDeps,
  targetAp: number,
): Promise<{ userId: string; ap: number } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usersTable = (deps.supabase as any).from('users');
  const { data, error } = (await usersTable
    .select('id, current_ap')
    .eq('is_bot', true)
    .gte('current_ap', targetAp - BAND_BASE_AP)
    .lte('current_ap', targetAp + BAND_BASE_AP)
    .limit(8)) as {
    data: { id: string; current_ap: number }[] | null;
    error: { message: string } | null;
  };
  if (error || !data || data.length === 0) return null;
  // Pick the bot whose AP is closest to the seeker.
  const closest = [...data].sort(
    (a, b) => Math.abs(a.current_ap - targetAp) - Math.abs(b.current_ap - targetAp),
  )[0]!;
  return { userId: closest.id, ap: closest.current_ap };
}

async function createBattle(
  deps: MatchmakingDeps,
  mode: MatchMode,
  seatA: { userId: string; ap: number; topicId?: string },
  seatB: { userId: string; ap: number; topicId?: string },
  isBotFallback: boolean,
): Promise<void> {
  // Atomic claim: ZREM both before any DB write. If either ZREM
  // returns 0 the user was already matched/cancelled; abort.
  const removedA = await deps.redis.zrem(queueKey(mode), seatA.userId);
  if (isBotFallback) {
    // Bot side never enters the queue — just claim the human seat.
    if (removedA === 0) {
      throw new Error(`seat A ${seatA.userId} already claimed`);
    }
  } else {
    const removedB = await deps.redis.zrem(queueKey(mode), seatB.userId);
    if (removedA === 0 || removedB === 0) {
      // Best-effort restore — re-add whichever side we successfully removed
      // so nobody is silently dropped from the queue.
      if (removedA > 0) {
        await deps.redis.zadd(queueKey(mode), { score: seatA.ap, member: seatA.userId });
      }
      if (removedB > 0) {
        await deps.redis.zadd(queueKey(mode), { score: seatB.ap, member: seatB.userId });
      }
      throw new Error(`race: seatA removed=${removedA}, seatB removed=${removedB}`);
    }
  }

  // For open_debate the seeker (seatA) carries the topic; assign it to the
  // battle so the runner + UI can resolve the news_topic. Partner's topicId
  // is intentionally ignored -- they agreed to "any open debate" by queueing.
  const topicId = mode === 'open_debate' ? (seatA.topicId ?? null) : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const battlesTable = (deps.supabase as any).from('battles');
  const startedAt = new Date().toISOString();
  const { data: battle, error: battleErr } = (await battlesTable
    .insert({
      mode,
      status: 'live',
      ap_pot: 0,
      started_at: startedAt,
      ...(topicId ? { topic_id: topicId } : {}),
    })
    .select('id')
    .maybeSingle()) as { data: { id: string } | null; error: { message: string } | null };

  if (battleErr || !battle) {
    throw new Error(`battles insert failed: ${battleErr?.message ?? 'no row'}`);
  }
  const battleId = battle.id;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const partsTable = (deps.supabase as any).from('battle_participants');
  const { error: partsErr } = (await partsTable.insert([
    { battle_id: battleId, user_id: seatA.userId, seat: 0, entry_ap: 0 },
    { battle_id: battleId, user_id: seatB.userId, seat: 1, entry_ap: 0 },
  ])) as { error: { message: string } | null };

  if (partsErr) {
    throw new Error(`battle_participants insert failed: ${partsErr.message}`);
  }

  // Clear queue meta + mark both users as matched.
  await Promise.all([
    deps.redis.del(metaKey(mode, seatA.userId), metaKey(mode, seatB.userId)),
    writeMatched(deps.redis, mode, seatA.userId, {
      battleId,
      role: isBotFallback ? 'practice' : 'human',
      opponentIsBot: isBotFallback,
    }),
    isBotFallback
      ? Promise.resolve()
      : writeMatched(deps.redis, mode, seatB.userId, {
          battleId,
          role: 'human',
          opponentIsBot: false,
        }),
  ]);
}

async function writeMatched(
  redis: UpstashLike,
  mode: MatchMode,
  userId: string,
  record: MatchedRecord,
): Promise<void> {
  await redis.set(matchedKey(mode, userId), JSON.stringify(record), {
    ex: MATCHED_TTL_S,
  });
}

function parseJson<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const __testing = { bandForWait };
