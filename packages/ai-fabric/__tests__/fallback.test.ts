import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@diktat/shared';
import { __setAdapterForTests, invoke } from '../src/fabric.js';
import { __resetLedgerForTests } from '../src/cost.js';
import type { ProviderEnv } from '../src/types.js';

const ENV: ProviderEnv = { xaiAvailable: true, perplexityAvailable: true };

const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length) restorers.pop()?.();
  __resetLedgerForTests();
});

function fakeOk(usd = 0.001, output = 'ok') {
  return {
    invoke: vi.fn(async () => ({ output, usd, latencyMs: 7 })),
  };
}

function fakeFail(message = 'boom', status?: number) {
  return {
    invoke: vi.fn(async () => {
      const err = new Error(message) as Error & { status?: number };
      if (status !== undefined) err.status = status;
      throw err;
    }),
  };
}

describe('fabric — fallback chain', () => {
  it('uses primary on first success', async () => {
    const primary = fakeOk(0.002, 'primary-output');
    const fb = fakeOk(0.005, 'fallback-output');
    restorers.push(__setAdapterForTests('anthropic', primary));
    restorers.push(__setAdapterForTests('google', fb));

    const result = await invoke({
      task: 'debate_score',
      system: 'judge',
      user: 'argument',
      env: ENV,
    });

    expect(result.provider).toBe('anthropic');
    expect(result.output).toBe('primary-output');
    expect(primary.invoke).toHaveBeenCalledOnce();
    expect(fb.invoke).not.toHaveBeenCalled();
  });

  it('advances to fallback when primary throws non-retryable', async () => {
    const primary = fakeFail('primary down', 400);
    const fb = fakeOk(0.001, 'rescued');
    restorers.push(__setAdapterForTests('anthropic', primary));
    restorers.push(__setAdapterForTests('google', fb));

    const result = await invoke({
      task: 'debate_score',
      system: 's',
      user: 'u',
      env: ENV,
    });

    expect(result.provider).toBe('google');
    expect(result.output).toBe('rescued');
    expect(primary.invoke).toHaveBeenCalledOnce();
    expect(fb.invoke).toHaveBeenCalledOnce();
  });

  it('throws ProviderError when every link fails', async () => {
    const primary = fakeFail('primary down', 400);
    const fb = fakeFail('fallback down', 400);
    restorers.push(__setAdapterForTests('anthropic', primary));
    restorers.push(__setAdapterForTests('google', fb));

    await expect(
      invoke({ task: 'debate_score', system: 's', user: 'u', env: ENV }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('records spend only on the successful link', async () => {
    const primary = fakeFail('primary down', 400);
    const fb = fakeOk(0.123, 'ok');
    restorers.push(__setAdapterForTests('anthropic', primary));
    restorers.push(__setAdapterForTests('google', fb));

    const result = await invoke({
      task: 'debate_score',
      system: 's',
      user: 'u',
      env: ENV,
    });

    expect(result.usd).toBe(0.123);
  });
});
