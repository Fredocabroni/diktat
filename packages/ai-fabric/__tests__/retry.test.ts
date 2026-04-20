import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/retry.js';

function httpErr(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('retry — retryable conditions', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('429 then success → resolves after one retry', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw httpErr(429, 'rate limited');
      return 'after-retry';
    });
    await expect(withRetry(fn, { baseMs: 1 })).resolves.toBe('after-retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('500 then success → resolves after one retry', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw httpErr(500);
      return 'recovered';
    });
    await expect(withRetry(fn, { baseMs: 1 })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('4×500 → exhausts attempts and surfaces the last error', async () => {
    const fn = vi.fn(async () => {
      throw httpErr(503);
    });
    await expect(withRetry(fn, { maxAttempts: 4, baseMs: 1 })).rejects.toMatchObject({
      message: 'HTTP 503',
    });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('400 (non-retryable) → surfaces immediately, no retries', async () => {
    const fn = vi.fn(async () => {
      throw httpErr(400);
    });
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toMatchObject({ message: 'HTTP 400' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('401 (non-retryable) → surfaces immediately', async () => {
    const fn = vi.fn(async () => {
      throw httpErr(401);
    });
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toMatchObject({ message: 'HTTP 401' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('network error (ECONNRESET cause) is retryable', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('fetch failed') as Error & { cause: { code: string } };
        err.cause = { code: 'ECONNRESET' };
        throw err;
      }
      return 'recovered';
    });
    await expect(withRetry(fn, { baseMs: 1 })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
