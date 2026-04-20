import { RoutingError } from '@diktat/shared';
import type { ZodTypeAny } from 'zod';
import type { AdapterResult, ProviderEnv } from '../types.js';

interface InvokeArgs<S extends ZodTypeAny | undefined = undefined> {
  model: string;
  system: string;
  user: string;
  schema?: S;
  env: ProviderEnv;
  maxTokens?: number;
}

/**
 * xAI (Grok) adapter — TODO until `XAI_API_KEY` is set in `.env.local`.
 *
 * Compiles + type-checks identically to a real adapter so the routing layer
 * can hold a stable reference, but `invoke()` throws so a misrouted call
 * surfaces loudly instead of silently degrading. Routing already filters
 * this provider out of every chain when the env flag is false; this throw
 * is a defense-in-depth check.
 */
export const xaiAdapter = {
  async invoke<S extends ZodTypeAny | undefined>(
    _args: InvokeArgs<S>,
  ): Promise<AdapterResult<S extends ZodTypeAny ? import('zod').infer<S> : string>> {
    throw new RoutingError(
      'xai adapter invoked but XAI_API_KEY is missing — see CLAUDE.md ## TODOs',
    );
  },
};
