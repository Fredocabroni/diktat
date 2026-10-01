// Structured logger for workers. Pino in production, JSON-lines to stdout.
// Tests can pass a no-op compatible shape via the `Logger` type below.
//
// SINK-LEVEL SCRUBBING (closes #146):
//
// Every argument passed to logger.{info,warn,error,debug} is piped
// through scrubLogPayload / scrubMessage BEFORE pino sees it. One pass,
// at the sink, covers every call site in the workers src tree —
// including future ones added by anyone, including unscrubbed Supabase
// SDK `error.message` fields, Postgres connection errors with
// DATABASE_URL in the libpq keyword form, Error.stack strings, nested
// causes, etc. Any new log line is scrubbed for free.
//
// The per-call-site `scrubMessage(error.message)` wraps already in the
// codebase stay in place as defense-in-depth: scrubbing a
// scrubbed string is idempotent (regex replace misses on already-
// redacted text), and if anyone ever bypasses this logger (e.g.
// console.log for debug), the extraction-site wrap still catches it.
// The static-scan test in __tests__/scrub-at-extraction.test.ts is
// kept as a backstop.

import { pino } from 'pino';

import { scrubLogPayload, scrubMessage } from '@diktat/shared/alerts';

import type { Env } from './env.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export function buildLogger(env: Env): Logger {
  const p = pino({
    level: env.LOG_LEVEL,
    base: { service: 'diktat-workers' },
  });
  return wrapWithScrub(p);
}

/**
 * Wrap a pino instance (or any Logger-shaped sink) so every call pipes
 * its args through the shared scrubber. Exported for test wiring —
 * production always builds through `buildLogger`.
 *
 * The wrap preserves pino's two-arg shape: logger.X(obj, msg?). Both
 * are scrubbed; the obj recursively (strings + nested Errors), the
 * msg string directly. If msg is undefined we don't invent a '' arg
 * since pino treats absent-msg and empty-string differently.
 */
export function wrapWithScrub(sink: Logger): Logger {
  return {
    info(obj, msg) {
      const scrubbedObj = scrubLogPayload(obj);
      if (msg === undefined) sink.info(scrubbedObj as object);
      else sink.info(scrubbedObj as object, scrubMessage(msg));
    },
    warn(obj, msg) {
      const scrubbedObj = scrubLogPayload(obj);
      if (msg === undefined) sink.warn(scrubbedObj as object);
      else sink.warn(scrubbedObj as object, scrubMessage(msg));
    },
    error(obj, msg) {
      const scrubbedObj = scrubLogPayload(obj);
      if (msg === undefined) sink.error(scrubbedObj as object);
      else sink.error(scrubbedObj as object, scrubMessage(msg));
    },
    debug(obj, msg) {
      const scrubbedObj = scrubLogPayload(obj);
      if (msg === undefined) sink.debug(scrubbedObj as object);
      else sink.debug(scrubbedObj as object, scrubMessage(msg));
    },
  };
}
