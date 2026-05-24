import { describe, expect, it, vi } from 'vitest';

import { __testing, runOpenDebateTick, type AiVerdict } from '../../src/jobs/open-debate-runner.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

const { ROUND_COUNT, tallyCommunityVotes, decide } = __testing;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const seat0 = (id: string) => ({
  user_id: id,
  seat: 0,
  current_ap: 1000,
  tier_id: 4,
  consecutive_losses: 0,
  reductions_used: 0,
});
const seat1 = (id: string) => ({
  user_id: id,
  seat: 1,
  current_ap: 1100,
  tier_id: 4,
  consecutive_losses: 0,
  reductions_used: 0,
});

describe('tallyCommunityVotes', () => {
  it('returns zeros for no votes', () => {
    const tally = tallyCommunityVotes({
      topic: null,
      participants: [seat0('A'), seat1('B')],
      argumentsBySeat: { 0: [], 1: [] },
      votes: [],
    });
    expect(tally).toEqual({ ap_for_seat_0: 0, ap_for_seat_1: 0, voter_count: 0 });
  });

  it('sums by vote_for_user_id and snapshots ap_at_vote_time', () => {
    const tally = tallyCommunityVotes({
      topic: null,
      participants: [seat0('A'), seat1('B')],
      argumentsBySeat: { 0: [], 1: [] },
      votes: [
        { voter_user_id: 'v1', vote_for_user_id: 'A', ap_at_vote_time: 300 },
        { voter_user_id: 'v2', vote_for_user_id: 'A', ap_at_vote_time: 50 },
        { voter_user_id: 'v3', vote_for_user_id: 'B', ap_at_vote_time: 200 },
        // Stranger -- doesn't match either seat user_id, ignored.
        { voter_user_id: 'v4', vote_for_user_id: 'stranger', ap_at_vote_time: 999 },
      ],
    });
    expect(tally).toEqual({ ap_for_seat_0: 350, ap_for_seat_1: 200, voter_count: 4 });
  });
});

describe('decide', () => {
  const participants = [seat0('A'), seat1('B')];
  const aiPicksA: AiVerdict = { winnerSeat: 0, scoreA: 80, scoreB: 50, reason: 'ai liked A' };
  const aiPicksB: AiVerdict = { winnerSeat: 1, scoreA: 50, scoreB: 80, reason: 'ai liked B' };

  it('community decides when one seat has more AP', () => {
    const d = decide(
      aiPicksA,
      { ap_for_seat_0: 100, ap_for_seat_1: 300, voter_count: 3 },
      participants,
    );
    expect(d).toMatchObject({
      winnerSeat: 1,
      winnerUserId: 'B',
      loserUserId: 'A',
      decidedBy: 'community_ap',
    });
  });

  it('flags disagreement when AI picks the other seat than the community', () => {
    // AI picks A (seat 0); community picks B (seat 1).
    const d = decide(
      aiPicksA,
      { ap_for_seat_0: 100, ap_for_seat_1: 300, voter_count: 3 },
      participants,
    );
    expect(d.disagreement).toBe(true);
  });

  it('no disagreement when AI and community agree', () => {
    const d = decide(
      aiPicksB,
      { ap_for_seat_0: 100, ap_for_seat_1: 300, voter_count: 3 },
      participants,
    );
    expect(d.disagreement).toBe(false);
  });

  it('AI tiebreaks an exact AP tie', () => {
    const d = decide(
      aiPicksA,
      { ap_for_seat_0: 100, ap_for_seat_1: 100, voter_count: 2 },
      participants,
    );
    expect(d).toMatchObject({
      winnerSeat: 0,
      winnerUserId: 'A',
      decidedBy: 'ai_tiebreaker',
      disagreement: false,
    });
  });

  it('unresolved when AP is tied and AI returned null winnerSeat', () => {
    const aiNull: AiVerdict = { winnerSeat: null, scoreA: 50, scoreB: 50, reason: 'too close' };
    const d = decide(aiNull, { ap_for_seat_0: 0, ap_for_seat_1: 0, voter_count: 0 }, participants);
    expect(d).toMatchObject({
      winnerSeat: null,
      winnerUserId: null,
      loserUserId: null,
      decidedBy: 'unresolved',
    });
  });
});

// ---------------------------------------------------------------------------
// State machine — runOpenDebateTick
// ---------------------------------------------------------------------------

