// Open-debate runner. PR 4.5 / Phase 4.
//
// Async turn-based tempo: 3 rounds (opening / rebuttal / closing). Within a
// round both seats submit "blind" -- neither sees the other's until both are
// in OR the round's deadline_at passes; then the round reveals and the next
// opens. ONE community AP-weighted vote at the end of the full debate (not
// per round). ONE debate_score AI call on the complete exchange.
//
// Winner = community AP-weighted vote (decisive). AI score is advisory and
// stored transparently in the verdict-round payload alongside the community
// tally so the UI (PR 4.6) can show them side-by-side -- ESPECIALLY when they
// DISAGREE (the §2 "a loss must feel fair" flashpoint; addiction-auditor
// surfaces this case explicitly in the payload via `disagreement: true`).
// AI breaks the tie only when the community AP totals are exactly equal.
//
// Data model: the runner uses a synthetic battle_rounds row at round_no=3 as
// the "verdict round". Its deadline_at = the community vote window close. On
// that deadline, the runner does the AI scoring + community tally, decides,
// settles via apply_ap_drafts, and marks battles.status='settled'.
//
// Pattern: mirrors the trivia battle-runner -- per-battle handle returned by
// runOpenDebate(battleId, deps); battle-poller spawns one per live battle.
// Tick logic is exposed as runOpenDebateTick() for unit testing.

import { applyDrafts, settleBattle, type Tier } from '@diktat/ap-engine';
import { battleId as toBattleId, userId as toUserId, type BattleMode } from '@diktat/shared';
import type { invoke as fabricInvoke, ProviderEnv } from '@diktat/ai-fabric';
import { z } from 'zod';

import type { Logger } from '../logger.js';
import type { ServiceClient } from '../supabase.js';

// ---------------------------------------------------------------------------
// Tunables (V1 defaults; can be moved to env in a future polish pass).
// ---------------------------------------------------------------------------
const ROUND_COUNT = 3;
const ARG_WINDOW_MS = 5 * 60 * 1000; // 5 min per round
const VOTE_WINDOW_MS = 2 * 60 * 1000; // 2 min community vote window
const TICK_INTERVAL_MS = 3_000;
const SCORER_USD_PROJECTION = 0.02;

