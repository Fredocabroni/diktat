import { readFile } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// PR #62 round-3 leftover #7 — single-shard atomicity doc regression guard.
//
// `COMBINED_ATOMIC_LUA` in `apps/api/src/rate-limit.internal.ts` does
// `GET KEYS[1] / GET KEYS[2] / check / INCR / INCR`. In Upstash REST
// single-shard mode (the current posture) this is atomic. Under
// cluster mode the two keys could land on different shards and the
// atomicity guarantee silently breaks — two concurrent callers could
// both pass the daily check and then both INCR, exceeding the budget
// by 1 per concurrent racer.
//
// The file-header note + inline comment on COMBINED_ATOMIC_LUA make
// the assumption explicit and document the three cluster-mode
// migration paths (hash-tag, WATCH/MULTI/EXEC, serialize to one key).
// Without the comment, the next reader sees Lua and assumes it's
// atomic — the assumption is invisible at the read site.
//
// This test grep's the file content for the load-bearing phrases.
// A future cleanup pass that strips the documentation as "noise"
// fails this test loudly.
// ---------------------------------------------------------------------------

const INTERNAL_PATH = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '../src/rate-limit.internal.ts',
);

describe('rate-limit.internal.ts — single-shard atomicity documentation', () => {
  it('file header documents the SHARD-MODE ASSUMPTION + cluster-mode migration path', async () => {
    const src = await readFile(INTERNAL_PATH, 'utf8');

    // Top-of-file assumption banner must be present.
    expect(src).toMatch(/SHARD-MODE ASSUMPTION/);
    expect(src).toMatch(/single-shard/i);
    expect(src).toMatch(/cluster/i);

    // Three migration paths must each be named so the doc actually
    // gives the next person something actionable, not just a warning.
    expect(src).toMatch(/hash-tag/i);
    expect(src).toMatch(/WATCH\/MULTI\/EXEC/);
    expect(src).toMatch(/serialize.*one (?:Redis )?key/i);
  });

  it('COMBINED_ATOMIC_LUA carries an inline cluster-mode reference at the declaration', async () => {
    const src = await readFile(INTERNAL_PATH, 'utf8');

    // Locate the LUA constant and check the comment block immediately
    // above it (within the 600 chars preceding the declaration line)
    // mentions the shard assumption. Reading the Lua without the
    // inline reminder is exactly the failure mode the file-header
    // banner is supposed to prevent — if both vanish, atomicity is
    // a silent assumption with no read-site signal.
    const idx = src.indexOf('export const COMBINED_ATOMIC_LUA');
    expect(idx).toBeGreaterThan(-1);
    const preamble = src.slice(Math.max(0, idx - 600), idx);
    expect(preamble).toMatch(/single-shard|SINGLE-SHARD/i);
    expect(preamble).toMatch(/cluster/i);
  });
});
