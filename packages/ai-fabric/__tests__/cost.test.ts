import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError } from '@diktat/shared';
import {
  ALERT_AT_USD,
  GLOBAL_CAP_USD,
  PER_TASK_CAPS_USD,
  __resetLedgerForTests,
  assertUnderCap,
  getDailySpend,
  recordSpend,
  resetIfNewUtcDay,
} from '../src/cost.js';
import type { LogPayload } from '../src/types.js';

beforeEach(() => {
  __resetLedgerForTests();
});

afterEach(() => {
  __resetLedgerForTests();
});

describe('cost — caps', () => {
  it('per-task caps sum to the global ceiling exactly', () => {
    const sum = Object.values(PER_TASK_CAPS_USD).reduce((a, b) => a + b, 0);
    expect(sum).toBe(GLOBAL_CAP_USD);
    expect(GLOBAL_CAP_USD).toBe(30);
  });

  it('assertUnderCap allows spend under per-task cap', () => {
    expect(() => assertUnderCap('code_gen', PER_TASK_CAPS_USD.code_gen)).not.toThrow();
  });

  it('assertUnderCap throws BudgetExceededError when per-task cap would be exceeded', () => {
    recordSpend('code_gen', PER_TASK_CAPS_USD.code_gen);
    expect(() => assertUnderCap('code_gen', 0.0001)).toThrow(BudgetExceededError);
  });

  it('assertUnderCap throws BudgetExceededError when global cap would be exceeded', () => {
    recordSpend('code_gen', PER_TASK_CAPS_USD.code_gen);
    recordSpend('debate_score', PER_TASK_CAPS_USD.debate_score);
    recordSpend('sourced_factcheck', PER_TASK_CAPS_USD.sourced_factcheck);
    recordSpend('live_factcheck', PER_TASK_CAPS_USD.live_factcheck);
    recordSpend('trivia_gen', PER_TASK_CAPS_USD.trivia_gen);
    recordSpend('news_rank', PER_TASK_CAPS_USD.news_rank);
    recordSpend('clip_gen', PER_TASK_CAPS_USD.clip_gen);
    recordSpend('x_post', PER_TASK_CAPS_USD.x_post);
    recordSpend('fingerprint', PER_TASK_CAPS_USD.fingerprint);
    expect(getDailySpend().total).toBe(GLOBAL_CAP_USD);
    expect(() => assertUnderCap('code_gen', 0.5)).toThrow(BudgetExceededError);
  });
});

describe('cost — alert hook fires at $22 threshold once per day', () => {
  it('emits a warn-level [budget-alert] log when total reaches $22', () => {
    const sink = vi.fn<(p: LogPayload) => void>();
    recordSpend('code_gen', 8, { sink });
    recordSpend('debate_score', 5, { sink });
    recordSpend('sourced_factcheck', 4, { sink });
    expect(sink).not.toHaveBeenCalled();
    recordSpend('live_factcheck', 4, { sink });
    recordSpend('trivia_gen', 1, { sink });
    expect(sink).toHaveBeenCalledTimes(1);
    const payload = sink.mock.calls[0]![0]!;
    expect(payload.level).toBe('warn');
    expect(payload.message).toMatch(/budget-alert/);
    expect(payload.usd).toBeGreaterThanOrEqual(ALERT_AT_USD);
  });

  it('does not re-fire on subsequent recordSpend calls within the same UTC day', () => {
    const sink = vi.fn<(p: LogPayload) => void>();
    recordSpend('code_gen', 8, { sink });
    recordSpend('debate_score', 5, { sink });
    recordSpend('sourced_factcheck', 4, { sink });
    recordSpend('live_factcheck', 4, { sink });
    recordSpend('trivia_gen', 1, { sink });
    recordSpend('news_rank', 0.5, { sink });
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe('cost — UTC day rollover resets the ledger', () => {
  it('clears total + byTask when crossing midnight UTC', () => {
    const today = new Date('2026-04-20T23:00:00Z');
    recordSpend('code_gen', 5, { now: today });
    expect(getDailySpend().total).toBe(5);

    const tomorrow = new Date('2026-04-21T01:00:00Z');
    resetIfNewUtcDay(tomorrow);
    expect(getDailySpend().total).toBe(0);
    expect(getDailySpend().byTask.code_gen).toBe(0);
    expect(getDailySpend().utcDay).toBe('2026-04-21');
  });
});
