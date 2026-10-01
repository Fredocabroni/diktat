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
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdefghijklmnop1234567890abcdef12345678';
    process.env.GIT_SHA = '0000000000000000000000000000000000000000';
    expect(resolveDeploySha()).toBe('abcdefg');
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
    process.env.RAILWAY_GIT_COMMIT_SHA = 'ab';
    expect(() => resolveDeploySha()).not.toThrow();
    // Short SHAs are preserved as-is (slice is bounds-safe).
    expect(resolveDeploySha()).toBe('ab');
  });
});
