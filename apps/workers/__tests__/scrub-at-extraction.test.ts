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
