import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDeploySha } from '../deploy-sha.js';

const SAVED = process.env.RAILWAY_GIT_COMMIT_SHA;

function clearEnv(): void {
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
}

function restoreEnv(): void {
  if (SAVED === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = SAVED;
}

describe('resolveDeploySha', () => {
  beforeEach(() => {
    clearEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('returns the 7-char short SHA when RAILWAY_GIT_COMMIT_SHA is a full hex SHA', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'aa70e579e22a32536f0da1e34d50334dfd8d12b5';
    expect(resolveDeploySha()).toBe('aa70e57');
  });

  it('returns "unknown" when RAILWAY_GIT_COMMIT_SHA is unset (local dev / tests)', () => {
    expect(resolveDeploySha()).toBe('unknown');
  });

  it('returns "unknown" when RAILWAY_GIT_COMMIT_SHA is an empty string', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = '';
    expect(resolveDeploySha()).toBe('unknown');
  });

  it('returns "unknown" when RAILWAY_GIT_COMMIT_SHA is whitespace-only', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = '   ';
    expect(resolveDeploySha()).toBe('unknown');
  });

  it('never throws', () => {
    expect(() => resolveDeploySha()).not.toThrow();
    process.env.RAILWAY_GIT_COMMIT_SHA = 'deadbeef';
    expect(() => resolveDeploySha()).not.toThrow();
    expect(resolveDeploySha()).toBe('deadbee');
  });

  it('maps a sub-7-char hex value to "invalid" — git short SHAs are 7+ chars', () => {
    // PR #162 round-3 security-reviewer LOW: the earlier `{4,64}`
    // regex accepted non-SHA hex as short as 4 characters (e.g. a
    // stray color code or hex port number); raised to `{7,64}` so
    // only lengths that could plausibly be real short SHAs pass.
    for (const sha of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
      process.env.RAILWAY_GIT_COMMIT_SHA = sha;
      expect(resolveDeploySha()).toBe('invalid');
    }
  });

  it('accepts a 7-char hex value (the floor) and emits it verbatim', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdef0';
    expect(resolveDeploySha()).toBe('abcdef0');
  });

  it('maps a non-hex value to "invalid" instead of propagating env text', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'hahaha<script>alert(1)</script>';
    expect(resolveDeploySha()).toBe('invalid');
  });

  it('maps a hex-length-but-wrong-chars value to "invalid"', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'zzzzzzz';
    expect(resolveDeploySha()).toBe('invalid');
  });

  it('maps a too-long value to "invalid" (above the 64-char hex ceiling)', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'a'.repeat(65);
    expect(resolveDeploySha()).toBe('invalid');
  });

  it('accepts uppercase hex (git SHAs are canonical lowercase, but tolerate case)', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'AA70E579E22A32536F0DA1E34D50334DFD8D12B5';
    // Case is preserved as supplied; the resolver only validates shape.
    expect(resolveDeploySha()).toBe('AA70E57');
  });
});
