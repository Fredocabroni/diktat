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
 * Perplexity (Sonar) adapter — TODO until `PERPLEXITY_API_KEY` is set in
 * `.env.local`. Same defense-in-depth pattern as `xaiAdapter`.
 */
export const perplexityAdapter = {
  async invoke<S extends ZodTypeAny | undefined>(
    _args: InvokeArgs<S>,
  ): Promise<AdapterResult<S extends ZodTypeAny ? import('zod').infer<S> : string>> {
    throw new RoutingError(
      'perplexity adapter invoked but PERPLEXITY_API_KEY is missing — see CLAUDE.md ## TODOs',
    );
  },
};
