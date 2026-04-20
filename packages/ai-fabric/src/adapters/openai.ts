import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { ProviderError, ValidationError } from '@diktat/shared';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import type { AdapterResult, ProviderEnv } from '../types.js';

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
      max_tokens: maxTokens ?? 4096,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };

    if (schema) {
      const jsonSchema = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<
        string,
        unknown
      >;
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
      return {
        output: schema.parse(parsed) as never,
        usd,
        latencyMs,
      };
    }
    return { output: raw as never, usd, latencyMs };
  },
};
