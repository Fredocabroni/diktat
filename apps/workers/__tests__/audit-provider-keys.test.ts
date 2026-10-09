// Tests for the boot-time provider-key audit. Not a Vitest-level
// network test; these exercise the audit's branching logic + alerter
// call shape against stub env + a fake alerter.

import { describe, expect, it, vi } from 'vitest';

import { auditProviderKeys, __testing } from '../src/audit-provider-keys.js';
import type { Logger } from '../src/logger.js';
import type { Alerter } from '@diktat/shared/alerts';

const { PROVIDER_ENV_KEY } = __testing;

function buildLogger(): Logger & { calls: { level: string; obj: Record<string, unknown> }[] } {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  return {
    calls,
    trace: (obj: Record<string, unknown>) => calls.push({ level: 'trace', obj }),
    debug: (obj: Record<string, unknown>) => calls.push({ level: 'debug', obj }),
    info: (obj: Record<string, unknown>) => calls.push({ level: 'info', obj }),
    warn: (obj: Record<string, unknown>) => calls.push({ level: 'warn', obj }),
    error: (obj: Record<string, unknown>) => calls.push({ level: 'error', obj }),
    fatal: (obj: Record<string, unknown>) => calls.push({ level: 'fatal', obj }),
    child: () => buildLogger(),
  } as unknown as Logger & { calls: { level: string; obj: Record<string, unknown> }[] };
}

function buildAlerter(): Alerter & {
  readonly calls: Array<{
    severity: string;
    title: string;
    detail: string;
    opts: { dedupKey?: string; dedupTtlMs?: number } | undefined;
  }>;
} {
  const calls: Array<{
    severity: string;
    title: string;
    detail: string;
    opts: { dedupKey?: string; dedupTtlMs?: number } | undefined;
  }> = [];
  return {
    enabled: true,
    alert: vi.fn(async (severity, title, detail, opts) => {
      calls.push({ severity, title, detail, opts });
    }),
    calls,
  } as unknown as Alerter & { readonly calls: typeof calls };
}

const providerEnv = { xaiAvailable: false, perplexityAvailable: false };

describe('auditProviderKeys — launch-scope task sweep', () => {
  it('all keys present: info log per task, no alerter calls', () => {
    const logger = buildLogger();
    const alerter = buildAlerter();
    auditProviderKeys({
      providerEnv,
      logger,
      alerter,
      env: {
        // drop_headline_rewrite needs anthropic + openai.
        ANTHROPIC_API_KEY: 'sk-test-1',
        OPENAI_API_KEY: 'sk-test-2',
        // debate_score falls back to google.
        GOOGLE_API_KEY: 'sk-test-3',
      },
    });
    const okLogs = logger.calls.filter((c) => c.obj.event === 'workers.boot.provider_key_ok');
    expect(okLogs.length).toBe(2); // one per launch-scope task
    expect(alerter.calls.length).toBe(0);
  });

  it('primary key missing: error log + error alert with chain_status + dedupKey', () => {
    const logger = buildLogger();
    const alerter = buildAlerter();
    auditProviderKeys({
      providerEnv,
      logger,
      alerter,
      // Anthropic (primary for both launch-scope tasks) missing.
      env: { OPENAI_API_KEY: 'sk-test-2' },
    });

    const missingLogs = logger.calls.filter(
      (c) => c.obj.event === 'workers.boot.provider_key_missing' && c.obj.provider === 'anthropic',
    );
    expect(missingLogs.length).toBe(2); // one per task

    const alerts = alerter.calls.filter((c) => c.severity === 'error');
    expect(alerts.length).toBe(2);
    for (const a of alerts) {
      expect(a.title).toMatch(/AI provider key missing/);
      expect(a.detail).toMatch(/ANTHROPIC_API_KEY|anthropic/);
      // Dedup is per-task per-provider — so a key-storm across tasks
      // still fires one alert per (task, provider).
      expect(a.opts?.dedupKey).toMatch(/^workers:boot:provider_key_missing:.*:anthropic:primary$/);
    }
    // Chain status differs by whether OpenAI (fallback) is present.
    // In this test OpenAI IS present, so chain is "fallback only",
    // not "chain exhausted".
    expect(alerts[0]!.detail).toMatch(/fallback only/);
  });

  it('primary AND fallback both missing: chain exhausted', () => {
    const logger = buildLogger();
    const alerter = buildAlerter();
    auditProviderKeys({
      providerEnv,
      logger,
      alerter,
      env: {}, // no provider keys at all
    });
    const alerts = alerter.calls.filter((c) => c.severity === 'error');
    // Each launch-scope task fires a primary-missing alert whose
    // detail reports chain exhausted when all fallbacks are also down.
    for (const a of alerts) {
      expect(a.detail).toMatch(/chain exhausted/);
    }
  });

  it('fallback-only missing: warn log + warn alert (primary still works)', () => {
    const logger = buildLogger();
    const alerter = buildAlerter();
    auditProviderKeys({
      providerEnv,
      logger,
      alerter,
      // Primary present, fallback (OpenAI) missing.
      env: { ANTHROPIC_API_KEY: 'sk-test-1' },
    });
    const warnAlerts = alerter.calls.filter((c) => c.severity === 'warn');
    // drop_headline_rewrite falls back to openai; debate_score to google.
    // Both are missing in this env — two warn alerts.
    expect(warnAlerts.length).toBe(2);
    for (const a of warnAlerts) {
      expect(a.title).toMatch(/AI fallback key missing/);
      expect(a.opts?.dedupKey).toMatch(
        /^workers:boot:provider_key_missing:[a-z_]+:(openai|google):fallback$/,
      );
    }
    // No error-severity alerts since the primary is live.
    expect(alerter.calls.filter((c) => c.severity === 'error').length).toBe(0);
  });

  it('returns a structured result per task for post-audit logging', () => {
    const logger = buildLogger();
    const results = auditProviderKeys({
      providerEnv,
      logger,
      env: { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' },
    });
    expect(results.length).toBe(2);
    expect(results[0]!.task).toBe('drop_headline_rewrite');
    expect(results[0]!.primary.provider).toBe('anthropic');
    expect(results[0]!.primary.present).toBe(true);
    expect(results[1]!.task).toBe('debate_score');
  });

  it('missing alerter never crashes the audit', () => {
    const logger = buildLogger();
    expect(() =>
      auditProviderKeys({
        providerEnv,
        logger,
        env: {}, // triggers error-severity branch; no alerter plumbed
      }),
    ).not.toThrow();
  });
});

describe('PROVIDER_ENV_KEY — mapping sanity', () => {
  it('covers every known provider id', () => {
    for (const provider of ['anthropic', 'openai', 'google', 'xai', 'perplexity'] as const) {
      expect(PROVIDER_ENV_KEY[provider]).toMatch(/^[A-Z_]+_API_KEY$/);
    }
  });
});
