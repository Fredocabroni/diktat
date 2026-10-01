import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('reads from .deploy-sha when both env vars are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-sha-'));
    try {
      writeFileSync(join(dir, '.deploy-sha'), '5e290ed8f9570900ae8abda4d2fc65d286db3aac\n', 'utf8');
      expect(resolveDeploySha(dir)).toBe('5e290ed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env var wins when both env + file are present', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdefghijklmnop1234567890abcdef12345678';
    const dir = mkdtempSync(join(tmpdir(), 'deploy-sha-'));
    try {
      writeFileSync(join(dir, '.deploy-sha'), '0000000000000000000000000000000000000000', 'utf8');
      expect(resolveDeploySha(dir)).toBe('abcdefg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns "unknown" when nothing resolves (local dev / tests)', () => {
    expect(resolveDeploySha('/this/path/does/not/exist')).toBe('unknown');
  });

  it('returns "unknown" on an empty .deploy-sha file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-sha-'));
    try {
      writeFileSync(join(dir, '.deploy-sha'), '', 'utf8');
      expect(resolveDeploySha(dir)).toBe('unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws on an unreadable file (bad path)', () => {
    // No throw path even if `fs.readFileSync` errors — the catch returns null.
    expect(() => resolveDeploySha('/dev/null-nonsense/no-such')).not.toThrow();
    expect(resolveDeploySha('/dev/null-nonsense/no-such')).toBe('unknown');
  });

  it('also works when appDir is omitted (reads ./.deploy-sha relative to cwd)', () => {
    // We stage a .deploy-sha inside a tmpdir and chdir into it so the
    // bare-call path exercises its default argument.
    const dir = mkdtempSync(join(tmpdir(), 'deploy-sha-cwd-'));
    const prev = process.cwd();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.deploy-sha'), 'ffffffff' + 'f'.repeat(32), 'utf8');
      process.chdir(dir);
      expect(resolveDeploySha()).toBe('fffffff');
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
