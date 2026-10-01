// Issue #146 — verify every workers catch that extracts err.message pipes
// the value through scrubMessage BEFORE the logger / alerter sees it.
//
// Approach: statically scan the production source for the known catch
// pattern `err instanceof Error ? err.message : String(err)` and assert
// every match is enclosed by `scrubMessage(...)`. Static assertion is
// enough because the scrub shape is byte-identical at every site;
// scrubMessage's correctness is covered by
// packages/shared/src/__tests__/alerts.test.ts (which includes the
// fake-postgres-URL case the issue's prompt asked for).
//
// We also exercise the scrub end-to-end against a fake postgres URL
// (one representative integration case) so a future refactor that
// renames scrubMessage or breaks its import path trips here.

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

    // Identifier ending in error / Error / Err, followed by .message.
    const PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*(?:Err|Error|error))\.message\b/g;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        let m: RegExpExecArray | null;
        PATTERN.lastIndex = 0;
        while ((m = PATTERN.exec(line))) {
          const start = m.index;
          // Already inside scrubMessage(...)? Walk back from start, strip
          // whitespace, and check for `scrubMessage(` immediately before.
          const prefix = line.slice(0, start);
          if (/scrubMessage\(\s*(?:[A-Za-z_][\w.]*\s*)?$/.test(prefix)) continue;
          // Zod-shape false positives: a `{ message: "..." }` object key
          // is NOT an extraction. Match only when `.message` is read
          // (not when `message:` is written as a prop key). The regex
          // already requires `.message` with a dot; a Zod `message: X`
          // key uses `message:` without the leading dot, so it never
          // matches here. Belt-and-suspenders: skip when preceded by
          // `{` to be safe.
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
