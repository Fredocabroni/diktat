import type { LogPayload, LogSink } from './types.js';

/**
 * Default sink: console JSON line.
 *
 * Uses console.warn/error for level-appropriate streams so log routers
 * (Vercel, Railway) classify them correctly.
 */
export const consoleSink: LogSink = (payload: LogPayload): void => {
  const line = JSON.stringify(payload);
  if (payload.level === 'error') {
    console.error(line);
  } else if (payload.level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
};

/**
 * Axiom sink stub.
 *
 * Phase 1: forward to console with an `[axiom-pending]` prefix when
 * `AXIOM_TOKEN` and `AXIOM_DATASET` are set. Real HTTP ingest lands in
 * Phase 2 (see CLAUDE.md ## TODOs).
 */
export const axiomSink: LogSink = (payload: LogPayload): void => {
  const tokenPresent = Boolean(process.env.AXIOM_TOKEN);
  const datasetPresent = Boolean(process.env.AXIOM_DATASET);
  if (!tokenPresent || !datasetPresent) {
    consoleSink(payload);
    return;
  }
  const wrapped: LogPayload = {
    ...payload,
    message: `[axiom-pending] ${payload.message ?? ''}`.trim(),
  };
  consoleSink(wrapped);
};

/**
 * Pick the configured default sink at runtime. Defaults to `consoleSink`
 * unless Axiom env vars are present (in which case `axiomSink` is used,
 * still backed by the console stub this phase).
 */
export function defaultSink(): LogSink {
  if (process.env.AXIOM_TOKEN && process.env.AXIOM_DATASET) return axiomSink;
  return consoleSink;
}

/** Emit a single log payload to the chosen sink. */
export function logCall(payload: LogPayload, sink: LogSink = defaultSink()): void {
  sink(payload);
}
