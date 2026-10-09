// Boot-time audit: do the provider API keys required by launch-scope AI
// tasks exist in the running process env?
//
// Why this exists: the ai-fabric adapters read provider keys lazily at
// first use (`client()` in each adapter). A missing key doesn't surface
// at boot — it throws on the first invoke, the fabric chain exhausts,
// and the handler-side catch returns empty strings. That exact silent-
// degradation path left workers producing 14 raw-title Drops over 14
// days before anyone noticed (post-mortem: Railway workers had no
// ANTHROPIC_API_KEY or OPENAI_API_KEY env vars for the full window).
//
// This audit turns that failure into a boot-time Telegram alert.
// Non-fatal — a missing fallback is a warning, a missing primary is an
// error alert but still proceeds. The alerter itself tolerates missing
// Telegram credentials by no-oping, so this audit never crashes boot
// regardless of configuration.

import { route, type ProviderEnv, type Provider, type Task } from '@diktat/ai-fabric';
import type { Alerter } from '@diktat/shared/alerts';
import type { Logger } from './logger.js';

/** Tasks that MUST have a working primary + at least one working
 *  fallback for the 50-user soft launch. Grows as surfaces come
 *  out of hiding. */
export const LAUNCH_SCOPE_TASKS: readonly Task[] = ['drop_headline_rewrite', 'debate_score'];

/** Map from provider id to the env var the adapter reads. Kept here
 *  (not re-exported from ai-fabric) because the adapter paths are
 *  intentionally module-local — this map is operator-facing and the
 *  canonical source for boot-time env checks. */
const PROVIDER_ENV_KEY: Readonly<Record<Provider, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  xai: 'XAI_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
});

export interface ProviderKeyAuditResult {
  readonly task: Task;
  readonly primary: { provider: Provider; envKey: string; present: boolean };
  readonly fallbacks: readonly { provider: Provider; envKey: string; present: boolean }[];
}

/**
 * Run the audit. Returns one result per launch-scope task so callers
 * can log a structured summary alongside the alerts.
 */
export function auditProviderKeys(opts: {
  readonly tasks?: readonly Task[];
  readonly providerEnv: ProviderEnv;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly alerter?: Alerter;
}): readonly ProviderKeyAuditResult[] {
  const tasks = opts.tasks ?? LAUNCH_SCOPE_TASKS;
  const procEnv = opts.env ?? process.env;
  const results: ProviderKeyAuditResult[] = [];

  for (const task of tasks) {
    const decision = route({ task }, opts.providerEnv);
    const primaryKey = PROVIDER_ENV_KEY[decision.primary];
    const primary = {
      provider: decision.primary,
      envKey: primaryKey,
      present: Boolean(procEnv[primaryKey]),
    };
    const fallbacks = decision.fallbacks.map((p) => ({
      provider: p,
      envKey: PROVIDER_ENV_KEY[p],
      present: Boolean(procEnv[PROVIDER_ENV_KEY[p]]),
    }));
    results.push({ task, primary, fallbacks });

    const allFallbacksMissing = fallbacks.length === 0 || fallbacks.every((f) => !f.present);

    if (!primary.present) {
      // Primary missing: every call starts with a dead link. If all
      // fallbacks are also missing, the whole chain exhausts on first
      // invoke — critical. If at least one fallback is live, we're on
      // the degraded path by default — error-severity but not critical.
      const severity: 'error' | 'warn' = 'error';
      const chainStatus = allFallbacksMissing ? 'chain exhausted' : 'fallback only';
      opts.logger.error({
        event: 'workers.boot.provider_key_missing',
        task,
        provider: primary.provider,
        env_key: primary.envKey,
        chain_status: chainStatus,
        fallbacks: fallbacks.map((f) => ({ provider: f.provider, present: f.present })),
      });
      void opts.alerter?.alert(
        severity,
        `AI provider key missing: ${task}`,
        `Primary ${primary.provider} (${primary.envKey}) is unset. ${chainStatus}.`,
        { dedupKey: `workers:boot:provider_key_missing:${task}:${primary.provider}:primary` },
      );
    } else {
      // Primary is present. Warn on any missing fallback, since the
      // whole chain can still exhaust if the primary throws.
      for (const fb of fallbacks) {
        if (!fb.present) {
          opts.logger.warn({
            event: 'workers.boot.provider_key_missing',
            task,
            provider: fb.provider,
            env_key: fb.envKey,
            chain_status: 'fallback_missing',
          });
          void opts.alerter?.alert(
            'warn',
            `AI fallback key missing: ${task}`,
            `Fallback ${fb.provider} (${fb.envKey}) is unset — chain will exhaust if primary ${primary.provider} fails.`,
            {
              dedupKey: `workers:boot:provider_key_missing:${task}:${fb.provider}:fallback`,
            },
          );
        }
      }
      opts.logger.info({
        event: 'workers.boot.provider_key_ok',
        task,
        primary: primary.provider,
        fallbacks_present: fallbacks.every((f) => f.present),
      });
    }
  }

  return results;
}

/** Test seam: expose the provider→env-key map so tests can assert the
 *  mapping without duplicating it. */
export const __testing = {
  PROVIDER_ENV_KEY,
};
