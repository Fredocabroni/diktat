import { describe, expect, it, vi } from 'vitest';

import { runBattle } from '../../src/jobs/battle-runner.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

const BATTLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HUMAN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface FakeSupabaseState {
  client: ServiceClient;
  battlesUpdates: { battleId: string; payload: Record<string, unknown> }[];
  roundsInserts: { battle_id: string; round_no: number; payload: unknown }[];
  answers: Array<{
    battle_id: string;
    round_id: string;
    user_id: string;
    correct: boolean;
    latency_ms: number;
    chosen_index: number;
    question_id: string;
  }>;
}

interface FakeSupabaseConfig {
  participants: Array<{
    user_id: string;
    seat: number;
    is_bot: boolean;
    current_ap: number;
    tier_id: number;
  }>;
  questions: Array<{
    id: string;
    category: string;
    prompt: string;
    choices: string[];
    correct_index: number;
    difficulty: number;
  }>;
  /** Pre-seeded human answers, optionally injected before settle. */
  preAnswers?: FakeSupabaseState['answers'];
}

function buildFakeSupabase(cfg: FakeSupabaseConfig): FakeSupabaseState {
  const state: FakeSupabaseState = {
    client: null as unknown as ServiceClient,
    battlesUpdates: [],
    roundsInserts: [],
    answers: cfg.preAnswers ? [...cfg.preAnswers] : [],
  };
  let nextRoundId = 1;

  const participantsBuilder = () => {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    };
    builder.order = () =>
      Promise.resolve({
        data: cfg.participants.map((p) => ({
          user_id: p.user_id,
          seat: p.seat,
          users: { is_bot: p.is_bot, current_ap: p.current_ap, tier_id: p.tier_id },
        })),
        error: null,
      });
    return builder;
  };

  const triviaQuestionsBuilder = () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.limit = () => Promise.resolve({ data: cfg.questions, error: null });
    return builder;
  };

  const triviaAnswersBuilder = () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => Promise.resolve({ data: state.answers, error: null });
    builder.insert = (payload: FakeSupabaseState['answers'][number]) => {
      state.answers.push(payload);
      return Promise.resolve({ error: null });
    };
    return builder;
  };

  const battleRoundsBuilder = () => {
    const builder: Record<string, unknown> = {};
    builder.insert = (payload: { battle_id: string; round_no: number; payload: unknown }) => {
      state.roundsInserts.push(payload);
      const id = `round-${nextRoundId++}`;
      return {
        select: () => ({
          maybeSingle: () => Promise.resolve({ data: { id }, error: null }),
        }),
      };
    };
    return builder;
  };

  const battlesBuilder = () => {
    let pending: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {};
    builder.update = (payload: Record<string, unknown>) => {
      pending = payload;
      return builder;
    };
    builder.eq = (_col: string, val: string) => {
      state.battlesUpdates.push({ battleId: val, payload: pending! });
      return Promise.resolve({ error: null });
    };
    return builder;
  };

  const fromImpl = (table: string) => {
    if (table === 'battle_participants') return participantsBuilder();
    if (table === 'trivia_questions') return triviaQuestionsBuilder();
    if (table === 'trivia_answers') return triviaAnswersBuilder();
    if (table === 'battle_rounds') return battleRoundsBuilder();
    if (table === 'battles') return battlesBuilder();
    throw new Error(`unexpected table ${table}`);
  };

  state.client = { from: fromImpl } as unknown as ServiceClient;
  return state;
}