// debate_score AI verdict shape.
const VerdictSchema = z.object({
  winnerSeat: z.union([z.literal(0), z.literal(1), z.null()]),
  scoreA: z.number().min(0).max(100),
  scoreB: z.number().min(0).max(100),
  reason: z.string().min(1),
});
export type AiVerdict = z.infer<typeof VerdictSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface OpenDebateRunnerDeps {
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  readonly invoke: typeof fabricInvoke;
  readonly providerEnv?: ProviderEnv;
  readonly applyDraftsFn?: typeof applyDrafts;
  readonly now?: () => number;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

export interface RunningOpenDebate {
  readonly battleId: string;
  stop(): void;
  /** Resolves when the debate settles or errors out. Tests await this. */
  done: Promise<void>;
}

interface ParticipantRow {
  user_id: string;
  seat: number;
  current_ap: number;
  tier_id: number;
  consecutive_losses: number;
  reductions_used: number;
}

interface RoundRow {
  id: string;
  round_no: number;
  payload: Record<string, unknown>;
  deadline_at: string | null;
  winner_user_id: string | null;
}

interface ArgumentRow {
  round_id: string;
  user_id: string;
  text: string;
}

interface VoteRow {
  voter_user_id: string;
  vote_for_user_id: string;
  ap_at_vote_time: number;
}

interface BattleRow {
  id: string;
  mode: BattleMode;
  status: string;
  topic_id: string | null;
  started_at: string | null;
  ap_pot: number;
}

interface TopicRow {
  id: string;
  headline: string;
  summary: string | null;
}

export type TickPhase =
  | 'noop'
  | 'created_round'
  | 'transitioned_to_revealed'
  | 'opened_verdict_round'
  | 'scored_and_settled'
  | 'resumed_settlement'
  | 'already_settled'
  | 'error';

export interface TickOutcome {
  phase: TickPhase;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a per-battle runner for one open_debate battle. Returns a handle
 * the battle-poller stores; the lifecycle ends when the debate settles or
 * `stop()` is called.
 */
export function runOpenDebate(battleId: string, deps: OpenDebateRunnerDeps): RunningOpenDebate {
  const setIntervalImpl = deps.setIntervalFn ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalFn ?? clearInterval;

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let stopped = false;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      const outcome = await runOpenDebateTick(battleId, deps);
      if (outcome.phase === 'scored_and_settled' || outcome.phase === 'already_settled') {
        stop();
      }
    } catch (err) {
      deps.logger.error({
        event: 'open_debate.tick_failed',
        battleId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      busy = false;
    }
  };

  const handle = setIntervalImpl(() => void tick(), TICK_INTERVAL_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearIntervalImpl(handle);
    resolveDone();
  }

  // Fire one tick immediately so a freshly-live battle creates its round 0
  // without waiting a full interval.
  void tick();

  return { battleId, stop, done };
}

// ---------------------------------------------------------------------------
// Tick logic (exposed for tests)
// ---------------------------------------------------------------------------

/** Run one tick. Returns a structured outcome (no side effects beyond DB). */
export async function runOpenDebateTick(
  battleId: string,
  deps: OpenDebateRunnerDeps,
): Promise<TickOutcome> {
  const battle = await fetchBattle(deps.supabase, battleId);
  if (!battle) return { phase: 'error', detail: { reason: 'battle_not_found' } };
  if (battle.status === 'settled' || battle.status === 'cancelled') {
    return { phase: 'already_settled' };
  }
  if (battle.mode !== 'open_debate') {
    return { phase: 'error', detail: { reason: 'wrong_mode', mode: battle.mode } };
  }

  const rounds = await fetchRounds(deps.supabase, battleId);
  const now = deps.now ? deps.now() : Date.now();

  // (1) If no rounds yet, create round 0.
  if (rounds.length === 0) {
    await createArgumentRound(deps.supabase, battleId, 0, deadlineAt(now, ARG_WINDOW_MS));
    deps.logger.info({ event: 'open_debate.round_opened', battleId, roundNo: 0 });
    return { phase: 'created_round', detail: { roundNo: 0 } };
  }

  // (2) Argument rounds (round_no 0..2): check for transitions in order.
  const argRounds = rounds
    .filter((r) => r.round_no < ROUND_COUNT)
    .sort((a, b) => a.round_no - b.round_no);
  for (const round of argRounds) {
    const state = String(round.payload?.state ?? '');
    if (state !== 'awaiting_arguments') continue;

    const args = await fetchArguments(deps.supabase, round.id);
    const bothSubmitted = args.length >= 2;
    const deadlineMs = round.deadline_at ? Date.parse(round.deadline_at) : Infinity;
    const deadlinePassed = now >= deadlineMs;

    if (!bothSubmitted && !deadlinePassed) {
      // Still waiting. Bail; next tick re-checks.
      return { phase: 'noop' };
    }

    const participants = await fetchParticipants(deps.supabase, battleId);
    const submittedUserIds = new Set(args.map((a) => a.user_id));
    const forfeitSeats = participants
      .filter((p) => !submittedUserIds.has(p.user_id))
      .map((p) => p.seat);

    await revealRound(deps.supabase, round, {
      revealed_at: new Date(now).toISOString(),
      revealed_by: bothSubmitted ? 'both_submitted' : 'deadline',
      forfeit_seats: forfeitSeats,
    });
    deps.logger.info({
      event: 'open_debate.round_revealed',
      battleId,
      roundNo: round.round_no,
      forfeitSeats,
    });

    // Open the next argument round, or the verdict round.
    if (round.round_no + 1 < ROUND_COUNT) {
      await createArgumentRound(
        deps.supabase,
        battleId,
        round.round_no + 1,
        deadlineAt(now, ARG_WINDOW_MS),
      );
    } else {
      await createVerdictRound(deps.supabase, battleId, deadlineAt(now, VOTE_WINDOW_MS));
      return { phase: 'opened_verdict_round' };
    }
    return { phase: 'transitioned_to_revealed', detail: { roundNo: round.round_no } };
  }

  // (3) Verdict round: if vote window has closed, score + settle.
  const verdictRound = rounds.find((r) => r.round_no === ROUND_COUNT);
  if (!verdictRound) return { phase: 'noop' };
  const verdictState = String(verdictRound.payload?.state ?? '');

  // (3a) Re-entry guard. Verdict already 'scored' but battle still 'live' =>
  // a previous tick wrote the verdict row but crashed before markBattleSettled
  // (or applyApSettlement) completed. Resume without re-tallying or re-calling
  // the AI -- crucial for AI-tiebroken debates, where re-invoking the scorer
  // could pick a different winnerSeat. SQL idempotency on its own does NOT
  // catch a flip: the per-user role-keyed keys (battle:<id>:user:<U>:reason:
  // battle_win vs :reason:battle_loss) DIFFER between (A-win, B-loss) and
  // (A-loss, B-win), so flipped roles miss both originals' keys and BOTH
  // users land a win-credit AND a loss-debit -- real double-credit corruption.
  // The fix is structural: the _settlement_inputs snapshot is stamped into
  // the verdict payload at first-pass time and replayed verbatim from that
  // persisted payload on resume (never queried live), so first-pass and
  // resume feed byte-identical inputs to settleBattle -- byte-identical
  // drafts, byte-identical idempotency keys, byte-identical deltas. A flip
  // is architecturally impossible by construction, not "caught downstream."
  if (verdictState === 'scored') {
    await resumeSettlement(deps, battle, verdictRound);
    return { phase: 'resumed_settlement' };
  }

  if (verdictState !== 'awaiting_final_vote') return { phase: 'noop' };

  const voteDeadlineMs = verdictRound.deadline_at ? Date.parse(verdictRound.deadline_at) : Infinity;
  if (now < voteDeadlineMs) return { phase: 'noop' };

  await scoreAndSettle(deps, battle, verdictRound, argRounds);
  return { phase: 'scored_and_settled' };
}

// ---------------------------------------------------------------------------
// Score + settle
// ---------------------------------------------------------------------------

interface ScoringInputs {
  topic: TopicRow | null;
  participants: ParticipantRow[];
  argumentsBySeat: Record<number, string[]>; // [opening, rebuttal, closing]
  votes: VoteRow[];
}

async function scoreAndSettle(
  deps: OpenDebateRunnerDeps,
  battle: BattleRow,
  verdictRound: RoundRow,
  argRounds: RoundRow[],
): Promise<void> {
  const inputs = await gatherScoringInputs(deps.supabase, battle, argRounds);

  // Call the debate_score AI -- one call on the complete exchange.
  const aiVerdict = await callAi(deps, inputs);

  // Tally community votes -- AP-weighted, snapshotted at vote time.
  const tally = tallyCommunityVotes(inputs);

  // Decide. Community AP-weighted vote is decisive unless tied (AI tiebreaker).
  const decision = decide(aiVerdict, tally, inputs.participants);

  const settledAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();

  // Snapshot the AP settlement inputs (apBefore/tier/consecutiveLosses/
  // reductionsUsed for each side) into the verdict payload. This is the
  // determinism guarantee for the resume path: if the worker crashes between
  // the verdict write and markBattleSettled, the resume branch (next tick)
  // reads these frozen values from the persisted payload -- it never queries
  // `users` live. Without the snapshot, a participant who gained AP in a
  // different battle between original scoring and resume would shift the
  // draft computation. Built from `inputs.participants`, which today still
  // joins `users` live for current_ap/tier_id (a separate pre-existing
  // concern about first-pass freshness, out of scope for this fix).
  const settlementInputs = decision.winnerUserId
    ? buildSettlementInputs(inputs.participants, decision)
    : null;

  const verdictPayload = {
    state: 'scored',
    ai: aiVerdict ?? { error: 'ai_unavailable' },
    community: tally,
    disagreement: decision.disagreement,
    decided_by: decision.decidedBy,
    winner_seat: decision.winnerSeat,
    winner_user_id: decision.winnerUserId,
    settled_at: settledAt,
    _settlement_inputs: settlementInputs,
  };

  // Write the verdict row first (transparent record, even if settlement fails).
  await updateRoundPayload(deps.supabase, verdictRound.id, verdictPayload, decision.winnerUserId);

  // Compute AP drafts and apply atomically via apply_ap_drafts (mig 0013).
  // Reads the same snapshot just stamped above so first-pass and resume use
  // identical inputs to settleBattle.
  if (settlementInputs) {
    await applyApSettlementFromSnapshot(deps, battle, settlementInputs);
  }

  // Mark battle settled.
  await markBattleSettled(deps.supabase, battle.id, decision.winnerUserId, settledAt);

  deps.logger.info({
    event: 'open_debate.settled',
    battleId: battle.id,
    decidedBy: decision.decidedBy,
    disagreement: decision.disagreement,
    winnerSeat: decision.winnerSeat,
  });
}

/**
 * Resume an in-flight settlement whose verdict row was already written
 * (`state='scored'`) but whose battle is still `status='live'` -- meaning a
 * prior tick crashed between updateRoundPayload and markBattleSettled.
 *
 * Reads winner/loser + their pre-settlement AP/tier/streak from the verdict
 * payload's `_settlement_inputs` snapshot (stamped by the first pass). NEVER
 * re-calls the AI, NEVER re-tallies votes, NEVER overwrites the verdict row.
 * AP application is safe to re-attempt: `apply_ap_drafts` is idempotent on
 * the (battle, user, reason) idempotency key.
 */
async function resumeSettlement(
  deps: OpenDebateRunnerDeps,
  battle: BattleRow,
  verdictRound: RoundRow,
): Promise<void> {
  const payload = verdictRound.payload ?? {};
  const winnerUserId = (payload.winner_user_id as string | null | undefined) ?? null;
  const settledAt =
    (payload.settled_at as string | undefined) ??
    new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const snapshot = payload._settlement_inputs as SettlementInputsSnapshot | null | undefined;

  const verdictStampMs = payload.settled_at ? Date.parse(payload.settled_at as string) : Number.NaN;
  const sinceVerdictMs = Number.isFinite(verdictStampMs)
    ? (deps.now ? deps.now() : Date.now()) - verdictStampMs
    : null;

  deps.logger.info({
    event: 'open_debate.resumed_settlement',
    battle_id: battle.id,
    settled_at: payload.settled_at ?? null,
    since_verdict_ms: sinceVerdictMs,
    winner_user_id: winnerUserId,
    has_snapshot: snapshot != null,
  });

  // Idempotent re-attempt of step 6. Skipped when there's no winner
  // (unresolved tie + null AI) or no snapshot (verdict written by an older
  // code path before _settlement_inputs existed -- battles in that state
  // still flip to settled; AP just won't auto-recover).
  if (winnerUserId && snapshot) {
    await applyApSettlementFromSnapshot(deps, battle, snapshot);
  }

  await markBattleSettled(deps.supabase, battle.id, winnerUserId, settledAt);
}

async function callAi(
  deps: OpenDebateRunnerDeps,
  inputs: ScoringInputs,
): Promise<AiVerdict | null> {
  const seatA = inputs.argumentsBySeat[0] ?? [];
  const seatB = inputs.argumentsBySeat[1] ?? [];
  const topicLine = inputs.topic
    ? `Topic: ${inputs.topic.headline}${inputs.topic.summary ? `\nSummary: ${inputs.topic.summary}` : ''}`
    : 'Topic: (unspecified)';
  const fmt = (label: string, args: string[]): string =>
    `${label} arguments:\nOpening: ${args[0] ?? '(no submission)'}\nRebuttal: ${args[1] ?? '(no submission)'}\nClosing: ${args[2] ?? '(no submission)'}`;

  const system =
    "You are a Diktat debate scorer. Read both seats' arguments across 3 rounds (opening, rebuttal, closing) and produce a structured verdict. Your score is ADVISORY: the decisive verdict is an AP-weighted community vote. Be transparent in `reason` so a losing side can see why.";
  const user = `${topicLine}\n\n${fmt('Seat 0', seatA)}\n\n${fmt('Seat 1', seatB)}\n\nReturn strict JSON: { winnerSeat: 0|1|null, scoreA: 0..100, scoreB: 0..100, reason: string }.`;

  try {
    const result = await deps.invoke({
      task: 'debate_score',
      system,
      user,
      schema: VerdictSchema,
      env: deps.providerEnv ?? { xaiAvailable: false, perplexityAvailable: false },
      projectedUsd: SCORER_USD_PROJECTION,
      maxTokens: 1024,
    });
    return result.output as AiVerdict;
  } catch (err) {
    deps.logger.warn({
      event: 'open_debate.scorer_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface CommunityTally {
  ap_for_seat_0: number;
  ap_for_seat_1: number;
  voter_count: number;
}

export function tallyCommunityVotes(inputs: ScoringInputs): CommunityTally {
  const seat0User = inputs.participants.find((p) => p.seat === 0)?.user_id;
  const seat1User = inputs.participants.find((p) => p.seat === 1)?.user_id;
  let apForSeat0 = 0;
  let apForSeat1 = 0;
  for (const v of inputs.votes) {
    if (v.vote_for_user_id === seat0User) apForSeat0 += v.ap_at_vote_time;
    else if (v.vote_for_user_id === seat1User) apForSeat1 += v.ap_at_vote_time;
  }
  return { ap_for_seat_0: apForSeat0, ap_for_seat_1: apForSeat1, voter_count: inputs.votes.length };
}

interface Decision {
  winnerSeat: 0 | 1 | null;
  winnerUserId: string | null;
  loserUserId: string | null;
  decidedBy: 'community_ap' | 'ai_tiebreaker' | 'unresolved';
  disagreement: boolean;
}

export function decide(
  ai: AiVerdict | null,
  tally: CommunityTally,
  participants: ParticipantRow[],
): Decision {
  const seat0 = participants.find((p) => p.seat === 0);
  const seat1 = participants.find((p) => p.seat === 1);
  if (!seat0 || !seat1) {
    return {
      winnerSeat: null,
      winnerUserId: null,
      loserUserId: null,
      decidedBy: 'unresolved',
      disagreement: false,
    };
  }

  let winnerSeat: 0 | 1 | null = null;
  let decidedBy: Decision['decidedBy'] = 'unresolved';

  if (tally.ap_for_seat_0 > tally.ap_for_seat_1) {
    winnerSeat = 0;
    decidedBy = 'community_ap';
  } else if (tally.ap_for_seat_1 > tally.ap_for_seat_0) {
    winnerSeat = 1;
    decidedBy = 'community_ap';
  } else {
    // Tie -- AI tiebreaker. Only if AI returned a non-null winner.
    if (ai && ai.winnerSeat !== null) {
      winnerSeat = ai.winnerSeat;
      decidedBy = 'ai_tiebreaker';
    }
    // else: unresolved (rare -- zero votes AND AI couldn't decide).
  }

  const winnerUserId = winnerSeat === 0 ? seat0.user_id : winnerSeat === 1 ? seat1.user_id : null;
  const loserUserId = winnerSeat === 0 ? seat1.user_id : winnerSeat === 1 ? seat0.user_id : null;

  // Disagreement: AI had an opinion AND community decided AND they differ.
  const disagreement =
    decidedBy === 'community_ap' &&
    ai !== null &&
    ai.winnerSeat !== null &&
    ai.winnerSeat !== winnerSeat;

  return { winnerSeat, winnerUserId, loserUserId, decidedBy, disagreement };
}

/**
 * Per-side AP settlement snapshot. Stamped into the verdict payload at
 * first-pass settlement so the resume path replays IDENTICAL inputs to
 * settleBattle without re-querying live `users`.
 */
interface SettlementInputsSnapshot {
  winner: {
    user_id: string;
    ap_before: number;
    tier: number;
  };
  loser: {
    user_id: string;
    ap_before: number;
    tier: number;
    consecutive_losses: number;
    reductions_used: number;
  };
}

function buildSettlementInputs(
  participants: ParticipantRow[],
  decision: Decision,
): SettlementInputsSnapshot | null {
  if (!decision.winnerUserId || !decision.loserUserId) return null;
  const winner = participants.find((p) => p.user_id === decision.winnerUserId);
  const loser = participants.find((p) => p.user_id === decision.loserUserId);
  if (!winner || !loser) return null;
  return {
    winner: {
      user_id: winner.user_id,
      ap_before: winner.current_ap,
      tier: winner.tier_id,
    },
    loser: {
      user_id: loser.user_id,
      ap_before: loser.current_ap,
      tier: loser.tier_id,
      consecutive_losses: loser.consecutive_losses,
      reductions_used: loser.reductions_used,
    },
  };
}

async function applyApSettlementFromSnapshot(
  deps: OpenDebateRunnerDeps,
  battle: BattleRow,
  snapshot: SettlementInputsSnapshot,
): Promise<void> {
  // Use the ap-engine's settleBattle helper -- handles loss-streak protection
  // and tier floor in one shot and emits properly-shaped drafts. Open debate
  // is never a practice match (bot fallback is OFF for open_debate), so
  // isPractice = false. Inputs come from the verdict payload's frozen
  // snapshot -- never from a fresh users-live join -- so first-pass and
  // resume produce byte-identical drafts (same idempotency keys, same
  // deltas), and apply_ap_drafts safely no-ops on re-attempt.
  const drafts = settleBattle({
    battleId: toBattleId(battle.id),
    mode: battle.mode,
    status: 'settled',
    isPractice: false,
    winner: {
      userId: toUserId(snapshot.winner.user_id),
      apBefore: snapshot.winner.ap_before,
      tier: snapshot.winner.tier as Tier,
    },
    loser: {
      userId: toUserId(snapshot.loser.user_id),
      apBefore: snapshot.loser.ap_before,
      tier: snapshot.loser.tier as Tier,
      consecutiveLosses: snapshot.loser.consecutive_losses,
      reductionsUsed: snapshot.loser.reductions_used,
    },
  });

  const apply = deps.applyDraftsFn ?? applyDrafts;
  await apply(deps.supabase as never, drafts);
}

// ---------------------------------------------------------------------------
// Supabase helpers (untyped, mirror trivia battle-runner conventions)
// ---------------------------------------------------------------------------

async function fetchBattle(supabase: ServiceClient, battleId: string): Promise<BattleRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('battles')
    .select('id, mode, status, topic_id, started_at, ap_pot')
    .eq('id', battleId)
    .maybeSingle()) as { data: BattleRow | null; error: { message: string } | null };
  if (error) throw new Error(`fetchBattle: ${error.message}`);
  return data;
}

async function fetchRounds(supabase: ServiceClient, battleId: string): Promise<RoundRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('battle_rounds')
    .select('id, round_no, payload, deadline_at, winner_user_id')
    .eq('battle_id', battleId)
    .order('round_no')) as { data: RoundRow[] | null; error: { message: string } | null };
  if (error) throw new Error(`fetchRounds: ${error.message}`);
  return data ?? [];
}

async function fetchArguments(supabase: ServiceClient, roundId: string): Promise<ArgumentRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('debate_arguments')
    .select('round_id, user_id, text')
    .eq('round_id', roundId)) as { data: ArgumentRow[] | null; error: { message: string } | null };
  if (error) throw new Error(`fetchArguments: ${error.message}`);
  return data ?? [];
}

