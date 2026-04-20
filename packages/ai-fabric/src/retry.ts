interface RetryOpts {
  maxAttempts?: number;
  baseMs?: number;
}

/** Network-error indicator. fetch/undici throw `TypeError: fetch failed`
 * with cause.code in the ECONNRESET / EAI_AGAIN family. */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  if (/fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(err.message)) return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
    return /^(ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)/i.test(cause.code);
  }
  return false;
}

/** Pull HTTP status off the error in either `status` or `statusCode` form. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: number; statusCode?: number };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return undefined;
}

function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }
  return isNetworkError(err);
}

/** Sleep helper exposed for tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential-backoff retry. Defaults: 4 attempts, base 250ms.
 * Retries 429 / 5xx / network errors only. Non-retryable errors (4xx other
 * than 429) surface immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseMs = opts.baseMs ?? 250;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) {
        throw err;
      }
      const delay = baseMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
  // Unreachable, but TS needs it.
  throw lastErr;
}