function buildLogger(): Logger & { calls: { level: string; obj: object }[] } {
  const calls: { level: string; obj: object }[] = [];
  const push = (level: string) => (obj: object) => {
    calls.push({ level, obj });
  };
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

const QUESTIONS = [
  {
    id: 'q-1',
    category: 'congress',
    prompt: 'Q1?',
    choices: ['A', 'B', 'C', 'D'],
    correct_index: 0,
    difficulty: 3,
  },
  {
    id: 'q-2',
    category: 'congress',
    prompt: 'Q2?',
    choices: ['A', 'B', 'C', 'D'],
    correct_index: 1,
    difficulty: 3,
  },
  {
    id: 'q-3',
    category: 'congress',
    prompt: 'Q3?',
    choices: ['A', 'B', 'C', 'D'],
    correct_index: 2,
    difficulty: 3,
  },
  {
    id: 'q-4',
    category: 'congress',
    prompt: 'Q4?',
    choices: ['A', 'B', 'C', 'D'],
    correct_index: 3,
    difficulty: 3,
  },
  {
    id: 'q-5',
    category: 'congress',
    prompt: 'Q5?',
    choices: ['A', 'B', 'C', 'D'],
    correct_index: 0,
    difficulty: 3,
  },
];

describe('runBattle', () => {
  it('emits 5 rounds, generates bot answers, and settles via applyFn', async () => {
    const supa = buildFakeSupabase({
      participants: [
        { user_id: HUMAN_ID, seat: 0, is_bot: false, current_ap: 1000, tier_id: 3 },
        { user_id: BOT_ID, seat: 1, is_bot: true, current_ap: 1000, tier_id: 3 },
      ],
      questions: QUESTIONS,
      preAnswers: QUESTIONS.map((q) => ({
        battle_id: BATTLE_ID,
        round_id: 'placeholder',
        user_id: HUMAN_ID,
        question_id: q.id,
        chosen_index: q.correct_index,
        correct: true,
        latency_ms: 2_000,
      })),
    });
    const logger = buildLogger();

    // Force timers immediate so the 12s round delay collapses.
    const fastTimeout = ((cb: () => void, _ms: number) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const applyFn = vi.fn().mockResolvedValue([]);

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      setTimeoutFn: fastTimeout,
      clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
      // Deterministic random — bot answers correctly 50% < 0.61 accuracy
      // for tier 3, so seed at 0 → always correct (< 0.6 base + 0.03).
      random: () => 0,
      now: () => 1_700_000_000_000,
    });
    await handle.done;

    expect(supa.roundsInserts).toHaveLength(5);
    expect(supa.roundsInserts.map((r) => r.round_no)).toEqual([0, 1, 2, 3, 4]);
    // 5 bot answers landed (one per round).
    const botAnswers = supa.answers.filter((a) => a.user_id === BOT_ID);
    expect(botAnswers).toHaveLength(5);
    // Settle wrote a battle UPDATE.
    expect(supa.battlesUpdates).toHaveLength(1);
    expect(supa.battlesUpdates[0]!.payload).toMatchObject({
      status: 'settled',
    });
    // Settle called applyFn with isPractice=true on every draft.
    expect(applyFn).toHaveBeenCalledTimes(1);
    const drafts = applyFn.mock.calls[0]![1];
    expect(drafts.every((d: { isPractice: boolean }) => d.isPractice === true)).toBe(true);
  });

  it('skips when fewer than 5 verified questions exist', async () => {
    const supa = buildFakeSupabase({
      participants: [
        { user_id: HUMAN_ID, seat: 0, is_bot: false, current_ap: 1000, tier_id: 3 },
        { user_id: BOT_ID, seat: 1, is_bot: true, current_ap: 1000, tier_id: 3 },
      ],
      questions: QUESTIONS.slice(0, 2),
    });
    const logger = buildLogger();
    const applyFn = vi.fn();

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
    });
    await handle.done;

    expect(supa.roundsInserts).toHaveLength(0);
    expect(applyFn).not.toHaveBeenCalled();
    expect(
      logger.calls.find(
        (c) =>
          c.level === 'error' &&
          (c.obj as { reason?: string }).reason === 'insufficient_verified_trivia',
      ),
    ).toBeDefined();
  });

  it('skips when participant count is not exactly 2', async () => {
    const supa = buildFakeSupabase({
      participants: [{ user_id: HUMAN_ID, seat: 0, is_bot: false, current_ap: 1000, tier_id: 3 }],
      questions: QUESTIONS,
    });
    const logger = buildLogger();
    const applyFn = vi.fn();

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
    });
    await handle.done;

    expect(supa.roundsInserts).toHaveLength(0);
    expect(applyFn).not.toHaveBeenCalled();
  });

  it('flags non-practice (isPractice=false) when both participants are humans', async () => {
    const supa = buildFakeSupabase({
      participants: [
        { user_id: HUMAN_ID, seat: 0, is_bot: false, current_ap: 1000, tier_id: 3 },
        {
          user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          seat: 1,
          is_bot: false,
          current_ap: 1100,
          tier_id: 3,
        },
      ],
      questions: QUESTIONS,
      preAnswers: QUESTIONS.flatMap((q) => [
        {
          battle_id: BATTLE_ID,
          round_id: 'r',
          user_id: HUMAN_ID,
          question_id: q.id,
          chosen_index: q.correct_index,
          correct: true,
          latency_ms: 2_000,
        },
      ]),
    });
    const logger = buildLogger();
    const fastTimeout = ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const applyFn = vi.fn().mockResolvedValue([]);

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      setTimeoutFn: fastTimeout,
      clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    });
    await handle.done;

    const drafts = applyFn.mock.calls[0]![1];
    expect(drafts.every((d: { isPractice: boolean }) => d.isPractice === false)).toBe(true);
  });
});
