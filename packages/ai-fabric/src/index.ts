// @diktat/ai-fabric — multi-provider AI router with cost caps, retry, structured
// output, and per-task routing. xAI + Perplexity adapters are stubs that throw
// at invocation until their API keys are configured (see CLAUDE.md ## TODOs).

export * from './types.js';
export * from './env.js';
export * from './routing.js';
export * from './cost.js';
export * from './redis-cost-sink.js';
export * from './retry.js';
export * from './structured.js';
export * from './logging.js';
export * from './fabric.js';
export { anthropicAdapter } from './adapters/anthropic.js';
export { openaiAdapter } from './adapters/openai.js';
export { googleAdapter } from './adapters/google.js';
export { xaiAdapter } from './adapters/xai.js';
export { perplexityAdapter } from './adapters/perplexity.js';
