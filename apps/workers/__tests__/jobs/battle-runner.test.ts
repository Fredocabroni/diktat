import { describe, expect, it, vi } from 'vitest';

import { runBattle, __testing } from '../../src/jobs/battle-runner.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

const BATTLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HUMAN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface FakeSupabaseState {
  client: ServiceClient;
  /** Current battle status; flips to 'settled' when the claim-guarded update lands. */
  battleStatus: string;
  /** Rounds a prior run already emitted (resume path); payload carries questionId. */
  existingRounds: { round_no: number; payload?: { questionId?: string } }[];
  battlesUpdates: { battleId: string; payload: Record<string, unknown> }[];
  roundsInserts: { battle_id: string; round_no: number; payload: unknown; id: string }[];
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
  /** Initial battle status (default 'live'). */
  status?: string;
  /** Rounds already emitted by a prior run (drives the resume path). */
  preRounds?: { round_no: number; payload?: { questionId?: string } }[];
  /** Force the claim-guarded flip to match 0 rows (simulates a lost claim). */
  claimLost?: boolean;
}

function buildFakeSupabase(cfg: FakeSupabaseConfig): FakeSupabaseState {
  const state: FakeSupabaseState = {
    client: null as unknown as ServiceClient,
    battleStatus: cfg.status ?? 'live',
    existingRounds: cfg.preRounds ? [...cfg.preRounds] : [],
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
    const filters: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    };
    // fetchQuestions: .select(...).eq(...).limit(n)
    builder.limit = () => Promise.resolve({ data: cfg.questions, error: null });
    // loadRoundForBackfill: .select(...).eq('id', qId).maybeSingle()
    builder.maybeSingle = () =>
      Promise.resolve({
        data: cfg.questions.find((q) => q.id === filters.id) ?? null,
        error: null,
      });
    return builder;
  };

  const triviaAnswersBuilder = () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => Promise.resolve({ data: state.answers, error: null });
    // emitBotAnswer: .upsert(payload, { onConflict:'round_id,user_id', ignoreDuplicates })
    // Model the unique (round_id, user_id): a duplicate is a clean no-op.
    builder.upsert = (payload: FakeSupabaseState['answers'][number]) => {
      const dup = state.answers.some(
        (a) => a.round_id === payload.round_id && a.user_id === payload.user_id,
      );
      if (!dup) state.answers.push(payload);
      return Promise.resolve({ error: null });
    };
    return builder;
  };

  const battleRoundsBuilder = () => {
    const builder: Record<string, unknown> = {};
    const eqFilters: Record<string, unknown> = {};
    // Model the (battle_id, round_no) unique constraint. Pre-seeded rounds get a
    // deterministic id so the conflict re-select can return it.
    const allRounds = (): { round_no: number; id: string; payload: unknown }[] => [
      ...state.existingRounds.map((r) => ({
        round_no: r.round_no,
        id: `preround-${r.round_no}`,
        payload: r.payload ?? null,
      })),
      ...state.roundsInserts.map((r) => ({ round_no: r.round_no, id: r.id, payload: r.payload })),
    ];

    // emitRound: .upsert(payload, { onConflict, ignoreDuplicates }).select('id').maybeSingle()
    // ignoreDuplicates => a conflict returns NO row; a fresh round returns { id }.
    builder.upsert = (payload: { battle_id: string; round_no: number; payload: unknown }) => ({
      select: () => ({
        maybeSingle: () => {
          const conflict = allRounds().some((r) => r.round_no === payload.round_no);
          if (conflict) return Promise.resolve({ data: null, error: null });
          const id = `round-${nextRoundId++}`;
          state.roundsInserts.push({ ...payload, id });
          return Promise.resolve({ data: { id }, error: null });
        },
      }),
    });

    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      eqFilters[col] = val;
      return builder;
    };
    // emitRound conflict re-select AND loadRoundForBackfill:
    //   .select('id'[,'payload']).eq('battle_id').eq('round_no').maybeSingle()
    builder.maybeSingle = () => {
      const found = allRounds().find((r) => r.round_no === eqFilters.round_no);
      return Promise.resolve({
        data: found ? { id: found.id, payload: found.payload } : null,
        error: null,
      });
    };
    // maxEmittedRoundNo: .select('round_no').eq('battle_id', id) — awaited directly.
    // A thenable builder lets the single-.eq read resolve without a terminal call.
    builder.then = (
      resolve: (v: { data: { round_no: number }[]; error: null }) => unknown,
      reject: (e: unknown) => unknown,
    ) =>
      Promise.resolve({
        data: allRounds().map((r) => ({ round_no: r.round_no })),
        error: null,
      }).then(resolve, reject);
    return builder;
  };

  const battlesBuilder = () => {
    let updatePayload: Record<string, unknown> | null = null;
    const filters: Record<string, string> = {};
    const builder: Record<string, unknown> = {};
    builder.update = (payload: Record<string, unknown>) => {
      updatePayload = payload;
      return builder;
    };
    builder.eq = (col: string, val: string) => {
      filters[col] = val;
      return builder;
    };
    // Entry guard: .select('status').eq('id', id).maybeSingle()
    builder.maybeSingle = () =>
      Promise.resolve({ data: { status: state.battleStatus }, error: null });
    builder.select = () => {
      if (!updatePayload) return builder; // read chain (status guard)
      // Claim-guarded flip terminal: .update(...).eq('id').eq('status','live').select('id')
      if (cfg.claimLost) return Promise.resolve({ data: [] as { id: string }[], error: null });
      const statusMatches = filters.status === undefined || filters.status === state.battleStatus;
      if (statusMatches) {
        state.battlesUpdates.push({ battleId: filters.id ?? '', payload: updatePayload });
        if (typeof updatePayload.status === 'string') state.battleStatus = updatePayload.status;
        return Promise.resolve({ data: [{ id: filters.id ?? '' }], error: null });
      }
      return Promise.resolve({ data: [] as { id: string }[], error: null });
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

const ALL_ROUNDS = [0, 1, 2, 3, 4].map((round_no) => ({ round_no }));
const seedAnswers = () =>
  QUESTIONS.map((q) => ({
    battle_id: BATTLE_ID,
    round_id: 'seed',
    user_id: HUMAN_ID,
    question_id: q.id,
    chosen_index: q.correct_index,
    correct: true,
    latency_ms: 2_000,
  }));
const hasEvent = (logger: ReturnType<typeof buildLogger>, event: string): boolean =>
  logger.calls.some((c) => (c.obj as { event?: string }).event === event);
const twoPlayers = [
  { user_id: HUMAN_ID, seat: 0, is_bot: false, current_ap: 1000, tier_id: 3 },
  { user_id: BOT_ID, seat: 1, is_bot: true, current_ap: 1000, tier_id: 3 },
];

describe('runBattle — crash safety (PR1: atomic settle + resume + drain)', () => {
  it('resume: all rounds already emitted -> skips re-emission, applies AP, flips settled', async () => {
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live',
      preRounds: ALL_ROUNDS,
      preAnswers: seedAnswers(),
    });
    const logger = buildLogger();
    const applyFn = vi.fn().mockResolvedValue([]);

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      now: () => 1_700_000_000_000,
    });
    await handle.done;

    expect(supa.roundsInserts).toHaveLength(0); // no re-emission
    expect(applyFn).toHaveBeenCalledTimes(1); // AP applied
    expect(supa.battlesUpdates).toHaveLength(1);
    expect(supa.battlesUpdates[0]!.payload).toMatchObject({ status: 'settled' });
    expect(supa.battleStatus).toBe('settled');
    expect(hasEvent(logger, 'battle.runner.resume_settle')).toBe(true);
  });

  it('idempotent re-run: an already-settled battle applies no AP and writes no update', async () => {
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'settled', // a prior run already settled it
      preRounds: ALL_ROUNDS,
      preAnswers: seedAnswers(),
    });
    const logger = buildLogger();
    const applyFn = vi.fn().mockResolvedValue([]);

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      now: () => 1_700_000_000_000,
    });
    await handle.done;

    expect(applyFn).not.toHaveBeenCalled(); // entry guard skipped settle
    expect(supa.roundsInserts).toHaveLength(0);
    expect(supa.battlesUpdates).toHaveLength(0);
    expect(hasEvent(logger, 'battle.runner.settle_skip')).toBe(true);
  });

  it('claim contention: a lost status claim aborts cleanly after AP is applied', async () => {
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live', // entry guard passes...
      preRounds: ALL_ROUNDS,
      preAnswers: seedAnswers(),
      claimLost: true, // ...but the flip matches 0 rows (another settler won)
    });
    const logger = buildLogger();
    const applyFn = vi.fn().mockResolvedValue([]);

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      now: () => 1_700_000_000_000,
    });
    await expect(handle.done).resolves.toBeUndefined(); // no throw

    expect(applyFn).toHaveBeenCalledTimes(1); // AP applied (before the flip)
    expect(supa.battlesUpdates).toHaveLength(0); // flip claimed nothing
    expect(hasEvent(logger, 'battle.runner.settle_claim_lost')).toBe(true);
  });

  it('drain: done resolves only after settle completes, even when stop() fires mid-settle', async () => {
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live',
      preRounds: ALL_ROUNDS, // resume -> straight to settle, no round-loop timers
      preAnswers: seedAnswers(),
    });
    const logger = buildLogger();
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((r) => {
      releaseApply = r;
    });
    const applyFn = vi.fn().mockImplementation(async () => {
      await applyGate;
      return [];
    });

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      now: () => 1_700_000_000_000,
    });
    let doneResolved = false;
    void handle.done.then(() => {
      doneResolved = true;
    });

    // Let the runner reach settle -> applyFn (now blocked on applyGate).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(applyFn).toHaveBeenCalledTimes(1);

    // Stop mid-settle: must NOT short-circuit the in-flight settlement.
    handle.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(doneResolved).toBe(false); // still draining: settle blocked on applyFn

    releaseApply();
    await handle.done;
    expect(doneResolved).toBe(true);
    expect(supa.battlesUpdates).toHaveLength(1); // drain let settle finish
    expect(supa.battleStatus).toBe('settled');
  });

  it('partial resume: emits only the missing rounds, never re-touching completed ones or their bot answers', async () => {
    // A prior run crashed after emitting rounds 0 and 1. Resume must pick up at
    // round 2 — re-emitting 0/1 would double-count their bot answers.
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live',
      preRounds: [{ round_no: 0 }, { round_no: 1 }],
      preAnswers: seedAnswers(), // human already answered every round
    });
    const logger = buildLogger();
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
      random: () => 0,
      now: () => 1_700_000_000_000,
    });
    await handle.done;

    // Only rounds 2,3,4 emitted — rounds 0,1 untouched.
    expect(supa.roundsInserts.map((r) => r.round_no)).toEqual([2, 3, 4]);
    // Bot answered only the 3 resumed rounds — not the 2 completed ones.
    expect(supa.answers.filter((a) => a.user_id === BOT_ID)).toHaveLength(3);
    // Settled normally, logging a resume (not a fresh start).
    expect(applyFn).toHaveBeenCalledTimes(1);
    expect(supa.battleStatus).toBe('settled');
    expect(hasEvent(logger, 'battle.runner.resume')).toBe(true);
    expect(hasEvent(logger, 'battle.runner.start')).toBe(false);
  });

  it('idempotent emit: re-emitting an existing round returns its id without throwing', async () => {
    // Defends the rare double-spawn race that resume-from-max makes unreachable
    // in the single-runner flow: emitRound against an already-persisted
    // (battle_id, round_no) must resolve to the existing row id via the
    // on-conflict-do-nothing path, not raise a unique violation that would
    // orphan the battle at status='live'.
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live',
      preRounds: [{ round_no: 2 }], // round 2 already exists
    });

    // First emit of round 2 hits the conflict path and re-selects the pre-seeded
    // id ("preround-2"), inserting nothing new.
    const existingId = await __testing.emitRound({
      supabase: supa.client,
      battleId: BATTLE_ID,
      roundNo: 2,
      question: QUESTIONS[2]!,
    });
    expect(existingId).toBe('preround-2');
    expect(supa.roundsInserts).toHaveLength(0); // no duplicate row

    // A fresh round (5) inserts normally and returns a new id.
    const freshId = await __testing.emitRound({
      supabase: supa.client,
      battleId: BATTLE_ID,
      roundNo: 5,
      question: QUESTIONS[0]!,
    });
    expect(freshId).toMatch(/^round-/);
    expect(supa.roundsInserts.map((r) => r.round_no)).toEqual([5]);
  });

  it('boundary backfill: crash after round-row + before bot-answer -> resume backfills the missing bot answer against the original question', async () => {
    // Rounds 0,1,2 emitted; the crash left round 2 (the boundary) with its row
    // but NO bot answer. Rounds 0,1 are fully complete (bot answered).
    // Capture round 2's original question id BEFORE the run — fetchQuestions
    // shuffles the shared questions array in place when it emits the new rounds.
    const round2OriginalQid = QUESTIONS[2]!.id;
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live',
      preRounds: [0, 1, 2].map((i) => ({ round_no: i, payload: { questionId: QUESTIONS[i]!.id } })),
      preAnswers: [
        // human answered all three completed rounds
        ...[0, 1, 2].map((i) => ({
          battle_id: BATTLE_ID,
          round_id: `preround-${i}`,
          user_id: HUMAN_ID,
          question_id: QUESTIONS[i]!.id,
          chosen_index: QUESTIONS[i]!.correct_index,
          correct: true,
          latency_ms: 2_000,
        })),
        // bot answered ONLY rounds 0 and 1 — round 2 (boundary) is missing
        ...[0, 1].map((i) => ({
          battle_id: BATTLE_ID,
          round_id: `preround-${i}`,
          user_id: BOT_ID,
          question_id: QUESTIONS[i]!.id,
          chosen_index: QUESTIONS[i]!.correct_index,
          correct: true,
          latency_ms: 3_000,
        })),
      ],
    });
    const logger = buildLogger();
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
      random: () => 0,
      now: () => 1_700_000_000_000,
    });
    await handle.done;

    // The bot's round-2 answer was backfilled against round 2's ORIGINAL question.
    const round2Bot = supa.answers.find((a) => a.user_id === BOT_ID && a.round_id === 'preround-2');
    expect(round2Bot).toBeDefined();
    expect(round2Bot!.question_id).toBe(round2OriginalQid); // original question, not reshuffled
    // Backfill emits no NEW round row; only genuinely-new rounds 3,4 are inserted.
    expect(supa.roundsInserts.map((r) => r.round_no)).toEqual([3, 4]);
    // Bot now has an answer for every round (0,1 seeded; 2 backfilled; 3,4 new).
    expect(supa.answers.filter((a) => a.user_id === BOT_ID)).toHaveLength(5);
    expect(hasEvent(logger, 'battle.runner.boundary_backfill_skipped')).toBe(false);
    expect(hasEvent(logger, 'battle.runner.resume')).toBe(true);
    expect(applyFn).toHaveBeenCalledTimes(1);
    expect(supa.battleStatus).toBe('settled');
  });

  it('crash after a COMPLETE round: resume backfill no-ops cleanly — no duplicate, no throw, no orphan', async () => {
    // All 5 rounds emitted AND fully answered (bot answered the final round). The
    // resume re-touches the boundary round; the idempotent bot-answer upsert must
    // no-op on the unique (round_id, user_id) constraint rather than throw.
    const complete = (uid: string) =>
      QUESTIONS.map((q, i) => ({
        battle_id: BATTLE_ID,
        round_id: `preround-${i}`,
        user_id: uid,
        question_id: q.id,
        chosen_index: q.correct_index,
        correct: true,
        latency_ms: 2_000,
      }));
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live',
      preRounds: QUESTIONS.map((q, i) => ({ round_no: i, payload: { questionId: q.id } })),
      preAnswers: [...complete(HUMAN_ID), ...complete(BOT_ID)],
    });
    const logger = buildLogger();
    const applyFn = vi.fn().mockResolvedValue([]);

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      now: () => 1_700_000_000_000,
    });
    await expect(handle.done).resolves.toBeUndefined(); // no throw / re-orphan

    // Idempotent: no duplicate bot answer for the final round.
    expect(supa.answers.filter((a) => a.user_id === BOT_ID)).toHaveLength(5);
    expect(supa.roundsInserts).toHaveLength(0);
    expect(hasEvent(logger, 'battle.runner.failed')).toBe(false);
    expect(hasEvent(logger, 'battle.runner.resume_settle')).toBe(true);
    expect(applyFn).toHaveBeenCalledTimes(1);
    expect(supa.battleStatus).toBe('settled');
  });

  it('🔴-alerts via deps.alerter when the runner fails (PR B-lite crash hook)', async () => {
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live',
      preRounds: ALL_ROUNDS,
      preAnswers: seedAnswers(),
    });
    const logger = buildLogger();
    const applyFn = vi.fn().mockRejectedValue(new Error('boom-apply')); // settle throws
    const alert = vi.fn().mockResolvedValue(undefined);

    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      alerter: { alert, enabled: true },
      now: () => 1_700_000_000_000,
    });
    await handle.done;

    expect(hasEvent(logger, 'battle.runner.failed')).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    const [severity, title, detail, opts] = alert.mock.calls[0]!;
    expect(severity).toBe('error');
    expect(title).toBe('battle runner failed');
    expect(detail).toContain(BATTLE_ID);
    expect(opts).toMatchObject({ dedupKey: `workers:battle:runner:${BATTLE_ID}` });
  });

  it('does not throw when no alerter is provided (optional dep)', async () => {
    const supa = buildFakeSupabase({
      participants: twoPlayers,
      questions: QUESTIONS,
      status: 'live',
      preRounds: ALL_ROUNDS,
      preAnswers: seedAnswers(),
    });
    const logger = buildLogger();
    const applyFn = vi.fn().mockRejectedValue(new Error('boom-apply'));
    const handle = runBattle(BATTLE_ID, {
      supabase: supa.client,
      logger,
      applyDraftsFn: applyFn as never,
      now: () => 1_700_000_000_000,
    });
    await expect(handle.done).resolves.toBeUndefined();
    expect(hasEvent(logger, 'battle.runner.failed')).toBe(true);
  });
});
