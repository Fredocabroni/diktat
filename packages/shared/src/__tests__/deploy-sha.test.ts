import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDeploySha } from '../deploy-sha.js';

const SAVED_ENV: Record<string, string | undefined> = {};
for (const k of ['RAILWAY_GIT_COMMIT_SHA', 'GIT_SHA']) {
  SAVED_ENV[k] = process.env[k];
}

function clearEnv(): void {
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
  delete process.env.GIT_SHA;
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('resolveDeploySha', () => {
  beforeEach(() => {
    clearEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('returns the short SHA from RAILWAY_GIT_COMMIT_SHA when set (highest precedence)', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'aa70e579e22a32536f0da1e34d50334dfd8d12b5';
    expect(resolveDeploySha()).toBe('aa70e57');
  });

  it('ignores an empty RAILWAY_GIT_COMMIT_SHA and falls through to GIT_SHA', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = '';
    process.env.GIT_SHA = 'cb6882f7c6223fe0b83c07646939c60eaa0de368';
    expect(resolveDeploySha()).toBe('cb6882f');
  });

  it('ignores whitespace-only RAILWAY_GIT_COMMIT_SHA', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = '   ';
    process.env.GIT_SHA = '352aae7d4c86a7fda06158d7d08e3100902e4321';
    expect(resolveDeploySha()).toBe('352aae7');
  });

  it('env var wins when RAILWAY_GIT_COMMIT_SHA is set alongside GIT_SHA', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
    process.env.GIT_SHA = '0000000000000000000000000000000000000000';
    expect(resolveDeploySha()).toBe('abcdef1');
  });

  it('returns "unknown" when neither env var resolves (local dev / tests)', () => {
    expect(resolveDeploySha()).toBe('unknown');
  });

  it('returns "unknown" when env vars are empty strings', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = '';
    process.env.GIT_SHA = '';
    expect(resolveDeploySha()).toBe('unknown');
  });

  it('appDir arg is accepted but ignored (file fallback removed 2026-10-01)', () => {
    // The function signature keeps the optional appDir for backwards
    // compatibility; passing it does NOT make the function read any
    // file — the file path was retired with the GHA deploy workflow.
    expect(() => resolveDeploySha('/dev/null-nonsense/no-such')).not.toThrow();
    expect(resolveDeploySha('/dev/null-nonsense/no-such')).toBe('unknown');
  });

  it('never throws', () => {
    expect(() => resolveDeploySha()).not.toThrow();
    process.env.RAILWAY_GIT_COMMIT_SHA = 'deadbeef';
    expect(() => resolveDeploySha()).not.toThrow();
    // A valid short SHA is sliced bounds-safely.
    expect(resolveDeploySha()).toBe('deadbee');
  });

  it('maps a sub-4-char value to "invalid" (fails the hex-shape minimum)', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'ab';
    expect(resolveDeploySha()).toBe('invalid');
  });

  it('maps a non-hex value to "invalid" instead of propagating env text', () => {
    // A hostile or malformed env value must not reach the boot-alert body.
    process.env.RAILWAY_GIT_COMMIT_SHA = 'hahaha<script>alert(1)</script>';
    expect(resolveDeploySha()).toBe('invalid');
  });

  it('maps a hex-length-but-wrong-chars value to "invalid"', () => {
    // Right length window, but contains non-hex chars → still invalid.
    process.env.RAILWAY_GIT_COMMIT_SHA = 'zzzzzzz';
    expect(resolveDeploySha()).toBe('invalid');
  });

  it('maps a too-long value to "invalid" (above the 64-char hex ceiling)', () => {
    // 65 hex chars — one past the ceiling.
    process.env.RAILWAY_GIT_COMMIT_SHA = 'a'.repeat(65);
    expect(resolveDeploySha()).toBe('invalid');
  });

  it('accepts uppercase hex (git SHAs are canonical lowercase, but tolerate case)', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'AA70E579E22A32536F0DA1E34D50334DFD8D12B5';
    // Case is preserved as supplied; the resolver only validates shape.
    expect(resolveDeploySha()).toBe('AA70E57');
  });

  it('invalid RAILWAY_GIT_COMMIT_SHA does NOT fall through to a valid GIT_SHA (precedence stays strict)', () => {
    // Precedence is positional: the winning env var's value governs the
    // outcome. If RAILWAY_GIT_COMMIT_SHA is set but malformed, that is
    // the resolver's answer — we flag the misconfiguration, we don't
    // mask it by silently using the fallback.
    process.env.RAILWAY_GIT_COMMIT_SHA = 'not-a-sha';
    process.env.GIT_SHA = 'aa70e579e22a32536f0da1e34d50334dfd8d12b5';
    expect(resolveDeploySha()).toBe('invalid');
  });
});