interface FakeState {
  battle: { id: string; mode: string; status: string; topic_id: string | null } | null;
  participants: {
    user_id: string;
    seat: number;
    users: { current_ap: number; tier_id: number } | null;
  }[];
  rounds: {
    id: string;
    round_no: number;
    payload: Record<string, unknown>;
    deadline_at: string | null;
    winner_user_id: string | null;
  }[];
  args: { round_id: string; user_id: string; text: string }[];
  votes: { voter_user_id: string; vote_for_user_id: string; ap_at_vote_time: number }[];
  topic: { id: string; headline: string; summary: string | null } | null;
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; eq: [string, unknown]; patch: Record<string, unknown> }[];
}

function buildFakeSupabase(state: FakeState): ServiceClient {
  const fromImpl = (table: string) => ({
    select(_cols: string) {
      const handler = {
        _filters: [] as { col: string; val: unknown }[],
        eq(col: string, val: unknown) {
          this._filters.push({ col, val });
          return this;
        },
        order(_col: string) {
          return this;
        },
        maybeSingle() {
          const rows = this._collect();
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
          // Awaiting the builder without .maybeSingle returns all matches.
          return Promise.resolve({ data: this._collect(), error: null }).then(resolve);
        },
        _collect(): unknown[] {
          const all = (() => {
            switch (table) {
              case 'battles':
                return state.battle ? [state.battle] : [];
              case 'battle_participants':
                return state.participants;
              case 'battle_rounds':
                return state.rounds;
              case 'debate_arguments':
                return state.args;
              case 'debate_votes':
                return state.votes;
              case 'news_topics':
                return state.topic ? [state.topic] : [];
              default:
                return [];
            }
          })();
          return all.filter((row) =>
            this._filters.every((f) => (row as Record<string, unknown>)[f.col] === f.val),
          );
        },
      };
      return handler;
    },
    insert(row: Record<string, unknown>) {
      state.inserts.push({ table, row });
      if (table === 'battle_rounds') {
        state.rounds.push({
          id: `round-${state.rounds.length}`,
          round_no: row.round_no as number,
          payload: (row.payload as Record<string, unknown>) ?? {},
          deadline_at: (row.deadline_at as string) ?? null,
          winner_user_id: null,
        });
      }
      return Promise.resolve({ error: null });
    },
    update(patch: Record<string, unknown>) {
      return {
        eq(col: string, val: unknown) {
          state.updates.push({ table, eq: [col, val], patch });
          if (table === 'battle_rounds' && col === 'id') {
            const r = state.rounds.find((x) => x.id === val);
            if (r) {
              if (patch.payload !== undefined) r.payload = patch.payload as Record<string, unknown>;
              if (patch.winner_user_id !== undefined)
                r.winner_user_id = patch.winner_user_id as string | null;
            }
          }
          if (table === 'battles' && col === 'id' && state.battle && state.battle.id === val) {
            if (patch.status !== undefined) state.battle.status = patch.status as string;
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  });
  return { from: fromImpl } as unknown as ServiceClient;
}

function buildLogger(): Logger & { calls: { level: string; obj: object }[] } {
  const calls: { level: string; obj: object }[] = [];
  const push = (level: string) => (obj: object) => calls.push({ level, obj });
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

const baseState = (): FakeState => ({
  battle: { id: 'b1', mode: 'open_debate', status: 'live', topic_id: 't1' },
  // battle_id stamped on every row whose query joins by it -- the fake's
  // .eq filter is exact-match so missing the column means the filter elides
  // the row entirely.
  participants: [
    {
      user_id: 'A',
      seat: 0,
      users: { current_ap: 1000, tier_id: 4 },
      battle_id: 'b1',
    } as unknown as FakeState['participants'][number],
    {
      user_id: 'B',
      seat: 1,
      users: { current_ap: 1100, tier_id: 4 },
      battle_id: 'b1',
    } as unknown as FakeState['participants'][number],
  ],
  rounds: [],
  args: [],
  votes: [],
  topic: { id: 't1', headline: 'Should X be Y?', summary: 'Context' },
  inserts: [],
  updates: [],
});

// Round / arg / vote seed helpers that auto-stamp battle_id.
function seedRound(
  state: FakeState,
  r: Omit<FakeState['rounds'][number], never> & { battle_id?: string },
): void {
  state.rounds.push({ ...r, battle_id: r.battle_id ?? state.battle!.id } as never);
}
function seedArg(state: FakeState, a: FakeState['args'][number] & { battle_id?: string }): void {
  state.args.push({ ...a, battle_id: a.battle_id ?? state.battle!.id } as never);
}
function seedVote(state: FakeState, v: FakeState['votes'][number] & { battle_id?: string }): void {
  state.votes.push({ ...v, battle_id: v.battle_id ?? state.battle!.id } as never);
}

describe('runOpenDebateTick state machine', () => {
  it('creates round 0 when the battle has no rounds yet', async () => {
    const state = baseState();
    const supabase = buildFakeSupabase(state);
    const logger = buildLogger();
    const invoke = vi.fn();
    const now = () => Date.parse('2026-05-24T10:00:00Z');

    const outcome = await runOpenDebateTick('b1', {
      supabase,
      logger,
      invoke: invoke as never,
      now,
    });

    expect(outcome).toMatchObject({ phase: 'created_round', detail: { roundNo: 0 } });
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]).toMatchObject({
      round_no: 0,
      payload: { state: 'awaiting_arguments' },
    });
    expect(state.rounds[0]!.deadline_at).toBe('2026-05-24T10:05:00.000Z');
  });

  it('transitions round 0 to revealed and opens round 1 when both seats submit', async () => {
    const state = baseState();
    seedRound(state, {
      id: 'r0',
      round_no: 0,
      payload: { state: 'awaiting_arguments' },
      deadline_at: '2026-05-24T10:05:00.000Z',
      winner_user_id: null,
    });
    seedArg(state, { round_id: 'r0', user_id: 'A', text: 'a opening' });
    seedArg(state, { round_id: 'r0', user_id: 'B', text: 'b opening' });
    const supabase = buildFakeSupabase(state);
    const logger = buildLogger();
    const invoke = vi.fn();
    const now = () => Date.parse('2026-05-24T10:01:00Z');

    const outcome = await runOpenDebateTick('b1', {
      supabase,
      logger,
      invoke: invoke as never,
      now,
    });

    expect(outcome).toMatchObject({ phase: 'transitioned_to_revealed', detail: { roundNo: 0 } });
    const r0 = state.rounds.find((r) => r.round_no === 0)!;
    expect(r0.payload).toMatchObject({
      state: 'revealed',
      revealed_by: 'both_submitted',
      forfeit_seats: [],
    });
    // Round 1 should be opened.
    expect(state.rounds.some((r) => r.round_no === 1)).toBe(true);
  });

  it('forfeits a seat when the round deadline passes without their submission', async () => {
    const state = baseState();
    seedRound(state, {
      id: 'r0',
      round_no: 0,
      payload: { state: 'awaiting_arguments' },
      deadline_at: '2026-05-24T10:00:00.000Z',
      winner_user_id: null,
    });
    seedArg(state, { round_id: 'r0', user_id: 'A', text: 'only A submitted' });
    const supabase = buildFakeSupabase(state);
    const logger = buildLogger();
    const invoke = vi.fn();
    // 1 minute past the deadline.
    const now = () => Date.parse('2026-05-24T10:01:00Z');

    const outcome = await runOpenDebateTick('b1', {
      supabase,
      logger,
      invoke: invoke as never,
      now,
    });

    expect(outcome.phase).toBe('transitioned_to_revealed');
    const r0 = state.rounds.find((r) => r.round_no === 0)!;
    expect(r0.payload).toMatchObject({
      state: 'revealed',
      revealed_by: 'deadline',
      forfeit_seats: [1], // B didn't submit
    });
  });

  it('opens the verdict round after round 2 reveals', async () => {
    const state = baseState();
    // Rounds 0 and 1 already revealed.
    seedRound(state, {
      id: 'r0',
      round_no: 0,
      payload: { state: 'revealed' },
      deadline_at: null,
      winner_user_id: null,
    });
    seedRound(state, {
      id: 'r1',
      round_no: 1,
      payload: { state: 'revealed' },
      deadline_at: null,
      winner_user_id: null,
    });
    seedRound(state, {
      id: 'r2',
      round_no: 2,
      payload: { state: 'awaiting_arguments' },
      deadline_at: '2026-05-24T10:20:00.000Z',
      winner_user_id: null,
    });
    seedArg(state, { round_id: 'r2', user_id: 'A', text: 'a closing' });
    seedArg(state, { round_id: 'r2', user_id: 'B', text: 'b closing' });
    const supabase = buildFakeSupabase(state);
    const logger = buildLogger();
    const invoke = vi.fn();
    const now = () => Date.parse('2026-05-24T10:18:00Z');

    const outcome = await runOpenDebateTick('b1', {
      supabase,
      logger,
      invoke: invoke as never,
      now,
    });

    expect(outcome.phase).toBe('opened_verdict_round');
    const verdictRound = state.rounds.find((r) => r.round_no === ROUND_COUNT);
    expect(verdictRound).toBeDefined();
    expect(verdictRound!.payload).toMatchObject({ state: 'awaiting_final_vote' });
  });

  it('scores + settles when the verdict round deadline passes; stores AI + community side by side', async () => {
    // ap-engine settle path validates UserId / BattleId via z.uuid(), so the
    // score+settle test uses real UUIDs (other tests use short ids -- they
    // don't hit the validator path).
    const BID = '11111111-1111-4111-8111-111111111111';
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const state = baseState();
    state.battle = { id: BID, mode: 'open_debate', status: 'live', topic_id: 't1' };
    state.participants = [
      {
        user_id: A,
        seat: 0,
        users: { current_ap: 1000, tier_id: 4 },
        battle_id: BID,
      } as unknown as FakeState['participants'][number],
      {
        user_id: B,
        seat: 1,
        users: { current_ap: 1100, tier_id: 4 },
        battle_id: BID,
      } as unknown as FakeState['participants'][number],
    ];
    seedRound(state, {
      id: 'r0',
      round_no: 0,
      payload: { state: 'revealed' },
      deadline_at: null,
      winner_user_id: null,
    });
    seedRound(state, {
      id: 'r1',
      round_no: 1,
      payload: { state: 'revealed' },
      deadline_at: null,
      winner_user_id: null,
    });
    seedRound(state, {
      id: 'r2',
      round_no: 2,
      payload: { state: 'revealed' },
      deadline_at: null,
      winner_user_id: null,
    });
    seedRound(state, {
      id: 'r3',
      round_no: 3,
      payload: { state: 'awaiting_final_vote' },
      deadline_at: '2026-05-24T10:25:00.000Z',
      winner_user_id: null,
    });
    seedArg(state, { round_id: 'r0', user_id: A, text: 'a opening' });
    seedArg(state, { round_id: 'r0', user_id: B, text: 'b opening' });
    seedArg(state, { round_id: 'r1', user_id: A, text: 'a rebuttal' });
    seedArg(state, { round_id: 'r1', user_id: B, text: 'b rebuttal' });
    seedArg(state, { round_id: 'r2', user_id: A, text: 'a closing' });
    seedArg(state, { round_id: 'r2', user_id: B, text: 'b closing' });
    // Community heavily votes for B (seat 1).
    seedVote(state, { voter_user_id: 'v1', vote_for_user_id: B, ap_at_vote_time: 500 });
    seedVote(state, { voter_user_id: 'v2', vote_for_user_id: B, ap_at_vote_time: 300 });
    seedVote(state, { voter_user_id: 'v3', vote_for_user_id: A, ap_at_vote_time: 100 });
    const supabase = buildFakeSupabase(state);
    const logger = buildLogger();
    // AI picks A -- disagreement scenario.
    const invoke = vi.fn().mockResolvedValueOnce({
      output: { winnerSeat: 0, scoreA: 90, scoreB: 60, reason: 'AI liked A' },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      task: 'debate_score',
      usd: 0.01,
      latencyMs: 500,
    });
    const applyDraftsFn = vi.fn().mockResolvedValue([]);
    const now = () => Date.parse('2026-05-24T10:26:00Z');

    const outcome = await runOpenDebateTick(BID, {
      supabase,
      logger,
      invoke: invoke as never,
      applyDraftsFn: applyDraftsFn as never,
      now,
    });

    expect(outcome.phase).toBe('scored_and_settled');
    // Verdict row updated with state='scored' and both AI + community payload.
    const verdict = state.rounds.find((r) => r.round_no === 3)!;
    expect(verdict.payload).toMatchObject({
      state: 'scored',
      ai: { winnerSeat: 0, scoreA: 90, scoreB: 60 },
      community: { ap_for_seat_0: 100, ap_for_seat_1: 800, voter_count: 3 },
      decided_by: 'community_ap',
      // AI picked A; community picked B -- disagreement flagged for the UI.
      disagreement: true,
      winner_seat: 1,
      winner_user_id: B,
    });
    // Battle marked settled.
    expect(state.battle!.status).toBe('settled');
    // AP settlement applied.
    expect(applyDraftsFn).toHaveBeenCalledTimes(1);
  });

  it('returns already_settled and does no work for a settled battle', async () => {
    const state = baseState();
    state.battle!.status = 'settled';
    const supabase = buildFakeSupabase(state);
    const logger = buildLogger();
    const invoke = vi.fn();

    const outcome = await runOpenDebateTick('b1', {
      supabase,
      logger,
      invoke: invoke as never,
    });

    expect(outcome.phase).toBe('already_settled');
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });
});
