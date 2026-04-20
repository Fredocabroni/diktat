export interface EnvSnapshot {
  anthropicKey?: string;
  openaiKey?: string;
  googleKey?: string;
  xaiKey?: string;
  perplexityKey?: string;
  xaiAvailable: boolean;
  perplexityAvailable: boolean;
}

/**
 * Read provider keys from `process.env` once.
 *
 * Only `xaiAvailable` / `perplexityAvailable` flow into the routing table —
 * those two providers are stubbed in Phase 1 and dropped from chains when
 * their API keys are absent. The other three (Anthropic, OpenAI, Google)
 * are required at runtime; their absence surfaces as a `ProviderError` from
 * the adapter rather than a routing-time skip.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvSnapshot {
  const xaiKey = env.XAI_API_KEY;
  const perplexityKey = env.PERPLEXITY_API_KEY;
  const snapshot: EnvSnapshot = {
    xaiAvailable: Boolean(xaiKey && xaiKey.length > 0),
    perplexityAvailable: Boolean(perplexityKey && perplexityKey.length > 0),
  };
  if (env.ANTHROPIC_API_KEY) snapshot.anthropicKey = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) snapshot.openaiKey = env.OPENAI_API_KEY;
  if (env.GOOGLE_API_KEY) snapshot.googleKey = env.GOOGLE_API_KEY;
  if (xaiKey) snapshot.xaiKey = xaiKey;
  if (perplexityKey) snapshot.perplexityKey = perplexityKey;
  return snapshot;
}
