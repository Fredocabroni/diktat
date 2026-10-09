import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { ProviderError, ValidationError } from '@diktat/shared';
import type { ZodTypeAny } from 'zod';
import { toToolSchema } from '../structured.js';
import type { AdapterResult, ProviderEnv } from '../types.js';

/**
 * GPT-5 renamed the token-cap parameter from `max_tokens` to
 * `max_completion_tokens`. GPT-4-generation models (and gpt-4o) still
 * accept `max_tokens`. Pick the parameter name by model family so one
 * adapter supports both without a hardcoded cutover date.
 */
function tokenCapKey(model: string): 'max_tokens' | 'max_completion_tokens' {
  return model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3')
    ? 'max_completion_tokens'
    : 'max_tokens';
}

/** OpenAI per-1M-token pricing snapshot. Adjust as the price page moves. */
const PRICE_PER_M_INPUT_USD: Record<string, number> = {
  'gpt-5': 5,
  'gpt-5-mini': 0.25,
};
const PRICE_PER_M_OUTPUT_USD: Record<string, number> = {
  'gpt-5': 15,
  'gpt-5-mini': 2,
};

interface InvokeArgs<S extends ZodTypeAny | undefined = undefined> {
  model: string;
  system: string;
  user: string;
  schema?: S;
  env: ProviderEnv;
  maxTokens?: number;
}

function priceUsd(model: string, inputTokens: number, outputTokens: number): number {
  const inUsd = ((PRICE_PER_M_INPUT_USD[model] ?? 5) * inputTokens) / 1_000_000;
  const outUsd = ((PRICE_PER_M_OUTPUT_USD[model] ?? 15) * outputTokens) / 1_000_000;
  return inUsd + outUsd;
}

let _client: OpenAI | undefined;
function client(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderError('openai', 'OPENAI_API_KEY missing');
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

export const openaiAdapter = {
  async invoke<S extends ZodTypeAny | undefined>(
    args: InvokeArgs<S>,
  ): Promise<AdapterResult<S extends ZodTypeAny ? import('zod').infer<S> : string>> {
    const start = Date.now();
    const { model, system, user, schema, maxTokens } = args;

    const params: Record<string, unknown> = {
      model,
      [tokenCapKey(model)]: maxTokens ?? 4096,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };

    if (schema) {
      const jsonSchema = toToolSchema(schema);
      params['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: jsonSchema,
          strict: true,
        },
      };
    }

    const response = (await client().chat.completions.create(params as never)) as ChatCompletion;
    const latencyMs = Date.now() - start;
    const usage = response.usage;
    const usd = priceUsd(model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);

    const choice = response.choices[0];
    if (!choice || !choice.message) {
      throw new ProviderError('openai', 'no choice/message returned');
    }
    const raw = choice.message.content ?? '';

    if (schema) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new ValidationError(`openai: response is not JSON: ${raw.slice(0, 80)}`, err);
      }
      // safeParse (not .parse) so the thrown error carries only
      // issue paths + codes, not received values. Received values
      // echo model output which may contain feed-derived PII. See
      // security-reviewer PR #193 Medium 2.
      const parseResult = schema.safeParse(parsed);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
        }));
        throw new ValidationError(
          `openai: structured output failed schema (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
          { issues },
        );
      }
      return {
        output: parseResult.data as never,
        usd,
        latencyMs,
      };
    }
    return { output: raw as never, usd, latencyMs };
  },
};