async function fetchParticipants(
  supabase: ServiceClient,
  battleId: string,
): Promise<ParticipantRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('battle_participants')
    .select('user_id, seat, users(current_ap, tier_id)')
    .eq('battle_id', battleId)) as {
    data:
      | {
          user_id: string;
          seat: number;
          users: { current_ap: number; tier_id: number } | null;
        }[]
      | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`fetchParticipants: ${error.message}`);
  return (data ?? []).map((row) => ({
    user_id: row.user_id,
    seat: row.seat,
    current_ap: row.users?.current_ap ?? 0,
    tier_id: row.users?.tier_id ?? 0,
    consecutive_losses: 0,
    reductions_used: 0,
  }));
}

async function fetchVotes(supabase: ServiceClient, battleId: string): Promise<VoteRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('debate_votes')
    .select('voter_user_id, vote_for_user_id, ap_at_vote_time')
    .eq('battle_id', battleId)) as {
    data: VoteRow[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`fetchVotes: ${error.message}`);
  return data ?? [];
}

async function fetchTopic(
  supabase: ServiceClient,
  topicId: string | null,
): Promise<TopicRow | null> {
  if (!topicId) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('news_topics')
    .select('id, headline, summary')
    .eq('id', topicId)
    .maybeSingle()) as { data: TopicRow | null; error: { message: string } | null };
  if (error) throw new Error(`fetchTopic: ${error.message}`);
  return data;
}

