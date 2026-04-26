// In-process battle runner. Phase 3 / Path B — no BullMQ. The
// matchmaker creates battle rows with status='live'; this module
// finds them, drives the round emission lifecycle (5 trivia rounds,
// 12s each), simulates bot answers when a participant is a bot, and
// settles the battle via the ap-engine + apply_ap_drafts SQL function.
//
// Single-instance assumption: one workers process owns the lifecycle
// for any given battle. The poller (in workers/index.ts) skips
// battles already running locally.
//
// Crash recovery (Phase 3.5): if the workers process restarts mid-
// battle, the battle is orphaned at status='live'. Phase 3.5
// introduces a periodic reaper that settles old live battles using
// whatever answers exist. Documented in CLAUDE.md "Phase 3 queue
// mechanism".

import { applyDrafts, idempotencyKeyFor, settleBattle, type Tier } from '@diktat/ap-engine';
import {
  battleId as toBattleId,
  userId as toUserId,
  type BattleId,
  type UserId,
} from '@diktat/shared';

import type { Logger } from '../logger.js';
import type { ServiceClient } from '../supabase.js';

const ROUND_COUNT = 5;
const ROUND_DURATION_MS = 12_000;
// Bots answer between these bounds, sampled uniformly. Keeps the user-
// visible "thinking" time human-feeling without making bots
// indistinguishable from a smart human.
const BOT_LATENCY_MIN_MS = 1_500;
const BOT_LATENCY_MAX_MS = 4_000;
// Bot accuracy floor + per-tier bonus. Tier 0 → 60 %, tier 11 → 71 %.
const BOT_ACCURACY_BASE = 0.6;
const BOT_ACCURACY_PER_TIER = 0.01;

export interface BattleRunnerDeps {
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  readonly applyDraftsFn?: typeof applyDrafts;
  readonly now?: () => number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly random?: () => number;
}

export interface RunningBattle {
  readonly battleId: string;
  stop(): void;
  /** Resolves when the battle settles (or errors). Tests await this. */
  done: Promise<void>;
}

interface ParticipantRow {
  user_id: string;
  seat: number;
  is_bot: boolean;
  current_ap: number;
  tier_id: number;
  consecutive_losses: number;
  reductions_used: number;
}

interface QuestionRow {
  id: string;
  category: string;
  prompt: string;
  choices: string[];
  correct_index: number;
  difficulty: number;
}

interface AnswerRow {
  user_id: string;
  question_id: string;
  correct: boolean;
  latency_ms: number;
}

export function runBattle(battleId: string, deps: BattleRunnerDeps): RunningBattle {
  const { logger } = deps;
  const apply = deps.applyDraftsFn ?? applyDrafts;
  const now = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const random = deps.random ?? Math.random;

  let stopped = false;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  const done = (async () => {
    try {
      const participants = await fetchParticipants(deps.supabase, battleId);
      if (participants.length !== 2) {
        logger.warn({
          event: 'battle.runner.skip',
          reason: 'participant_count',
          battleId,
          count: participants.length,
        });
        return;
      }

      const questions = await fetchQuestions(deps.supabase, ROUND_COUNT);
      if (questions.length < ROUND_COUNT) {
        logger.error({
          event: 'battle.runner.skip',
          reason: 'insufficient_verified_trivia',
          battleId,
          got: questions.length,
          need: ROUND_COUNT,
        });
        return;
      }

      logger.info({
        event: 'battle.runner.start',
        battleId,
        botSeats: participants.filter((p) => p.is_bot).map((p) => p.seat),
      });

      for (let roundNo = 0; roundNo < ROUND_COUNT; roundNo += 1) {
        if (stopped) return;
        const question = questions[roundNo]!;
        const roundId = await emitRound({
          supabase: deps.supabase,
          battleId,
          roundNo,
          question,
        });

        // Generate any bot answers for this round.
        for (const p of participants.filter((x) => x.is_bot)) {
          await emitBotAnswer({
            supabase: deps.supabase,
            battleId,
            roundId,
            userId: p.user_id,
            questionId: question.id,
            correctIndex: question.correct_index,
            tier: p.tier_id as Tier,
            random,
          });
        }

        if (roundNo < ROUND_COUNT - 1) {
          await sleep(ROUND_DURATION_MS, setTimeoutFn, clearTimeoutFn, (t) => {
            pendingTimeout = t;
          });
          pendingTimeout = null;
        }
      }

      if (stopped) return;
      await settle({
        supabase: deps.supabase,
        battleId,
        participants,
        applyFn: apply,
        logger,
        now,
      });
      logger.info({ event: 'battle.runner.settled', battleId });
    } catch (err) {
      logger.error({
        event: 'battle.runner.failed',
        battleId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pendingTimeout = null;
    }
  })();

  return {
    battleId,
    stop: () => {
      stopped = true;
      if (pendingTimeout !== null) clearTimeoutFn(pendingTimeout);
    },
    done,
  };
}

async function sleep(
  ms: number,
  setTimeoutFn: typeof setTimeout,
  _clearTimeoutFn: typeof clearTimeout,
  capture: (t: ReturnType<typeof setTimeout>) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeoutFn(() => resolve(), ms);
    capture(t);
  });
}

