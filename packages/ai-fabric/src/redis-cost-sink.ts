// Cost-ledger sink that mirrors per-task and total spend into Upstash
// Redis via REST. Caller wires it to `setCostSink(...)` once at boot.
//
// Strategy
// --------
// In-memory `cost.ts` ledger remains the *authoritative* gate for
// `assertUnderCap` — caps fail fast without a network roundtrip. The
// Redis sink is a *fire-and-forget observability layer* that lets
// multiple processes (workers, api, future) each write into the same
// daily counters and read the aggregate at boot via
// `hydrateLedgerFromSink()`.
//
// This is deliberately eventually-consistent. The `$30/day` cap is a
// soft alert, not a money flow. Strict cross-process enforcement
// would require all `recordSpend` callers to await Redis on every
// invocation — measurable latency for marginal correctness. Phase 4
// can revisit if cost discipline tightens.

import type { Task } from './types.js';

export interface CostSink {
  recordSpend(utcDay: string, task: Task, usd: number): Promise<void>;
  loadDailySpend(utcDay: string): Promise<{
    byTask: Partial<Record<Task, number>>;
    total: number;
  }>;
}

/**
 * Subset of `@upstash/redis` we depend on. Lets tests substitute a
 * fake without pulling the real SDK or a live Redis.
 */
export interface UpstashLike {
  incrbyfloat(key: string, increment: number): Promise<string | number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get<T = unknown>(key: string): Promise<T | null>;
}

const SECONDS_PER_DAY = 86_400;
const TTL_SECONDS = 2 * SECONDS_PER_DAY;

const ALL_TASKS: readonly Task[] = [
  'code_gen',
  'trivia_gen',
  'live_factcheck',
  'sourced_factcheck',
  'debate_score',
  'news_rank',
  'clip_gen',
  'x_post',
  'fingerprint',
];

function totalKey(utcDay: string): string {
  return `ai_cost:${utcDay}:total`;
}

function taskKey(utcDay: string, task: Task): string {
  return `ai_cost:${utcDay}:task:${task}`;
}

function parseFloatish(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const parsed = Number.parseFloat(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildUpstashCostSink(client: UpstashLike): CostSink {
  return {
    async recordSpend(utcDay, task, usd) {
      if (usd <= 0) return;
      const tKey = totalKey(utcDay);
      const sKey = taskKey(utcDay, task);
      // Two atomic increments + two TTL refreshes. Order doesn't matter
      // since each key has its own counter and the ledger is
      // commutative.
      await Promise.all([client.incrbyfloat(tKey, usd), client.incrbyfloat(sKey, usd)]);
      await Promise.all([client.expire(tKey, TTL_SECONDS), client.expire(sKey, TTL_SECONDS)]);
    },
    async loadDailySpend(utcDay) {
      const totalRaw = await client.get(totalKey(utcDay));
      const total = parseFloatish(totalRaw);
      const taskRaws = await Promise.all(ALL_TASKS.map((t) => client.get(taskKey(utcDay, t))));
      const byTask: Partial<Record<Task, number>> = {};
      ALL_TASKS.forEach((t, i) => {
        const v = parseFloatish(taskRaws[i]);
        if (v > 0) byTask[t] = v;
      });
      return { byTask, total };
    },
  };
}