async function gatherScoringInputs(
  supabase: ServiceClient,
  battle: BattleRow,
  argRounds: RoundRow[],
): Promise<ScoringInputs> {
  const [participants, votes, topic] = await Promise.all([
    fetchParticipants(supabase, battle.id),
    fetchVotes(supabase, battle.id),
    fetchTopic(supabase, battle.topic_id),
  ]);

  const argumentsBySeat: Record<number, string[]> = { 0: ['', '', ''], 1: ['', '', ''] };
  for (const round of argRounds) {
    const args = await fetchArguments(supabase, round.id);
    for (const a of args) {
      const seat = participants.find((p) => p.user_id === a.user_id)?.seat;
      if (seat === 0 || seat === 1) {
        argumentsBySeat[seat]![round.round_no] = a.text;
      }
    }
  }

  return { topic, participants, argumentsBySeat, votes };
}

async function createArgumentRound(
  supabase: ServiceClient,
  battleId: string,
  roundNo: number,
  deadlineIso: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (supabase as any).from('battle_rounds').insert({
    battle_id: battleId,
    round_no: roundNo,
    deadline_at: deadlineIso,
    payload: { state: 'awaiting_arguments' },
  })) as { error: { message: string } | null };
  if (error) throw new Error(`createArgumentRound: ${error.message}`);
}