async function fetchParticipants(
  supabase: ServiceClient,
  battleId: string,
): Promise<ParticipantRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('battle_participants')
    .select(
      'user_id, seat, users!inner ( is_bot, current_ap, tier_id, streaks!left ( current_length, freeze_tokens ) )',
    )
    .eq('battle_id', battleId)
    .order('seat', { ascending: true })) as {
    data:
      | {
          user_id: string;
          seat: number;
          users: {
            is_bot: boolean;
            current_ap: number;
            tier_id: number;
          };
        }[]
      | null;
    error: { message: string } | null;
  };

  if (error || !data) {
    throw new Error(`fetchParticipants: ${error?.message ?? 'no rows'}`);
  }

  return data.map((row) => ({
    user_id: row.user_id,
    seat: row.seat,
    is_bot: row.users.is_bot,
    current_ap: row.users.current_ap,
    tier_id: row.users.tier_id,
    // Loss-streak protection counters live on a separate table that V1
    // doesn't yet write; default to zero so settle is well-formed.
    consecutive_losses: 0,
    reductions_used: 0,
  }));
}

async function fetchQuestions(supabase: ServiceClient, count: number): Promise<QuestionRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('trivia_questions')
    .select('id, category, prompt, choices, correct_index, difficulty')
    .eq('verified', true)
    .limit(count * 4)) as {
    data: QuestionRow[] | null;
    error: { message: string } | null;
  };

  if (error) throw new Error(`fetchQuestions: ${error.message}`);
  const pool = data ?? [];
  // Shuffle then slice — simplest randomization for V1.
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}

async function emitRound(opts: {
  supabase: ServiceClient;
  battleId: string;
  roundNo: number;
  question: QuestionRow;
}): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (opts.supabase as any)
    .from('battle_rounds')
    .insert({
      battle_id: opts.battleId,
      round_no: opts.roundNo,
      payload: { questionId: opts.question.id },
    })
    .select('id')
    .maybeSingle()) as { data: { id: string } | null; error: { message: string } | null };

  if (error || !data) {
    throw new Error(`emitRound: ${error?.message ?? 'no row'}`);
  }
  return data.id;
}

async function emitBotAnswer(opts: {
  supabase: ServiceClient;
  battleId: string;
  roundId: string;
  userId: string;
  questionId: string;
  correctIndex: number;
  tier: Tier;
  random: () => number;
}): Promise<void> {
  const accuracy = Math.min(0.95, BOT_ACCURACY_BASE + BOT_ACCURACY_PER_TIER * opts.tier);
  const isCorrect = opts.random() < accuracy;
  const chosenIndex = isCorrect
    ? opts.correctIndex
    : pickWrongIndex(opts.correctIndex, opts.random);
  const latencyMs = Math.floor(
    BOT_LATENCY_MIN_MS + opts.random() * (BOT_LATENCY_MAX_MS - BOT_LATENCY_MIN_MS),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (opts.supabase as any).from('trivia_answers').insert({
    battle_id: opts.battleId,
    round_id: opts.roundId,
    user_id: opts.userId,
    question_id: opts.questionId,
    chosen_index: chosenIndex,
    correct: isCorrect,
    latency_ms: latencyMs,
  })) as { error: { message: string } | null };

  if (error) {
    throw new Error(`emitBotAnswer: ${error.message}`);
  }
}

