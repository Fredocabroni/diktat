// Issue #146 — scrub-at-sink + backstop static scan.
//
// Primary gate: `apps/workers/src/logger.ts` wraps pino with
// `wrapWithScrub`, which pipes every call's obj + msg through
// `scrubLogPayload` + `scrubMessage` before pino sees them. One
// pass at the sink covers every call site, including unscrubbed
// Supabase-SDK `error.message` fields, Error.stack, nested .cause
// chains, and anything a future call site adds. Correctness is
// covered by scrub-at-sink.test.ts (sink-level) and
// packages/shared/src/__tests__/alerts.test.ts (scrubber-level).
//
// This file is the BACKSTOP: static scan of the production source
// so a future refactor that silently bypasses the sink (e.g. a
// `console.log(error.message)` or a direct `process.stdout.write`
// call) still gets caught. The two it() blocks below scan the
// canonical extraction patterns and fail if any match is NOT
// already wrapped in `scrubMessage(...)`.
//
// A fake-postgres-URL integration smoke proves scrubMessage itself
// still redacts credentials end-to-end.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scrubMessage } from '@diktat/shared/alerts';

const WORKERS_SRC = join(__dirname, '..', 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') continue;
      out.push(...listTsFiles(p));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('workers scrub-at-extraction', () => {
  it('every err.message extraction in apps/workers/src/** is wrapped in scrubMessage', () => {
    const files = listTsFiles(WORKERS_SRC);
    const unscrubbed: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        // Match the canonical extraction pattern. If it's not inside a
        // scrubMessage(...) call on the same line, flag it.
        if (
          line.includes('err instanceof Error ? err.message : String(err)') ||
          /\bString\(err\)/.test(line)
        ) {
          if (!line.includes('scrubMessage(')) {
            unscrubbed.push({
              file: file.replace(WORKERS_SRC, 'apps/workers/src'),
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    if (unscrubbed.length > 0) {
      const formatted = unscrubbed.map((u) => `  ${u.file}:${u.line}  ${u.text}`).join('\n');
      throw new Error(
        `Found ${unscrubbed.length} unscrubbed err.message extraction(s) in apps/workers/src/:\n${formatted}\n` +
          'Wrap each in `scrubMessage(err instanceof Error ? err.message : String(err))` ' +
          '(see apps/workers/src/jobs/scheduler.ts:182 for the reference pattern).',
      );
    }
  });

  // Round-1 security-reviewer HIGH-2: the canonical-ternary scan above
  // misses Supabase-SDK error.message extractions, which can carry
  // DSN / connection-info in the message string when a Postgres
  // connection fails. Catch every `<ident>.message` where <ident> ends
  // in `error` / `Error` / `Err` and the match is NOT already enclosed
  // in `scrubMessage(...)`.
  //
  // Narrow allow-list of identifiers that MUST stay unscrubbed:
  //   - `err.message` extractions already in `scrubMessage(...)` form
  //     (the first test above gates those).
  //   - Zod schema definitions (`.message` as a Zod option key) —
  //     filtered via the leading `{` check in the match context.
  //
  // Any new `error.message`-style site added without scrubMessage trips
  // this. Same reference pattern applies: wrap at the extraction site.
  it('every Supabase-SDK error.message extraction is wrapped in scrubMessage', () => {
    const files = listTsFiles(WORKERS_SRC);
    const unscrubbed: Array<{ file: string; line: number; text: string }> = [];

    // Identifier ending in error / Error / Err, followed by .message
    // OR ?.message. The `?` is optional-chain access (TypeScript);
    // without matching it, sites like `selError?.message` slip past.
    const PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*(?:Err|Error|error))\??\.message\b/g;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        let m: RegExpExecArray | null;
        PATTERN.lastIndex = 0;
        while ((m = PATTERN.exec(line))) {
          const start = m.index;
          // Already inside a scrubMessage(...) call on this line? The
          // scan is coarse (line-level) because the per-call-site wraps
          // are belt-and-suspenders over the sink-level scrubber in
          // apps/workers/src/logger.ts; a `scrubMessage(` anywhere on
          // the line is enough signal that the author did pass this
          // value through the scrubber. Accepts both canonical
          // `scrubMessage(x.message)` and optional-chain
          // `scrubMessage(x?.message ?? '…')` shapes without a bespoke
          // lookback regex per shape.
          if (line.includes('scrubMessage(')) continue;
          // Zod-shape false positives: a `{ message: "..." }` object key
          // is NOT an extraction. Match only when `.message` is read
          // (not when `message:` is written as a prop key). Skip when
          // the character immediately before the match is `{`.
          const left = line.slice(0, start);
          if (/\{\s*$/.test(left)) continue;
          unscrubbed.push({
            file: file.replace(WORKERS_SRC, 'apps/workers/src'),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    if (unscrubbed.length > 0) {
      const formatted = unscrubbed.map((u) => `  ${u.file}:${u.line}  ${u.text}`).join('\n');
      throw new Error(
        `Found ${unscrubbed.length} unscrubbed <error>.message extraction(s) in apps/workers/src/:\n${formatted}\n` +
          'Wrap each via `scrubMessage(<path>.error.message)` at the extraction site. ' +
          'See the reference pattern already in scheduler.ts / battle-runner.ts / etc.',
      );
    }
  });

  it('scrubMessage redacts a fake postgres URL end-to-end (integration smoke)', () => {
    const raw =
      'ECONNREFUSED postgres://alice:s3cret@db.internal:5432/prod host=db.internal token=t_abc';
    const scrubbed = scrubMessage(raw);

    // Credentials and URL authority must not survive.
    expect(scrubbed).not.toContain('s3cret');
    expect(scrubbed).not.toContain('t_abc');
    expect(scrubbed).not.toContain('db.internal');
    expect(scrubbed).not.toContain('alice');

    // Redaction markers must be present.
    expect(scrubbed).toContain('<url-redacted>');
    expect(scrubbed).toContain('host=<redacted>');
    expect(scrubbed).toContain('token=<redacted>');

    // Surrounding sentence prose survives (non-DSN non-keyword content
    // like 'ECONNREFUSED' is left alone).
    expect(scrubbed).toContain('ECONNREFUSED');
  });
});