async function createVerdictRound(
  supabase: ServiceClient,
  battleId: string,
  deadlineIso: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (supabase as any).from('battle_rounds').insert({
    battle_id: battleId,
    round_no: ROUND_COUNT,
    deadline_at: deadlineIso,
    payload: { state: 'awaiting_final_vote' },
  })) as { error: { message: string } | null };
  if (error) throw new Error(`createVerdictRound: ${error.message}`);
}

async function revealRound(
  supabase: ServiceClient,
  round: RoundRow,
  reveal: {
    revealed_at: string;
    revealed_by: 'both_submitted' | 'deadline';
    forfeit_seats: number[];
  },
): Promise<void> {
  const newPayload = { ...round.payload, state: 'revealed', ...reveal };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (supabase as any)
    .from('battle_rounds')
    .update({ payload: newPayload })
    .eq('id', round.id)) as { error: { message: string } | null };
  if (error) throw new Error(`revealRound: ${error.message}`);
}

async function updateRoundPayload(
  supabase: ServiceClient,
  roundId: string,
  payload: Record<string, unknown>,
  winnerUserId: string | null,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (supabase as any)
    .from('battle_rounds')
    .update({ payload, winner_user_id: winnerUserId })
    .eq('id', roundId)) as { error: { message: string } | null };
  if (error) throw new Error(`updateRoundPayload: ${error.message}`);
}

async function markBattleSettled(
  supabase: ServiceClient,
  battleId: string,
  winnerUserId: string | null,
  settledAtIso: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (supabase as any)
    .from('battles')
    .update({ status: 'settled', winner_user_id: winnerUserId, ended_at: settledAtIso })
    .eq('id', battleId)) as { error: { message: string } | null };
  if (error) throw new Error(`markBattleSettled: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deadlineAt(nowMs: number, windowMs: number): string {
  return new Date(nowMs + windowMs).toISOString();
}

export const __testing = {
  VerdictSchema,
  tallyCommunityVotes,
  decide,
  ARG_WINDOW_MS,
  VOTE_WINDOW_MS,
  ROUND_COUNT,
};
