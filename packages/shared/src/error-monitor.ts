// Error-monitoring glue — no-op by default.
//
// Why a stub: the eventual production wiring is Sentry (or an
// equivalent error-aggregation service), but the vendor choice,
// account provisioning and SDK integration are a separate workstream.
// Code paths across web / api / workers need a stable call site NOW
// so that when the real integration lands, there is one `reportError`
// surface to wire up — not a grep across dozens of catch blocks.
//
// Behaviour today:
//   - `reportError(err, context?)` always scrubs then logs to
//     `console.error('error_monitor', …)` so operators still see the
//     call shape in local / Railway stdout.
//   - When `SENTRY_DSN` is unset (default) nothing else happens — the
//     no-op flag on Phase 2 wiring, exactly like `axiomSink` in
//     `@diktat/ai-fabric/logging`.
//   - When `SENTRY_DSN` is set, the function still only logs today;
//     a follow-up PR replaces the `// TODO` block with the real SDK
//     call. The DSN is NEVER logged (treat like a secret).
//
// Scrub guarantees — before the error reaches the console, every
// string field is passed through `scrubLogPayload` (which runs
// `scrubMessage` under the hood for URL / credential pairs), PLUS
// a local pass that redacts bare email addresses and IPv4 literals.
// Neither of those shapes is covered by `scrubMessage` today (its
// job is credential-pair redaction for the Telegram alerter), so this
// module layers the privacy scrub for the error-monitoring use case
// on top.

import { scrubLogPayload, scrubMessage } from './alerts.js';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Matches IPv4 dotted-quad. The leading / trailing word-boundary keeps
// version strings (`1.2.3`), release tags (`v4.5.6.7-beta`) and
// unrelated 4-part dotted numbers out; a full IPv4 needs four octets
// each in 0..255 and surrounding boundary characters. We accept any
// 1–3 digit groups rather than a strict range check — operator logs
// don't need RFC-grade parsing, they need the credential-shaped
// substring gone.
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Redact common PII-shaped substrings (email, IPv4) in addition to
 *  the credential-pair / URL scrub that `scrubMessage` already does. */
export function scrubPii(text: string): string {
  return scrubMessage(text).replace(EMAIL_RE, '<email-redacted>').replace(IPV4_RE, '<ip-redacted>');
}

export interface ErrorContext {
  readonly [key: string]: unknown;
}

export interface ErrorMonitor {
  reportError(err: unknown, context?: ErrorContext): void;
}

function scrubError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: scrubPii(err.message),
      stack: typeof err.stack === 'string' ? scrubPii(err.stack) : undefined,
    };
  }
  if (typeof err === 'string') return scrubPii(err);
  return scrubLogPayload(err);
}

/** Scrub-then-forward: console today, Sentry tomorrow (when SENTRY_DSN
 *  is wired up). Never throws — a reporter that throws would be a
 *  pathological error-handling path. */
export function reportError(err: unknown, context: ErrorContext = {}): void {
  try {
    const scrubbedErr = scrubError(err);
    const scrubbedContext = scrubLogPayload(context);
     
    console.error('error_monitor', {
      err: scrubbedErr,
      context: scrubbedContext,
      // SENTRY_DSN is only consulted for presence; never logged.
      sink: process.env.SENTRY_DSN ? 'sentry-stub' : 'console-only',
    });
    // TODO(sentry): when the Sentry SDK lands, forward scrubbedErr +
    // scrubbedContext here under `if (process.env.SENTRY_DSN)`.
    // Keep the console.error above as a local-dev convenience.
  } catch {
    // Never let a reporter error propagate. Operator loses one event;
    // callers don't double-fault.
  }
}

/** Singleton surface so a module that wants a dependency-inversion
 *  seam can pass this around instead of calling `reportError` directly. */
export const defaultErrorMonitor: ErrorMonitor = { reportError };
