import { describe, expect, it } from 'vitest';
import { RoutingError } from '@diktat/shared';
import { route, modelFor } from '../src/routing.js';
import type { ProviderEnv, Task } from '../src/types.js';

const ALL: ProviderEnv = { xaiAvailable: true, perplexityAvailable: true };
const NEITHER: ProviderEnv = { xaiAvailable: false, perplexityAvailable: false };
const ONLY_XAI: ProviderEnv = { xaiAvailable: true, perplexityAvailable: false };
const ONLY_PPLX: ProviderEnv = { xaiAvailable: false, perplexityAvailable: true };

describe('routing — happy path with all providers available', () => {
  it.each<[Task, string, string[]]>([
    ['code_gen', 'anthropic', ['anthropic']],
    ['trivia_gen', 'anthropic', ['openai']],
    ['live_factcheck', 'xai', ['perplexity']],
    ['sourced_factcheck', 'perplexity', ['anthropic']],
    ['debate_score', 'anthropic', ['google']],
    ['news_rank', 'anthropic', ['openai']],
    ['clip_gen', 'google', ['anthropic']],
    ['x_post', 'anthropic', ['xai']],
    ['fingerprint', 'anthropic', []],
  ])('task=%s primary=%s fallbacks=%s', (task, primary, fallbacks) => {
    const decision = route({ task }, ALL);
    expect(decision.primary).toBe(primary);
    expect(decision.fallbacks).toEqual(fallbacks);
    expect(decision.model.length).toBeGreaterThan(0);
  });
});

describe('routing — xAI/Perplexity dropped when env keys missing', () => {
  it('live_factcheck with neither key falls back to Anthropic Opus extended-thinking', () => {
    const d = route({ task: 'live_factcheck' }, NEITHER);
    expect(d.primary).toBe('anthropic');
    expect(d.model).toBe('claude-opus-4-7');
    expect(d.extendedThinking).toBe(true);
    expect(d.fallbacks).toEqual([]);
  });

  it('live_factcheck with only xai promotes xai, no perplexity fallback', () => {
    const d = route({ task: 'live_factcheck' }, ONLY_XAI);
    expect(d.primary).toBe('xai');
    expect(d.fallbacks).toEqual([]);
  });

  it('live_factcheck with only perplexity promotes perplexity', () => {
    const d = route({ task: 'live_factcheck' }, ONLY_PPLX);
    expect(d.primary).toBe('perplexity');
    expect(d.fallbacks).toEqual([]);
  });

  it('sourced_factcheck without perplexity falls back to Anthropic Opus extended-thinking', () => {
    const d = route({ task: 'sourced_factcheck' }, ONLY_XAI);
    expect(d.primary).toBe('anthropic');
    expect(d.extendedThinking).toBe(true);
    expect(d.fallbacks).toEqual([]);
  });

  it('x_post without xai swaps fallback to OpenAI', () => {
    const d = route({ task: 'x_post' }, ONLY_PPLX);
    expect(d.primary).toBe('anthropic');
    expect(d.fallbacks).toEqual(['openai']);
  });

  it('chains never include unavailable providers', () => {
    const tasks: Task[] = [
      'code_gen',
      'trivia_gen',
      'live_factcheck',
      'sourced_factcheck',
      'debate_score',
      'news_rank',
      'clip_gen',
      'x_post',
      'fingerprint',
    ];
    for (const task of tasks) {
      const d = route({ task }, NEITHER);
      expect(d.primary).not.toBe('xai');
      expect(d.primary).not.toBe('perplexity');
      expect(d.fallbacks).not.toContain('xai');
      expect(d.fallbacks).not.toContain('perplexity');
    }
  });
});

describe('modelFor', () => {
  it('returns the table-defined model for a configured provider', () => {
    expect(modelFor('anthropic', 'code_gen')).toBe('claude-opus-4-7');
    expect(modelFor('openai', 'trivia_gen')).toBe('gpt-5');
    expect(modelFor('google', 'clip_gen')).toBe('gemini-2.5-pro');
  });

  it('returns a sensible default when provider not in the chain', () => {
    expect(modelFor('openai', 'fingerprint')).toBe('gpt-5');
    expect(modelFor('google', 'fingerprint')).toBe('gemini-2.5-pro');
  });
});

describe('routing — RoutingError safety net', () => {
  it('does not throw for any task in any env combination', () => {
    const tasks: Task[] = [
      'code_gen',
      'trivia_gen',
      'live_factcheck',
      'sourced_factcheck',
      'debate_score',
      'news_rank',
      'clip_gen',
      'x_post',
      'fingerprint',
    ];
    for (const env of [ALL, NEITHER, ONLY_XAI, ONLY_PPLX]) {
      for (const task of tasks) {
        expect(() => route({ task }, env)).not.toThrow(RoutingError);
      }
    }
  });
});
