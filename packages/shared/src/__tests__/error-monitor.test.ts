import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError, scrubPii } from '../error-monitor.js';

describe('scrubPii', () => {
  it('redacts email addresses', () => {
    expect(scrubPii('user alice@example.com failed')).toBe('user <email-redacted> failed');
  });

  it('redacts IPv4 literals', () => {
    expect(scrubPii('request from 10.0.0.42 refused')).toBe('request from <ip-redacted> refused');
  });

  it('still redacts credential-pair + URI shapes via scrubMessage', () => {
    expect(scrubPii('conn failed: postgres://u:p@h:5432/db — bye')).toContain('<url-redacted>');
  });

  it('leaves plain prose and version strings alone', () => {
    const msg = 'parse error at line 42 (v1.2.3)';
    expect(scrubPii(msg)).toBe(msg);
  });
});

describe('reportError', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {
      // swallow
    });
  });

  afterEach(() => {
    spy.mockRestore();
    delete process.env.SENTRY_DSN;
  });

  it('scrubs an Error message + stack before logging', () => {
    const err = new Error('login failed for bob@example.com from 8.8.8.8');
    reportError(err, { userId: 'u1' });
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0]![1] as {
      err: { message: string; stack?: string };
    };
    expect(payload.err.message).not.toContain('bob@example.com');
    expect(payload.err.message).not.toContain('8.8.8.8');
    expect(payload.err.message).toContain('<email-redacted>');
    expect(payload.err.message).toContain('<ip-redacted>');
  });

  it('stamps sink=console-only when SENTRY_DSN is unset', () => {
    reportError(new Error('x'));
    const payload = spy.mock.calls[0]![1] as { sink: string };
    expect(payload.sink).toBe('console-only');
  });

  it('stamps sink=sentry-stub when SENTRY_DSN is set but does not leak the DSN', () => {
    process.env.SENTRY_DSN = 'https://abcd@o1.ingest.sentry.io/1234';
    reportError(new Error('x'));
    const call = spy.mock.calls[0]!;
    const payload = call[1] as { sink: string };
    expect(payload.sink).toBe('sentry-stub');
    expect(JSON.stringify(call)).not.toContain('abcd');
    expect(JSON.stringify(call)).not.toContain('ingest.sentry.io');
  });

  it('never throws even on a weird input shape', () => {
    expect(() => reportError({ some: 'unknown', shape: 42 })).not.toThrow();
    const weird: { self?: unknown } = {};
    weird.self = weird;
    expect(() => reportError(weird)).not.toThrow();
  });
});
