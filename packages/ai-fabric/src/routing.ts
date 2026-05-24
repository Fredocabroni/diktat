import { RoutingError } from '@diktat/shared';
import type { Provider, ProviderEnv, RouteDecision, RouteRequest, Task } from './types.js';

/**
 * Concrete model identifiers per provider.
 *
 * Note on dated suffixes: Anthropic + OpenAI + Google all expose stable
 * latest aliases. We pin to short aliases here and let the underlying SDK
 * resolve the dated revision. If a model id changes, update this map only.
 */
const MODELS = {
  anthropic_opus_47: 'claude-opus-4-7',
  anthropic_sonnet_46: 'claude-sonnet-4-6',
  anthropic_haiku_45: 'claude-haiku-4-5',
  openai_gpt5: 'gpt-5',
  openai_gpt5_mini: 'gpt-5-mini',
  google_gemini_25_pro: 'gemini-2.5-pro',
  xai_grok: 'grok-2-latest',
  perplexity_sonar: 'sonar-large',
} as const;

interface RawDecision {
  primary: { provider: Provider; model: string; extendedThinking?: boolean };
  fallbacks: Array<{ provider: Provider; model: string }>;
  /** Substitution to apply when xAI is unavailable. */
  whenXaiMissing?: Partial<{
    primary: { provider: Provider; model: string; extendedThinking?: boolean };
    fallbacks: Array<{ provider: Provider; model: string }>;
  }>;
  whenPerplexityMissing?: Partial<{
    primary: { provider: Provider; model: string; extendedThinking?: boolean };
    fallbacks: Array<{ provider: Provider; model: string }>;
  }>;
  whenBothMissing?: Partial<{
    primary: { provider: Provider; model: string; extendedThinking?: boolean };
    fallbacks: Array<{ provider: Provider; model: string }>;
  }>;
}

const TABLE: Record<Task, RawDecision> = {
  code_gen: {
    primary: { provider: 'anthropic', model: MODELS.anthropic_opus_47 },
    fallbacks: [{ provider: 'anthropic', model: MODELS.anthropic_sonnet_46 }],
  },
  trivia_gen: {
    primary: { provider: 'anthropic', model: MODELS.anthropic_sonnet_46 },
    fallbacks: [{ provider: 'openai', model: MODELS.openai_gpt5 }],
  },
  live_factcheck: {
    primary: { provider: 'xai', model: MODELS.xai_grok },
    fallbacks: [{ provider: 'perplexity', model: MODELS.perplexity_sonar }],
    whenXaiMissing: {
      primary: { provider: 'perplexity', model: MODELS.perplexity_sonar },
      fallbacks: [],
    },
    whenPerplexityMissing: {
      primary: { provider: 'xai', model: MODELS.xai_grok },
      fallbacks: [],
    },
    whenBothMissing: {
      primary: {
        provider: 'anthropic',
        model: MODELS.anthropic_opus_47,
        extendedThinking: true,
      },
      fallbacks: [],
    },
  },
  sourced_factcheck: {
    primary: { provider: 'perplexity', model: MODELS.perplexity_sonar },
    // Perplexity-present fallback: Sonnet 4.6, not Opus 4.7 — Opus's empty
    // `{}` tool-input bug (see whenPerplexityMissing below) would resurface
    // here the moment Perplexity is wired and ever falls back. Revisit if
    // the Opus forced-tool / thinking path is fixed later.
    fallbacks: [{ provider: 'anthropic', model: MODELS.anthropic_sonnet_46 }],
    whenPerplexityMissing: {
      // Sonnet 4.6 — the model the generator already uses — is reliable on
      // the forced-tool structured-output path. Opus 4.7 returns an empty
      // `{}` tool input on ~30-40% of calls (2026-05-22 seed diagnostics),
      // so the verifier routes to Sonnet, not Opus, when Perplexity is off.
      primary: {
        provider: 'anthropic',
        model: MODELS.anthropic_sonnet_46,
      },
      fallbacks: [],
    },
  },
  debate_score: {
    // Sonnet 4.6 — same forced-tool path the generator uses reliably. Opus 4.7
    // returns an empty `{}` tool input on ~35% of forced-`tool_choice` calls
    // (see 2026-05-22 seed diagnostics, mirrored by the sourced_factcheck fix
    // in 5018f1f). Quality tradeoff named in the PR: Opus is the better
    // reasoner, but a 35% empty-verdict rate makes scoring quality moot. The
    // AI score is advisory anyway — community AP-weighted vote is decisive.
    // Revisit if the Opus forced-tool path is fixed or we land safeParse+retry.
    primary: { provider: 'anthropic', model: MODELS.anthropic_sonnet_46 },
    fallbacks: [{ provider: 'google', model: MODELS.google_gemini_25_pro }],
  },
  news_rank: {
    primary: { provider: 'anthropic', model: MODELS.anthropic_haiku_45 },
    fallbacks: [{ provider: 'openai', model: MODELS.openai_gpt5_mini }],
  },
  clip_gen: {
    primary: { provider: 'google', model: MODELS.google_gemini_25_pro },
    fallbacks: [{ provider: 'anthropic', model: MODELS.anthropic_sonnet_46 }],
  },
  x_post: {
    primary: { provider: 'anthropic', model: MODELS.anthropic_sonnet_46 },
    fallbacks: [{ provider: 'xai', model: MODELS.xai_grok }],
    whenXaiMissing: {
      fallbacks: [{ provider: 'openai', model: MODELS.openai_gpt5 }],
    },
  },
  fingerprint: {
    primary: { provider: 'anthropic', model: MODELS.anthropic_opus_47 },
    fallbacks: [],
  },
};

