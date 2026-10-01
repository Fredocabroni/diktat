// Sink-level scrubbing: every call to the wrapped logger pipes its
// obj + msg through scrubLogPayload + scrubMessage BEFORE pino sees
// them. One pass at the sink covers every call site in the workers
// src tree — including unscrubbed Supabase-SDK `error.message`,
// nested .cause chains, and anything a future call site adds.
//
// These tests fake the pino sink with a recorder so the assertions
// run against the exact object the real pino would receive, byte-
// identical. No `pino` call is actually made.

import { describe, expect, it } from 'vitest';

import { wrapWithScrub, type Logger } from '../src/logger.js';

interface Call {
  readonly level: 'info' | 'warn' | 'error' | 'debug';
  readonly obj: unknown;
  readonly msg?: string;
}

function recordingSink(): Logger & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    info(obj, msg) {
      calls.push({ level: 'info', obj, msg });
    },
    warn(obj, msg) {
      calls.push({ level: 'warn', obj, msg });
    },
    error(obj, msg) {
      calls.push({ level: 'error', obj, msg });
    },
    debug(obj, msg) {
      calls.push({ level: 'debug', obj, msg });
    },
    calls,
  };
}

describe('wrapWithScrub (sink-level scrub)', () => {
  it('scrubs a top-level `message` string carrying a DSN', () => {
    const sink = recordingSink();
    const logger = wrapWithScrub(sink);

    logger.error({
      event: 'db.query_failed',
      message:
        'ECONNREFUSED postgres://alice:s3cret@db.internal:5432/prod host=db.internal token=t_abc',
    });

    const recorded = sink.calls[0]!.obj as { event: string; message: string };
    expect(recorded.event).toBe('db.query_failed');
    expect(recorded.message).not.toContain('s3cret');
    expect(recorded.message).not.toContain('t_abc');
    expect(recorded.message).not.toContain('db.internal');
    expect(recorded.message).toContain('<url-redacted>');
    expect(recorded.message).toContain('host=<redacted>');
    expect(recorded.message).toContain('token=<redacted>');
  });

  it('scrubs msg argument (pino two-arg shape)', () => {
    const sink = recordingSink();
    const logger = wrapWithScrub(sink);

    logger.info({ event: 'x' }, 'connect failed to postgres://u:p@h/d');

    expect(sink.calls[0]!.msg).toContain('<url-redacted>');
    expect(sink.calls[0]!.msg).not.toContain('u:p@h');
  });

  it('omits msg argument entirely when absent (pino treats undefined vs empty-string differently)', () => {
    const sink = recordingSink();
    const logger = wrapWithScrub(sink);

    logger.info({ event: 'tick' });

    // The recorded msg must be undefined, NOT the empty string — pino's
    // formatter emits a different output shape for the two.
    expect(sink.calls[0]!.msg).toBeUndefined();
  });

  it('scrubs an Error.message + Error.stack passed as a payload field', () => {
    const sink = recordingSink();
    const logger = wrapWithScrub(sink);

    const err = new Error('connection refused to postgres://u:pw@host.example:5432/db password=pw');
    // Force a predictable stack prefix so the assertion is deterministic.
    err.stack = `Error: connection refused to postgres://u:pw@host.example:5432/db password=pw
    at pg.Client.connect (/node_modules/pg/lib/client.js:1:1)`;

    logger.error({ event: 'pg.connect_failed', err });

    const recorded = sink.calls[0]!.obj as {
      event: string;
      err: { name: string; message: string; stack: string };
    };
    expect(recorded.err.name).toBe('Error');
    expect(recorded.err.message).toContain('<url-redacted>');
    expect(recorded.err.message).toContain('password=<redacted>');
    expect(recorded.err.message).not.toContain('pw@host');

    expect(recorded.err.stack).toContain('<url-redacted>');
    expect(recorded.err.stack).toContain('password=<redacted>');
    expect(recorded.err.stack).not.toContain('pw@host');
    // Non-sensitive stack lines are preserved.
    expect(recorded.err.stack).toContain('pg.Client.connect');
  });

  it('walks nested .cause chain', () => {
    const sink = recordingSink();
    const logger = wrapWithScrub(sink);

    const root = new Error('innermost token=t_abc');
    const mid = new Error('mid-wrap');
    (mid as { cause?: unknown }).cause = root;
    const outer = new Error('outer wrap');
    (outer as { cause?: unknown }).cause = mid;

    logger.error({ err: outer });

    const recorded = sink.calls[0]!.obj as {
      err: { message: string; cause?: { message: string; cause?: { message: string } } };
    };
    expect(recorded.err.message).toBe('outer wrap');
    expect(recorded.err.cause!.message).toBe('mid-wrap');
    expect(recorded.err.cause!.cause!.message).toContain('token=<redacted>');
    expect(recorded.err.cause!.cause!.message).not.toContain('t_abc');
  });

  it('is cycle-safe (self-referential .cause does not stack-overflow)', () => {
    const sink = recordingSink();
    const logger = wrapWithScrub(sink);

    const loop = new Error('loop host=secret.local');
    (loop as { cause?: unknown }).cause = loop;

    expect(() => logger.error({ err: loop })).not.toThrow();
    const recorded = sink.calls[0]!.obj as { err: { message: string } };
    expect(recorded.err.message).toContain('host=<redacted>');
  });

  it('passes primitives through unchanged', () => {
    const sink = recordingSink();
    const logger = wrapWithScrub(sink);

    logger.info({ count: 42, flag: true, ratio: 3.14, missing: null, undef: undefined });

    expect(sink.calls[0]!.obj).toEqual({
      count: 42,
      flag: true,
      ratio: 3.14,
      missing: null,
      undef: undefined,
    });
  });

  it('scrubs strings inside arrays (not just top-level fields)', () => {
    const sink = recordingSink();
    const logger = wrapWithScrub(sink);

    logger.warn({
      event: 'batch_failed',
      urls: ['postgres://a:b@h/d', 'redis://user:pw@cache/0', 'https://safe.example.com/path'],
    });

    const recorded = sink.calls[0]!.obj as { urls: string[] };
    expect(recorded.urls[0]).toBe('<url-redacted>');
    expect(recorded.urls[1]).toBe('<url-redacted>');
    expect(recorded.urls[2]).toBe('<url-redacted>');
  });
});