function pickWrongIndex(correctIndex: number, random: () => number): number {
  // Choices have indices 0..3. Pick uniformly from the three wrong ones.
  const wrongs = [0, 1, 2, 3].filter((i) => i !== correctIndex);
  return wrongs[Math.floor(random() * wrongs.length)]!;
}

async function settle(opts: {
  supabase: ServiceClient;
  battleId: string;
  participants: ParticipantRow[];
  applyFn: typeof applyDrafts;
  logger: Logger;
  now: () => number;
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: answers, error: answersErr } = (await (opts.supabase as any)
    .from('trivia_answers')
    .select('user_id, question_id, correct, latency_ms')
    .eq('battle_id', opts.battleId)) as {
    data: AnswerRow[] | null;
    error: { message: string } | null;
  };

  if (answersErr || !answers) {
    throw new Error(`settle.fetchAnswers: ${answersErr?.message ?? 'no rows'}`);
  }

  const stats = new Map<string, { correct: number; latency: number }>();
  for (const p of opts.participants) {
    stats.set(p.user_id, { correct: 0, latency: 0 });
  }
  for (const ans of answers) {
    const s = stats.get(ans.user_id);
    if (!s) continue;
    if (ans.correct) s.correct += 1;
    s.latency += ans.latency_ms;
  }

  // Winner: most correct, tiebreak on lowest cumulative latency.
  const ranked = [...opts.participants].sort((a, b) => {
    const sa = stats.get(a.user_id)!;
    const sb = stats.get(b.user_id)!;
    if (sb.correct !== sa.correct) return sb.correct - sa.correct;
    return sa.latency - sb.latency;
  });

  const winner = ranked[0]!;
  const loser = ranked[1]!;
  const isPractice = opts.participants.some((p) => p.is_bot);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateErr } = (await (opts.supabase as any)
    .from('battles')
    .update({
      status: 'settled',
      winner_user_id: winner.user_id,
      ended_at: new Date(opts.now()).toISOString(),
    })
    .eq('id', opts.battleId)) as { error: { message: string } | null };

  if (updateErr) {
    throw new Error(`settle.battleUpdate: ${updateErr.message}`);
  }

  const drafts = settleBattle({
    battleId: toBattleId(opts.battleId),
    mode: 'trivia',
    status: 'settled',
    isPractice,
    winner: {
      userId: toUserId(winner.user_id),
      apBefore: winner.current_ap,
      tier: winner.tier_id as Tier,
    },
    loser: {
      userId: toUserId(loser.user_id),
      apBefore: loser.current_ap,
      tier: loser.tier_id as Tier,
      consecutiveLosses: loser.consecutive_losses,
      reductionsUsed: loser.reductions_used,
    },
  });

  // applyFn is the engine's RPC adapter; its `SupabaseClient<unknown>`
  // signature doesn't unify with the typed `ServiceClient` schema, so
  // we widen here. The runtime contract is: pass any Supabase client
  // with `.rpc('apply_ap_drafts', { p_drafts })`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await opts.applyFn(opts.supabase as any, drafts);

  opts.logger.info({
    event: 'battle.runner.settle_drafts',
    battleId: opts.battleId,
    isPractice,
    winnerUserId: winner.user_id,
    loserUserId: loser.user_id,
    drafts: drafts.length,
  });
}

// Re-export so the test file can build matching idempotency keys
// without crossing a deep import.
export const __testing = {
  ROUND_COUNT,
  ROUND_DURATION_MS,
  idempotencyKeyFor,
  pickWrongIndex,
};

// Type re-exports for convenience in callers.
export type { BattleId, UserId };