/**
 * Pure routing function. Returns the post-availability-filtered chain.
 *
 * Throws `RoutingError` only when the resulting chain is empty — which is
 * impossible given the substitutions above, but enforced as a safety net.
 */
export function route(req: RouteRequest, env: ProviderEnv): RouteDecision {
  const raw = TABLE[req.task];

  let primary = raw.primary;
  let fallbacks = raw.fallbacks;

  if (!env.xaiAvailable && !env.perplexityAvailable && raw.whenBothMissing) {
    if (raw.whenBothMissing.primary) primary = raw.whenBothMissing.primary;
    if (raw.whenBothMissing.fallbacks) fallbacks = raw.whenBothMissing.fallbacks;
  } else {
    if (!env.xaiAvailable && raw.whenXaiMissing) {
      if (raw.whenXaiMissing.primary) primary = raw.whenXaiMissing.primary;
      if (raw.whenXaiMissing.fallbacks) fallbacks = raw.whenXaiMissing.fallbacks;
    }
    if (!env.perplexityAvailable && raw.whenPerplexityMissing) {
      if (raw.whenPerplexityMissing.primary) primary = raw.whenPerplexityMissing.primary;
      if (raw.whenPerplexityMissing.fallbacks) fallbacks = raw.whenPerplexityMissing.fallbacks;
    }
  }

  // Always drop any unavailable provider from the resulting chain as a final pass.
  const isAvailable = (p: Provider): boolean => {
    if (p === 'xai') return env.xaiAvailable;
    if (p === 'perplexity') return env.perplexityAvailable;
    return true;
  };

  const filteredFallbacks = fallbacks.filter((f) => isAvailable(f.provider));

  let resolvedPrimary = primary;
  let resolvedFallbacks = filteredFallbacks;

  if (!isAvailable(primary.provider)) {
    const promoted = resolvedFallbacks[0];
    if (!promoted) {
      throw new RoutingError(
        `route(${req.task}): primary provider ${primary.provider} unavailable and no fallback configured`,
      );
    }
    resolvedPrimary = promoted;
    resolvedFallbacks = resolvedFallbacks.slice(1);
  }

  const decision: RouteDecision = {
    primary: resolvedPrimary.provider,
    model: resolvedPrimary.model,
    fallbacks: resolvedFallbacks.map((f) => f.provider),
  };
  if (resolvedPrimary.extendedThinking) decision.extendedThinking = true;
  return decision;
}

/** Exported model map for adapters that need to resolve fallback model ids. */
export function modelFor(provider: Provider, task: Task): string {
  const raw = TABLE[task];
  if (raw.primary.provider === provider) return raw.primary.model;
  const fb = raw.fallbacks.find((f) => f.provider === provider);
  if (fb) return fb.model;
  // Defaults — keep aligned with MODELS map.
  switch (provider) {
    case 'anthropic':
      return MODELS.anthropic_sonnet_46;
    case 'openai':
      return MODELS.openai_gpt5;
    case 'google':
      return MODELS.google_gemini_25_pro;
    case 'xai':
      return MODELS.xai_grok;
    case 'perplexity':
      return MODELS.perplexity_sonar;
  }
}
