import { ProviderError } from '@diktat/shared';
import type { ZodTypeAny, z as Z } from 'zod';

import { anthropicAdapter } from './adapters/anthropic.js';
import { googleAdapter } from './adapters/google.js';
import { openaiAdapter } from './adapters/openai.js';
import { perplexityAdapter } from './adapters/perplexity.js';
import { xaiAdapter } from './adapters/xai.js';
import { assertUnderCap, readBilledUsd, recordSpend } from './cost.js';
import { defaultSink, logCall } from './logging.js';
import { withRetry } from './retry.js';
import { modelFor, route } from './routing.js';
import type { AdapterResult, InvokeResult, LogSink, Provider, ProviderEnv, Task } from './types.js';

interface AdapterShape {
  invoke: <S extends ZodTypeAny | undefined>(args: {
    model: string;
    system: string;
    user: string;
    schema?: S;
    env: ProviderEnv;
    extendedThinking?: boolean;
    maxTokens?: number;
  }) => Promise<AdapterResult<S extends ZodTypeAny ? Z.infer<S> : string>>;
}

const REGISTRY: Record<Provider, AdapterShape> = {
  anthropic: anthropicAdapter as AdapterShape,
  openai: openaiAdapter as AdapterShape,
  google: googleAdapter as AdapterShape,
  xai: xaiAdapter as AdapterShape,
  perplexity: perplexityAdapter as AdapterShape,
};

/** Test seam: swap in fake adapters to exercise fallback / cost / retry layers. */
export function __setAdapterForTests(provider: Provider, adapter: AdapterShape): () => void {
  const previous = REGISTRY[provider];
  REGISTRY[provider] = adapter;
  return () => {
    REGISTRY[provider] = previous;
  };
}

export interface FabricInvokeRequest<S extends ZodTypeAny | undefined = undefined> {
  task: Task;
  system: string;
  user: string;
  schema?: S;
  env: ProviderEnv;
  /** Pre-call USD projection used to gate against the per-task / global cap. */
  projectedUsd?: number;
  sink?: LogSink;
  extendedThinking?: boolean;
  maxTokens?: number;
}

/**
 * Orchestrate one `invoke`:
 *   1. resolve the chain via `route()`
 *   2. assert the per-task + global cap won't be breached by `projectedUsd`
 *   3. for primary then each fallback: `withRetry(adapter.invoke)`
 *      → on success: `recordSpend` + log + return
 *   4. if every link fails: `ProviderError('all providers exhausted')`
 */
export async function invoke<S extends ZodTypeAny | undefined = undefined>(
  req: FabricInvokeRequest<S>,
): Promise<InvokeResult<S extends ZodTypeAny ? Z.infer<S> : string>> {
  const sink = req.sink ?? defaultSink();
  const decision = route({ task: req.task }, req.env);

  if (typeof req.projectedUsd === 'number' && req.projectedUsd > 0) {
    assertUnderCap(req.task, req.projectedUsd);
  }

  const chain: Array<{ provider: Provider; model: string; extendedThinking?: boolean }> = [
    {
      provider: decision.primary,
      model: decision.model,
      ...(decision.extendedThinking ? { extendedThinking: true } : {}),
    },
    ...decision.fallbacks.map((p) => ({ provider: p, model: modelFor(p, req.task) })),
  ];

  let lastError: unknown;
  for (const link of chain) {
    const adapter = REGISTRY[link.provider];
    try {
      const result = await withRetry(() =>
        adapter.invoke({
          model: link.model,
          system: req.system,
          user: req.user,
          ...(req.schema !== undefined ? { schema: req.schema } : {}),
          env: req.env,
          ...(link.extendedThinking ? { extendedThinking: true } : {}),
          ...(typeof req.maxTokens === 'number' ? { maxTokens: req.maxTokens } : {}),
        } as never),
      );
      recordSpend(req.task, result.usd, {
        sink,
        provider: link.provider,
        model: link.model,
      });
      logCall(
        {
          ts: new Date().toISOString(),
          level: 'info',
          task: req.task,
          provider: link.provider,
          model: link.model,
          usd: result.usd,
          latencyMs: result.latencyMs,
          status: 'ok',
        },
        sink,
      );
      return {
        ...(result as AdapterResult<S extends ZodTypeAny ? Z.infer<S> : string>),
        provider: link.provider,
        model: link.model,
        task: req.task,
      };
    } catch (err) {
      lastError = err;
      // A call that reached the provider (and was billed) but failed
      // downstream — e.g. a structured-output parse error — stamps its real
      // cost on the thrown error. Record it so the ledger and per-task cap
      // are not blind to billed-but-failed spend.
      const billedUsd = readBilledUsd(err);
      if (billedUsd > 0) {
        recordSpend(req.task, billedUsd, {
          sink,
          provider: link.provider,
          model: link.model,
        });
      }
      logCall(
        {
          ts: new Date().toISOString(),
          level: 'warn',
          task: req.task,
          provider: link.provider,
          model: link.model,
          usd: billedUsd,
          latencyMs: 0,
          status: 'fail',
          message: 'adapter failed; trying next link in chain',
          error: err instanceof Error ? err.message : String(err),
        },
        sink,
      );
    }
  }

  throw new ProviderError(
    chain[chain.length - 1]?.provider ?? 'unknown',
    'all providers exhausted',
    undefined,
    lastError,
  );
}
