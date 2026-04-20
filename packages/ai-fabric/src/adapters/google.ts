import { GoogleGenAI } from '@google/genai';
import { ProviderError, ValidationError } from '@diktat/shared';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import type { AdapterResult, ProviderEnv } from '../types.js';

const PRICE_PER_M_INPUT_USD: Record<string, number> = {
  'gemini-2.5-pro': 1.25,
};
const PRICE_PER_M_OUTPUT_USD: Record<string, number> = {
  'gemini-2.5-pro': 10,
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
  const inUsd = ((PRICE_PER_M_INPUT_USD[model] ?? 1.25) * inputTokens) / 1_000_000;
  const outUsd = ((PRICE_PER_M_OUTPUT_USD[model] ?? 10) * outputTokens) / 1_000_000;
  return inUsd + outUsd;
}

let _client: GoogleGenAI | undefined;
function client(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new ProviderError('google', 'GOOGLE_API_KEY missing');
  }
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

// Google's responseSchema is JSON-Schema-flavored but does not accept `$schema`,
// `additionalProperties`, or `$ref`. Strip those so a Zod-derived schema is
// accepted by the SDK without surfacing a 400 from the upstream API.
function sanitizeForGoogle(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeForGoogle);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === '$schema' || k === '$ref' || k === 'additionalProperties') continue;
      out[k] = sanitizeForGoogle(v);
    }
    return out;
  }
  return schema;
}

export const googleAdapter = {
  async invoke<S extends ZodTypeAny | undefined>(
    args: InvokeArgs<S>,
  ): Promise<AdapterResult<S extends ZodTypeAny ? import('zod').infer<S> : string>> {
    const start = Date.now();
    const { model, system, user, schema, maxTokens } = args;

    const config: Record<string, unknown> = {
      systemInstruction: system,
      maxOutputTokens: maxTokens ?? 4096,
    };
    if (schema) {
      const jsonSchema = zodToJsonSchema(schema, { target: 'jsonSchema7' });
      config['responseMimeType'] = 'application/json';
      config['responseSchema'] = sanitizeForGoogle(jsonSchema);
    }

    const response = await client().models.generateContent({
      model,
      contents: user,
      config: config as never,
    });

    const latencyMs = Date.now() - start;
    const usage =
      (response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
        .usageMetadata ?? {};
    const usd = priceUsd(model, usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0);

    const text = (response as { text?: string }).text ?? '';
    if (!text) {
      throw new ProviderError('google', 'no text in response');
    }

    if (schema) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new ValidationError(`google: response is not JSON: ${text.slice(0, 80)}`, err);
      }
      return { output: schema.parse(parsed) as never, usd, latencyMs };
    }
    return { output: text as never, usd, latencyMs };
  },
};
