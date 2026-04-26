// Structured logger for workers. Pino in production, JSON-lines to stdout.
// Tests can pass a no-op compatible shape via the `Logger` type below.

import { pino } from 'pino';

import type { Env } from './env.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export function buildLogger(env: Env): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: 'diktat-workers' },
  });
}
